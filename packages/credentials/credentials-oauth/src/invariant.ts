/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-credentials-oauth`.
 * @module @deepseek-ai/dsh-credentials-oauth/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-credentials-oauth'

/** Cordis companion plugin name. */
export const name = 'credentials-oauth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the Service Definition companion owns the
 * `credentials/updated` lifecycle contract; this plugin's store and login
 * sequencing is asynchronous I/O pinned by its unit suite.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
