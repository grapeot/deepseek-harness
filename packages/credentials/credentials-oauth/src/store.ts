/**
 * Atomic 0600 store for OAuth token pairs at `$DSH_HOME/.oauth-credentials.json`.
 * @module @deepseek-ai/dsh-credentials-oauth/store
 */

import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Basename of the OAuth store inside the harness home. */
export const OAUTH_STORE_FILENAME = '.oauth-credentials.json'

/** On-disk document version this reader accepts. */
export const OAUTH_STORE_VERSION = 1

/** One persisted flow's token pair. */
export interface StoredFlow {
  access: string
  refresh: string
  expiresAt: number
  obtainedAt: number
}

/** Versioned store document. */
export interface OAuthStoreDocument {
  version: typeof OAUTH_STORE_VERSION
  flows: Record<string, StoredFlow>
}

const GROUP_OTHER_BITS = 0o077

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Resolve the store path: an explicit `path` wins, otherwise the document
 * lives at `<harness home>/.oauth-credentials.json`.
 * @param config - optional path and home overrides.
 */
export function resolveStorePath(config: { path?: string; dshHome?: string }): string {
  return resolve(config.path ?? join(resolveDshHome(config.dshHome), OAUTH_STORE_FILENAME))
}

/**
 * Reject a store other OS users can read. Windows has no POSIX mode, so the
 * check is skipped there rather than faked.
 * @param filename - absolute store path.
 */
export async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    /* v8 ignore next -- absence is the empty-store path; any other stat failure must surface */
    if (!isENOENT(error)) throw error
    return
  }
  /* v8 ignore next -- POSIX coverage cannot take the Windows peer; native Windows coverage does. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows has no POSIX mode enforcement; POSIX behavior tests enforce this peer. */
  const offending = mode & GROUP_OTHER_BITS
  if (offending === 0) return
  throw new Error(
    `credentials-oauth: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
    + ` run "chmod 600 ${filename}" before starting again`,
  )
  /* v8 ignore stop */
}

/**
 * Parse one store document. An empty or absent document is an empty store.
 * An unknown version, a non-object root, or a malformed flow entry fails loud.
 * @param text - file text.
 * @param filename - quoted in errors.
 */
export function parseOAuthStore(text: string, filename: string): OAuthStoreDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    /* v8 ignore next -- JSON.parse throws Error */
    const reason = error instanceof Error ? error.message : 'invalid JSON'
    throw new Error(`credentials-oauth: invalid document at ${filename}: ${reason}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`credentials-oauth: ${filename} must be a JSON object`)
  }
  const root = parsed as { version?: unknown; flows?: unknown }
  if (root.version !== OAUTH_STORE_VERSION) {
    throw new Error(
      `credentials-oauth: ${filename} has unsupported version ${String(root.version)}; expected ${String(OAUTH_STORE_VERSION)}`,
    )
  }
  if (root.flows === undefined) return { version: OAUTH_STORE_VERSION, flows: {} }
  if (root.flows === null || typeof root.flows !== 'object' || Array.isArray(root.flows)) {
    throw new TypeError(`credentials-oauth: ${filename} "flows" must be an object`)
  }
  const flows: Record<string, StoredFlow> = {}
  for (const [id, value] of Object.entries(root.flows as Record<string, unknown>)) {
    flows[id] = parseStoredFlow(value, id, filename)
  }
  return { version: OAUTH_STORE_VERSION, flows }
}

function parseStoredFlow(value: unknown, id: string, filename: string): StoredFlow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`credentials-oauth: flow "${id}" in ${filename} must be an object`)
  }
  const entry = value as Record<string, unknown>
  const access = requiredString(entry.access, 'access', id, filename)
  const refresh = requiredString(entry.refresh, 'refresh', id, filename)
  const expiresAt = requiredNumber(entry.expiresAt, 'expiresAt', id, filename)
  const obtainedAt = requiredNumber(entry.obtainedAt, 'obtainedAt', id, filename)
  return { access, refresh, expiresAt, obtainedAt }
}

function requiredString(value: unknown, field: string, id: string, filename: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`credentials-oauth: flow "${id}" in ${filename} is missing a non-empty "${field}"`)
  }
  return value
}

function requiredNumber(value: unknown, field: string, id: string, filename: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`credentials-oauth: flow "${id}" in ${filename} is missing a finite "${field}"`)
  }
  return value
}

/** File-backed OAuth store with exclusive writes. */
export class OAuthStore {
  constructor(private readonly filename: string) {}

  /** Absolute path of the store document. */
  get path(): string {
    return this.filename
  }

  /**
   * Read the current document. Absence is an empty store.
   * @returns the parsed document.
   */
  async read(): Promise<OAuthStoreDocument> {
    await assertOwnerOnly(this.filename)
    let text: string
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      return { version: OAUTH_STORE_VERSION, flows: {} }
    }
    return parseOAuthStore(text, this.filename)
  }

  /**
   * Replace one flow's stored pair, or delete it when `record` is undefined.
   * Persist happens under the writer lock; failure rejects so a rotated
   * refresh token cannot leave the store. `persist` runs under that lock
   * against the on-disk record: return false to leave the document unchanged
   * so a logout or a newer login is not overwritten.
   * @param flowId - the flow to write.
   * @param record - the new pair, or `undefined` to delete.
   * @param persist - skip the write when this returns false.
   * @returns whether a write happened.
   */
  async writeFlow(
    flowId: string,
    record: StoredFlow | undefined,
    persist?: (current: StoredFlow | undefined) => boolean,
  ): Promise<boolean> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return await withFileLock(this.filename, async () => {
      const current = await this.read()
      const existing = current.flows[flowId]
      if (persist !== undefined && !persist(existing)) return false
      const nextFlows = { ...current.flows }
      if (record === undefined) {
        const { [flowId]: _removed, ...kept } = nextFlows
        current.flows = kept
      } else {
        nextFlows[flowId] = record
        current.flows = nextFlows
      }
      const text = `${JSON.stringify(current, undefined, 2)}\n`
      await writeFileAtomic(this.filename, text, { mode: 0o600, dirMode: 0o700 })
      return true
    })
  }
}
