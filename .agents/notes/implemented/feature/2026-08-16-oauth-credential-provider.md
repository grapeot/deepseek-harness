# Agent Note: OAuth credential provider

Status: implemented

English | [中文](2026-08-16-oauth-credential-provider.zh.md)

## Problem

A SuperGrok or X Premium+ subscription can back Grok API access through xAI's OAuth device-code flow: log in at `auth.x.ai`, then send the access token as a bearer to `https://api.x.ai/v1`, drawing from the subscription's weekly usage pool instead of api.x.ai billing. Warp and Hermes Agent already ship this path. The harness could not reach it: `dsh-llm-pi-ai` resolves authentication exclusively through the credential seam as an api-key string, and its catalog layer deliberately withholds OAuth-only providers because the adapter runs no login flow and holds no OAuth credential store — a decision the [withheld-providers note](../bug-fix/2026-08-13-oauth-only-providers-withheld.md) recorded with OAuth support explicitly deferred. The underlying `@earendil-works/pi-ai` already ships the complete xAI flow — device-code login, refresh handling including xAI's non-rotating refresh tokens, and a `toAuth` that returns `{ apiKey: accessToken }` — behind its public provider definition.

The missing pieces were harness-side only: a login entry point, token storage, refresh before expiry, and per-request injection. This change is that deferred work; it extends, and on the `xai` fraction partially supersedes, the withheld-providers decision, and extends the credential-seam boundaries the [credential boundaries note](../architecture/2026-07-30-credential-boundaries-and-atomic-registration.md) records.

## Decision

`@deepseek-ai/dsh-credentials-oauth` (`packages/credentials/credentials-oauth`) is an OAuth credential source that mounts into the credential seam, stores tokens in its own file, refreshes lazily at resolve time, and exposes the live access token as one ordinary credential reference per flow. `dsh-llm-pi-ai` stays unchanged: an OAuth access token is a string, the adapter already passes the resolved credential as pi-ai's highest-priority `apiKey` override, and xAI's `toAuth` shape confirms the endpoint accepts that token as the bearer.

The load-bearing fact is the seam's existing per-operation resolution contract ([credentials README](../../../../packages/credentials/credentials/README.md)): consumers re-resolve `ctx.credentials.resolve(ref)` at each operation, so a token rotated by lazy refresh reaches the next model request with no restart and no timer. The user story: run `/oauth login xai` once, approve in the browser, configure the `xai` route with `apiKeyEnv: XAI_OAUTH_ACCESS`, and Grok requests draw from the subscription.

### Credential source registry

Same-name Cordis services hold one active instance, so a second `CredentialProvider` would shadow `dsh-credentials-local` rather than compose with it. The credential Service Definition package therefore has a `CredentialSource` interface and a registry service `ctx.credentialSources.register(source)` (disposer-returning, per the registration-as-effect convention); `dsh-credentials-local` starts the registry if it is absent and folds mounted sources into its layer pipeline between the inherited environment and the managed file. A dynamic source answers `resolve` and `describe` only; precedence is env > dynamic sources > file > project-env > user-env, keeping the launching environment as per-run operator override and never letting a stale stored entry shadow rotating tokens.

Two loud rules mirror existing semantics: `set`/`unset` reject for a reference a dynamic source owns (the write would be shadowed — the same rejection the env layer already applies), with directions to use `/oauth`; and a stored-file entry for a source-owned reference fails at registration or reload instead of silently losing. Two sources claiming one reference reject at registration.

### Token store and lazy refresh

The plugin owns `$DSH_HOME/.oauth-credentials.json` (Config `path` override): `{ version: 1, flows: { xai: { access, refresh, expiresAt, obtainedAt } } }`, written atomically (temp file, rename, mode 0600). `expiresAt` is the provider-reported expiry minus a refresh margin (pi-ai already applies five minutes). `resolve` returns the stored access token while unexpired; otherwise it runs a single-flight refresh — concurrent resolves share one in-flight promise — persists the new pair before returning, and only then answers. Persist failure fails the request rather than risking a rotated refresh token that the store never learned. A refresh the provider rejects throws with directions to re-run `/oauth login`; `resolve` returns `undefined` only for never-logged-in flows, so existing `MISSING_CREDENTIAL` semantics hold. No background timer exists: idle periods simply skip refreshes, and laptop sleep is handled because expiry is re-checked on every resolve.

### Login, status, logout commands

The plugin registers the `/oauth` command through `ctx.commands` when that service is mounted ([commands README](../../../../packages/interaction/commands/README.md)). `/oauth login xai` requests a device code (one POST), starts polling as a plugin-owned abortable task, and immediately returns the verification URL and user code — the poll does not hold the command handler for its whole window. `/oauth status` reports per-flow state (pending with remaining validity, connected with expiry, or last failure); `/oauth logout xai` drops the stored record. Login completion and logout fire `credentials/updated`; silent refreshes do not, because configured-ness never changed and consumers never cache values across operations. The flow itself comes from pi-ai's public provider definition (`xaiProvider().auth.oauth`: `login`, `refresh`, `toAuth`), lazily imported so the Node-only OAuth code loads only on login and refresh.

### Config

```yaml
- id: credentials-oauth
  name: '@deepseek-ai/dsh-credentials-oauth'
  config:
    path: /custom/oauth-store.json   # default $DSH_HOME/.oauth-credentials.json
    providers:
      xai:
        credentialRef: XAI_OAUTH_ACCESS   # default <FLOW>_OAUTH_ACCESS
```

A flow mounts exactly when it appears under `providers`; an id the package does not ship fails at load (misconfiguration fails loud). Empty or omitted `providers` mounts the plugin dormant with zero sources, mirroring `dsh-llm-pi-ai`'s dormant pattern. The shipped base bundle mounts `xai`. `openai-codex` and `anthropic` adapters are not shipped — the mechanism is generic, and the codex case is already serviceable because a route a settings document names keeps its directory entry and `apiKeyEnv` authenticates it with the token this plugin supplies.

### Security

Tokens live only in the 0600 store; they never enter session events, telemetry, or Client-visible data, and `describe` reports `{ configured, source: 'oauth', writable: false }` with no value. The login task and any in-flight refresh are abortable plugin effects, so plugin unload stops them.

## Alternatives considered

### Why not a token-keeper plugin with a refresh timer?

A keeper that logs in and rewrites the access token into `.credentials.yaml` needs no seam change, but refresh becomes timer-driven: a lifecycle to own, writes proportional to wall-clock rather than use, staleness after sleep, and auto-managed entries polluting the user-owned credentials document while `set`/`unset` semantics fight the manager. The per-operation resolution contract already delivers everything OAuth needs; lazy resolve is strictly simpler.

### Why not OAuth inside dsh-llm-pi-ai?

Giving the adapter a credential store and login flow duplicates the credential seam inside one LLM adapter, and every other consumer of OAuth-shaped auth (future providers, other capabilities) would re-implement it. The seam exists precisely so authentication resolves once, harness-wide.

### Why not vendor the xAI flow?

The flow's client id, scope set, and quirks (xAI may omit `refresh_token` on refresh) are maintained upstream against a live endpoint. Public pi-ai exports reach the same flow objects lazily; forking the code buys a dependency boundary at the cost of tracking xAI's OAuth behavior by hand.

### Why not replace the single provider service with a multi-provider router?

No second full `CredentialProvider` exists to route between; the source registry covers dynamic sources with less churn. Revisit if a genuinely independent provider (not a resolvable source) appears.

## Consequences

- **xAI tiers OAuth API access by subscription level.** Login can succeed while inference returns 403 for standard SuperGrok tiers (observed on Hermes Agent issue #26847). Not fixable harness-side; the request error surfaces verbatim, and the api-key route remains the fallback.
- **The flow rides pi-ai's registered OAuth client id.** xAI gating changes against third-party clients break login upstream; our own client registration is the mitigation and is deferred until observed necessary.
- **Long-idle refresh-token expiry fails the next request** with re-login directions — loud by design, but a session that idles past the provider's refresh lifetime loses single-sign-on continuity.
- **Clock jumps backward** could reuse a token past its true expiry; the five-minute margin covers small jumps, and provider 401s surface as request failures.
- **No headless login path**: the command plane needs an interactive adapter. A `dsh oauth` CLI entry is deferred alongside the Web settings surface.

## Testing

Package tests cover `/oauth login xai` against a fake flow (verification URL and code, completion, status, pending, failure), single-flight refresh that persists before returning, rejected refresh with re-login directions, `set`/`unset` on an owned reference, and a file-layer conflict at source registration. `loadBuiltInFlow('xai')` loads the real pi-ai object. Manual SuperGrok login and one live Grok completion remain a PR-recorded check, not a keyless gate.
