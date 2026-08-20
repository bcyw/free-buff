# Freebuff 官方 Desktop 客户端辅助请求规格报告（Ads / Streak / Agents Validate / 设备信息 / CLI Launcher）

逆向对象：`Freebuff.app/Contents/Resources/orchestrator/orchestrator.js`（esbuild bundle，134835 行）+ `@codebuff/sdk` 0.10.7 TypeScript 源码 + npm `freebuff@0.0.149` 启动器（`/usr/local/lib/node_modules/freebuff/`）。
比对对象：`free-buff-lol`（`src/upstream.js`、`src/handlers.js`、`src/versions.js`、`src/messages.js`、`src/constants.js`）。

行号均指 orchestrator.js。主 chat 请求规格见 `official-desktop-chat-request-spec.md`，本文是其姊妹篇，只覆盖**辅助请求**（广告、streak、agents validate、设备信息）与 **CLI 启动器**。

---

## A. 广告链（Ads）

### A1. 触发时机（两个独立入口）

**① 行内广告（inline，对话流中）——服务端 orchestrator 驱动**

`runTurn` 内 `maybeRequestAd`（127322-127326），每轮 turn 最多触发 4 次：

| 条件 | 值 | 位置 |
|---|---|---|
| harnessId | 必须 `"codebuff"`（free 托管模型；本地 harness 无广告） | 127322 |
| `adsRequested < MAX_MESSAGE_AD_COUNT` | `< 4` | 125269 |
| `countResponseNodes(live.parts) >= AD_NODE_THRESHOLDS[adsRequested]` | `[1, 4, 7, 10]` | 127208 |

触发时**非阻塞**（fire-and-forget）：

```js
adsRequested++;
deps.ads.inlineAd(threadId, engine.recentMessageTexts(threadId, 6), aborter.signal)
  .then(ad2 => emit({ type: "ad", ad: ad2 }))   // 渲染层在消息流中插入广告块
```

`countResponseNodes`（127600）计数规则：跳过 `kind === "ad"` 的 part；`"changes"` 节点重置 `inActivityRun`（不计数）；reasoning / tool 每次运行只算 1 个节点；其余 part 逐条 +1。即：**首个 inline 广告在模型产出第 1 个节点后请求**，之后按 4/7/10 个节点递增，最多 4 条。

`recentMessageTexts(threadId, 6)`（131086）：取最近 6 条消息 → `{ role, text: partsText(parts) }`，过滤空文本后 **reverse（最新在前）** 传给广告接口。

**② 底部插槽广告（banner）——渲染层驱动**

renderer `index-BeKzmW6_.js` 的 `IU` 组件（下方聊天区 banner）：

- 渲染条件：`authed && 该 thread 存在 role==="user" 的消息`
- 挂载时立即取广告；之后 `setInterval(u, 60000)` 每 **60s** 轮询一次
- 限流窗口：`Kb < 3` 且 `Date.now() - eD <= 30000`（30s 窗口内最多发 3 次真实 `/api/ad/slot` 请求）；超出窗口后轮换本地缓存队列 `na`（最多 50 条，AU=50），不再打接口
- 用户任何 `keydown`/`pointerdown`（capture 阶段）→ 重置窗口（`eD = Date.now(); Kb = 0`）
- `NE` 去重：同时只有一个 `/api/ad/slot` 在途请求；首个广告缓存到 `Td` 后持续展示，不再重复请求

**③ impression / click ——渲染层驱动**

- impression：`J2`（广告组件）`useEffect(() => RU(e.impUrl), [e.impUrl])`；`RU` 按 `impUrl` 去重（`LE` Set），调 `POST /api/ad/impression`，`.catch(() => {})`
- click：广告 `<a>` 的 `onClick` 与 `onAuxClick(button === 1)`（中键）→ `DE(e.impUrl)` → `POST /api/ad/click`

### A2. 请求格式

服务端 `Ads` 类（`src/server/services/ads.ts`，124077-124160）：

```
常量：DESKTOP_INLINE_PLACEMENT_ID = "Desktop-Inline-Chat"
      SLOT_PLACEMENT_ID           = "Desktop-Below-Chat"
      AD_FETCH_TIMEOUT_MS         = 10000
      DESKTOP_AD_REQUEST_USER_AGENT = `Freebuff-Desktop/${FREEBUFF_APP_VERSION?.trim() || "dev"}`
```

**POST `https://www.codebuff.com/api/v1/ads`**（`auction`，124111-124130）：

```json
{
  "surface": "cli_chat",                  // 仅 inline；slot 不含此字段
  "placementId": "Desktop-Inline-Chat",   // inline；slot = "Desktop-Below-Chat"
  "messages": [{ "role": "...", "content": "<text>" }],  // inline=最近6条（最新在前）；slot=[]
  "sessionId": "<threadId>",              // slot 缺省时 "desktop-slot"
  "device": { "os": "macos", "timezone": "...", "locale": "..." },
  "userAgent": "Mozilla/5.0 ... Chrome/124.0.0.0 Safari/537.36"
}
```

请求头：`Authorization: Bearer <token>`、`content-type: application/json`、`User-Agent: Freebuff-Desktop/<版本或 dev>`；超时 `AbortSignal.timeout(10000)`（与调用方 signal 用 `AbortSignal.any` 合成）。无 token → 直接 `null`，不发请求；任何 fetch 异常 → `null`。

响应解析：`res.ok` 为假 → `[]`；否则 `.ads` 数组**过滤 `title && url` 非空的广告**；`inlineAd`/`slotAd` 取第 `[0]` 条，且 inline 必须带 `impUrl`，否则返回 `null`。解析异常 → `[]`。

**POST `.../api/v1/ads/impression`**：`{ impUrl, mode: "desktop" }` → 返回 `Boolean(res?.ok)`。
**POST `.../api/v1/ads/click`**：`{ impUrl }` → 返回 `Boolean(res?.ok)`。

本地 HTTP 路由（orchestrator 内嵌服务）：

| 路由 | 行为 | 位置 |
|---|---|---|
| `POST /api/ad/slot` | body `{threadId: string\|null}` → `{ ad: slotAd(threadId) }` | 133137-133140 |
| `POST /api/ad/impression` | `impUrl` 非字符串 → 400；成功且 `ok` → `analytics.track("desktop.ad_shown")` | 133148-133155 |
| `POST /api/ad/click` | `{ impUrl }` → `{ ok }` | 133164 |

### A3. 失败容忍度

- 广告**从不阻塞 chat**：inline 是 turn 内 fire-and-forget；slot 是渲染层异步请求；全部 `.catch(() => {})` / `try-catch → null|[]`。
- 广告失败（网络错误、超时、无 token、响应无合法广告）只影响"本次不展示广告"，不影响消息流、session 或 rate limit。
- 无广告时 slot 渲染层轮换本地缓存，无缓存则 `Kb` 计数仍然递增（`i && (Kb += 1)`，无广告不计数）。

---

## B. Streak（连续签到）

### B1. 触发时机

**仅在渲染层 `WZ` 面板打开时**获取一次（free-mode 状态/提示面板，含 streak 展示组件）：`useEffect(() => { ve.streak().then(C => setData(C), () => {}) }, [panelOpen])`。**无轮询、无定时刷新**。

### B2. 请求格式

服务端 `streak.ts`（132718-132742）：

- `STREAK_TIMEOUT_MS = 1e4`
- `GET ${API_HOST}/api/v1/freebuff/streak`
- 头：`Authorization: Bearer <token>`、`accept: application/json`；**无 User-Agent**
- `AbortSignal.timeout(10000)`；`!res.ok → null`；任何异常 `catch → null`
- `parseStreakResponse` 严格校验：`streak` 必须为有限 number、`todayUsed` 必须 boolean、`lastUsageDate` 必须 `null|string`、`timeZone` 必须 string；不合规 → `null`

本地路由 `GET /api/streak`（133093-133105）→ 响应：

```json
{
  "line": { "label": "3 day streak", "dots": "●●●○○○○", "progress": { "filled": 3, "total": 7, "beyond": false } },
  "bonusNote": { "full": "...", "limited": "..." },
  "dashboardUrl": "https://freebuff.com/account"
}
```

`line` 在 `streak <= 0` 时为 `null`；超过 7 天显示 `+`（`FREEBUFF_STREAK_WEEK = 7`，132999-133004）。`bonusNote` 文案由 `getFreebuffStreakBonusNote`（133008-133020）生成：文案含 `+1 bonus session every day`，full tier 且 GLM 奖励开启时追加 `+ N GLM 5.2 sessions each day`（`N = min(floor(streak/7), maxMult) * units`，至少 1，133012 之前）；`streak < 7` 时显示剩余天数。

### B3. 是否影响 session / rate limit —— **不影响**

- streak 请求是独立 GET，只读展示数据；与 session 准入、心跳、`rateLimitsByModel` **零耦合**。
- rate limit 完全来自 session 响应体：`getRateLimitsByModel(session)` / `glmPromo` / `referral`（121397），消费后 `incoming = getRateLimitsByModel(body2)`（122023）。
- 失败时 UI 静默（`() => {}`），面板照常显示，不影响任何会话。

---

## C. Agents Validate（/api/agents/validate）

### C1. 官方行为

**Desktop 0.0.61 从不调用此接口。** 启动路径 `loadLocalAgents({ verbose: !1 })`（90055）`validate` 默认 `false`，只做本地 Zod 模板校验（`validateAgents`，72635；失败按 `agentId` 删除对应 agent 并返回 `validationErrors`，89623-89680）。

远程校验存在于 **SDK**（`@codebuff/sdk` 0.10.7 `validate-agents.ts`，与 bundle 内 `validateAgents2` 89511 同源，供 CLI 使用，`remote: true` 时触发）：

- `POST ${websiteUrl}/api/agents/validate`，头**仅** `Content-Type: application/json`（无 Authorization、无 UA、无超时）
- body：`JSON.stringify({ agentDefinitions: definitions })` —— **原始数组**（非 object map）
- 失败（`!ok`）：`{ success:false, validationErrors:[{ id:"network_error", message:"Failed to validate via API: " + (body.error || "HTTP <status>: <statusText>") }], errorCount:1 }`
- 网络异常：`{ success:false, validationErrors:[{ id:"network_error", message:"Failed to connect to validation API: <err>" }], errorCount:1 }`
- 成功：`validationErrors = data.validationErrors || []` → 映射 `{ id: error.filePath ?? "unknown", message }`；`errorCount = errors.length`，`success = errorCount === 0`

### C2. 与 free-buff-lol 差异

| # | 项 | 官方 | free-buff-lol（upstream.js:331-339） |
|---|---|---|---|
| 1 | 触发 | 仅 CLI（remote 选项）；desktop 不调用 | **每次 chat 请求前**非阻塞调用 |
| 2 | body | `{ agentDefinitions: <CLI 模板定义> }` | `buildAgentValidationPayload()`（messages.js:57-98）：base3/base2 全量 agent 定义，含 `toolNames`/`spawnableAgents`/`systemPrompt`/`inputSchema`，systemPrompt 日期硬编码 `2026-08-15` |
| 3 | UA | 无 | `Bun/1.3.11`（`CODEBUFF_JSON_USER_AGENT`） |
| 4 | 失败容忍 | 返回结构化 network_error | 打印日志后继续（不阻塞、不重试） |

---

## D. 设备信息生成与 UA 总表

### D1. 设备信息（`deviceInfo()`，124079-124088，结果缓存于 `deviceCached`）

| 字段 | 生成方式 |
|---|---|
| `os` | `darwin → "macos"`；`win32 → "windows"`；其余 → `"linux"`（`process.platform`） |
| `timezone` | `Intl.DateTimeFormat().resolvedOptions().timeZone` |
| `locale` | `Intl.DateTimeFormat().resolvedOptions().locale` |

### D2. 广告体 UA（`AD_USER_AGENTS`，124061-124069，来自 common `ad-user-agent.ts`）

三平台统一 **Chrome/124.0.0.0**：darwin = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)`；win32 = `(Windows NT 10.0; Win64; x64)`；linux = `(X11; Linux x86_64)`。`getAdUserAgent(platform)` 将 `"macos"/"windows"` 别名归一化后取表，未知平台回落 linux。

### D3. 各请求 UA 总表

| 请求 | UA | 位置 |
|---|---|---|
| chat `/api/v1/chat/completions` | `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/node.js/v<ver>` | 88866；VERSION5=88814、VERSION4=87697、87664 |
| ads 请求头 | `Freebuff-Desktop/<FREEBUFF_APP_VERSION 或 dev>` | 124077 |
| ads body `userAgent` | Chrome 124 三平台 | 124061-124069 |
| session / streak / heartbeat / me / agent-runs / title | **无 UA**（仅 Authorization + x-freebuff-* 头） | 121763、132738、87155-87165 |
| release 下载（CLI） | `freebuff-cli` | launcher.js:153 |

注：VERSION5 = `typeof __PACKAGE_VERSION__ < "u" ? __PACKAGE_VERSION__ : "0.0.0-test"` —— esbuild 未内联该常量，**发布包运行时恒为 `"0.0.0-test"`**。runtime 后缀在 Node 下为 `runtime/node.js/v<process.version>`（87664-87681）；Bun 下 process.versions.node 存在，同样输出 node.js 前缀。

---

## E. CLI Launcher（npm `freebuff@0.0.149`）

### E1. 角色与入口

`index.js` → `createLauncher({ packageName:"freebuff", displayName:"Freebuff", wrapperVersion:"0.0.149"（= npm 包版本）, telemetryEvent:"cli.update_freebuff_failed" })`。npm 包本身**不含 CLI**，只负责下载/更新 Bun 编译的二进制并启动（`main()` 内 `ensureBinaryReady` → spawn）。

### E2. 文件布局（launcher.js:141-153）

| 路径 | 内容 |
|---|---|
| `~/.config/manicode/freebuff` | CLI 二进制（非 win32 chmod 755） |
| `~/.config/manicode/freebuff-metadata.json` | 缓存元数据（`version`、`target`、`bun` 等） |
| `~/.config/manicode/.freebuff-download-temp/` | 下载解压临时目录 |
| `~/.config/manicode/cpu-features.json` | AVX2 检测缓存（343） |

### E3. 版本来源（三级）

1. **wrapperVersion = 0.0.149**（npm 包自身版本）：`getRequiredWrapperVersion`（888-899）—— 当二进制缓存版本 **<** wrapperVersion 时**强制**下载 wrapperVersion（npm 升级后同步二进制；`compareVersions(current, wrapperVersion) >= 0` 时不走此路径）。
2. **registry 最新版**：`getLatestVersion()`（427-440）= `GET https://registry.npmjs.org/freebuff/latest` → `.version`；非 200 / JSON 解析失败 / 网络异常 → `null`。
3. **缓存元数据**：`getCurrentVersion()` 读 metadata + 校验二进制存在 + target 与本机匹配；崩溃重试路径用 `metadata?.version || getLatestVersion()`（1364）。

### E4. 下载逻辑（stageBinary，749-764）

```
fileName    = PLATFORM_TARGETS[targetKey]
             = freebuff-{linux-x64|linux-x64-baseline|linux-arm64|darwin-x64|darwin-arm64|win32-x64|win32-x64-baseline}.tar.gz
downloadUrl = ${NEXT_PUBLIC_CODEBUFF_APP_URL || "https://codebuff.com"}/api/releases/download/${version}/${fileName}
```

流程：`downloadAndExtract`（tar.gz，`tar` npm 包）→ chmod 755 → `replaceFileWithRollback`（旧文件改名 `.old.<ts>` 再原子替换，失败回滚）。HTTP 客户端 `createReleaseHttpClient`（http.js）支持代理：`HTTP_PROXY`/`HTTPS_PROXY`（https 优先 HTTPS_PROXY）、`NO_PROXY`（域名通配/`*`/去端口匹配）、HTTPS 代理走 CONNECT 隧道。

### E5. 失败容忍（ensureBinaryReady，901-932）

| 场景 | 行为 |
|---|---|
| 缓存二进制有效且无需 repair | 直接启动，**不查 registry** |
| 需要版本但 registry/repair 都拿不到 | 打印 `Failed to determine latest version` + 网络提示 → `process.exit(1)` |
| 下载失败且存在有效缓存 | 打印错误，**用缓存继续启动** |
| 下载失败且无缓存 | `process.exit(1)` |
| 启动即崩溃 | `recordMachineLacksAvx2` / `-baseline` 回退下载重试（1364-1391）；仍失败则退出 |
| telemetry | 各失败点 `trackUpdateFailed(error, version, { stage })`（事件 `cli.update_freebuff_failed`） |

### E6. 与 free-buff-lol 的关系

`versions.js:checkAndUpdateVersions` 抓取 `freebuff2api_rs` 源码中的 `"Bun/(\d+\.\d+\.\d+)"` 与 npm registry 更新版本字符串（`Bun/1.3.11`、`Freebuff-CLI/0.0.149`、`ai-sdk ... provider-utils/3.0.25`）—— 这是对 **CLI 二进制**（Bun 运行时）发往 `www.codebuff.com` 各 API 的 UA 的模拟；launcher 本身只与 `registry.npmjs.org` 和 `codebuff.com/api/releases` 通信，两者互不重叠。

---

## F. 辅助请求总表（触发 / 格式 / 失败容忍）

| 请求 | 触发 | 格式 | 超时 | 失败行为 | 阻塞 chat？ | 影响 session/rate limit？ |
|---|---|---|---|---|---|---|
| `/api/v1/ads`（inline） | turn 中第 1/4/7/10 个节点后，≤4 次/轮 | POST，见 A2 | 10s | `null`/`[]`，静默 | 否（fire-and-forget） | 否 |
| `/api/v1/ads`（slot） | 渲染层挂载 + 每 60s；30s 窗口 ≤3 次 | 同上，messages=[] | 10s | `[]`，轮换本地缓存 | 否 | 否 |
| `/api/v1/ads/impression` | 广告渲染 mount（impUrl 去重） | POST `{impUrl, mode:"desktop"}` | 10s | catch 忽略 | 否 | 否 |
| `/api/v1/ads/click` | 广告点击/中键 | POST `{impUrl}` | 10s | catch 忽略 | 否 | 否 |
| `/api/v1/freebuff/streak` | 仅状态面板打开时 | GET，仅 Authorization | 10s | `null`，UI 静默 | 否 | 否 |
| `/api/agents/validate` | **desktop 从不调用**；SDK remote 时 | POST，仅 Content-Type | 无 | 结构化 network_error | 否（CLI 路径） | 否 |
| session 准入 | 每 turn 开始，**阻塞** | POST，见 chat-spec E | 15s | 重试 [500,1000]ms | **是** | **是**（rateLimitsByModel 来源） |

---

## G. free-buff-lol 差异清单（辅助请求部分）

| # | 项目 | 官方（desktop 0.0.61） | free-buff-lol | 结论 |
|---|---|---|---|---|
| 1 | ads body 结构 | `{ surface:"cli_chat"?, placementId, messages, sessionId, device, userAgent }`，placementId 必填 | `requestAds`：`{ provider, messages, sessionId, device, userAgent }` **无 placementId**；dashboard `/api/ads`：`{ provider:"gravity", surface:"waiting_room", ... }` 无 placementId | ❌ 官方用 `placementId` 定位广告位；user 端 `provider`/`surface:"waiting_room"` 不是官方 0.0.61 的任何取值（官方 surface 仅 inline 用 `"cli_chat"`） |
| 2 | ads body device | 真实 `process.platform` + `Intl` timezone/locale（缓存） | 硬编码 `{ os:"windows", timezone:"Asia/Shanghai", locale:"zh-CN" }`（requestAds）；dashboard 用真实 timezone + `en-US` | ⚠️ 若服务端按 device 定向或风控，硬编码是风险点 |
| 3 | ads body userAgent | Chrome 124 三平台 UA（伪装浏览器） | `Bun/1.3.11`（requestAds）/ Chrome 124（dashboard `/api/ads`） | ⚠️ 不一致：requestAds 传的 `userAgent` 字段是 Bun 版本而非浏览器 UA |
| 4 | ads 请求头 UA | `Freebuff-Desktop/<ver>` | `Freebuff-CLI/0.0.149`（`getAdsUserAgent`） | ⚠️ 版本号轨道不同（desktop 0.0.61 vs CLI 0.0.149）；服务端对 UA 版本敏感度未知 |
| 5 | impression mode | `"desktop"` | `"LITE"`（默认）/ 透传 | ⚠️ mode 取值不同（`LITE` 疑为旧 CLI 时代取值） |
| 6 | zeroclick | **官方 0.0.61 无任何 zeroclick 代码**（bundle 内 0 处） | `reportZeroclickImpression` → `zeroclick.dev/api/v2/impressions`（UA Bun/1.3.11，ids 数组，≥400 记录） | ⚠️ user 独有特性；来源不明（疑为早期 CLI 或第三方）；对 codebuff 官方接口无影响 |
| 7 | streak 请求头 | 仅 Authorization + accept，**无 UA** | `doJSON` 带 `apiHeaders`（HAR 风格：`User-Agent: Bun/1.3.11`、`Accept-Encoding: gzip, deflate`、`Connection: keep-alive`、`Host`） | ⚠️ 头部集合不同（官方更干净） |
| 8 | streak 触发 | 仅面板打开时一次 | 每次 chat 请求前（与 validate/ads 并行的非阻塞段） | ⚠️ 频率远高于官方；被服务端按频率统计时可能暴露代理行为 |
| 9 | validateAgents | desktop 从不调用；SDK remote 无 UA 无超时 | 每次 chat 前调用 + `Bun/1.3.11` UA + 自建 payload（日期硬编码 2026-08-15） | ⚠️ 高频触发 + 非官方 body（CLI 版定义格式）；建议降频或仅启动时调用 |
| 10 | slot 轮询节奏 | 60s 轮询 + 30s 窗口 3 次上限 + 用户活动重置 | dashboard 每 30s 轮换（无窗口上限） | ⚠️ 节奏不同，频率略高 |
| 11 | sessionId | inline=`threadId`；slot=`threadId ?? "desktop-slot"` | `crypto.randomUUID()`（dashboard）/ 上游透传 | ⚠️ 官方用真实 threadId 关联会话 |
| 12 | 失败容忍 | 全部静默（null/[]/catch 忽略），绝不阻塞 chat | 基本一致（广告失败返回 `[]`、streak/validate 打印后继续） | ✅ 一致 |

### 汇总

- **一致（可放心）**：辅助请求全部非阻塞、静默失败；ads/streak 与 session/rate limit 零耦合（官方证实）。
- **必须修（wire 差异）**：#1 ads body 无 `placementId`（服务端可能无法路由到具体广告位，导致恒空广告）。
- **建议修**：#3 requestAds 的 body `userAgent` 改用 Chrome UA（对齐官方伪装语义）；#5 impression mode 改 `"desktop"`；#8 streak 降频；#9 validateAgents 改启动时/低频调用并去掉 Bun UA（官方无 UA）。
- **有意为之/保留**：#6 zeroclick（user 独有链路，与官方无关）；#2 硬编码 device（若有意伪装 Windows 用户可保留，注意 locale 与 timezone 组合需自洽）。
- **无法本地验证**：服务端对 `placementId` 缺失、`mode:"LITE"`、`provider` 字段的实际容忍度（建议抓包对照官方 desktop 的 wire）。

---

## 附录：关键行号索引（orchestrator.js）

| 事实 | 位置 |
|---|---|
| AD_USER_AGENTS / getAdUserAgent | 124061-124069 |
| ads.ts 常量（placement/UA/timeout） | 124077 |
| deviceInfo() | 124079-124088 |
| Ads 类（inlineAd/slotAd/impression/click/auction/post） | 124095-124160 |
| MAX_MESSAGE_AD_COUNT | 125269 |
| AD_NODE_THRESHOLDS | 127208 |
| maybeRequestAd（inline 触发） | 127322-127326 |
| countResponseNodes | 127600 |
| recentMessageTexts | 131086 |
| POST /api/ad/slot | 133137-133140 |
| POST /api/ad/impression（desktop.ad_shown） | 133148-133155 |
| POST /api/ad/click | 133164 |
| streak.ts（STREAK_TIMEOUT_MS/parse/fetch） | 132718-132742 |
| GET /api/streak | 133093-133105 |
| freebuff-streak util（GLM bonus） | 132990-132996 |
| freebuff-streak-line（line/bonusNote） | 132999-133020 |
| validateAgents2（SDK remote 同源） | 89511 / 89530 |
| loadLocalAgents（desktop 本地校验，不调远程） | 89623-89680 / 90055 |
| getRateLimitsByModel / 消费点 | 121397 / 122023 |
| sessionEndpoint / 会话常量 | 121763 / 121765-121772 |
| getUserInfoFromApiKey（/api/v1/me） | 87155-87165 |
| getFreebuffStreakLine / WEEK=7 | 132999-133004 |
| VERSION2 (gateway) / VERSION3 (ai) / VERSION (provider-utils) / VERSION4 / VERSION5 | 25496 / 38547 / 23187 / 87697 / 88814 |
| getRuntimeEnvironmentUserAgent3 / withUserAgentSuffix3 | 87664 / 87693 |

**CLI launcher（launcher.js）**

| 事实 | 位置 |
|---|---|
| 目录/二进制/metadata/UA | 141-153 |
| PLATFORM_TARGETS（tar.gz 文件名表） | 231-239 |
| cpu-features.json（AVX2） | 343 |
| getLatestVersion（npm registry） | 427-440 |
| stageBinary（下载 URL） | 749-764 |
| getRequiredWrapperVersion（wrapperVersion 强制修复） | 888-899 |
| ensureBinaryReady（失败容忍） | 901-932 |
| baseline 回退下载 | 1364-1391 |