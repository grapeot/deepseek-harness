/**
 * OAuth credential source: stores tokens in `$DSH_HOME/.oauth-credentials.json`,
 * refreshes lazily at resolve time, and exposes each flow's access token as
 * one ordinary credential reference. `/oauth login|status|logout` runs through
 * `ctx.commands` when that service is mounted.
 * @module @deepseek-ai/dsh-credentials-oauth
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, CredentialSource, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { defaultCredentialRef, isBuiltinFlowId, loadBuiltInFlow } from './flows.ts'
import type { DeviceCodeEvent, OAuthFlow, OAuthTokens } from './flows.ts'
import { OAuthStore, resolveStorePath } from './store.ts'
import type { StoredFlow } from './store.ts'

export { BUILTIN_FLOW_IDS, defaultCredentialRef, isBuiltinFlowId, loadBuiltInFlow } from './flows.ts'
export type { BuiltinFlowId, DeviceCodeEvent, OAuthFlow, OAuthTokens } from './flows.ts'
export {
  OAUTH_STORE_FILENAME,
  OAUTH_STORE_VERSION,
  OAuthStore,
  parseOAuthStore,
  resolveStorePath,
} from './store.ts'
export type { OAuthStoreDocument, StoredFlow } from './store.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'credentials-oauth'

/** Services this plugin registers into. `commands` is optional. */
export const inject = ['credentials', 'credentialSources']

/** One mounted flow's optional reference override. */
export interface OAuthProviderConfig {
  /** Credential reference this flow owns; defaults to `<FLOW>_OAUTH_ACCESS`. */
  credentialRef?: string
}

/** Plugin config (all optional — empty `providers` mounts dormant). */
export interface Config {
  /** Store path; defaults to `.oauth-credentials.json` under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /**
   * Flows to mount, keyed by shipped id. Omission or `{}` mounts zero sources.
   * Each entry's `credentialRef` defaults to `<FLOW>_OAUTH_ACCESS`.
   */
  providers?: Record<string, OAuthProviderConfig>
}

export const Config: z<Config> = z.object({
  path: z.string(),
  dshHome: z.string(),
  providers: z.dict(z.object({
    credentialRef: z.string().role('credential-ref'),
  })),
})

/** Load one flow; tests pass a fake here instead of hitting pi-ai. */
export type ResolveFlow = (id: string) => Promise<OAuthFlow>

interface MountedFlow {
  id: string
  ref: CredentialRef
  flow?: OAuthFlow
  load: Promise<OAuthFlow>
}

type LoginState =
  | { kind: 'idle' }
  | {
    kind: 'pending'
    userCode: string
    verificationUri: string
    expiresAt: number
    abort: AbortController
  }
  | { kind: 'failed'; message: string }

/**
 * Mount the OAuth sources and, when `ctx.commands` is present, the `/oauth`
 * command. `resolveFlow` defaults to the shipped pi-ai loaders.
 * @param ctx - context carrying credentials and credentialSources.
 * @param config - plugin config.
 * @param resolveFlow - flow loader; tests inject a fake.
 */
export function applyOAuth(ctx: Context, config: Config, resolveFlow: ResolveFlow = loadBuiltInFlow): void {
  const filename = resolveStorePath(config)
  const store = new OAuthStore(filename)
  const providers = config.providers ?? {}
  const mounted = new Map<string, MountedFlow>()
  const logins = new Map<string, LoginState>()
  const inflight = new Map<string, Promise<string>>()

  for (const [id, entry] of Object.entries(providers)) {
    if (!isBuiltinFlowId(id)) {
      throw new Error(`credentials-oauth: unknown flow "${id}"`)
    }
    const rawRef = entry?.credentialRef ?? defaultCredentialRef(id)
    const ref = credentialRef(rawRef)
    const load = resolveFlow(id)
    mounted.set(id, { id, ref, load })
    ctx.credentialSources.register(new OAuthCredentialSource(id, ref, {
      resolve: () => resolveAccess(id),
      describe: () => describeAccess(id),
    }))
  }

  async function flowOf(id: string): Promise<OAuthFlow> {
    const entry = mounted.get(id)
    /* v8 ignore next -- resolve/login only run for mounted ids */
    if (entry === undefined) throw new Error(`credentials-oauth: flow "${id}" is not mounted`)
    entry.flow ??= await entry.load
    return entry.flow
  }

  async function resolveAccess(id: string): Promise<string | undefined> {
    const document = await store.read()
    const record = document.flows[id]
    if (record === undefined) return undefined
    if (Date.now() < record.expiresAt) return record.access
    return refreshSingleFlight(id, record)
  }

  async function describeAccess(id: string): Promise<CredentialInfo> {
    const document = await store.read()
    return {
      configured: document.flows[id] !== undefined,
      ...document.flows[id] === undefined ? {} : { source: 'oauth' as const },
      writable: false,
    }
  }

  function refreshSingleFlight(id: string, record: StoredFlow): Promise<string> {
    const existing = inflight.get(id)
    if (existing !== undefined) return existing
    const pending = refreshAndPersist(id, record).finally(() => inflight.delete(id))
    inflight.set(id, pending)
    return pending
  }

  async function refreshAndPersist(id: string, record: StoredFlow): Promise<string> {
    const flow = await flowOf(id)
    let next: OAuthTokens
    try {
      next = await flow.refresh({
        type: 'oauth',
        access: record.access,
        refresh: record.refresh,
        expires: record.expiresAt,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'refresh rejected'
      throw new Error(
        `credentials-oauth: refresh for "${id}" failed (${detail}); re-run /oauth login ${id}`,
      )
    }
    const stored = toStored(next)
    await store.writeFlow(id, stored)
    return stored.access
  }

  function toStored(tokens: OAuthTokens): StoredFlow {
    return {
      access: tokens.access,
      refresh: tokens.refresh,
      expiresAt: tokens.expires,
      obtainedAt: Date.now(),
    }
  }

  function announce(ref: CredentialRef): void {
    ctx.credentials.announceUpdated(ref)
  }

  async function startLogin(id: string): Promise<CommandResult> {
    const entry = mounted.get(id)
    if (entry === undefined) {
      return { kind: 'error', text: `Unknown OAuth flow "${id}".` }
    }
    const previous = logins.get(id)
    if (previous?.kind === 'pending') previous.abort.abort()

    const abort = new AbortController()
    const flow = await flowOf(id)
    let notify!: (event: DeviceCodeEvent) => void
    const notified = new Promise<DeviceCodeEvent>((resolve, reject) => {
      /* v8 ignore next -- abort-before-notify is not a command path */
      const onAbort = (): void => reject(abortError(abort.signal))
      abort.signal.addEventListener('abort', onAbort, { once: true })
      notify = (event) => {
        abort.signal.removeEventListener('abort', onAbort)
        resolve(event)
      }
    })

    const login = flow.login({
      signal: abort.signal,
      /* v8 ignore next -- xai device-code login never prompts */
      prompt: () => Promise.reject(new Error('credentials-oauth: login does not prompt')),
      notify: (event) => {
        if (event.type === 'device_code') notify(event as unknown as DeviceCodeEvent)
      },
    })

    const device = await notified
    logins.set(id, {
      kind: 'pending',
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      expiresAt: Date.now() + (device.expiresInSeconds ?? 0) * 1000,
      abort,
    })

    ctx.effect(function* () {
      /* v8 ignore next -- plugin unload aborts an in-flight login */
      yield () => abort.abort()
      void login.then(async (tokens) => {
        /* v8 ignore next -- logout during pending aborts before persist */
        if (abort.signal.aborted) return
        await store.writeFlow(id, toStored(tokens))
        logins.set(id, { kind: 'idle' })
        announce(entry.ref)
      }, (error: unknown) => {
        /* v8 ignore next -- logout during pending aborts before the failure handler */
        if (abort.signal.aborted) return
        const message = error instanceof Error ? error.message : 'login failed'
        logins.set(id, { kind: 'failed', message })
      })
    }, `credentials-oauth.login(${id})`)

    return {
      kind: 'success',
      text: [
        `Open ${device.verificationUri} and enter code ${device.userCode}.`,
        'Polling for approval; /oauth status reports when the login completes.',
      ].join('\n'),
    }
  }

  async function logout(id: string): Promise<CommandResult> {
    const entry = mounted.get(id)
    if (entry === undefined) {
      return { kind: 'error', text: `Unknown OAuth flow "${id}".` }
    }
    const previous = logins.get(id)
    if (previous?.kind === 'pending') previous.abort.abort()
    logins.set(id, { kind: 'idle' })
    const before = await store.read()
    const wasConfigured = before.flows[id] !== undefined
    await store.writeFlow(id, undefined)
    if (wasConfigured) announce(entry.ref)
    return { kind: 'success', text: `Logged out of ${id}.` }
  }

  async function status(id: string | undefined): Promise<CommandResult> {
    const ids = id === undefined ? [...mounted.keys()] : [id]
    if (id !== undefined && !mounted.has(id)) {
      return { kind: 'error', text: `Unknown OAuth flow "${id}".` }
    }
    if (ids.length === 0) {
      return { kind: 'success', text: 'No OAuth flows mounted.' }
    }
    const document = await store.read()
    const lines = ids.map(flowId => formatStatus(flowId, document.flows[flowId], logins.get(flowId)))
    return { kind: 'success', text: lines.join('\n') }
  }

  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'oauth',
      description: 'Log in, inspect, or log out of an OAuth credential flow',
      input: { hint: 'login <flow> | status [flow] | logout <flow>' },
      handler: async invocation => handleOAuthCommand(invocation.rawInput, {
        startLogin,
        logout,
        status,
      }),
    }), 'credentials-oauth: command')
  }
}

function formatStatus(id: string, record: StoredFlow | undefined, login: LoginState | undefined): string {
  if (login?.kind === 'pending') {
    const remaining = Math.max(0, Math.round((login.expiresAt - Date.now()) / 1000))
    return `${id}: pending (${login.userCode} at ${login.verificationUri}, ${String(remaining)}s left)`
  }
  if (login?.kind === 'failed') return `${id}: failed (${login.message})`
  if (record === undefined) return `${id}: not connected`
  return `${id}: connected (expires ${new Date(record.expiresAt).toISOString()})`
}

/* v8 ignore start -- abort-before-notify is not reachable from /oauth once the device code has been emitted */
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'oauth login aborted')
}
/* v8 ignore stop */

/** Parse `/oauth` arguments and dispatch. */
export async function handleOAuthCommand(
  rawInput: string,
  actions: {
    startLogin: (id: string) => Promise<CommandResult>
    logout: (id: string) => Promise<CommandResult>
    status: (id: string | undefined) => Promise<CommandResult>
  },
): Promise<CommandResult> {
  const parts = rawInput.trim().split(/\s+/).filter(part => part.length > 0)
  const verb = parts[0]
  if (verb === undefined) {
    return { kind: 'error', text: 'Usage: /oauth login <flow> | /oauth status [flow] | /oauth logout <flow>' }
  }
  if (verb === 'login') {
    const id = parts[1]
    if (id === undefined || parts.length !== 2) {
      return { kind: 'error', text: 'Usage: /oauth login <flow>' }
    }
    return actions.startLogin(id)
  }
  if (verb === 'logout') {
    const id = parts[1]
    if (id === undefined || parts.length !== 2) {
      return { kind: 'error', text: 'Usage: /oauth logout <flow>' }
    }
    return actions.logout(id)
  }
  if (verb === 'status') {
    if (parts.length > 2) return { kind: 'error', text: 'Usage: /oauth status [flow]' }
    return actions.status(parts[1])
  }
  return { kind: 'error', text: `Unknown /oauth verb "${verb}".` }
}

/** One flow's credential source. */
class OAuthCredentialSource implements CredentialSource {
  readonly refs: readonly CredentialRef[]

  constructor(
    readonly id: string,
    ref: CredentialRef,
    private readonly ops: {
      resolve: () => Promise<string | undefined>
      describe: () => Promise<CredentialInfo>
    },
  ) {
    this.refs = [ref]
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    /* v8 ignore next -- the registry only asks a source about refs it owns */
    if (ref !== this.refs[0]) return undefined
    const value = await this.ops.resolve()
    if (value === undefined || value.length === 0) return undefined
    return { value, source: 'oauth' }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    /* v8 ignore next -- the registry only asks a source about refs it owns */
    if (ref !== this.refs[0]) return { configured: false, writable: false }
    return this.ops.describe()
  }
}

/** Register the OAuth sources and command with shipped pi-ai flows. */
export function apply(ctx: Context, config: Config): void {
  applyOAuth(ctx, config)
}
