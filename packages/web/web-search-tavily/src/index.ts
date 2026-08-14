/**
 * Register a Tavily-backed provider in `ctx.web`. It calls Tavily's Search API
 * (`POST /search`) — a dedicated retrieval endpoint, not a model call, so one
 * search costs retrieval units only. The API key is resolved per search through
 * the credentials seam (`TAVILY_API_KEY` by default).
 * @module @deepseek-ai/dsh-web-search-tavily
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-web'
import {
  TavilySearchProvider,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_DEFAULT_TOPIC,
} from './provider.ts'
import type { TavilySearchProviderOptions, TavilySearchDepth, TavilyTopic } from './provider.ts'

export {
  TavilySearchProvider,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_DEFAULT_TOPIC,
  TAVILY_PROVIDER_ID,
} from './provider.ts'
export type { TavilySearchDepth, TavilySearchProviderOptions, TavilyTopic } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/**
 * Environment variable naming this provider's endpoint. Distinct from any
 * Tavily SDK default so a deployment pins its endpoint without touching the
 * ambient environment other Tavily consumers read.
 */
const SEARCH_BASE_URL_ENV = 'TAVILY_SEARCH_BASE_URL'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Tavily API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search; defaults to `TAVILY_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/search` is appended. Falls back to `$TAVILY_SEARCH_BASE_URL`. */
  baseURL?: string
  /** Search depth sent as Tavily's `search_depth`. Defaults to `advanced`. */
  searchDepth?: TavilySearchDepth
  /** Topic filter sent as Tavily's `topic`. Defaults to `general`. */
  topic?: TavilyTopic
  /** Default result count when a request carries no `maxResults`. Defaults to 6. */
  maxResults?: number
  /** Request Tavily's generated answer; maps to the seam's optional `content`. Defaults to false. */
  includeAnswer?: boolean
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  searchDepth: z.union(['basic', 'advanced', 'fast', 'ultra-fast'] as const),
  topic: z.union(['general', 'news', 'finance'] as const),
  maxResults: z.number().step(1).min(1),
  includeAnswer: z.boolean(),
})

/** Register the Tavily search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  ctx.web.registerSearchProvider(new TavilySearchProvider(() => ({
    ...config.apiKey !== undefined && config.apiKey.length > 0 ? { apiKey: config.apiKey } : {},
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value
      ?? TAVILY_DEFAULT_BASE_URL,
    searchDepth: config.searchDepth ?? TAVILY_DEFAULT_SEARCH_DEPTH,
    topic: config.topic ?? TAVILY_DEFAULT_TOPIC,
    maxResults: config.maxResults ?? TAVILY_DEFAULT_MAX_RESULTS,
    includeAnswer: config.includeAnswer ?? false,
  } satisfies TavilySearchProviderOptions)))
}
