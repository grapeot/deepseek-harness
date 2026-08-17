import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import {
  apply,
  applyOAuth,
  defaultCredentialRef,
  handleOAuthCommand,
  isBuiltinFlowId,
  loadBuiltInFlow,
  parseOAuthStore,
  resolveStorePath,
} from '../src/index.ts'
import type { OAuthFlow, OAuthProviderConfig, OAuthTokens } from '../src/index.ts'

const REF = credentialRef('XAI_OAUTH_ACCESS')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-oauth-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function tokens(access: string, refresh = 'refresh-1', expires = Date.now() + 60_000): OAuthTokens {
  return { type: 'oauth', access, refresh, expires }
}

function fakeFlow(options: {
  login?: OAuthFlow['login']
  refresh?: OAuthFlow['refresh']
} = {}): OAuthFlow {
  return {
    login: options.login ?? (async (interaction) => {
      interaction.notify({
        type: 'device_code',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.x.ai/device',
        expiresInSeconds: 60,
      })
      return tokens('access-live')
    }),
    refresh: options.refresh ?? (async () => tokens('access-refreshed', 'refresh-2')),
    toAuth: async credential => ({ apiKey: credential.access }),
  }
}

interface Booted {
  ctx: Context
  storePath: string
  agent: Agent
}

async function boot(options: {
  flow?: OAuthFlow
  providers?: Record<string, OAuthProviderConfig>
  withCommands?: boolean
} = {}): Promise<Booted> {
  const dir = await tempDir()
  const storePath = join(dir, '.oauth-credentials.json')
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, {
    path: join(dir, '.credentials.yaml'),
    watch: false,
  })
  if (options.withCommands !== false) {
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
  }
  applyOAuth(ctx, {
    path: storePath,
    providers: options.providers ?? { xai: {} },
  }, async () => options.flow ?? fakeFlow())
  const session = ctx.get('sessions')?.create(SessionId('oauth-test'))
  const agent = { id: session?.id ?? 'oauth-test', session } as Agent
  return { ctx, storePath, agent }
}

describe('flow helpers', () => {
  it('recognizes shipped ids and default refs', () => {
    expect(isBuiltinFlowId('xai')).toBe(true)
    expect(isBuiltinFlowId('anthropic')).toBe(false)
    expect(defaultCredentialRef('xai')).toBe('XAI_OAUTH_ACCESS')
    expect(defaultCredentialRef('openai-codex')).toBe('OPENAI_CODEX_OAUTH_ACCESS')
  })

  it('loads the shipped xai flow from pi-ai', async () => {
    const flow = await loadBuiltInFlow('xai')
    expect(flow.login).toBeTypeOf('function')
    expect(flow.refresh).toBeTypeOf('function')
    await expect(loadBuiltInFlow('nope')).rejects.toThrow(/unknown flow/)
  })

  it('resolves the store path from an explicit path or the harness home', () => {
    expect(resolveStorePath({ path: '/tmp/oauth.json' })).toMatch(/oauth\.json$/)
    expect(resolveStorePath({ dshHome: '/custom/home' })).toMatch(/[/\\]custom[/\\]home[/\\]\.oauth-credentials\.json$/)
  })
})

describe('store document', () => {
  it('parses a valid document and rejects malformed ones', () => {
    expect(parseOAuthStore(JSON.stringify({
      version: 1,
      flows: { xai: { access: 'a', refresh: 'r', expiresAt: 1, obtainedAt: 2 } },
    }), 'store.json')).toEqual({
      version: 1,
      flows: { xai: { access: 'a', refresh: 'r', expiresAt: 1, obtainedAt: 2 } },
    })
    expect(() => parseOAuthStore('{', 'store.json')).toThrow(/invalid document/)
    expect(() => parseOAuthStore('[]', 'store.json')).toThrow(/JSON object/)
    expect(() => parseOAuthStore('{"version":2,"flows":{}}', 'store.json')).toThrow(/unsupported version/)
    expect(() => parseOAuthStore('{"version":1,"flows":[]}', 'store.json')).toThrow(/flows/)
    expect(() => parseOAuthStore('{"version":1,"flows":{"xai":"nope"}}', 'store.json')).toThrow(/must be an object/)
    expect(() => parseOAuthStore('{"version":1,"flows":{"xai":{}}}', 'store.json')).toThrow(/access/)
    expect(() => parseOAuthStore('{"version":1,"flows":{"xai":{"access":"a","refresh":"r","expiresAt":"x","obtainedAt":1}}}', 'store.json'))
      .toThrow(/expiresAt/)
  })
})

describe('handleOAuthCommand', () => {
  const actions = {
    startLogin: async (id: string) => ({ kind: 'success' as const, text: `login:${id}` }),
    logout: async (id: string) => ({ kind: 'success' as const, text: `logout:${id}` }),
    status: async (id: string | undefined) => ({ kind: 'success' as const, text: `status:${id ?? '*'}` }),
  }

  it('dispatches verbs and rejects bad usage', async () => {
    expect(await handleOAuthCommand(' login xai ', actions)).toEqual({ kind: 'success', text: 'login:xai' })
    expect(await handleOAuthCommand('logout xai', actions)).toEqual({ kind: 'success', text: 'logout:xai' })
    expect(await handleOAuthCommand('status', actions)).toEqual({ kind: 'success', text: 'status:*' })
    expect(await handleOAuthCommand('status xai', actions)).toEqual({ kind: 'success', text: 'status:xai' })
    expect(await handleOAuthCommand('', actions)).toMatchObject({ kind: 'error' })
    expect(await handleOAuthCommand('login', actions)).toMatchObject({ kind: 'error' })
    expect(await handleOAuthCommand('logout', actions)).toMatchObject({ kind: 'error' })
    expect(await handleOAuthCommand('status a b', actions)).toMatchObject({ kind: 'error' })
    expect(await handleOAuthCommand('dance xai', actions)).toMatchObject({ kind: 'error' })
  })
})

describe('applyOAuth', () => {
  it('treats omitted providers as dormant', async () => {
    const dir = await tempDir()
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    applyOAuth(ctx, { path: join(dir, '.oauth-credentials.json') }, async () => fakeFlow())
    expect(ctx.get('credentialSources')?.lookup(REF)).toBeUndefined()
  })

  it('apply mounts dormant through the shipped loader', async () => {
    const dir = await tempDir()
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    apply(ctx, { path: join(dir, '.oauth-credentials.json'), providers: {} })
    expect(ctx.get('credentialSources')?.lookup(REF)).toBeUndefined()
  })

  it('mounts dormant with empty providers', async () => {
    const { ctx } = await boot({ providers: {} })
    expect(ctx.credentialSources.lookup(REF)).toBeUndefined()
  })

  it('rejects an unknown flow id at load', async () => {
    const dir = await tempDir()
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    expect(() => applyOAuth(ctx, { providers: { nope: {} } }, async () => fakeFlow()))
      .toThrow(/unknown flow/)
  })

  it('resolves undefined until login, then the live access token', async () => {
    const { ctx, agent } = await boot()
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: false })
    const result = await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    expect(result?.result).toMatchObject({ kind: 'success' })
    expect(result?.result.kind === 'success' ? result.result.text : '').toContain('ABCD-EFGH')
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'access-live', source: 'oauth' })
    })
    expect(await ctx.credentials.describe(REF))
      .toEqual({ configured: true, source: 'oauth', writable: false })
  })

  it('refreshes a single-flight expired token and persists before returning', async () => {
    const { ctx, storePath } = await boot({
      flow: fakeFlow({
        refresh: async () => tokens('access-refreshed', 'refresh-rotated'),
      }),
    })
    await writeFile(storePath, `${JSON.stringify({
      version: 1,
      flows: {
        xai: { access: 'stale', refresh: 'refresh-1', expiresAt: Date.now() - 1, obtainedAt: 1 },
      },
    })}\n`, { mode: 0o600 })
    const [first, second] = await Promise.all([
      ctx.credentials.resolve(REF),
      ctx.credentials.resolve(REF),
    ])
    expect(first).toEqual({ value: 'access-refreshed', source: 'oauth' })
    expect(second).toEqual({ value: 'access-refreshed', source: 'oauth' })
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as { flows: { xai: { access: string; refresh: string } } }
    expect(stored.flows.xai.access).toBe('access-refreshed')
    expect(stored.flows.xai.refresh).toBe('refresh-rotated')
  })

  it('fails a rejected refresh with re-login directions', async () => {
    const { ctx, storePath } = await boot({
      flow: fakeFlow({
        refresh: async () => {
          throw new Error('invalid_grant')
        },
      }),
    })
    await writeFile(storePath, `${JSON.stringify({
      version: 1,
      flows: {
        xai: { access: 'stale', refresh: 'dead', expiresAt: Date.now() - 1, obtainedAt: 1 },
      },
    })}\n`, { mode: 0o600 })
    await expect(ctx.credentials.resolve(REF)).rejects.toThrow(/\/oauth login xai/)
  })

  it('reports status, logout, and unknown flow errors', async () => {
    const { ctx, agent } = await boot()
    const empty = await ctx.commands.execute(agent, '/oauth status', new AbortController().signal)
    expect(empty?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('not connected') })
    await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    await vi.waitFor(async () => {
      expect((await ctx.credentials.resolve(REF))?.value).toBe('access-live')
    })
    const connected = await ctx.commands.execute(agent, '/oauth status xai', new AbortController().signal)
    expect(connected?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('connected') })
    const loggedOut = await ctx.commands.execute(agent, '/oauth logout xai', new AbortController().signal)
    expect(loggedOut?.result).toMatchObject({ kind: 'success' })
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.commands.execute(agent, '/oauth login nope', new AbortController().signal))
      .toMatchObject({ result: { kind: 'error' } })
    expect(await ctx.commands.execute(agent, '/oauth logout nope', new AbortController().signal))
      .toMatchObject({ result: { kind: 'error' } })
    expect(await ctx.commands.execute(agent, '/oauth status nope', new AbortController().signal))
      .toMatchObject({ result: { kind: 'error' } })
  })

  it('returns pending status while login is in flight', async () => {
    let release!: (tokens: OAuthTokens) => void
    const held = new Promise<OAuthTokens>((resolve) => { release = resolve })
    const { ctx, agent } = await boot({
      flow: fakeFlow({
        login: async (interaction) => {
          interaction.notify({
            type: 'device_code',
            userCode: 'WAIT-CODE',
            verificationUri: 'https://auth.x.ai/device',
            expiresInSeconds: 30,
          })
          return held
        },
      }),
    })
    const login = ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    await vi.waitFor(async () => {
      const status = await ctx.commands.execute(agent, '/oauth status', new AbortController().signal)
      expect(status?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('pending') })
    })
    release(tokens('access-later'))
    await login
    await vi.waitFor(async () => {
      expect((await ctx.credentials.resolve(REF))?.value).toBe('access-later')
    })
  })

  it('records a failed login on status', async () => {
    const { ctx, agent } = await boot({
      flow: fakeFlow({
        login: async (interaction) => {
          interaction.notify({
            type: 'device_code',
            userCode: 'NOPE',
            verificationUri: 'https://auth.x.ai/device',
            expiresInSeconds: 5,
          })
          throw new Error('denied')
        },
      }),
    })
    await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    await vi.waitFor(async () => {
      const status = await ctx.commands.execute(agent, '/oauth status', new AbortController().signal)
      expect(status?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('failed') })
    })
  })

  it('status with no mounted flows says so', async () => {
    const { ctx, agent } = await boot({ providers: {} })
    const result = await ctx.commands.execute(agent, '/oauth status', new AbortController().signal)
    expect(result?.result).toEqual({ kind: 'success', text: 'No OAuth flows mounted.' })
  })

  it('honours a custom credentialRef and a second login aborts the first', async () => {
    const custom = credentialRef('CUSTOM_XAI')
    let firstReleased = false
    let releaseFirst!: (tokens: OAuthTokens) => void
    const firstHeld = new Promise<OAuthTokens>((resolve) => { releaseFirst = resolve })
    let logins = 0
    const { ctx, agent } = await boot({
      providers: { xai: { credentialRef: 'CUSTOM_XAI' } },
      flow: fakeFlow({
        login: async (interaction) => {
          logins += 1
          interaction.notify({
            type: 'info',
            message: 'ignored',
          })
          interaction.notify({
            type: 'device_code',
            userCode: `CODE-${String(logins)}`,
            verificationUri: 'https://auth.x.ai/device',
          })
          if (logins === 1) return firstHeld
          return tokens('access-second')
        },
      }),
    })
    const first = ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    await first
    await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    firstReleased = true
    releaseFirst(tokens('access-first'))
    await vi.waitFor(async () => {
      expect((await ctx.credentials.resolve(custom))?.value).toBe('access-second')
    })
    expect(firstReleased).toBe(true)
  })

  it('treats a non-Error refresh rejection as refresh rejected', async () => {
    const { ctx, storePath } = await boot({
      flow: fakeFlow({
        refresh: async () => {
          throw 'nope'
        },
      }),
    })
    await writeFile(storePath, `${JSON.stringify({
      version: 1,
      flows: {
        xai: { access: 'stale', refresh: 'dead', expiresAt: Date.now() - 1, obtainedAt: 1 },
      },
    })}\n`, { mode: 0o600 })
    await expect(ctx.credentials.resolve(REF)).rejects.toThrow(/refresh rejected/)
  })

  it('aborts an in-flight login on logout and logs out when never connected', async () => {
    let release!: (tokens: OAuthTokens) => void
    const held = new Promise<OAuthTokens>((resolve) => { release = resolve })
    const { ctx, agent } = await boot({
      flow: fakeFlow({
        login: async (interaction) => {
          interaction.notify({
            type: 'device_code',
            userCode: 'PEND',
            verificationUri: 'https://auth.x.ai/device',
            expiresInSeconds: 20,
          })
          return held
        },
      }),
    })
    await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    const loggedOut = await ctx.commands.execute(agent, '/oauth logout xai', new AbortController().signal)
    expect(loggedOut?.result).toMatchObject({ kind: 'success' })
    release(tokens('too-late'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })

  it('records a non-Error login failure', async () => {
    const { ctx, agent } = await boot({
      flow: fakeFlow({
        login: async (interaction) => {
          interaction.notify({
            type: 'device_code',
            userCode: 'NOPE',
            verificationUri: 'https://auth.x.ai/device',
            expiresInSeconds: 5,
          })
          throw 'denied'
        },
      }),
    })
    await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    await vi.waitFor(async () => {
      const status = await ctx.commands.execute(agent, '/oauth status', new AbortController().signal)
      expect(status?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('failed') })
    })
  })

  it('skips the command when commands is not mounted', async () => {
    const { ctx } = await boot({ withCommands: false })
    expect(ctx.get('commands')).toBeUndefined()
    expect(ctx.credentialSources.lookup(REF)).toBeDefined()
  })

  it('returns an error when login fails before the device code with a non-Error', async () => {
    const { ctx, agent } = await boot({
      flow: fakeFlow({
        login: async () => {
          throw 'device down'
        },
      }),
    })
    const result = await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    expect(result?.result).toMatchObject({ kind: 'error', text: 'login failed' })
  })

  it('does not mark a superseded pre-notify login as the current failure', async () => {
    let releaseFirst!: () => void
    const firstHeld = new Promise<OAuthTokens>((_resolve, reject) => {
      releaseFirst = () => reject(new Error('first aborted'))
    })
    let logins = 0
    const { ctx, agent } = await boot({
      flow: fakeFlow({
        login: async (interaction) => {
          logins += 1
          if (logins === 1) return firstHeld
          interaction.notify({
            type: 'device_code',
            userCode: 'SECOND',
            verificationUri: 'https://auth.x.ai/device',
            expiresInSeconds: 20,
          })
          return tokens('access-second')
        },
      }),
    })
    const first = ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    await vi.waitFor(() => { expect(logins).toBe(1) })
    const second = await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    expect(second?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('SECOND') })
    releaseFirst()
    expect((await first)?.result).toMatchObject({ kind: 'error' })
    await vi.waitFor(async () => {
      expect((await ctx.credentials.resolve(REF))?.value).toBe('access-second')
    })
  })

  it('returns an error when login fails before the device code', async () => {
    const { ctx, agent } = await boot({
      flow: fakeFlow({
        login: async () => {
          throw new Error('device request failed')
        },
      }),
    })
    const result = await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    expect(result?.result).toMatchObject({ kind: 'error', text: 'device request failed' })
    const status = await ctx.commands.execute(agent, '/oauth status xai', new AbortController().signal)
    expect(status?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('failed') })
  })

  it('returns an error when login completes without a device code', async () => {
    const { ctx, agent } = await boot({
      flow: fakeFlow({
        login: async () => tokens('no-device'),
      }),
    })
    const result = await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    expect(result?.result).toMatchObject({ kind: 'error', text: expect.stringContaining('without a device code') })
  })

  it('does not resurrect a session when refresh overlaps logout', async () => {
    let release!: (tokens: OAuthTokens) => void
    const held = new Promise<OAuthTokens>((resolve) => { release = resolve })
    let refreshing = false
    const { ctx, agent, storePath } = await boot({
      flow: fakeFlow({
        refresh: async () => {
          refreshing = true
          return held
        },
      }),
    })
    await writeFile(storePath, `${JSON.stringify({
      version: 1,
      flows: {
        xai: { access: 'stale', refresh: 'refresh-1', expiresAt: Date.now() - 1, obtainedAt: 1 },
      },
    })}\n`, { mode: 0o600 })
    const resolving = ctx.credentials.resolve(REF)
    await vi.waitFor(() => { expect(refreshing).toBe(true) })
    const loggedOut = await ctx.commands.execute(agent, '/oauth logout xai', new AbortController().signal)
    expect(loggedOut?.result).toMatchObject({ kind: 'success' })
    release(tokens('resurrected', 'refresh-2'))
    expect(await resolving).toBeUndefined()
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as { flows: Record<string, unknown> }
    expect(stored.flows.xai).toBeUndefined()
  })

  it('does not persist a login that finishes after logout', async () => {
    let release!: (tokens: OAuthTokens) => void
    const held = new Promise<OAuthTokens>((resolve) => { release = resolve })
    const { ctx, agent, storePath } = await boot({
      flow: fakeFlow({
        login: async (interaction) => {
          interaction.notify({
            type: 'device_code',
            userCode: 'PEND',
            verificationUri: 'https://auth.x.ai/device',
            expiresInSeconds: 20,
          })
          return held
        },
      }),
    })
    await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    await ctx.commands.execute(agent, '/oauth logout xai', new AbortController().signal)
    release(tokens('too-late'))
    await vi.waitFor(async () => {
      const stored = JSON.parse(await readFile(storePath, 'utf8')) as { flows: Record<string, unknown> }
      expect(stored.flows.xai).toBeUndefined()
    })
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
  })

  it('records a persist failure after login completes', async () => {
    const { ctx, agent, storePath } = await boot({
      flow: fakeFlow({
        login: async (interaction) => {
          interaction.notify({
            type: 'device_code',
            userCode: 'SAVE',
            verificationUri: 'https://auth.x.ai/device',
            expiresInSeconds: 20,
          })
          const { chmod } = await import('node:fs/promises')
          await chmod(join(storePath, '..'), 0o555)
          return tokens('access-live')
        },
      }),
    })
    const { chmod } = await import('node:fs/promises')
    try {
      await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
      await vi.waitFor(async () => {
        const status = await ctx.commands.execute(agent, '/oauth status xai', new AbortController().signal)
        expect(status?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('failed') })
      })
    } finally {
      await chmod(join(storePath, '..'), 0o700)
    }
  })

  it('ignores a post-notify login rejection after logout', async () => {
    let rejectLogin!: (error: Error) => void
    const held = new Promise<OAuthTokens>((_resolve, reject) => { rejectLogin = reject })
    const { ctx, agent } = await boot({
      flow: fakeFlow({
        login: async (interaction) => {
          interaction.notify({
            type: 'device_code',
            userCode: 'PEND',
            verificationUri: 'https://auth.x.ai/device',
            expiresInSeconds: 20,
          })
          return held
        },
      }),
    })
    await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    await ctx.commands.execute(agent, '/oauth logout xai', new AbortController().signal)
    rejectLogin(new Error('denied after logout'))
    await new Promise(resolve => setTimeout(resolve, 20))
    const status = await ctx.commands.execute(agent, '/oauth status xai', new AbortController().signal)
    expect(status?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('not connected') })
  })

  it('unregisters the source when the oauth fiber disposes', async () => {
    const dir = await tempDir()
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, {
      path: join(dir, '.credentials.yaml'),
      watch: false,
    })
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    const held = new Promise<OAuthTokens>(() => undefined)
    function OAuthTest(inner: Context): void {
      applyOAuth(inner, { path: join(dir, '.oauth-credentials.json'), providers: { xai: {} } }, async () => fakeFlow({
        login: async (interaction) => {
          interaction.notify({
            type: 'device_code',
            userCode: 'PEND',
            verificationUri: 'https://auth.x.ai/device',
            expiresInSeconds: 20,
          })
          return held
        },
      }))
    }
    OAuthTest.inject = ['credentials', 'credentialSources']
    const fiber = await ctx.plugin(OAuthTest)
    const session = ctx.get('sessions')?.create(SessionId('oauth-dispose'))
    const agent = { id: session?.id ?? 'oauth-dispose', session } as Agent
    await ctx.commands.execute(agent, '/oauth login xai', new AbortController().signal)
    expect(ctx.credentialSources.lookup(REF)).toBeDefined()
    expect(ctx.credentials).toBeDefined()
    await fiber.dispose()
    expect(ctx.credentialSources.lookup(REF)).toBeUndefined()
    expect(ctx.credentials).toBeDefined()
  })
})

describe('local provider plus oauth source', () => {
  it('rejects a file-layer conflict when the source registers', async () => {
    const dir = await tempDir()
    const creds = join(dir, '.credentials.yaml')
    await writeFile(creds, 'XAI_OAUTH_ACCESS: leftover\n', { mode: 0o600 })
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: creds, watch: false })
    expect(() => applyOAuth(ctx, {
      path: join(dir, '.oauth-credentials.json'),
      providers: { xai: {} },
    }, async () => fakeFlow())).toThrow(/stored in/)
  })
})
