# Agent Note: Tavily search provider — a dedicated retrieval route for the web seam

Status: implemented

English | [中文](2026-08-14-web-search-tavily.zh.md)

## Problem

The web capability seam (`ctx.web`) had three search providers, all of which reach the web through model-shaped backends: Exa and Perplexity are retrieval endpoints, but the only keyless-default route the shipped bundles mount is DeepSeek's, which issues a full Anthropic-compatible Messages model call per search. A deployment that searches often pays a model turn each time, and a deployment holding a Tavily key had no way to use it inside the seam at all — the Tavily-backed CLI skill and MCP servers live outside `ctx.web`, so `web_search` could not reach them.

## Decision

Add `@deepseek-ai/dsh-web-search-tavily`, a `WebSearchProvider` backed by Tavily's dedicated `POST /search` retrieval endpoint, mounted by the base bundle as an optional row (`web-search-tavily`, default credential reference `TAVILY_API_KEY`) without changing the default `searchProvider`. A deployment selects it with one `web` row override.

The provider follows the `web-search-deepseek` structure (credential resolution per search through the optional `ctx.credentials` seam, falling back to the launching environment; options snapshotted once per operation so a config write landing inside credential resolution cannot mix sections) minus the DeepSeek-specific surfaces: no settings section (a deployment pins Tavily in `cordis.yml`, not the Models page) and no auxiliary-request session event (there is no model request to disclose).

Two mapping decisions differ from the Exa adapter deliberately. First, a result with an empty or absent `content` excerpt is KEPT rather than dropped: Tavily's `content` is the crawler's page extract and may legitimately be empty while the URL still cites, whereas an Exa highlight is the only portable snippet field and its absence leaves nothing to map. Second, `score` and `raw_content` are dropped and the request pins `include_raw_content: false` — the seam has no counterpart field and the payload should not carry bytes the adapter throws away. `includeAnswer` (default off) maps a requested generated answer to the seam's optional `content` with Perplexity-answer semantics. Everything else is the provider contract verbatim: `redirect: 'error'` with real-HTTP regression coverage proving the `Location` target is never contacted (the web-group policy), `WEB_PROVIDER_ERROR`/`WEB_ABORTED`/`WEB_PROVIDER_CREDENTIAL_MISSING` taxonomy, and the seam owning final `maxResults` truncation.

Tavily's per-request controls (time range, date bounds, domain filters, country boost, images) stay out: the seam's request vocabulary is `query` + `maxResults` until provider-neutral fields exist ([seam deferred work](../architecture/2026-06-24-web-capability-seam.md)). Deployments needing those controls today keep using the Tavily CLI skill or an MCP server outside the seam.

## Consequences

`dsh-tool-web` needs no change: the provider registers into `ctx.web` and the model-facing schema was already provider-neutral. The provider's `available()` is a credential-and-config check, so a deployment without `TAVILY_API_KEY` sees the row mount and the provider simply never auto-selects. With both DeepSeek and Tavily rows mounted, auto-selection would be ambiguous — selecting Tavily requires the explicit `web` row override (exactly how the deploying profile in this fork pins it).

The e2e probe self-skips without `TAVILY_API_KEY`, matching the repo's keyless-CI policy; unlike the DeepSeek probe it is a live assertion rather than `it.skip`, because a dedicated retrieval endpoint returns a deterministic envelope the model-call route cannot promise.

## Alternatives considered

- **An MCP bridge to Tavily's server** (`dsh-mcp-client` config) is zero code but lands tools outside the seam: no provider selection, no `WebError` taxonomy, MCP-qualified names in the model catalog, and no KV-stable schema story across search backends. It remains the right answer for extract/map workflows this seam does not own.
- **Widening `WebSearchRequest` with recency/domain fields** was scoped and deferred: both controls need coordinated `dsh-web`/`dsh-tool-web`/three-provider changes and a defensible provider-neutral contract — worth doing as upstream work when usage evidence exists, not as a private fork's first delta.
