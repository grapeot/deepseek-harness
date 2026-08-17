# Agent Note: OAuth credential provider

Status: implemented

[English](2026-08-16-oauth-credential-provider.md) | 中文

## Problem

SuperGrok 或 X Premium+ 订阅可以通过 xAI 的 OAuth device-code 流为 Grok API 访问背书：在 `auth.x.ai` 登录，然后把 access token 作为 bearer 发往 `https://api.x.ai/v1`，用量从订阅的周池扣除而不是 api.x.ai 计费。Warp 和 Hermes Agent 已经上线了这条路径。本 harness 曾经够不到它：`dsh-llm-pi-ai` 只通过 credential seam 以 api-key 字符串解析认证，其 catalog 层有意扣留纯 OAuth provider——这一决定记录在 [withheld-providers note](../bug-fix/2026-08-13-oauth-only-providers-withheld.md) 中，OAuth 支持被明确推迟。底层 `@earendil-works/pi-ai` 已经把完整的 xAI flow——device-code 登录、含 xAI 不轮换 refresh token 的刷新处理、以及返回 `{ apiKey: accessToken }` 的 `toAuth`——放在公开 provider 定义后面。

缺的只是 harness 侧的四件事：登录入口、token 存储、过期前刷新、逐请求注入。本次变更就是那项被推迟的工作；它扩展了上述 withheld-providers 决定（并在 `xai` 那一半构成部分取代），也扩展 [credential boundaries note](../architecture/2026-07-30-credential-boundaries-and-atomic-registration.md) 记录的 credential seam 边界。

## Decision

`@deepseek-ai/dsh-credentials-oauth`（`packages/credentials/credentials-oauth`）是一个挂入 credential seam 的 OAuth credential source，把 token 存进自己的文件，在 resolve 时惰性刷新，并把每个 flow 的活跃 access token 暴露为一个普通 credential reference。`dsh-llm-pi-ai` 保持不动：OAuth access token 就是字符串，适配器本来就把解析出的凭证作为 pi-ai 最高优先级的 `apiKey` 覆盖下传，而 xAI 的 `toAuth` 形状证实该端点接受这个 token 作为 bearer。

承重事实是 seam 既有的逐操作解析契约（[credentials README](../../../../packages/credentials/credentials/README.md)）：消费方在每次操作时重新 `ctx.credentials.resolve(ref)`，所以惰性刷新轮换出的 token 无需重启、无需定时器就能到达下一个模型请求。用户故事：跑一次 `/oauth login xai`，在浏览器里批准，给 `xai` 路由配 `apiKeyEnv: XAI_OAUTH_ACCESS`，Grok 请求就从订阅扣量。

### Credential source 注册表

同名 Cordis service 只保有一个活跃实例，第二个 `CredentialProvider` 会遮蔽 `dsh-credentials-local` 而不是与它组合。因此 credential Service Definition 包拥有 `CredentialSource` 接口和注册服务 `ctx.credentialSources.register(source)`（按 registration-as-effect 约定返回 disposer）；`dsh-credentials-local` 在注册表缺席时启动它，并把挂载的 source 折进自己的层级管线，位置在继承环境与托管文件之间。优先级为 env > 动态 source > file > project-env > user-env，保持启动环境作为每次运行的运维覆盖，也绝不让陈旧的存储条目遮蔽轮换中的 token。

两条响亮规则镜像既有语义：对动态 source 拥有的 reference 执行 `set`/`unset` 会被拒绝（写入会被遮蔽——与 env 层既有的拒绝同理），并指引使用 `/oauth`；source 拥有的 reference 若在文件层有条目，则在注册或重新加载时失败而不是静默失效。两个 source 声称同一个 reference 在注册时被拒绝。

### Token 存储与惰性刷新

该插件拥有 `$DSH_HOME/.oauth-credentials.json`（Config `path` 可覆盖）：`{ version: 1, flows: { xai: { access, refresh, expiresAt, obtainedAt } } }`，原子写入（临时文件、rename、mode 0600）。`expiresAt` 是 provider 报告的到期时间减去刷新余量（pi-ai 已经扣了五分钟）。`resolve` 在未过期时返回存储的 access token；过期则跑一次 single-flight 刷新——并发 resolve 共享一个 in-flight promise——先持久化新 token 对再返回。持久化失败则请求失败，而不是冒险让已轮换的 refresh token 逃离存储。provider 拒绝的刷新抛出并指引重跑 `/oauth login`；`resolve` 只对从未登录的 flow 返回 `undefined`，既有 `MISSING_CREDENTIAL` 语义保持成立。不存在后台定时器：空闲期自然跳过刷新，笔记本休眠也无妨，因为每次 resolve 都重新检查到期。

### 登录、状态、登出命令

该插件在挂载了 `ctx.commands` 时通过它（[commands README](../../../../packages/interaction/commands/README.md)）注册 `/oauth` 命令。`/oauth login xai` 请求 device code（一次 POST），把轮询作为插件持有的可中止任务启动，并立即返回验证 URL 和 user code——轮询不在命令 handler 里挂满整个窗口。`/oauth status` 报告每个 flow 的状态（pending 及剩余有效期、connected 及到期时间、或最近一次失败）；`/oauth logout xai` 删除存储记录。登录完成和登出触发 `credentials/updated`；静默刷新不触发，因为 configured-ness 没变，且消费方从不跨操作缓存值。flow 本身来自 pi-ai 的公开 provider 定义（`xaiProvider().auth.oauth`：`login`、`refresh`、`toAuth`），惰性导入，Node-only 的 OAuth 代码只在登录和刷新时加载。

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

一个 flow 恰在它出现于 `providers` 之下时挂载；包未发布的 id 在加载时失败（misconfiguration fails loud）。`providers` 为空或省略时插件以零 source 休眠挂载，镜像 `dsh-llm-pi-ai` 的 dormant 模式。已发布的 base bundle 挂载 `xai`。`openai-codex` 和 `anthropic` 适配器未发布——机制是通用的，且 codex 的情形现在就已可用，因为 settings document 已命名的路由保留其目录条目，`apiKeyEnv` 用本插件供给的 token 认证它。

### Security

token 只存在于 0600 存储中；绝不进入 session 事件、telemetry 或 Client 可见数据，`describe` 报告 `{ configured, source: 'oauth', writable: false }` 而不含值。登录任务与任何 in-flight 刷新都是可中止的插件 effect，插件卸载即停止它们。

## Alternatives considered

### 为什么不是带刷新定时器的 token-keeper 插件？

一个登录后把 access token 重写进 `.credentials.yaml` 的 keeper 无需改动 seam，但刷新变成定时器驱动：需要专属生命周期、写入量与挂钟成正比而非与使用量、休眠后陈旧、自动管理的条目污染用户持有的 credentials document，`set`/`unset` 语义还要与管理者打架。逐操作解析契约已经交付 OAuth 需要的一切；惰性 resolve 严格更简单。

### 为什么不在 dsh-llm-pi-ai 内部做 OAuth？

给适配器配 credential store 和登录流，等于在一个 LLM 适配器内部复制 credential seam，而 OAuth 形状认证的其他消费方（未来的 provider、其他 capability）都要再实现一遍。seam 的存在意义就是让认证在全 harness 解析一次。

### 为什么不 vendor xAI flow？

flow 的 client id、scope 集合与怪癖（xAI 刷新时可能省略 `refresh_token`）由上游对着活端点维护。pi-ai 的公开导出能惰性拿到同一批 flow 对象；分叉代码买到的是一个依赖边界，代价是手工追踪 xAI 的 OAuth 行为。

### 为什么不把单一 provider service 换成多 provider 路由器？

不存在第二个完整 `CredentialProvider` 需要路由。source 注册表以更小改动覆盖动态 source。若将来出现真正独立的 provider（而非可解析的 source），再重新评估。

## Consequences

- **xAI 按订阅档位门控 OAuth API 访问。** 登录可能成功而推理对标准 SuperGrok 档位返回 403（Hermes Agent issue #26847 有观测）。harness 侧无法修复；请求错误原样呈现，api-key 路线仍是回退。
- **flow 搭乘 pi-ai 注册的 OAuth client id。** xAI 对第三方 client 的门控变化会在上游打断登录；自己注册 client 是缓解手段，推迟到观测到必要时。
- **长期空闲导致 refresh token 过期**，下一次请求失败并给出重新登录指引——这是有意响亮，但空闲超过 provider refresh 生命周期的 session 会失去单点登录连续性。
- **时钟回拨**可能在真实过期后复用 token；五分钟余量覆盖小幅跳变，provider 401 以请求失败形式呈现。
- **没有 headless 登录路径**：命令面板需要交互式适配器。`dsh oauth` CLI 入口与 Web settings 表面一起推迟。

## Testing

包测试覆盖对着假 flow 的 `/oauth login xai`（验证 URL 与 code、完成、status、pending、失败、notify 前拒绝、无 device code 即完成）、先持久化再返回的 single-flight 刷新、带重新登录指引的被拒刷新、登出压过进行中的 refresh 或 login persist、对被拥有 reference 的 `set`/`unset`、随贡献 fiber 卸载的 source，以及 source 注册时的文件层冲突。`loadBuiltInFlow('xai')` 加载真实的 pi-ai 对象。真实 SuperGrok 登录与一次活 Grok completion 仍是记在 PR 里的手工检查，不是 keyless 门。
