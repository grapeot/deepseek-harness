import { describe, expect, it } from 'vitest'
import {
  TavilySearchProvider,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_MAX_RESULTS,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_DEFAULT_TOPIC,
} from '@deepseek-ai/dsh-web-search-tavily'

/** Construct the provider over a fixed options value; production passes a live thunk. */
import type { TavilySearchProviderOptions } from '@deepseek-ai/dsh-web-search-tavily'

const searchProvider = (options: TavilySearchProviderOptions): TavilySearchProvider =>
  new TavilySearchProvider(() => options)

/**
 * Real-API probe for the Tavily search provider; self-skips without
 * `TAVILY_API_KEY`. A dedicated retrieval endpoint returns a deterministic
 * envelope shape, so the wire round-trip is a meaningful check here.
 */
const apiKey = process.env.TAVILY_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('TavilySearchProvider real API', () => {
  it('returns citeable sources for a live query', async () => {
    const provider = searchProvider({
      apiKey: apiKey!,
      baseURL: process.env.TAVILY_SEARCH_BASE_URL ?? TAVILY_DEFAULT_BASE_URL,
      searchDepth: TAVILY_DEFAULT_SEARCH_DEPTH,
      topic: TAVILY_DEFAULT_TOPIC,
      maxResults: TAVILY_DEFAULT_MAX_RESULTS,
      includeAnswer: true,
    })
    const result = await provider.search({ query: 'What is the DeepSeek API?', maxResults: 3 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
    expect(result.content).toBeDefined()
  }, 60_000)
})
