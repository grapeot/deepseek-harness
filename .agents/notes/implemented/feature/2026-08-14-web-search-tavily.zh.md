# Agent Note: Tavily 搜索 provider — web 缝的专用检索路由

Status: implemented

[English](2026-08-14-web-search-tavily.md)

## 问题

web 能力缝（`ctx.web`）此前有三个搜索 provider，但全部经由模型形态的后端触网：Exa 和 Perplexity 是检索端点，而随产品 bundle 挂载的免 key 默认路由只有 DeepSeek 的——每次搜索发一轮完整的 Anthropic 兼容 Messages 模型调用。高频搜索的部署每次都付一轮模型调用；持有 Tavily key 的部署则完全无法在缝内使用它——Tavily CLI skill 和 MCP server 都活在 `ctx.web` 之外，`web_search` 够不着。

## 决策

新增 `@deepseek-ai/dsh-web-search-tavily`：基于 Tavily 专用 `POST /search` 检索端点的 `WebSearchProvider`，由 base bundle 以可选行挂载（`web-search-tavily`，默认凭证引用 `TAVILY_API_KEY`），不改变默认 `searchProvider`。部署用一个 `web` 行覆盖即可选中它。

provider 沿用 `web-search-deepseek` 的结构（每次搜索经可选的 `ctx.credentials` 缝解析凭证，无该缝时回退启动环境；选项按操作一次性快照，凭证解析期间落地的配置写不会串节），减去 DeepSeek 特有的面：无 settings section（部署在 `cordis.yml` 里钉住 Tavily，而非 Models 页面）、无辅助请求 session 事件（没有模型请求需要披露）。

两个映射决策有意区别于 Exa 适配器。其一，`content` 摘录为空或缺失的结果保留而非丢弃：Tavily 的 `content` 是爬虫的页面提取，合法地为空，而 URL 本身仍是可引用来源；Exa 的 highlight 则是唯一可移植的 snippet 字段，缺失就无物可映射。其二，`score` 与 `raw_content` 丢弃，且请求固定 `include_raw_content: false`——缝里没有对应字段，payload 不该携带适配器要扔掉的字节。`includeAnswer`（默认关）把请求到的生成答案映射为缝的可选 `content`，语义与 Perplexity 的答案一致。其余逐字遵守 provider 契约：`redirect: 'error'` 加真 HTTP 回归覆盖证明 `Location` 目标从不被接触（web 组策略）、`WEB_PROVIDER_ERROR`/`WEB_ABORTED`/`WEB_PROVIDER_CREDENTIAL_MISSING` 错误分类、最终 `maxResults` 截断由缝执行。

Tavily 的按请求控制（时间范围、日期边界、域名过滤、国家加权、图片）不进来：缝的请求词表是 `query` + `maxResults`，直到 provider 中立字段存在（[缝的延期工作](../architecture/2026-06-24-web-capability-seam.md)）。今天需要这些控制的部署继续在缝外使用 Tavily CLI skill 或 MCP server。

## 后果

`dsh-tool-web` 零改动：provider 注册进 `ctx.web`，模型侧 schema 本来就 provider 中立。provider 的 `available()` 是凭证与配置检查，无 `TAVILY_API_KEY` 的部署照样挂载该行，只是 provider 永不自动选中。DeepSeek 与 Tavily 两行同时挂载时自动选择会歧义——选中 Tavily 需要显式 `web` 行覆盖（本 fork 的部署 profile 正是这样钉住它的）。

e2e 探针无 `TAVILY_API_KEY` 时自跳过，符合仓库的无 key CI 政策；与 DeepSeek 探针不同，它是活断言而非 `it.skip`，因为专用检索端点返回确定性 envelope，这是模型调用路由承诺不了的。

## 考虑过的替代方案

- **MCP 桥接 Tavily server**（`dsh-mcp-client` 配置）零代码，但工具落在缝外：没有 provider 选择、没有 `WebError` 分类、模型目录里是 MCP 限定名，也没有跨搜索后端的 KV 稳定 schema。对于本缝不拥有的 extract/map workflow，它仍是正确答案。
- **用 recency/domain 字段加宽 `WebSearchRequest`** 已规划并推迟：两个控制都需要 `dsh-web`/`dsh-tool-web`/三个 provider 的协调改动和站得住的 provider 中立契约——等有使用证据后作为 upstream 工作来做，而不是作为私有 fork 的第一份 delta。
