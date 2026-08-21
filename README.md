# Free-Buff Proxy

OpenAI- 与 Anthropic-兼容的 HTTP 代理，前端对接 Codebuff 的免费 API（`www.codebuff.com`）。由 Go 版 [Freebuff2API](https://github.com/Quorinex/Freebuff2API) 翻译为 Node.js/Bun，线协议逐字节模仿**官方桌面 orchestrator**——上游按请求头、请求体结构、系统提示词和工具名做反滥用校验。

## 功能

- **OpenAI 兼容** — `/v1/chat/completions`（SSE 流式）+ `/v1/models`
- **Anthropic 兼容** — `/v1/messages` + `/v1/messages/count_tokens`，自动格式转换
- **多 Token 轮询** — 多个账号 token 轮询，会话缓存 + 45s 心跳 + 跨重启持久化
- **模型锁处理** — full tier 按请求显式切换会话（DELETE + POST）；limited tier 在服务端锁定时复用绑定会话
- **配额可见** — dashboard 逐模型显示 `已用/上限` 进度条；控制台逐请求打印 `[Quota]` 摘要
- **动态模型注册表** — 从 GitHub 拉取官方模型/agent 映射，网络不可用时回退到硬编码表
- **出口代理** — `UPSTREAM_PROXY` 支持 http/https/socks4/socks5，让访问 tier 按出口节点地区判定
- **OAuth 登录** — 复刻官方 CLI issue+poll 流，登录后保存到项目 `.config/`（0600）
- **仪表盘** — 零依赖自包含 UI（无 CDN/壁纸/外部请求）：token/session 状态、逐模型配额与重置倒计时、full/limited tier、OAuth、广告、国家显示
- **状态兼容** — 以服务端 session 状态和 `availableHours` 为准，避免用过时的客户端模型 metadata 推断可用性
- **客户端兼容** — OpenAI 响应会递归移除 provider 不兼容的 `reasoning_details` 字段，避免严格 SDK 解析失败
- **HAR 风格指纹** — 浏览器兼容请求头（`Accept-Encoding`/`Connection`/`Host`/UA）过上游校验
- **429 重试** — 跨账号轮换重试（最多 3 次），先关闭废弃 run 再重新入场

## 架构

```
proxy.js                  # 入口（~110 行）：启动编排
src/                      # 全部逻辑（15 个 CommonJS 模块）
  state.js                # 可变共享运行时状态单例
  constants.js            # 不可变常量（URL、别名、agent/tool 表）
  config.js               # 配置加载/保存 + Freebuff CLI 凭据发现
  versions.js             # 运行时版本刷新 + 代理自更新检查
  model-registry.js       # 模型 <-> agent 注册表（GitHub 热更新 + 回退）
  upstream.js             # UpstreamClient：所有对 codebuff.com 的调用
  net-agent.js            # 出口代理（UPSTREAM_PROXY）
  messages.js             # 消息规范化 + 签名工具注入
  run-chain.js            # Agent-run 生命周期（单循环 START/FINISH）
  token-pool.js           # 轮询 token + 会话缓存 + 心跳
  token-validator.js      # 启动 token 校验 + 账号封禁检测
  anthropic.js            # Anthropic <-> OpenAI 转换 + Claude SSE 写入
  util.js                 # 通用工具（防抖、别名、schema、流）
  oauth.js                # 官方登录流（CLI 模式 + HTTP handler）
  handlers.js             # HTTP 路由 + 聊天代理 + 国家检测
dashboard.html            # 自包含 Web UI（服务在 /，零外部依赖）
docs/                     # 逆向的线格式规格（改上游前必读）
.config/                  # 运行时状态（config.json、sessions.json、tokens.json、credentials.json）
```

## 安装

```bash
npm install
node proxy.js        # 默认监听所有接口的 0.0.0.0:3001
```

或使用 Bun：

```bash
npm run start:bun
```

开发模式（自动重载）：

```bash
npm run dev
```

## 配置

配置加载自 `.config/config.json`，可被环境变量覆盖：

| 键 | 说明 | 默认 |
|----|------|------|
| `LISTEN_ADDR` | 监听地址 | `:3001` |
| `UPSTREAM_BASE_URL` | Freebuff 后端 URL | `https://www.codebuff.com` |
| `REQUEST_TIMEOUT` | 上游请求超时 | `15m` |
| `AUTH_TOKENS` | Freebuff auth token 数组 | `[]` |
| `API_KEYS` | 代理鉴权 key（启用后客户端需带 key） | `[]`（开放访问） |
| `ENABLED_MODELS` | 启用的模型列表 | 全部 |
| `MOCK_COUNTRY` | 模拟国家（测试用） | 无 |
| `UPSTREAM_PROXY` | 出口代理（http/https/socks4/socks5） | 无 |
| `ACTING_USER_ID` | 覆盖 `x-freebuff-acting-user-id` | 从凭据自动读取 |

对应环境变量：`LISTEN_ADDR`、`UPSTREAM_BASE_URL`、`REQUEST_TIMEOUT`、`AUTH_TOKENS`、`API_KEYS`、`ENABLED_MODELS`、`MOCK_COUNTRY`、`UPSTREAM_PROXY`、`ACTING_USER_ID`。

### UPSTREAM_PROXY（区域控制）

Freebuff 的访问 tier（full/limited）是**按出口 IP 地区**判定的。设置 `UPSTREAM_PROXY` 会把所有上游流量（会话、聊天、广告、agent-run、国家探测、OAuth）都路由到配置的代理，让 tier 按代理节点的地区判定，而非宿主机。

支持内嵌凭据：`socks5://user:pass@host:port`。

### 开启 API Key 鉴权

默认开放访问。设置 `API_KEYS` 后客户端需带 key：

```bash
curl -H "Authorization: Bearer my-secret-key" http://127.0.0.1:3001/v1/models
# 或 x-api-key 头
```

生成随机 key：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 认证 Token

有三种方式获取 token：

1. **仪表盘 OAuth** — 打开 `http://127.0.0.1:3001`，点 "Generate Auth Token"，浏览器完成 GitHub 登录。保存到 `.config/credentials.json` + `.config/tokens.json`（0600）。
2. **官方 CLI** — `npm i -g freebuff && freebuff`，token 存到 `~/.config/manicode/credentials.json`，代理自动发现。
3. **手动** — 把 token 写入 `.config/config.json` 的 `AUTH_TOKENS`。

> 读取顺序：项目 `.config/credentials.json` 优先，官方 `~/.config/manicode/credentials.json` 作为 fallback。

## 用法

### OpenAI 客户端

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:3001/v1',
  apiKey: 'not-needed'
});

await client.chat.completions.create({
  model: 'deepseek-v4-flash',   // 短别名自动解析
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### Anthropic 客户端

```javascript
await fetch('http://127.0.0.1:3001/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek/deepseek-v4-pro',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello!' }]
  })
});
```

## 模型与实时配额

注册表从 Codebuff 源码热更新；网络不可用时使用下表作为启动回退（agent
均为 base3 单循环）。这张表是路由和展示 metadata，不是实时权限或配额表；
实际可用模型、访问 tier 和限额以服务端 session 响应为准。

| 模型 | 类型 |
|------|------|
| `deepseek/deepseek-v4-pro` | premium |
| `deepseek/deepseek-v4-flash` | 服务端决定 |
| `openai/gpt-5.6-luna` | premium |
| `minimax/minimax-m3` | 服务端决定 |
| `mimo/mimo-v2.5` | 服务端决定 |
| `anthropic/claude-fable-5` | 服务端决定（可能限时） |
| `google/gemini-3.1-flash-lite` | 服务端决定 |
| `google/gemini-3.1-pro-preview` | 服务端决定 |

短别名自动解析（如 `deepseek-v4-pro` → `deepseek/deepseek-v4-pro`），完整表见
`src/constants.js` 的 `CANONICAL_MODEL_ALIASES`。`glm` 系模型默认黑名单。

`/healthz` 的 `quota_by_model` 只显示上游实际返回的 `rateLimitsByModel`：有
`limit` 的模型显示 `recentCount/limit`，没有条目不代表无限额度，也不代表当前
可用。`session_detail` 的 `model_unavailable`、`message` 和 `availableHours`
是判断模型时段的权威来源。dashboard 另外显示北京时间、US Pacific、US Eastern
时钟，以及按 Pacific 时区计算的配额重置倒计时；这些时钟用于对照节点和本地时间，
不能替代上游状态。

## API 端点

### 核心

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/healthz` | 健康检查 + token/session/tier/绑定模型/配额/可用时段状态 |
| `GET` | `/v1/models` | OpenAI 模型列表 |
| `POST` | `/v1/chat/completions` | OpenAI 聊天（流式） |
| `POST` | `/v1/messages` | Anthropic 消息（自动转 OpenAI） |
| `POST` | `/v1/messages/count_tokens` | Anthropic token 计数 |

### 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET`/`POST` | `/api/config` | 读取/更新配置 |
| `GET` | `/api/tokens` | 列出 token（脱敏）+ 封禁/冷却状态 |
| `GET` | `/api/models` | 注册表模型 + 元数据 |
| `POST` | `/api/auth/start` | 发起 OAuth 流 |
| `POST` | `/api/auth/status` | 轮询 OAuth（自动保存 token） |
| `POST` | `/api/auth/cancel` | 取消 OAuth |
| `POST` | `/api/session/unlock` | 清除所有模型锁 |
| `GET` | `/api/ads` | 上游广告 |
| `POST` | `/api/ads/impression` | 广告曝光上报 |
| `POST` | `/api/ads/click` | 广告点击上报 |
| `GET` | `/api/streak` | 签到状态 |

## 警告

- **数据收集**：DeepSeek 模型明确标注 "Collects data for training"，敏感代码请避免使用，改用 `mimo/mimo-v2.5`。
- **封号风险**：此代理绕过 Freebuff 的 CLI-only 校验（省略 `cost_mode` 字段），违反其 ToS，账号可能被封禁。使用风险自负。
- **限时模型**：`claude-fable-5` 的可用时段由上游 session 的
  `model_unavailable.availableHours` 决定。不要用固定北京时间区间推断可用性；
  夏令时、工作日规则及服务端临时调整都可能影响实际结果。

## 依赖

- `node-fetch` — HTTP 客户端（SOCKS5/HTTPS 代理支持）
- `socks-proxy-agent` / `https-proxy-agent` — 出口代理
- `freebuff` — CLI token 检测（版本指纹）
- Node.js 内建：`http`、`https`、`fs`、`path`、`crypto`、`url`

## 致谢

- 直接来源：[free-buff-lol](https://github.com/notBlubbll/free-buff-lol) by notBlubbll（本项目为其二开）
- 原 Go 实现：[Freebuff2API](https://github.com/Quorinex/Freebuff2API) by Quorinex
- [freebuff-proxy](https://github.com/ferdiunal/freebuff-proxy) by ferdiunal
- Freebuff / Codebuff 后端

## License

MIT
