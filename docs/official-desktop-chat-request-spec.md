# Freebuff 官方 Desktop 客户端 Chat 请求完整规格报告

逆向对象：`Freebuff.app/Contents/Resources/orchestrator/orchestrator.js`（esbuild bundle，134835 行，内置
@codebuff/sdk + @codebuff/agent-runtime + AI SDK）+ `@codebuff/sdk` TypeScript 源码。
比对对象：`free-buff-lol`（src/*.js）。

行号均指 orchestrator.js。desktop 的 free-mode 聊天走 **agent-template 路径**：
`CodebuffHarness.runTurn` → `run()`（SDK）→ `callMainPrompt` → agent-runtime `getAgentStreamFromTemplate`
(69650) → `promptAiSdkStream` (89026) → `streamText` → `OpenAICompatibleChatLanguageModel` (getModelForRequest)。

---

## A. Chat 请求载荷（POST /api/v1/chat/completions）

端点：`https://www.codebuff.com/api/v1/chat/completions`
（`getWebsiteUrl()` = env 或 `NEXT_PUBLIC_CODEBUFF_APP_URL`，86654-86657；`path.join('/api/v1', endpoint)`，SDK model-provider.ts:147）

### A1. 逐层构造链

| 层 | 位置 | 行为 |
|---|---|---|
| harness | 122743-122750 | `costMode: "free"`；`extraCodebuffMetadata: { freebuff_instance_id: turn.freeMode.instanceId, freebuff_multi_session: "1", freebuff_reasoning_effort? }` |
| run() | 92147-92170 | `clientSessionId = promptId`（= `Math.random().toString(36).substring(2, 15)`，13 位 base36）；`extraCodebuffMetadata += { trace_session_id: traceSessionId }`（traceSessionId = `previousRun?.traceSessionId ?? crypto.randomUUID()`，91848/91928，跨 turn 延续） |
| agent-runtime | 69678-69715 | `maxRetries: 3`、`maxOutputTokens: undefined`、`stopSequences: [globalStopSequence]`、`agentProviderOptions = template.providerOptions`、`providerOptions.openrouter/codebuff.reasoning = template.reasoningOptions` |
| promptAiSdkStream | 89037-89052 | `streamText({ messages: convertCbToModelMessages(...), allowSystemInMessages: true, providerOptions: getProviderOptions(...) })` |
| getProviderOptions | 88956-88994 | `codebuff_metadata = { ...extraCodebuffMetadata, run_id, client_id, n?, cost_mode?, cache_debug_correlation? }`；`provider = agentProviderOptions`（template 有则用之） |
| openai-compatible 映射 | 88430 附近 | 顶层 body = `{ model, messages, stream: true, stop: stopSequences, tools, tool_choice?, ...providerOptions["codebuff"] 展开 }`（展开时剔除 `user`/`reasoningEffort`/`textVerbosity` 三个 key） |

### A2. 最终 wire body

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [
    {"role": "system", "content": "You are Buffy, the coding agent behind Codebuff. ..."},
    {"role": "user", "content": "..."},
    ...
  ],
  "stream": true,
  "stop": ["\"cb_easp\""],
  "tools": [...],
  "tool_choice": "auto",
  "codebuff_metadata": {
    "freebuff_instance_id": "<session instanceId>",
    "freebuff_multi_session": "1",
    "freebuff_reasoning_effort": "<effort>",
    "trace_session_id": "<uuid, run() 级>",
    "llm_step_number": "1",
    "run_id": "<agent-runs START 返回的 runId>",
    "client_id": "<promptId>",
    "cost_mode": "free"
  },
  "provider": { "data_collection": "deny" }
}
```

要点：
- `stop` = `[globalStopSequence]`，`globalStopSequence = JSON.stringify("cb_easp")` = **`'"cb_easp"'`（带双引号）**（69002、69695）。
- `llm_step_number` 每 agent 循环步 +1（83809-83812）。
- `n` 仅当 generateN > 1 时出现；`cache_debug_correlation` 仅调试时出现。
- `temperature` / `max_tokens` **官方不发送**（maxOutputTokens: undefined；streamText 不设 temperature）。
- anthropic 系模型（model.startsWith("anthropic/")）：`provider = { only: ["amazon-bedrock"], data_collection: "deny" }`（122454）。
- 无 `developer` role：`modelMessageSchema` 只接受 system/user/assistant/tool。

### A3. 消息规范化 convertCbToModelMessages（68324 起）

1. **dropUnansweredToolCalls**：删除没有对应 assistant tool_call 的 tool-result。
2. **convertToolMessages**：system 内容块 → 以 `\n\n` 连接成字符串；assistant → content 包成 `[{type:"text", text}]`；tool → `{type:"tool-result", output}`（带 cache_control，见 4）。
3. **聚合**：相邻且 role/timeToLive/providerOptions/tags 相同的消息合并，system+system 以 `\n\n` 连接。
4. **withCacheControl**（68222-68236）：对最后一条消息内容块加 `providerOptions.{anthropic,openrouter,openaiCompatible}.cache_control = {type:"ephemeral"}`——对 openai-compatible 后端不会上线（shape 不包含该字段），仅影响原生 anthropic provider 路径。

---

## B. 请求头

`getModelForRequest`（SDK model-provider.ts:148-153，bundle 88860 附近）+ `postJsonToApi2`（87864-87886）：

| Header | 值 | 来源 |
|---|---|---|
| `Content-Type` | `application/json` | postJsonToApi2 固定 |
| `Authorization` | `Bearer <apiKey>` | model-provider headers |
| `user-agent` | `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/node.js/v<ver>` | 见下 |
| `x-freebuff-acting-user-id` | `<userId>`（可选） | 仅当 userId 传入（服务账号/请求方）；官方会先 `GET /api/v1/me?fields=id` 解析真实 userId（92107-92114） |
| `x-openrouter-api-key` | `<key>`（可选） | 仅当 `CODEBUFF_BYOK_OPENROUTER` 环境变量存在（86649-86651） |

UA 拼接链：
1. model-provider: `ai-sdk/openai-compatible/${VERSION}/codebuff`，`VERSION = __PACKAGE_VERSION__` 若定义否则 `"0.0.0-test"`（88814）——**bundle 保留了 `typeof __PACKAGE_VERSION__ < "u"` 检查（esbuild 未替换），运行时为 undefined → 线上恒为 `0.0.0-test`**。
2. `withUserAgentSuffix3`（87693）：追加 `ai-sdk/provider-utils/3.0.25`（VERSION4 硬编码，87697）。
3. `getRuntimeEnvironmentUserAgent3`（87664-87675）：desktop 跑在 Bun 下但 `process.versions.node` 存在 → **`runtime/node.js/v24.x`**（非 runtime/bun）。

Header 用途分界：`x-freebuff-instance-id`、`x-freebuff-model`、`x-freebuff-multi-session`、`x-freebuff-heartbeat`、`x-freebuff-include-unused-rate-limits`、`x-freebuff-takeover-instance-id`（87072-87073）**只出现在 session API 请求**，chat 请求不带。

---

## C. 系统提示词（desktop thread agent）

Desktop 用 **base3**（server 端模板数据库下发，bundle 内仅 `createBase3` 定义；agent id `freebuff-desktop-thread-{mode}-v3`，见 83988-83995、122596）。

组合（`threadAgentDefinition`，122585-122602）：四段以 `\n\n` 连接：

```
1. base3.systemPrompt（createBase3，122477）
2. DESKTOP_SYSTEM_PROMPT（122571）   # Freebuff Desktop + SUGGEST_PROMPTS_GUIDANCE + ELEVATION_GUIDANCE
3. workspaceGuidance2(mode)         LOCAL_WORKSPACE_GUIDANCE2 / WORKTREE_WORKSPACE_GUIDANCE2
4. additionalSystemPrompt（通常为空）
```

base3 全文（122477-122489）：

```
You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.

Current date: {CODEBUFF_CURRENT_DATE}.

- Match the project's existing conventions. Verify a library is already used in the project before employing it.
- Prefer editing existing files over creating new ones. Make the fewest changes that address the request.
- Verify non-trivial changes by running the project's typecheck and relevant tests.
- Use write_todos to plan and track multi-step tasks.
- Your responses are displayed in a terminal. Keep them short and concise.
- Don't run destructive or hard-to-undo commands (git push, resets, deploys) unless the user asks for them.

{CODEBUFF_KNOWLEDGE_FILES_CONTENTS}
```

占位符替换（`formatPrompt`，82477-82521）：
- `CURRENT_DATE` → `Intl.DateTimeFormat("en-US", {year, month:"long", day})`，如 `August 17, 2026`（82470-82476）
- `KNOWLEDGE_FILES_CONTENTS` → 项目根 `AGENTS.md`/`CLAUDE.md`/`*.knowledge.md` 内容（82430-82445），超 `PROJECT_INSTRUCTION_LIMIT` 截断并附截断注记
- `SYSTEM_INFO_PROMPT` → 机器信息；`GIT_CHANGES_PROMPT` → 会话开始时 git 状态快照
- `AGENT_NAME` → template.displayName

服务端标记检查：free-mode 根请求的 system 消息**必须以 `FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS` 之一逐字开头**（`requestHasFreebuffSystemMarker`），否则 403（free-buff-lol messages.js:15-21 已记录）。base2 opening = `You are Buffy, the strategic coding assistant.`；base3 opening = `You are Buffy, the coding agent behind Codebuff.`

**base2 系统提示全文不在客户端**：agent 模板（含 base2）由服务端 `fetchAgentFromDatabase` 下发（83984 附近），bundle 只有 base3 的本地定义。base2 文本需以免费账号抓包或以 free-agents.ts 为准。

---

## D. 错误处理

### D1. 重试（chat 层）
- `streamText` `maxRetries: 3`（69689；AI SDK 默认 2）。
- AI SDK `retryWithExponentialBackoff`：maxRetries=2、initialDelayInMs=2000、backoffFactor=2（28684-28692）。
- `getRetryDelayInMs`（30564-30588）：**优先尊重 `retry-after-ms`（精确 ms）与 `retry-after`（秒）响应头**，其次指数退避。
- `APICallError.isRetryable` = 408/409/429/≥500（21234）；`shouldRetry` = isRetryable===true（38589）。
- `fetchWithRetryableNetworkErrors`（SDK model-provider.ts:96-124）：Bun fetch 的瞬时网络错误（ECONNRESET/ConnectionClosed 等）包装成 isRetryable 的 APICallError，纳入 AI SDK 退避。
- **429 `free_mode_capacity_deferred`**（SDK model-provider.ts:62-83）：clone 响应体，error==='free_mode_capacity_deferred' 时通知 `freeModeCapacityDeferralListener`，retryAfterSeconds 取 `retry-after` 头、缺省 10s；desktop 借此发 "capacity-wait" 状态事件（122630-122633），重试本身由 AI SDK 静默吸收。

### D2. 错误解析
- `extractApiErrorDetails`（68028 附近）：解析响应体 error → `errorCode`（error 字符串 / 嵌套 code / 嵌套 type）、`message`、`countryCode`、`countryBlockReason`、`ipPrivacySignals`、`statusCode`。
- 最终面向用户消息：有解析 message 用之，否则 `FETCH_IDLE_TIMEOUT_USER_MESSAGE`（5 分钟 idle，68049-68052）/ `TRANSIENT_NETWORK_ERROR_USER_MESSAGE`（92175-92186）。

### D3. 会话层（SessionManager）
- `SESSION_ADMISSION_RETRY_DELAYS_MS = [500, 1000]`、`SESSION_RETRY_AFTER_CAP_MS = 3000`、`SESSION_REQUEST_TIMEOUT_MS = 15000`、`SESSION_HEARTBEAT_TIMEOUT_MS = 10000`、`FREEBUFF_SESSION_HEARTBEAT_INTERVAL_MS = 45000`（87073、121761）。
- 错误消息模板（122233-122235）：`rate_limited` → `Come back in X — your free usage resets automatically at midnight Pacific.`；`ip_capped` → 提及 `activeUsersForIp`。
- 404 → `disabled`；`premium_slot_taken` → 409 + 带 `x-freebuff-takeover-instance-id: <currentInstanceId>` 重试接管（upstream.js createSession 已实现，187-207）。
- Turn 失败分类 `classifyTurnFailure`（127558-127566）：`KIND_BY_FREEBUFF_STATUS`：`session_ended`→freebuff_session_ended、`premium_slot_taken`/`session_limit_reached`→freebuff_concurrency、`rate_limited`/`spend_limited`/`ip_capped`→freebuff_quota、`unauthenticated`→freebuff_auth；另有 REWRITTEN_FAILURES 正则（context_overflow、连接错误）与 NOTICE_BY_ERROR_NAME（登出提示）。

### D4. account_suspended
**bundle 中不存在** `account_suspended`/`banned` 的专用处理（仅 session status 轮询的通用路径）——该错误码是服务端下发的，官方客户端经 extractApiErrorDetails 透传展示。free-buff-lol 的 `detectAccountSuspension`（handlers.js:194-216）属于增强行为。

---

## E. free-buff-lol 与官方实现逐条比对

| # | 项目 | 官方（desktop 0.0.61） | free-buff-lol | 结论 |
|---|---|---|---|---|
| 1 | chat UA | `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/node.js/v<ver>` | `getChatUserAgent()` 逐字相同（versions.js:13-22） | ✅ 一致 |
| 2 | chat 头集合 | Content-Type + Authorization + user-agent + 可选 acting-user-id/BYOK | chatHeaders 相同（upstream.js:71-78） | ✅ 一致（常量 `AI_SDK_COMPAT_USER_AGENT=1.0.25` 已废弃未使用） |
| 3 | `stop` | `['"cb_easp"']`（**带引号** JSON 编码） | `['cb_easp']`（无引号，handlers.js:319） | ❌ **wire 差异**：模型输出流式 token 为 `"cb_easp"`（带引号），官方 stop 序列与之精确匹配；无引号版本可能不触发服务端 stop_reason 判定 |
| 4 | codebuff_metadata 字段 | `freebuff_instance_id` + `freebuff_multi_session:"1"` + `freebuff_reasoning_effort?` + `trace_session_id` + `llm_step_number` + `run_id` + `client_id` + `cost_mode` | 仅 `freebuff_instance_id`/`trace_session_id`/`run_id`/`client_id`/`cost_mode`（handlers.js:311-317） | ❌ **缺 3 字段**：`freebuff_multi_session`、`llm_step_number`（官方每步递增）、`freebuff_reasoning_effort` |
| 5 | `client_id` | 13 位 base36 随机；同一次 run 内复用（promptId） | 13 位 base36 随机（util.js:55-61），每次请求新生成 | ⚠️ 格式一致，生命周期不同 |
| 6 | `trace_session_id` | crypto.randomUUID()，**跨 turn 延续**（previousRun.traceSessionId） | crypto.randomUUID()，每请求新生成 | ⚠️ 官方会延续 |
| 7 | `provider` | base3：`{data_collection:"deny"}`；anthropic 系：`{only:["amazon-bedrock"], data_collection:"deny"}` | 恒 `{data_collection:"deny"}`（handlers.js:318） | ⚠️ anthropic 模型缺 `only` 字段 |
| 8 | `cost_mode` | `"free"`（freeMode turn） | `"free"` | ✅ 一致 |
| 9 | 系统提示 | 完整 3-4 段（base3 + # Freebuff Desktop + workspace 指引 + 占位符替换） | 仅注入 opening 首行（messages.js:23-47） | ⚠️ 通过服务端标记检查，但 agent 收到的行为指引远少于官方 |
| 10 | `temperature`/`max_tokens` | **不发送**（maxOutputTokens undefined，无 temperature） | 透传客户端值 | ⚠️ 差异（服务端 free-mode 可能忽略，但 wire 不同） |
| 11 | `stream` | 恒 true（streamText） | 未定义时补 true（handlers.js:307） | ✅ 等价 |
| 12 | 消息规范化 | developer 从不出现；聚合相邻同 role；删除未应答 tool call；tool-result 重排 | 仅 developer→system + 前缀注入（messages.js:23-47） | ⚠️ 不做聚合与 tool-call 清理（客户端通常已规范，影响小） |
| 13 | `x-freebuff-acting-user-id` | 运行时经 `/api/v1/me` 解析真实 userId 后发送 | 仅 `config.actingUserId` 配置时发送（upstream.js:53-56） | ⚠️ 默认不发送 |
| 14 | 429 处理 | AI SDK 退避（尊重 retry-after）+ capacity deferral 监听，同 token | 手动 3 次 3s/6s/9s + token 轮换/冷却（handlers.js:327-355） | ⚠️ 策略不同（多账号轮换是有意的代理增强；单账号下无 retry-after 尊重） |
| 15 | 会话错误码 | desktop 状态机：active/queued/ended/superseded/disabled、premium_slot_taken 接管 | isSessionInvalid 另有 waiting_room_required/queued、session_expired、session_model_mismatch（util.js:190-199，源自 CLI 行为） | ⚠️ 集合不同（含额外 CLI 时代码；服务端新码会漏） |
| 16 | 会话头 | multi-session / instance-id / model / heartbeat / include-unused-rate-limits / takeover | upstream.js:34-40 逐项对应，POST 无 body、GET 含 unused-rate-limits、heartbeat body cancel | ✅ 一致 |
| 17 | 心跳 | 45s，GET + `x-freebuff-heartbeat:1`，10s 超时，body 取消 | 45s（SESSION_HEARTBEAT_INTERVAL_MS=45000）相同语义 | ✅ 一致 |
| 18 | 会话重试 | [500, 1000]ms、retry-after 上限 3s、15s 超时、仅 5xx/超时/瞬时错误重试 | 完全相同（upstream.js:236-281） | ✅ 一致 |
| 19 | 错误响应解析 | openaiCompatible errorSchema + extractApiErrorDetails（含 countryCode/countryBlockReason/ipPrivacySignals） | 松散 JSON 解析（writePassthroughError） | ⚠️ 官方结构化解析未复刻 |
| 20 | account_suspended/banned | 官方无专用处理（透传展示） | detectAccountSuspension + markTokenBanned（handlers.js:194-216, 386-393） | ⚠️ 增强特性（官方没有） |
| 21 | run 生命周期 | START →（步骤本地缓存）→ FINISH 携带 steps；base3 无 context-pruner 子 run | startRunChainSimple（base3 单 run）/Normal（base2 + context-pruner）/Gemini，步骤缓冲在 FINISH 提交（upstream.js:128-156） | ✅ 对齐官方（含 steps-in-FINISH 语义） |
| 22 | 端点 | `https://www.codebuff.com/api/v1/chat/completions`（env 可覆盖） | `UPSTREAM_BASE_URL` 可配置，默认相同 | ✅ 一致 |
| 23 | BYOK | `CODEBUFF_BYOK_OPENROUTER` env → `x-openrouter-api-key` | 未实现 | ⚠️ 缺失（普通免费代理不需要） |

### 汇总
- **一致（可放心）**：UA、chat 头集合、会话头/重试/心跳、cost_mode、stream、端点、run 生命周期。
- **必须修（wire 差异）**：#3 `stop` 引号；#4 codebuff_metadata 缺 3 字段（若服务端对 freebuff_multi_session / llm_step_number 有校验或统计）。
- **建议修**：#6 trace_session_id 延续、#7 anthropic `only` 字段、#13 acting-user-id 自动解析、#19 结构化错误解析。
- **有意为之的差异**：#14 多 token 429 轮换、#20 封禁检测、#22 多 upstream。
- **无法本地验证**：base2 系统提示全文（服务端模板下发）、server 端对以上 wire 差异的实际容忍度（建议抓包对照）。

## 附录：关键行号索引

| 事实 | 位置 |
|---|---|
| 常量头（BYOK） | 86582 |
| 常量头（FREEBUFF_*） | 87072-87073 |
| VERSION5 / UA 版本 | 88814 |
| provider-utils VERSION4 | 87697 |
| postJsonToApi2/postToApi2 | 87864-87924 |
| withUserAgentSuffix3 / getRuntimeEnvironmentUserAgent3 | 87693 / 87664 |
| getModelForRequest（bundle） | 88860-88868 |
| getProviderOptions | 88956-88994 |
| promptAiSdkStream | 89026 |
| 网络错误→retryable 包装 | SDK model-provider.ts:96-124 |
| 429 capacity deferral | SDK model-provider.ts:62-83 |
| globalStopSequence / cb_easp | 67848 / 69002 |
| agent-runtime stream params | 69650-69716 |
| convertCbToModelMessages | 68324 |
| withCacheControl | 68222-68236 |
| extractApiErrorDetails | 68028-68052 |
| idle timeout 消息 | 68049-68052 |
| promptId / run() | 92107 / 91928 / 92165-92170 |
| llm_step_number | 83809-83812 |
| freeMode extra metadata | 122743-122750 |
| threadAgentDefinition / desktop prompt | 122566-122602 |
| createBase3 | 122449-122491 |
| formatPrompt / 占位符 | 82447-82521 |
| 会话常量 | 121761-121763 |
| session 错误消息 | 122233-122235 |
| classifyTurnFailure / KIND_BY_FREEBUFF_STATUS | 127550-127566 |
