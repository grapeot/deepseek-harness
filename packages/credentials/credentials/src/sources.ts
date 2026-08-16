/**
 * Dynamic credential-source registry (`ctx.credentialSources`). A source
 * answers `resolve` and `describe` for the references it owns; the local
 * provider folds registered sources into its layer pipeline. A second
 * `CredentialProvider` would shadow the local provider rather than compose
 * with it, which is why sources register here instead of as another provider.
 * @module @deepseek-ai/dsh-credentials/sources
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialRef } from './types.ts'
import type { CredentialInfo, ResolvedCredential } from './index.ts'

/**
 * One resolvable credential source. `resolve` and `describe` cover only the
 * references listed in {@link CredentialSource.refs}; the registry rejects a
 * second source that claims any of the same references.
 */
export interface CredentialSource {
  /** Diagnostic id such as `oauth:xai`. */
  readonly id: string
  /** References this source owns exclusively. */
  readonly refs: readonly CredentialRef[]
  /**
   * Resolve one owned reference.
   * @param ref - the reference; callers only pass a member of {@link refs}.
   * @returns the value and source id, or `undefined` while unconfigured.
   */
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  /**
   * Describe one owned reference without exposing the value.
   * @param ref - the reference; callers only pass a member of {@link refs}.
   * @returns configured state; `writable` is always false.
   */
  describe(ref: CredentialRef): Promise<CredentialInfo>
}

/** Called when a source registers; throw to reject the registration. */
export type CredentialSourceValidator = (source: CredentialSource) => void

declare module '@deepseek-ai/cordis' {
  interface Context {
    credentialSources: CredentialSourceRegistry
  }
}

/**
 * Registry of dynamic credential sources. Registration is an effect: the
 * returned disposer unregisters the source. Two sources claiming one
 * reference reject at registration.
 */
export class CredentialSourceRegistry extends Service {
  private readonly sources: CredentialSource[] = []
  private readonly validators = new Set<CredentialSourceValidator>()

  constructor(ctx: Context) {
    super(ctx, 'credentialSources')
  }

  /**
   * Register a source for the lifetime of the calling fiber.
   * @param source - the source; its refs must not overlap an already-registered source.
   * @returns the disposer that unregisters this source.
   */
  register(source: CredentialSource): () => void {
    if (source.refs.length === 0) {
      throw new Error(`credential source "${source.id}" owns no references`)
    }
    for (const existing of this.sources) {
      if (existing.id === source.id) {
        throw new Error(`credential source "${source.id}" is already registered`)
      }
      for (const ref of source.refs) {
        if (existing.refs.includes(ref)) {
          throw new Error(
            `credential source "${source.id}" claims "${ref}", which "${existing.id}" already owns`,
          )
        }
      }
    }
    for (const validate of this.validators) validate(source)
    const { sources } = this
    const dispose = this.ctx.effect(function* () {
      sources.push(source)
      yield () => {
        const index = sources.indexOf(source)
        /* v8 ignore next -- dispose is only invoked once per registration */
        if (index >= 0) sources.splice(index, 1)
      }
    }, 'credentialSources.register()')
    return () => void dispose()
  }

  /**
   * Install a validator that runs before a source is admitted. The local
   * provider uses this to reject a source whose reference already has a
   * stored-file entry.
   * @param validate - throws to refuse the source.
   * @returns the disposer that removes this validator.
   */
  addValidator(validate: CredentialSourceValidator): () => void {
    const { validators } = this
    const dispose = this.ctx.effect(function* () {
      validators.add(validate)
      yield () => validators.delete(validate)
    }, 'credentialSources.addValidator()')
    return () => void dispose()
  }

  /**
   * Find the source that owns a reference.
   * @param ref - the reference to look up.
   * @returns the owning source, or `undefined` when none is registered.
   */
  lookup(ref: CredentialRef): CredentialSource | undefined {
    return this.sources.find(source => source.refs.includes(ref))
  }
}

export default CredentialSourceRegistry
