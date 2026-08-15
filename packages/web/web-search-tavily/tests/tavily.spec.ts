import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import { TavilySearchProvider, TAVILY_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-tavily'
import * as tavilyPlugin from '@deepseek-ai/dsh-web-search-tavily'
import { mapTavilyResponse, mapTavilyResult } from '../src/provider.ts'
import type { TavilySearchProviderOptions } from '@deepseek-ai/dsh-web-search-tavily'
import type { TavilySearchResponse } from '@deepseek-ai/dsh-web-search-tavily/src/types.ts'

/** Construct the provider over a fixed options value; production passes a live thunk. */
const searchProvider = (options: TavilySearchProviderOptions): TavilySearchProvider =>
  new TavilySearchProvider(() => options)

const options: TavilySearchProviderOptions = {
  apiKey: 'tvly-key',
  baseURL: 'https://api.tavily.test',
  searchDepth: 'advanced',
  topic: 'general',
  maxResults: 6,
  includeAnswer: false,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** A minimal well-formed search response with two results. */
function searchResponse(): TavilySearchResponse {
  return {
    answer: 'Tavily says this.',
    results: [
      { url: 'https://a.test', title: 'A', content: 'excerpt for A', score: 0.9, published_date: '2026-02-02T00:00:00Z' },
      { url: 'https://b.test', title: 'B', content: 'excerpt for B' },
    ],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mapTavilyResult', () => {
  it('maps content to snippet and published_date to publishedAt', () => {
    expect(mapTavilyResult({ url: 'https://a.test', title: 'A', content: 'excerpt', published_date: '2026-02-02' }))
      .toEqual({ url: 'https://a.test', title: 'A', snippet: 'excerpt', publishedAt: '2026-02-02' })
  })

  it('keeps an entry whose content excerpt is empty (url alone still cites)', () => {
    expect(mapTavilyResult({ url: 'https://a.test', content: '' })).toEqual({ url: 'https://a.test' })
    expect(mapTavilyResult({ url: 'https://b.test' })).toEqual({ url: 'https://b.test' })
  })

  it('drops blank title and score/raw_content never reach the seam', () => {
    const source = mapTavilyResult({ url: 'https://a.test', title: '', content: 'excerpt', score: 1, raw_content: 'full page' })
    expect(source).toEqual({ url: 'https://a.test', snippet: 'excerpt' })
  })
})

describe('mapTavilyResponse', () => {
  it('maps answer to content and every result to a source', () => {
    expect(mapTavilyResponse(searchResponse())).toEqual({
      content: 'Tavily says this.',
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'excerpt for A', publishedAt: '2026-02-02T00:00:00Z' },
        { url: 'https://b.test', title: 'B', snippet: 'excerpt for B' },
      ],
      truncated: false,
    })
  })

  it('omits content when the answer is absent or blank', () => {
    expect(mapTavilyResponse({ answer: null, results: [] })).toEqual({ sources: [], truncated: false })
    expect(mapTavilyResponse({ answer: '', results: [] })).toEqual({ sources: [], truncated: false })
    expect(mapTavilyResponse({ results: [{ url: 'https://a.test' }] })).toEqual({
      sources: [{ url: 'https://a.test' }],
      truncated: false,
    })
  })

  it('tolerates a missing results array', () => {
    expect(mapTavilyResponse({})).toEqual({ sources: [], truncated: false })
  })
})

/**
 * The fixture options minus every key source, with optional overrides.
 * `exactOptionalPropertyTypes` forbids expressing the removal as `apiKey: undefined`.
 */
const keylessOptions = (overrides: Partial<TavilySearchProviderOptions> = {}): TavilySearchProviderOptions => {
  const { apiKey: _apiKey, resolveApiKey: _resolve, ...rest } = { ...options, ...overrides }
  return rest
}

describe('TavilySearchProvider.search', () => {
  it('sends the configured defaults in the wire body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider(options).search({ query: 'q' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.tavily.test/search')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tvly-key')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'q',
      search_depth: 'advanced',
      topic: 'general',
      max_results: 6,
      include_answer: false,
      include_raw_content: false,
    })
  })

  it('applies a request maxResults over the configured default', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider(options).search({ query: 'q', maxResults: 2 })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ max_results: 2 })
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'Invalid API key' }, { status: 401 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'Invalid API key' })
  })

  it('keeps the status-line message when the error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 429 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 429)' })
  })

  it('keeps the status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 502)' })
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('maps a DOMException that is not an AbortError to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError') }))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('maps an abort to WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(searchProvider(options).search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('maps a fetch-time abort to WEB_ABORTED, not WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal !== undefined) {
        return await new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      }
      return jsonResponse(searchResponse())
    }))
    const controller = new AbortController()
    const pending = searchProvider(options).search({ query: 'q' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('maps an abort raised while fetch is in flight to WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }),
    ))
    const pending = searchProvider(options).search({ query: 'q' }, controller.signal)
    // Let the credential resolve and fetch start before aborting, so the abort
    // surfaces from the fetch catch rather than the pre-dispatch check.
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      return new Response('Bad Gateway', { status: 502 })
    }))
    await expect(searchProvider(options).search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      return new Response('not json', { status: 200 })
    }))
    await expect(searchProvider(options).search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('reports an actionable credential error when no key resolves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(searchResponse())))
    await expect(searchProvider(keylessOptions()).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
  })
})

describe('TavilySearchProvider.available', () => {
  it('is usable with a literal key and a parseable base URL', () => {
    expect(searchProvider(options).available()).toBe(true)
  })

  it('is usable with only a credential resolver', () => {
    expect(searchProvider({ ...keylessOptions(), resolveApiKey: async () => 'k' }).available()).toBe(true)
  })

  it('is unusable without any key source', () => {
    expect(searchProvider(keylessOptions()).available()).toBe(false)
  })

  it('is unusable with an unparseable base URL', () => {
    expect(searchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is unusable with a non-positive default maxResults', () => {
    expect(searchProvider({ ...options, maxResults: 0 }).available()).toBe(false)
  })
})

describe('web-search-tavily plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(searchResponse())))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tvly-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('rejects maxResults: 0 at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    await expect(ctx.plugin(tavilyPlugin, { apiKey: 'tvly-key', maxResults: 0 }))
      .rejects.toThrow(/maxResults expected number >= 1/)
  })

  it('rejects an unknown searchDepth at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    // The literal is deliberately outside the schema's union; schemastery must reject it.
    const invalid = { apiKey: 'tvly-key', searchDepth: 'deep' } as Readonly<{ apiKey: string; searchDepth: never }>
    await expect(ctx.plugin(tavilyPlugin, invalid))
      .rejects.toThrow(/searchDepth expected "basic"/)
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in tavilyPlugin).toBe(false)
  })

  it('survives the real Loader unwrapExports path keeping name/inject/Config', () => {
    // A default export would make `unwrapExports` collapse the namespace and drop `inject: ['web']`.
    // Drive the real Loader path because hand-built namespace mounting cannot expose that failure.
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tavilyPlugin) as Record<string, unknown>
    expect(unwrapped).toBe(tavilyPlugin)
    expect(unwrapped.name).toBe('web-search-tavily')
    expect(unwrapped.inject).toEqual(['web'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.web through the unwrapped module without an inject error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(searchResponse())))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tavilyPlugin) as Parameters<Context['plugin']>[0]
    // A collapsed export shape (dropped inject) would throw "without inject" here.
    const fiber = await ctx.plugin(unwrapped, { apiKey: 'tvly-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
  })

  it('falls back to the env key and endpoint defaults when config omits them', async () => {
    const prev = process.env.TAVILY_API_KEY
    const prevBase = process.env.TAVILY_SEARCH_BASE_URL
    process.env.TAVILY_API_KEY = 'env-key'
    process.env.TAVILY_SEARCH_BASE_URL = 'https://api.tavily.env.test'
    try {
      const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      tavilyPlugin.apply(ctx, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.tavily.env.test/search')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer env-key')
      expect(JSON.parse(init.body as string)).toMatchObject({ search_depth: 'advanced', topic: 'general' })
      await ctx.fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = prev
      if (prevBase === undefined) delete process.env.TAVILY_SEARCH_BASE_URL
      else process.env.TAVILY_SEARCH_BASE_URL = prevBase
    }
  })

  it('reports an actionable credential error when neither config nor env supplies a key', async () => {
    const prev = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      // No credentials service is mounted, so the ambient environment is the
      // whole credential plane and the absent env var short-circuits.
      tavilyPlugin.apply(ctx, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
      await ctx.fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = prev
    }
  })

  it('resolves the credential for each search so a stored or rotated key needs no restart', async () => {
    const previous = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-tavily-credentials-'))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(tavilyPlugin, { baseURL: 'https://api.tavily.test' })

      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

      const ref = credentialRef('TAVILY_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'rotated' })

      const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value.authorization)).toEqual(['Bearer stored-key', 'Bearer rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = previous
    }
  })
})
