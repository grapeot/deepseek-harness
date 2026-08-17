import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertOwnerOnly,
  OAuthStore,
  parseOAuthStore,
} from '../src/store.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-oauth-store-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('OAuthStore', () => {
  it('treats an absent file as an empty store and writes then deletes a flow', async () => {
    const dir = await tempDir()
    const path = join(dir, '.oauth-credentials.json')
    const store = new OAuthStore(path)
    expect(store.path).toBe(path)
    expect(await store.read()).toEqual({ version: 1, flows: {} })
    await store.writeFlow('xai', { access: 'a', refresh: 'r', expiresAt: 10, obtainedAt: 1 })
    expect((await store.read()).flows.xai?.access).toBe('a')
    await store.writeFlow('xai', undefined)
    expect((await store.read()).flows.xai).toBeUndefined()
  })

  it('skips a write when persist rejects the current record', async () => {
    const dir = await tempDir()
    const path = join(dir, '.oauth-credentials.json')
    const store = new OAuthStore(path)
    await store.writeFlow('xai', { access: 'a', refresh: 'r', expiresAt: 10, obtainedAt: 1 })
    expect(await store.writeFlow(
      'xai',
      { access: 'b', refresh: 'r2', expiresAt: 20, obtainedAt: 2 },
      current => current?.refresh === 'other',
    )).toBe(false)
    expect((await store.read()).flows.xai?.access).toBe('a')
  })

  it('parses a document with no flows key as empty', () => {
    expect(parseOAuthStore('{"version":1}', 'store.json')).toEqual({ version: 1, flows: {} })
  })

  it('rejects empty access, missing refresh, and non-finite obtainedAt', () => {
    expect(() => parseOAuthStore('{"version":1,"flows":{"xai":{"access":"","refresh":"r","expiresAt":1,"obtainedAt":1}}}', 's.json'))
      .toThrow(/access/)
    expect(() => parseOAuthStore('{"version":1,"flows":{"xai":{"access":"a","expiresAt":1,"obtainedAt":1}}}', 's.json'))
      .toThrow(/refresh/)
    expect(() => parseOAuthStore('{"version":1,"flows":{"xai":{"access":"a","refresh":"r","expiresAt":1,"obtainedAt":null}}}', 's.json'))
      .toThrow(/obtainedAt/)
  })

  it('propagates a read that is not absence', async () => {
    const dir = await tempDir()
    const path = join(dir, '.oauth-credentials.json')
    const store = new OAuthStore(path)
    await writeFile(path, '{', { mode: 0o600 })
    await expect(store.read()).rejects.toThrow(/invalid document/)
  })

  it('propagates a read of a directory', async () => {
    const dir = await tempDir()
    const path = join(dir, '.oauth-credentials.json')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path, { mode: 0o700 })
    const store = new OAuthStore(path)
    await expect(store.read()).rejects.toThrow(/EISDIR/)
  })

  it.skipIf(process.platform === 'win32')('refuses a store other OS users can read', async () => {
    const dir = await tempDir()
    const path = join(dir, '.oauth-credentials.json')
    await writeFile(path, '{"version":1,"flows":{}}\n', { mode: 0o644 })
    await expect(assertOwnerOnly(path)).rejects.toThrow(/readable beyond its owner/)
  })
})
