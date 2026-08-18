/**
 * Built-in OAuth flows. Phase 1 ships `xai` from pi-ai's public provider
 * definition, loaded only on login and refresh so the Node-only OAuth
 * implementation stays out of idle startups.
 * @module @deepseek-ai/dsh-credentials-oauth/flows
 */

/** Flow ids this package ships. An id not in this set fails at load. */
export const BUILTIN_FLOW_IDS = ['xai'] as const

/** One built-in flow id. */
export type BuiltinFlowId = (typeof BUILTIN_FLOW_IDS)[number]

/** Token pair pi-ai's `login`/`refresh` return. `expires` is already skewed. */
export interface OAuthTokens {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
}

/** Device-code notification the command handler waits for. */
export interface DeviceCodeEvent {
  type: 'device_code'
  userCode: string
  verificationUri: string
  intervalSeconds?: number
  expiresInSeconds?: number
}

/** The subset of pi-ai's OAuth flow this package calls. */
export interface OAuthFlow {
  login(interaction: {
    signal?: AbortSignal
    prompt(prompt: unknown): Promise<string>
    notify(event: { type: string } & Record<string, unknown>): void
  }): Promise<OAuthTokens>
  refresh(credential: OAuthTokens, signal?: AbortSignal): Promise<OAuthTokens>
  toAuth(credential: OAuthTokens): Promise<{ apiKey?: string }>
}

/**
 * Whether `id` is a flow this package ships.
 * @param id - candidate flow id from plugin config.
 * @returns true when `id` is a {@link BuiltinFlowId}.
 */
export function isBuiltinFlowId(id: string): id is BuiltinFlowId {
  return (BUILTIN_FLOW_IDS as readonly string[]).includes(id)
}

/**
 * Load one shipped flow. Unknown ids throw — misconfiguration fails loud.
 * @param id - a {@link BuiltinFlowId}.
 * @returns the pi-ai flow object.
 */
export async function loadBuiltInFlow(id: string): Promise<OAuthFlow> {
  if (id === 'xai') {
    const { xaiProvider } = await import('@earendil-works/pi-ai/providers/xai')
    const oauth = xaiProvider().auth.oauth
    /* v8 ignore next -- the shipped xai provider always declares oauth */
    if (oauth === undefined) {
      throw new Error('credentials-oauth: the installed xai provider has no oauth flow')
    }
    return oauth
  }
  throw new Error(`credentials-oauth: unknown flow "${id}"`)
}

/**
 * Default credential reference for one flow: `<FLOW>_OAUTH_ACCESS` with
 * hyphens folded to underscores.
 * @param flowId - the flow id.
 * @returns the conventional reference name.
 */
export function defaultCredentialRef(flowId: string): string {
  return `${flowId.toUpperCase().replaceAll('-', '_')}_OAUTH_ACCESS`
}
