import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialSourceRegistry, credentialRef } from '../src/index.ts'
import type { CredentialInfo, CredentialRef, CredentialSource, ResolvedCredential } from '../src/index.ts'

const ALPHA = credentialRef('OAUTH_ALPHA')
const BETA = credentialRef('OAUTH_BETA')

class FakeSource implements CredentialSource {
  constructor(
    readonly id: string,
    readonly refs: readonly CredentialRef[],
    private readonly value?: string,
  ) {}

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (!this.refs.includes(ref) || this.value === undefined) return Promise.resolve(undefined)
    return Promise.resolve({ value: this.value, source: 'oauth' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (!this.refs.includes(ref) || this.value === undefined) {
      return Promise.resolve({ configured: false, writable: false })
    }
    return Promise.resolve({ configured: true, source: 'oauth', writable: false })
  }
}

describe('CredentialSourceRegistry', () => {
  it('registers a source and looks it up by reference', async () => {
    const ctx = new Context()
    await ctx.plugin(CredentialSourceRegistry)
    const source = new FakeSource('oauth:xai', [ALPHA], 'tok')
    const dispose = ctx.credentialSources.register(source)
    expect(ctx.credentialSources.lookup(ALPHA)).toBe(source)
    expect(ctx.credentialSources.lookup(BETA)).toBeUndefined()
    dispose()
    dispose()
    expect(ctx.credentialSources.lookup(ALPHA)).toBeUndefined()
  })

  it('rejects a source with no references', async () => {
    const ctx = new Context()
    await ctx.plugin(CredentialSourceRegistry)
    expect(() => ctx.credentialSources.register(new FakeSource('empty', [])))
      .toThrow(/owns no references/)
  })

  it('rejects two sources claiming the same reference', async () => {
    const ctx = new Context()
    await ctx.plugin(CredentialSourceRegistry)
    ctx.credentialSources.register(new FakeSource('one', [ALPHA]))
    expect(() => ctx.credentialSources.register(new FakeSource('two', [ALPHA])))
      .toThrow(/already owns/)
  })

  it('rejects a duplicate source id', async () => {
    const ctx = new Context()
    await ctx.plugin(CredentialSourceRegistry)
    ctx.credentialSources.register(new FakeSource('oauth:xai', [ALPHA]))
    expect(() => ctx.credentialSources.register(new FakeSource('oauth:xai', [BETA])))
      .toThrow(/already registered/)
  })

  it('runs validators before admitting a source and uninstalls them', async () => {
    const ctx = new Context()
    await ctx.plugin(CredentialSourceRegistry)
    const seen: string[] = []
    const dispose = ctx.credentialSources.addValidator((source) => {
      seen.push(source.id)
      if (source.id === 'blocked') throw new Error('blocked')
    })
    expect(() => ctx.credentialSources.register(new FakeSource('blocked', [ALPHA])))
      .toThrow(/blocked/)
    ctx.credentialSources.register(new FakeSource('ok', [ALPHA]))
    dispose()
    ctx.credentialSources.register(new FakeSource('blocked', [BETA]))
    expect(seen).toEqual(['blocked', 'ok'])
  })
})
