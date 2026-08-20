# Freebuff2Opencode Proxy — Developer Guide

OpenAI- and Anthropic-compatible HTTP proxy that fronts Codebuff's free API
(`www.codebuff.com`). Translated from the Go Freebuff2API to Node.js/Bun. The
wire protocol is a byte-for-byte mimic of the **official desktop orchestrator**;
upstream gates on headers, body shape, system prompts, and tool names.

## Project Structure

```
proxy.js              # Entry point only (~110 lines): startup orchestration
src/                  # All logic (15 CommonJS modules)
  state.js            # Mutable shared runtime state singleton
  constants.js        # Immutable constants (URLs, aliases, agent/tool tables)
  config.js           # Config load/save + Freebuff CLI credential discovery
  versions.js         # Runtime version refresh + proxy self-update check
  model-registry.js   # Model <-> agent registry (GitHub hot-update + fallback)
  upstream.js         # UpstreamClient: all calls to codebuff.com
  net-agent.js        # Egress proxy (UPSTREAM_PROXY: http/https/socks4/socks5)
  messages.js         # Message normalization + signature-tool injection
  run-chain.js        # Agent-run lifecycle (single-loop START/FINISH)
  token-pool.js       # Round-robin tokens + session cache + heartbeat
  token-validator.js  # Startup token validation + account-ban detection
  anthropic.js        # Anthropic <-> OpenAI conversion + Claude SSE writer
  util.js             # Generic helpers (debounce, aliases, schema, streams)
  oauth.js            # Official sign-in flow (CLI mode + HTTP handlers)
  handlers.js         # HTTP router + chat proxying + country detection
dashboard.html        # Liquid-glass web UI (served at /)
docs/                 # Reverse-engineered wire specs (READ before touching upstream)
.config/              # Runtime state (config.json, sessions.json, tokens.json)
```

There is **no test suite** — `node --check proxy.js && node --check src/*.js`
is the only verification. `skills.md` and `DASHBOARD_GUIDE.md` document the
dashboard. There is **no `.gitignore`** — never commit `.config/` or `node_modules/`.

## Commands

```bash
node proxy.js                 # or `npm start` (default listen 127.0.0.1:3001)
npm run dev                   # node --watch proxy.js
npm run start:bun             # Bun runtime
node --check proxy.js         # syntax check (also: node --check src/*.js)
node src/oauth.js             # interactive Freebuff sign-in (saves token)
```

## Config

Loaded from `.config/config.json`, overridden by env vars
(`LISTEN_ADDR`, `UPSTREAM_BASE_URL`, `REQUEST_TIMEOUT`, `AUTH_TOKENS`,
`API_KEYS`, `ENABLED_MODELS`, `MOCK_COUNTRY`, `UPSTREAM_PROXY`,
`ACTING_USER_ID`). Defaults: listen `:3001`, upstream `https://www.codebuff.com`,
timeout `15m`. Tokens are also auto-discovered from
`~/.config/manicode/credentials.json` (the official CLI credential file).

`UPSTREAM_PROXY` routes *all* upstream traffic — chat, sessions, ads,
agent-runs, the country probe, and the OAuth flow — through a configured egress
proxy so the access tier is judged on the proxy's region, not the host's.

## Architecture Rules

1. **Shared state** lives in `src/state.js` (`state.config`, `state.modelRegistry`,
   `state.tokenPool`, `state.versions`, `state.traceSessionId`, `state.detectedCountry`).
   Modules read/write this singleton instead of holding their own globals.
2. **All upstream traffic** goes through `net-agent.proxiedFetch` (a wrapped
   `node-fetch`), never bare `fetch`/`https.get` — this is what honors
   `UPSTREAM_PROXY`. (Exception: `util.httpGet` and `model-registry.fetchSource`
   route through `net-agent.getAgent()`.)
3. `constants.js` is **immutable**; version strings that change at runtime live
   in `state.versions` (refreshed by `versions.js`).
4. `state.config` is authoritative — after any config change call
   `saveConfig()` (config.js) and, if tokens changed, `reloadTokenPool()`
   (token-validator.js).

## Critical Upstream Invariants

These are the anti-abuse gates that break silently if you touch the wrong line:

- **Freebuff system marker** (`messages.js`): proxied `messages` must open with
  the verbatim Buffy opening — `You are Buffy, the strategic coding assistant.`
  (base2) or `You are Buffy, the coding agent behind Codebuff.` (base3) at
  position 0, else upstream 403s. No "override/ignore" clause may follow.
- **Outbound body whitelist** (`handlers.proxyChatRequest`): only
  `{ model, messages, stream, stop, tools, tool_choice, codebuff_metadata, provider }`
  is sent. Third-party SDK fields (temperature, top_p, seed, stream_options,
  response_format, …) are scrubbed. `stop` is always `["\"cb_easp\""]`.
- **Signature-tool injection** (`ensureSignatureTool`): a toolset containing no
  Freebuff signature tool name is silently downgraded upstream to
  `inclusionai/ling-3.0-tiny:free`. Inject `write_todos`/`suggest_followups`
  when the caller ships only generic tool names.
- **Single-loop run chain** (`run-chain.js`): one `START` + one `FINISH` per
  chat request (step 1, totalSteps 1). There is no context-pruner child run and
  no separate gemini parent/chat pair anymore — `startRunChainNormal`,
  `startRunChainGemini`, and `startRunChainSimple` are equivalent.
- **Session admission** (`token-pool.js`/`upstream.js`): single POST, no polling
  loop — only `active`/`disabled` are accepted, anything else is a terminal
  `FreebuffSessionError` surfaced to the client. Sessions are reusable up to a
  30-min grace window after `expiresAt`; a 45s `x-freebuff-heartbeat: 1` GET
  keeps the instance alive. Instances persist across restarts via
  `.config/sessions.json` and are re-validated (GET) before reuse.
- **Model lock**: a server-side model binding is *accepted*, never churned —
  re-admission burns quota at 0.1h granularity and the server re-binds anyway.
  Full tier does an explicit switch (DELETE old instance + POST requested model).
- **429**: the token enters cooldown and the retry rotates to another account
  (up to 3 tries). A cross-account retry must first close the abandoned run with
  a failed `FINISH`, then re-admit session + run on the new account.
- **Account ban detection**: startup `GET /api/v1/me` probe +
  runtime `account_suspended`/`banned` detection → `markTokenBanned()` removes
  the token from rotation. A chat `401` → `markTokenInvalid()` (sign-in revoked).
- **Two fetch flavors**: `node-fetch` yields Node streams, global `fetch` yields
  web `ReadableStream`. Always use `readBodyText()` / `pipeBodyToResponse()` /
  `isNodeStream()` from `util.js` when consuming upstream bodies.
- **Debounce**: 1.3s minimum gap between proxied chat requests (`util.debounceRequest`).
- **Debug**: `WIRE_DEBUG=1` prints outbound chat headers/body.

## Model Registry

`model-registry.js` applies a hardcoded 8-model table immediately (startup never
blocks on network), then hot-updates in the background from four GitHub sources:
`free-agents.ts`, `freebuff-models.ts`, `freebuff-model-ids.ts`, `model-config.ts`
(parse → resolve variable map → build `model -> agent` + metadata). Current roots
are `base3-*` single-loop agents. `CANONICAL_MODEL_ALIASES` maps slashless slugs
(e.g. `deepseek-v4-pro`) to wire IDs; `resolveFullModelId` is called *before* any
session work so the session lock matches. `BLACKLISTED_MODEL_PATTERNS` (/glm/i)
filters excluded models.

## HTTP Endpoints (router in `handlers.handleRequest`)

- OpenAI: `/v1/chat/completions`, `/v1/models`
- Anthropic: `/v1/messages`, `/v1/messages/count_tokens`
- Ops: `/healthz`, `/api/config`, `/api/tokens`, `/api/models`, `/api/session/unlock`
- OAuth: `/api/auth/start`, `/api/auth/status`, `/api/auth/cancel`
- Ads/streak: `/api/ads`, `/api/ads/impression`, `/api/ads/click`, `/api/streak`
- UI: `/` and `/dashboard` (serves dashboard.html), `/api/bg` (Bing wallpaper)

## Read Before Changing Sensitive Areas

- `docs/official-desktop-chat-request-spec.md` — authoritative chat wire format.
- `docs/official-desktop-aux-requests-spec.md` — session/ads/agent-runs/streak format.
- `DASHBOARD_GUIDE.md`, `README.md` — user-facing docs (README is partly stale).

## Security Notes

- `.config/` holds live tokens (`tokens.json` is written with `0600`). **There is
  no `.gitignore`** — do not commit `.config/` or `node_modules/`.
- Tokens are masked (`first8...last4`) in `/healthz`, `/api/tokens`, and the dashboard.
- `API_KEYS` enables proxy auth (`x-api-key` header or `Authorization: Bearer`).
