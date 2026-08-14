# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

基于 [Tavily](https://tavily.com) 的 `WebSearchProvider`，注册进 harness 的 [web 能力缝](../web/README.md)（`ctx.web`）。它调用 Tavily 的 `POST /search` 检索端点——专用搜索 API 而非模型调用，一次搜索只消耗检索额度——并把扁平的 `results[]` 映射为缝的规范化 `WebSearchResult`。

这是一个**实现**包：它向 `ctx.web` 注册 provider，不拥有 `ctx.web` 键，也不注册面向模型的工具（那是 `@deepseek-ai/dsh-tool-web` 的职责）。与 `@deepseek-ai/dsh-web-search-deepseek` 一样，它是 function/namespace 插件（`inject: ['web']`），API key 按次搜索经可选的 `ctx.credentials` 缝解析；无该缝时回退到启动进程环境。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面 Tavily API key；优先用 `apiKeyEnv`，避免密钥进入配置文件。非空字面值优先。 |
| `apiKeyEnv` | `TAVILY_API_KEY` | 每次搜索经 `ctx.credentials` 解析的凭证引用；无该缝时取进程环境。缺失时调用以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。 |
| `baseURL` | `https://api.tavily.com` | 端点基址；追加 `/search`。回退到 `$TAVILY_SEARCH_BASE_URL`。无法解析的值使 provider 不可用。 |
| `searchDepth` | `advanced` | 作为 Tavily `search_depth` 发送的搜索深度：`basic`、`advanced`、`fast`、`ultra-fast`。 |
| `topic` | `general` | 作为 Tavily `topic` 发送的主题过滤：`general`、`news`、`finance`。 |
| `maxResults` | `6` | 请求未带 `maxResults` 时的默认结果数。必须是正整数。 |
| `includeAnswer` | `false` | 请求 Tavily 生成答案并映射为缝的可选 `content`。 |

```yaml
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

## 映射

每条 Tavily 结果映射为一个 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← `content`、`publishedAt` ← `published_date`。`content` 为空或缺失的结果会保留（与 Exa 适配器的丢弃规则不同）：Tavily 的 `content` 是爬虫提取的页面摘录，合法地为空，而 URL 本身仍是可引用来源。`score` 与 `raw_content` 在缝中没有对应字段，直接丢弃；请求固定携带 `include_raw_content: false`，payload 从不携带它们。开启 `includeAnswer` 时非空 `answer` 映射为 `content`（与 Perplexity 适配器的答案语义一致）；否则省略 `content`。请求的 `maxResults` 优先于配置默认值，并作为 Tavily 的 `max_results` 发送以优化成本/延迟；最终上界由缝执行。provider 失败（HTTP 错误、网络失败、无法解析或形状错误的响应体）以 `WebError` `WEB_PROVIDER_ERROR` 暴露；中止的请求以 `WEB_ABORTED` 暴露；凭证缺失以 `WEB_PROVIDER_CREDENTIAL_MISSING` 暴露。HTTP 重定向在接触 `Location` 目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 暴露。

## 模型体验

间接，经由 [`dsh-tool-web`](../tool-web/README.md)：该消费方保留本 provider 按 `maxResults` 截断的 URL、标题、摘录与（开启 `includeAnswer` 时的）生成答案，或其确切的 `Tavily search aborted`、`Tavily search request failed: <error>`、`Tavily returned an unprocessable response body: <error>` 失败（包在消费方的错误包装下），provider 私有字段不进入上下文。

#### KV Cache 影响

无直接失效；具名消费方拥有任何请求前缀变化。

## 已知限制与延期工作

- **只暴露 `searchDepth`/`topic`/`maxResults`/`includeAnswer`** — Tavily 的按请求控制（时间范围、日期边界、域名过滤、国家加权、图片结果）等待 provider 中立的 Service Definition 字段（[缝 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)）；今天需要它们的部署在本缝之外使用 Tavily CLI skill 或 MCP server。
- **Tavily 的 extract 能力不在范围内** — `web_extract` 操作是缝的延期工作，不是 fetch provider 的加宽（[缝 README](../web/README.md)）。
- **中止分类基于错误形状** — 只有名为 `AbortError` 的 `DOMException` 映射为 `WEB_ABORTED`；携带自定义 reason 的中止（如 `dsh-timeout` 的 `TimeoutReason`）以 `WEB_PROVIDER_ERROR` 暴露。
