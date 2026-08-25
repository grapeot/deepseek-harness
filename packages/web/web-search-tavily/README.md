# @deepseek-ai/dsh-web-search-tavily

English | [中文](README.zh.md)

A [Tavily](https://tavily.com)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Tavily's `POST /search` retrieval endpoint — a dedicated search API, not a model call, so one search costs retrieval units only — and maps the flat `results[]` into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-web-search-deepseek`, it is a function/namespace plugin (`inject: ['web']`) whose API key is resolved per search through the optional `ctx.credentials` seam; without one, it falls back to the launching process environment.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal Tavily API key; prefer `apiKeyEnv` so no secret enters configuration files. A non-empty literal wins. |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, or from the process environment when that seam is absent. A missing value fails the call as `WEB_PROVIDER_CREDENTIAL_MISSING`. |
| `baseURL` | `https://api.tavily.com` | Endpoint base; `/search` is appended. Falls back to `$TAVILY_SEARCH_BASE_URL`. An unparseable value makes the provider unavailable. |
| `searchDepth` | `advanced` | Search depth sent as Tavily's `search_depth`: `basic`, `advanced`, `fast`, or `ultra-fast`. |
| `topic` | `general` | Topic filter sent as Tavily's `topic`: `general`, `news`, or `finance`. |
| `maxResults` | `6` | Default result count when a request carries no `maxResults`. Must be a positive integer. |
| `includeAnswer` | `false` | Request Tavily's generated answer and map it to the seam's optional `content`. |

```yaml
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

## Mapping

Each Tavily result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← `content`, `publishedAt` ← `published_date`. A result with an empty or absent `content` is kept (unlike the Exa adapter's drop rule): Tavily's `content` is the crawler's page excerpt and may legitimately be empty while the URL still cites. `score` and `raw_content` have no seam counterpart and are dropped; `include_raw_content: false` is sent so the payload never carries them. With `includeAnswer` a non-blank `answer` maps to `content` (the Perplexity adapter's answer semantics); `content` is omitted otherwise. A request's `maxResults` wins over the configured default and is sent as Tavily's `max_results` for a cost/latency optimization; the final bound is enforced by the seam. Provider failures (HTTP errors, network failure, unparseable or wrong-shape bodies) surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`; a missing credential surfaces as `WEB_PROVIDER_CREDENTIAL_MISSING`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, excerpts, and (when `includeAnswer`) the generated answer or its exact `Tavily search aborted`, `Tavily search request failed: <error>`, and `Tavily returned an unprocessable response body: <error>` failures under the consumer's error wrapper while provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Only `searchDepth`/`topic`/`maxResults`/`includeAnswer` are exposed** — Tavily's per-request controls (time range, date bounds, domain filters, country boost, image results) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)); deployments needing them today use the Tavily-backed CLI skill or MCP server outside this seam.
- **Tavily's extract capability is out of scope** — a `web_extract` operation is deferred seam work, not a fetch-provider widening ([seam README](../web/README.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
