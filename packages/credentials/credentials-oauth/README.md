# @deepseek-ai/dsh-credentials-oauth

English | [中文](README.zh.md)

OAuth credential source for the [credential seam](../credentials/README.md). It stores token pairs in `$DSH_HOME/.oauth-credentials.json`, refreshes lazily when `ctx.credentials.resolve` runs, and exposes each flow's live access token as one ordinary credential reference. `dsh-llm-pi-ai` is unchanged: the access token is a string, and the adapter already passes the resolved value as pi-ai's `apiKey` override.

Phase 1 ships the `xai` flow from pi-ai's public provider definition (`xaiProvider().auth.oauth`). `/oauth login xai` starts device-code login, returns the verification URL immediately, and polls as an abortable plugin effect.

## Config

| Key | Default | Meaning |
|---|---|---|
| `path` | `<harness home>/.oauth-credentials.json` | Token store location. Created `0600` under a `0700` directory. |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Home used when `path` is omitted. |
| `providers` | `{}` | Flows to mount. Empty or omitted mounts the plugin dormant. An id this package does not ship fails at load. |
| `providers.<id>.credentialRef` | `<FLOW>_OAUTH_ACCESS` | Reference the source owns. For `xai` that is `XAI_OAUTH_ACCESS`. |

```yaml
- id: credentials-oauth
  name: '@deepseek-ai/dsh-credentials-oauth'
  config:
    providers:
      xai:
        credentialRef: XAI_OAUTH_ACCESS
```

Point the `xai` route at that reference (`apiKeyEnv: XAI_OAUTH_ACCESS`). `set`/`unset` on an owned reference fail and direct the caller to `/oauth`.

## Commands

`/oauth login <flow>` requests a device code and returns the verification URL and user code. Polling does not hold the command handler. `/oauth status [flow]` reports pending, connected, failed, or not connected. `/oauth logout <flow>` deletes the stored pair. Login completion and logout emit `credentials/updated`; silent refresh does not. The command registers only when `ctx.commands` is mounted.

## Model Experience

Indirectly, through the consuming LLM adapters: a resolved access token authorizes their provider requests as a bearer, and the adapter owns every model-visible surface.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **xAI tiers OAuth API access by subscription level** — login can succeed while inference returns 403; the api-key route remains the fallback.
- **The flow rides pi-ai's registered OAuth client id** — xAI gating changes against third-party clients break login upstream.
- **No headless login path** — `/oauth` needs an interactive command adapter. A `dsh oauth` CLI entry is deferred.
- **`openai-codex` and `anthropic` adapters are not shipped** — the mechanism is generic; those flows are a later change.
