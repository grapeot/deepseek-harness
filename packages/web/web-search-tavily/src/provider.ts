/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by Tavily's Search API
 * (`POST /search`). It maps `results[].content` to `snippet`, `published_date` to
 * `publishedAt`, keeps URL-bearing entries regardless of snippet presence (Tavily
 * content is the page excerpt, which may legitimately be empty), and maps a
 * requested `answer` to the seam's `content`.
 * @module @deepseek-ai/dsh-web-search-tavily/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { TavilyError, TavilyResult, TavilySearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily Search endpoint; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Default search depth: Tavily's advanced tier. */
export const TAVILY_DEFAULT_SEARCH_DEPTH = 'advanced'

/** Default topic filter: general web search. */
export const TAVILY_DEFAULT_TOPIC = 'general'

/** Default result count requested when neither request nor config names one. */
export const TAVILY_DEFAULT_MAX_RESULTS = 6

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Tavily's `search_depth` values, as sent on the wire. */
export type TavilySearchDepth = 'basic' | 'advanced' | 'fast' | 'ultra-fast'

/** Tavily's `topic` values, as sent on the wire. */
export type TavilyTopic = 'general' | 'news' | 'finance'

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface TavilySearchProviderOptions {
  /** Literal Tavily API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Tavily API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Search depth sent as Tavily's `search_depth`. */
  searchDepth: TavilySearchDepth
  /** Topic filter sent as Tavily's `topic`. */
  topic: TavilyTopic
  /** Default result count when a request carries no `maxResults`. */
  maxResults: number
  /** Request Tavily's generated answer and map it to the seam's `content`. */
  includeAnswer: boolean
}

/** True when the value is a positive integer. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1
}

/**
 * True when the value names an absolute URL the provider can append `/search`
 * to (a cheap local config check).
 */
function isValidBaseUrl(value: string): boolean {
  return URL.canParse(value)
}

/**
 * Map one Tavily result to a normalized source. Unlike the Exa adapter, an
 * entry without `content` is KEPT: Tavily's `content` is the page excerpt the
 * crawler extracted and may legitimately be empty, while `url` alone still
 * cites; inventing a snippet would lie, dropping the entry would hide a source
 * the provider ranked.
 *
 * @param result - one entry of Tavily's `results[]`.
 * @returns the normalized source.
 */
export function mapTavilyResult(result: TavilyResult): WebSearchSource {
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.content != null && result.content.length > 0 ? { snippet: result.content } : {},
    ...result.published_date != null && result.published_date.length > 0
      ? { publishedAt: result.published_date }
      : {},
  }
}

/**
 * Map a Tavily response envelope to a normalized search result. `answer`
 * becomes the seam's `content` only when non-blank; the web service owns the
 * final `maxResults` truncation, so `truncated` is always `false` here.
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result.
 */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  const sources = (response.results ?? []).map(mapTavilyResult)
  const answer = response.answer != null && response.answer.length > 0 ? response.answer : undefined
  return {
    ...answer !== undefined ? { content: answer } : {},
    sources,
    truncated: false,
  }
}

/** Throw the provider's stable cancellation error for the given cause. */
function searchAborted(cause?: unknown): WebError {
  return new WebError('Tavily search aborted', 'WEB_ABORTED', cause !== undefined ? { cause } : {})
}

/** True when the error is a DOMException abort from `fetch`/`AbortController`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted()
}

/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections. A
   * thunk rather than a value because the plugin's configuration can change
   * between searches, and re-registering the provider to carry a new endpoint
   * would make the seam's selection observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => TavilySearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && isValidBaseUrl(options.baseURL)
      && isPositiveInteger(options.maxResults)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // configuration write landing inside that await must not send the key
    // resolved from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options)
    throwIfSearchAborted(signal)
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          search_depth: options.searchDepth,
          topic: options.topic,
          max_results: request.maxResults ?? options.maxResults,
          include_answer: options.includeAnswer,
          // The seam's snippet is the portable excerpt; requesting raw page
          // content would inflate the payload for a field this provider drops.
          include_raw_content: false,
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(error)
      throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Tavily API error (HTTP ${status})`
      try {
        const parsed = await response.json() as TavilyError
        const detail = parsed.detail ?? parsed.message
        if (detail != null && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(error)
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as TavilySearchResponse
      return mapTavilyResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(error)
      if (error instanceof WebError) throw error
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @returns the resolved key.
   */
  private async apiKey(options: TavilySearchProviderOptions): Promise<string> {
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    const resolved = await options.resolveApiKey?.()
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'TAVILY_API_KEY'
    throw new WebError(
      `Tavily search has no API key for "${ref}"; store it through the credentials service`
      + ' (the web Models page writes it), export it in the launching environment, or set a literal'
      + ' "apiKey" in the web-search-tavily config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}
