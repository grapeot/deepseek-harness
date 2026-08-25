/**
 * Provider-private wire types for Tavily's Search API (`POST /search`). These types
 * carry only the fields this provider reads; the wire envelope accepts more.
 * @module @deepseek-ai/dsh-web-search-tavily/types
 */

/** One entry of Tavily's `results[]`: a citeable search result. */
export interface TavilyResult {
  readonly url: string
  readonly title?: string | null
  /** Page-extracted snippet; mapped to the seam's `snippet`. */
  readonly content?: string | null
  /** Relevance score in [0, 1]; the seam has no counterpart, so it is dropped. */
  readonly score?: number | null
  /** Full page content; dropped (the seam's snippet is the portable excerpt). */
  readonly raw_content?: string | null
  /** Publication timestamp as a provider-supplied ISO-8601 string. */
  readonly published_date?: string | null
}

/** Tavily's `POST /search` response envelope. */
export interface TavilySearchResponse {
  /** Generated answer when `include_answer` was requested; otherwise absent. */
  readonly answer?: string | null
  readonly results?: readonly TavilyResult[]
  /** Milliseconds the provider took; not portable, dropped. */
  readonly response_time?: number | null
}

/** Tavily's error response envelope (best-effort; fields vary). */
export interface TavilyError {
  readonly detail?: string | null
  readonly message?: string | null
}
