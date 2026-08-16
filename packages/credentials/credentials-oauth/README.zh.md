# @deepseek-ai/dsh-credentials-oauth

[English](README.md) | 中文

[凭据 seam](../credentials/README.md) 的 OAuth 凭据源。它把 token 对存进 `$DSH_HOME/.oauth-credentials.json`，在 `ctx.credentials.resolve` 时惰性刷新，并把每个 flow 的活跃 access token 暴露为一个普通 credential reference。`dsh-llm-pi-ai` 保持不动：access token 就是字符串，适配器本来就把解析出的值作为 pi-ai 的 `apiKey` 覆盖下传。

第一阶段发布 `xai` flow，来自 pi-ai 的公开 provider 定义（`xaiProvider().auth.oauth`）。`/oauth login xai` 启动 device-code 登录，立即返回验证 URL，轮询作为可中止的插件 effect 运行。

## Config

| Key | 默认 | 含义 |
|---|---|---|
| `path` | `<harness home>/.oauth-credentials.json` | Token 存储路径。以 `0600` 创建，目录 `0700`。 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 省略 `path` 时使用的 home。 |
| `providers` | `{}` | 要挂载的 flow。为空或省略时插件休眠挂载。本包未发布的 id 在加载时失败。 |
| `providers.<id>.credentialRef` | `<FLOW>_OAUTH_ACCESS` | 该 source 拥有的引用。`xai` 为 `XAI_OAUTH_ACCESS`。 |

```yaml
- id: credentials-oauth
  name: '@deepseek-ai/dsh-credentials-oauth'
  config:
    providers:
      xai:
        credentialRef: XAI_OAUTH_ACCESS
```

把 `xai` 路由指到该引用（`apiKeyEnv: XAI_OAUTH_ACCESS`）。对被拥有引用的 `set`/`unset` 会失败，并指引使用 `/oauth`。

## Commands

`/oauth login <flow>` 请求 device code，并返回验证 URL 与 user code。轮询不占用命令 handler。`/oauth status [flow]` 报告 pending、connected、failed 或 not connected。`/oauth logout <flow>` 删除存储的 token 对。登录完成和登出发出 `credentials/updated`；静默刷新不发。仅在挂载了 `ctx.commands` 时注册该命令。

## Model Experience

间接地，通过消费方 LLM 适配器：解析出的 access token 作为 bearer 授权其 provider 请求，适配器拥有每一处模型可见表面。

#### KV Cache effect

无直接失效；凭据从不进入请求前缀。

## Known Limitations and Deferred Work

- **xAI 按订阅档位门控 OAuth API 访问** — 登录可能成功而推理返回 403；api-key 路线仍是回退。
- **flow 搭乘 pi-ai 注册的 OAuth client id** — xAI 对第三方 client 的门控变化会在上游打断登录。
- **没有 headless 登录路径** — `/oauth` 需要交互式命令适配器。`dsh oauth` CLI 入口推迟。
- **未发布 `openai-codex` 与 `anthropic` 适配器** — 机制是通用的；这些 flow 属于后续变更。
