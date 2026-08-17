import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as OAuthInvariant from '../src/invariant.ts'

describe('credentials-oauth invariant companion', () => {
  it('registers and reserves the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(OAuthInvariant)
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-credentials-oauth', () => {})
    }).toThrow(/already registered/)
  })
})
