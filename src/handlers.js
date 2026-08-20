// HTTP handlers + main request router + country detection.
// proxyChatRequest gains runtime account-ban detection: when upstream answers
// with account_suspended / banned, the token is marked banned and removed from
// rotation instead of being blindly retried.

const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const crypto = require('crypto');

const {
  FALLBACK_AGENT_IDS,
  FREEBUFF_DOWNGRADE_MODEL_ID,
} = require('./constants');
const { state } = require('./state');
const {
  debounceRequest,
  resolveFullModelId,
  cloneMap,
  cloneSlice,
  normalizeToolSchemas,
  generateClientSessionId,
  isSessionInvalid,
  isRunInvalid,
  readBodyText,
  pipeBodyToResponse,
  isNodeStream,
} = require('./util');
const {
  normalizeChatMessages,
  ensureSignatureTool,
  BUFFY_BASE2_SYSTEM_PROMPT_OPENING,
  BUFFY_BASE3_SYSTEM_PROMPT_OPENING,
} = require('./messages');
const { saveConfig } = require('./config');
const { getAdsUserAgent } = require('./versions');
const { FREE_DESKTOP_ADS_USER_AGENT } = require('./constants');
const { reloadTokenPool } = require('./token-validator');
const { proxiedFetch } = require('./net-agent');
const oauth = require('./oauth');
const {
  startRunChainNormal,
  startRunChainGemini,
  startRunChainSimple,
  finalizeRunChainNormal,
  finalizeRunChainGemini,
  finalizeRunChainSimple,
  finalizeRunFailed,
  isGeminiModel,
  getGeminiSubagentId,
} = require('./run-chain');
const {
  convertClaudeMessagesRequestToOpenAI,
  writeClaudeSuccessResponse,
} = require('./anthropic');

function authorized(req) {
  const config = state.config;
  if (!config.apiKeys || config.apiKeys.length === 0) return true;
  const xApiKey = (req.headers['x-api-key'] || '').trim();
  if (xApiKey && config.apiKeys.includes(xApiKey)) return true;
  const authorization = (req.headers['authorization'] || '').trim();
  if (!authorization.startsWith('Bearer ')) return false;
  return config.apiKeys.includes(authorization.substring(7).trim());
}

function isClaudeRequestPath(pathname) { return pathname.startsWith('/v1/messages'); }

function writeJSON(res, statusCode, payload) {
  try { res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); }
  catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"encode failed","type":"server_error"}}'); }
}

function writeOpenAIError(res, statusCode, message, errorType, code) {
  if (!message) message = http.STATUS_CODES[statusCode] || 'Unknown error';
  const payload = { error: { message, type: errorType } };
  if (code) payload.error.code = code;
  writeJSON(res, statusCode, payload);
}

function writeClaudeError(res, statusCode, message, errorType) {
  if (!message) message = http.STATUS_CODES[statusCode] || 'Unknown error';
  if (!errorType) errorType = 'api_error';
  writeJSON(res, statusCode, { type: 'error', error: { type: errorType, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleHealthz(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  const config = state.config;
  const tokenPool = state.tokenPool;
  const modelRegistry = state.modelRegistry;
  const tokenState = [];
  for (const token of tokenPool.tokens) {
    const maskedToken = token.substring(0, 8) + '...' + token.substring(token.length - 4);
    const allSessions = [];
    for (const [key, session] of tokenPool.sessions.entries()) {
      if (key.startsWith(token + ':')) allSessions.push(session);
    }
    const bestSession = allSessions.find(s => s.status === 'active') || allSessions[0] || null;
    const lockedModel = tokenPool.lockedModels.get(token) || null;
    // Zero-cost quota snapshot (refreshTier GET, cached 30s). Fills
    // rateLimitsByModel when the POST admission body omitted it.
    const snap = await tokenPool.refreshQuotaSnapshot(token);
    const quotaByModel = bestSession?.rateLimitsByModel || snap?.rateLimitsByModel || null;
    tokenState.push({
      name: `token-${tokenPool.tokens.indexOf(token) + 1}`,
      token: maskedToken,
      session_status: bestSession?.status || 'none',
      session_instance_id: bestSession?.instanceID || null,
      session_expires_at: bestSession?.expiresAt || null,
      country_code: bestSession?.countryCode || state.detectedCountry || null,
      access_tier: bestSession?.accessTier || snap?.accessTier || null,
      country_block_reason: bestSession?.countryBlockReason || null,
      remaining_ms: bestSession?.remainingMs || null,
      // Current server-bound model (the model the live session is admitted on).
      model: bestSession?.model || null,
      locked_model: lockedModel,
      // Official quota visibility (SessionManager snapshot quotaByModel):
      // per-model limit / recentCount / resetAt from the session body.
      quota_by_model: quotaByModel,
      quota: bestSession?.quota || null,
      desktop_session_counts: snap?.desktopSessionCounts || null,
      referral: snap?.referral || null,
      runs: []
    });
  }
  writeJSON(res, 200, {
    ok: true, started_at: state.startTime.toISOString(),
    uptime_sec: Math.floor((Date.now() - state.startTime.getTime()) / 1000),
    token_state: tokenState,
    banned_tokens: tokenPool.getBannedTokens(),
    invalid_tokens: tokenPool.getInvalidTokens(),
    models_count: modelRegistry.getModels().length,
    valid_tokens: tokenPool.tokens.length,
    locked_tokens: tokenState.filter(t => t.locked_model).length,
    runtime: state.isBun ? 'bun' : 'node',
    runtime_version: state.runtimeVersion
  });
}

async function handleModels(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  const created = Math.floor(state.startTime.getTime() / 1000);
  writeJSON(res, 200, { object: 'list', data: state.modelRegistry.getModels().map(m => ({ id: m, object: 'model', created, owned_by: 'Freebuff2Opencode', root: m, permission: [] })) });
}

async function handleChatCompletions(req, res) {
  if (req.method !== 'POST') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeOpenAIError(res, 400, 'failed to read request body', 'invalid_request_error', ''); return; }
  let payload;
  try { payload = JSON.parse(requestBody); } catch (e) { writeOpenAIError(res, 400, 'request body must be valid JSON', 'invalid_request_error', ''); return; }
  const requestedModel = (payload.model || '').trim();
  if (!requestedModel) { writeOpenAIError(res, 400, 'model is required', 'invalid_request_error', ''); return; }
  await proxyChatRequest(res, payload, requestedModel, writeOpenAIError, writePassthroughError, writeOpenAISuccessResponse);
}

async function handleClaudeMessages(req, res) {
  if (req.method !== 'POST') { writeClaudeError(res, 405, 'method not allowed', 'invalid_request_error'); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeClaudeError(res, 400, 'failed to read request body', 'invalid_request_error'); return; }
  let payload, requestedModel, stream;
  try { ({ payload, modelName: requestedModel, stream } = convertClaudeMessagesRequestToOpenAI(requestBody)); } catch (e) { writeClaudeError(res, 400, e.message, 'invalid_request_error'); return; }
  await proxyChatRequest(res, payload, requestedModel, (r, s, m, t, _) => writeClaudeError(r, s, m, t), writeClaudePassthroughError, (r, resp) => writeClaudeSuccessResponse(r, resp, requestedModel, stream));
}

async function handleClaudeCountTokens(req, res) {
  if (req.method !== 'POST') { writeClaudeError(res, 405, 'method not allowed', 'invalid_request_error'); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeClaudeError(res, 400, 'failed to read request body', 'invalid_request_error'); return; }
  let payload, requestedModel;
  try { ({ payload, modelName: requestedModel } = convertClaudeMessagesRequestToOpenAI(requestBody)); } catch (e) { writeClaudeError(res, 400, e.message, 'invalid_request_error'); return; }
  writeJSON(res, 200, { input_tokens: countOpenAIPayloadTokens(requestedModel, payload) });
}

function countOpenAIPayloadTokens(model, payload) {
  const segments = [];
  if (Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (m && typeof m === 'object') {
        if (m.role) segments.push(m.role);
        if (typeof m.content === 'string') segments.push(m.content);
        else if (Array.isArray(m.content)) {
          for (const p of m.content) if (p && typeof p === 'object' && p.type === 'text' && p.text) segments.push(p.text);
        }
      }
    }
  }
  return Math.ceil(segments.join('\n').length / 4);
}

/**
 * Runtime ban detector. Returns a { banned, reason } verdict for a non-2xx
 * upstream response. Recognizes:
 *   - error === 'account_suspended' (chat endpoint)
 *   - message containing 'suspended'/'banned' (chat endpoint)
 *   - session body {"status":"banned"}
 *   - HTTP 403 with 'banned'/'suspended' in the body
 */
function detectAccountSuspension(statusCode, body) {
  const text = (body || '').substring(0, 800);
  try {
    const parsed = JSON.parse(text);
    const error = parsed.error || '';
    const code = parsed.code || '';
    if (error === 'account_suspended' || code === 'account_suspended') {
      return { banned: true, reason: parsed.message || 'account_suspended' };
    }
    if (parsed.status === 'banned') return { banned: true, reason: 'session status=banned' };
    if (typeof error === 'string' && /suspended|banned/i.test(error)) {
      return { banned: true, reason: parsed.message || error };
    }
    if (statusCode === 403 && /suspended|banned/i.test(text)) {
      return { banned: true, reason: parsed.message || text.substring(0, 160) };
    }
  } catch (e) {
    if (statusCode === 403 && /suspended|banned/i.test(text)) {
      return { banned: true, reason: text.substring(0, 160) };
    }
  }
  return { banned: false, reason: '' };
}

async function proxyChatRequest(res, payload, requestedModel, writeError, writeUpstreamError, writeSuccess) {
  const reqStart = Date.now();
  const config = state.config;
  const tokenPool = state.tokenPool;
  const modelRegistry = state.modelRegistry;

  // Resolve short aliases (e.g. "deepseek-v4-flash") to the canonical wire id
  // (e.g. "deepseek/deepseek-v4-flash") BEFORE any session work. Clients like
  // opencode send the slashless slug; without this the session lock (which
  // stores the server-bound full id) never matches the requested slug, so every
  // request tears down and re-admits the upstream session mid-run.
  requestedModel = resolveFullModelId(requestedModel);

  let token = tokenPool.getToken();
  if (!token) { writeError(res, 503, 'no authentication tokens configured', 'server_error', 'no_tokens'); return; }
  const client = tokenPool.client;

  // Official aux traffic: the desktop NEVER calls /api/agents/validate; the
  // streak endpoint is fetched by the UI (GET /api/streak route below), not
  // per-turn. Ads are the only per-turn fire-and-forget aux call: official
  // triggers an inline auction on every turn once the response has ≥1 node
  // (throttled to ≤4 per turn via AD_NODE_THRESHOLDS=[1,4,7,10]); each proxied
  // chat request is one turn, so fire one auction per request. Never awaited
  // (official: launched, not awaited) — failures are silent.
  try { client.requestAds(token, 'gravity', payload.messages || []).catch(() => {}); } catch (_) {}

  let currentModel = requestedModel;
  for (let attempt = 0; attempt < 3; attempt++) {
    let sessionInstanceID;
    let session = null;
    let actualModel = currentModel;
    let accessTier = null;
    try {
      session = await tokenPool.ensureSession(token, currentModel);
      sessionInstanceID = session.instanceID;
      actualModel = session.model;
      accessTier = session.accessTier;
    } catch (e) {
      const ban = detectAccountSuspension(0, e.message || '');
      if (ban.banned) {
        await tokenPool.markTokenBanned(token, ban.reason);
        writeError(res, 403, `account suspended: ${ban.reason}`, 'server_error', 'account_suspended');
      } else {
        // Official FreebuffSessionError semantics: map the session status to
        // the HTTP code openai clients understand (quota=429 retryable,
        // concurrency=409, auth=401, session-ended=410).
        const st = e.status;
        const httpStatus = st === 'rate_limited' || st === 'spend_limited' || st === 'ip_capped' ? 429
          : st === 'premium_slot_taken' || st === 'session_limit_reached' ? 409
          : st === 'unauthenticated' ? 401
          : st === 'session_expired' ? 410
          : st === 'session_superseded' ? 409
          : 502;
        writeError(res, httpStatus, `failed to acquire upstream free session: ${e.message}`, 'server_error', st || '');
      }
      return;
    }

    const canonicalModel = resolveFullModelId(actualModel);
    const agentID = modelRegistry.getAgentForModel(canonicalModel) || FALLBACK_AGENT_IDS[canonicalModel] || 'base2-free';

    const isGemini = isGeminiModel(canonicalModel);
    let geminiSubagent = null;

    const isBase3 = agentID.startsWith('base3-');
    let run;
    try {
      if (isGemini) {
        geminiSubagent = getGeminiSubagentId(canonicalModel);
        // Official: single run bound to the model's root agent; there is no
        // parent/chat pair in the desktop orchestrator.
        run = await startRunChainGemini(client, token, geminiSubagent);
      } else if (isBase3) {
        run = await startRunChainSimple(client, token, agentID);
      } else {
        run = await startRunChainNormal(client, token, agentID);
      }
    } catch (e) {
      writeError(res, 502, `failed to start run chain: ${e.message}`, 'server_error', '');
      return;
    }

    const requestedDisplay = actualModel !== requestedModel ? ` (locked from ${requestedModel})` : '';
    let chatRunId = run.runId;
    console.log(`[Request] model: ${actualModel}${requestedDisplay}, run: ${chatRunId}, tier: ${accessTier || 'normal'}`);
    // Per-model quota snapshot (rateLimitsByModel) — surfaced to console so the
    // daily/池 quota is visible without hitting /healthz. Non-consuming: the
    // session body already carries it; no extra upstream request is made.
    const rl = session && session.rateLimitsByModel;
    if (rl && typeof rl === 'object') {
      const summary = Object.values(rl)
        .map(q => `${(q.model || '').split('/').pop()}:${q.recentCount ?? 0}/${q.limit ?? 0}`)
        .join(' ');
      console.log(`[Quota] ${summary}`);
    }
    const userMsg = (payload.messages || []).find(m => m.role === 'user');
    if (userMsg) console.log(`[Prompt] ${typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content)}`);

    const normalizedMessages = normalizeChatMessages(
      payload.messages,
      isBase3 ? BUFFY_BASE3_SYSTEM_PROMPT_OPENING : BUFFY_BASE2_SYSTEM_PROMPT_OPENING,
    );

    // --- Outbound body whitelist (foreign-client scrub) ---
    // The official desktop wire body is EXACTLY { model, messages, stream,
    // stop, tools, tool_choice?, codebuff_metadata, provider }. Third-party
    // clients (opencode/Cline/Codex) inject their own SDK fields — temperature,
    // top_p, seed, stream_options, user, presence_penalty, n, response_format,
    // logit_bias, ... — which the official client never sends. Rebuild the
    // body from the whitelist so nothing client-specific leaks upstream.
    let cloned = {};
    cloned.model = actualModel;
    cloned.messages = normalizedMessages;
    cloned.stream = payload.stream === undefined ? true : payload.stream;
    // Official stop is ALWAYS the quoted cb_easp wire form (globalStopSequence
    // = JSON.stringify("cb_easp")); a client-supplied stop is overwritten.
    cloned.stop = ['"cb_easp"'];
    if (payload.tools) {
      cloned.tools = Array.isArray(payload.tools) ? cloneSlice(payload.tools) : cloneMap(payload.tools);
      normalizeToolSchemas(cloned.tools);
      // Upstream foreign-client gate: a toolset with no Freebuff signature tool
      // is downgraded to ling-3.0-tiny:free. opencode/Cline/Codex only ship the
      // generic names, so inject ours when none are present.
      ensureSignatureTool(cloned);
      // Official: when the agent carries tools the wire ALWAYS includes
      // tool_choice (agent-runtime defaults `{type:"auto"}` → "auto"); an
      // explicit client tool_choice is honored as-is.
      if (payload.tool_choice === undefined) cloned.tool_choice = 'auto';
      else if (typeof payload.tool_choice === 'string') cloned.tool_choice = payload.tool_choice;
      else cloned.tool_choice = cloneMap(payload.tool_choice);
    }

    const clientId = generateClientSessionId();
    // Official desktop semantics (orchestrator): trace_session_id is created
    // once per desktop session (process lifetime) and reused across every
    // turn; the CLI reuses it per chat. Process-level reuse matches the
    // desktop surface we simulate.
    if (!state.traceSessionId) state.traceSessionId = crypto.randomUUID();
    // Official desktop freeMode metadata (orchestrator): 8 fields, with
    // freebuff_multi_session always "1" and llm_step_number the STRING form of
    // the per-request step index (1 for a single-shot request).
    cloned.codebuff_metadata = {
      freebuff_instance_id: sessionInstanceID,
      freebuff_multi_session: '1',
      ...(payload.reasoning_effort ? { freebuff_reasoning_effort: payload.reasoning_effort } : {}),
      trace_session_id: state.traceSessionId,
      llm_step_number: '1',
      run_id: chatRunId,
      client_id: clientId,
      cost_mode: 'free',
    };
    // Official provider block: anthropic models pin the Amazon Bedrock adapter;
    // everything else only denies data collection.
    if (canonicalModel.startsWith('anthropic/')) {
      cloned.provider = { only: ['amazon-bedrock'], data_collection: 'deny' };
    } else {
      cloned.provider = { data_collection: 'deny' };
    }

    let resp;
    try { resp = await client.chatCompletions(token, cloned); } catch (e) {
      writeError(res, 502, e.message, 'server_error', '');
      return;
    }

    if (resp.status === 429) {
      const errorBodyStr = await readBodyText(resp.body);
      console.log(`[Rate Limit] 429: ${errorBodyStr.substring(0, 200)}`);
      // Official semantics: respect retry-after / retry-after-ms first; a
      // `free_mode_capacity_deferred` error defaults to 10s (capacity
      // deferral listener). We keep the multi-account rotation as a proxy
      // enhancement on top of that backoff.
      let retryAfterMs = 0;
      try {
        const raHeader = resp.headers['retry-after-ms'] || resp.headers['retry-after'];
        if (raHeader) {
          const n = Number(raHeader);
          if (Number.isFinite(n) && n > 0) retryAfterMs = resp.headers['retry-after-ms'] ? n : n * 1000;
        }
      } catch (_) {}
      let isCapacityDeferred = false;
      try { const parsed = JSON.parse(errorBodyStr); isCapacityDeferred = parsed.error === 'free_mode_capacity_deferred'; } catch (_) {}
      // cline-gateway style: put the token into cooldown so the round-robin
      // skips it while we retry on another account.
      tokenPool.enterCooldown(token, Math.max(retryAfterMs || 0, 60000));
      for (let retry = 0; retry < 3; retry++) {
        const waitMs = retry === 0
          ? (retryAfterMs > 0 ? retryAfterMs : (isCapacityDeferred ? 10000 : 3000))
          : (retry + 1) * 3000;
        console.log(`[Rate Limit] Waiting ${Math.round(waitMs / 1000)}s before retry ${retry + 1}/3...`);
        await new Promise(r => setTimeout(r, waitMs));
        const retryToken = tokenPool.getToken();
        if (!retryToken) {
          writeError(res, 429, 'all tokens cooling down after rate limit', 'server_error', '');
          return;
        }
        if (retryToken !== token) {
          // Cross-account retry: the run_id / freebuff_instance_id baked into
          // codebuff_metadata belong to the old account's session. Reusing
          // them under a different Bearer token would leave the old run
          // orphaned and reference account A's instance from account B — a
          // foreign-client tell. Close the abandoned run with a failed FINISH
          // (official: dead runs are finished, never left hanging), then do a
          // full re-admission on the new account: fresh session + fresh run.
          setImmediate(() => finalizeRunFailed(client, token, run, 'rate limited; retried on another account'));
          token = retryToken;
          try {
            const session = await tokenPool.ensureSession(retryToken, currentModel);
            sessionInstanceID = session.instanceID;
          } catch (e) {
            writeError(res, 429, `failed to acquire upstream free session on retry: ${e.message}`, 'server_error', e.status || '');
            return;
          }
          try {
            run = isGemini ? await startRunChainGemini(client, retryToken, geminiSubagent)
              : isBase3 ? await startRunChainSimple(client, retryToken, agentID)
              : await startRunChainNormal(client, retryToken, agentID);
          } catch (e) {
            writeError(res, 502, `failed to start run chain on retry: ${e.message}`, 'server_error', '');
            return;
          }
          chatRunId = run.runId;
          cloned.codebuff_metadata = {
            ...cloned.codebuff_metadata,
            freebuff_instance_id: sessionInstanceID,
            run_id: chatRunId,
          };
          console.log(`[Rate Limit] Retry ${retry + 1} on account ${retryToken.substring(0, 8)}..., new run: ${chatRunId}`);
        }
        try { resp = await client.chatCompletions(retryToken, cloned); } catch (e) {
          writeError(res, 502, e.message, 'server_error', '');
          return;
        }
        if (resp.status !== 429) break;
        tokenPool.enterCooldown(retryToken, Math.max(retryAfterMs || 0, 60000));
        console.log(`[Rate Limit] Still 429 on retry ${retry + 1}`);
      }
      if (resp.status === 429) {
        const finalBody = await readBodyText(resp.body);
        writeUpstreamError(res, 429, finalBody);
        return;
      }
    }

    if (resp.status === 401) {
      // Static Freebuff tokens never expire server-side: a 401 means the
      // sign-in was revoked/terminated — mark invalid and drop from rotation.
      const errBody = await readBodyText(resp.body);
      console.error(`[Invalid] Token ${token.substring(0, 8)}... rejected with 401 (sign-in revoked): ${errBody.substring(0, 200)}`);
      await tokenPool.markTokenInvalid(token, 'sign-in revoked (401)');
      writeUpstreamError(res, 401, errBody);
      return;
    }

    if (resp.status >= 200 && resp.status < 300) {
      let messageId = null;
      let actualResponseModel = null;
      try { const result = await writeSuccess(res, resp); messageId = result.messageId; actualResponseModel = result.model; } catch (e) { console.error(`proxy response copy failed: ${e.message}`); }
      if (actualResponseModel && actualResponseModel.includes('ling-3.0-tiny')) {
        console.warn(`[ForeignClient] upstream downgraded request to ${actualResponseModel} (foreign_toolset hit) — signature tool missing from toolset`);
      }
      console.log(`[Response] model: ${actualResponseModel || actualModel}, completed in ${Date.now() - reqStart}ms (status: ${resp.status})`);
      setImmediate(() => {
        if (isGemini) finalizeRunChainGemini(client, token, run, messageId);
        else if (isBase3) finalizeRunChainSimple(client, token, run, messageId);
        else finalizeRunChainNormal(client, token, run, messageId);
      });
      return;
    }

    const errorBodyStr = await readBodyText(resp.body);
    console.log(`[Upstream Error] ${resp.status}: ${errorBodyStr.substring(0, 200)}`);

    // --- Runtime account-ban detection (new) ---
    const ban = detectAccountSuspension(resp.status, errorBodyStr);
    if (ban.banned) {
      console.error(`[Banned] Token ${token.substring(0, 8)}... suspended by upstream: ${ban.reason}`);
      await tokenPool.markTokenBanned(token, ban.reason);
      writeError(res, 403, `account suspended: ${ban.reason}`, 'server_error', 'account_suspended');
      return;
    }

    if (isSessionInvalid(resp.status, errorBodyStr)) {
      let errorType = '';
      let lockedModel = null;
      try {
        const errorData = JSON.parse(errorBodyStr);
        errorType = errorData.error || '';
        if (errorType === 'session_model_mismatch') {
          lockedModel = errorData.lockedModel || null;
          if (!lockedModel && errorData.message) {
            const match = errorData.message.match(/bound to ([a-zA-Z0-9][a-zA-Z0-9._/-]+)/);
            if (match) lockedModel = match[1].replace(/;.*$/, '').replace(/\.$/, '');
          }
          if (!lockedModel) {
            const cached = await tokenPool.getLockedModel(token);
            if (cached) lockedModel = cached;
          }
          if (!lockedModel) {
            try { const parsed = JSON.parse(errorBodyStr); if (parsed.body && parsed.body.currentModel) lockedModel = parsed.body.currentModel; } catch (_) {}
          }
        }
      } catch (e) {}
      console.log(`[Session Invalid] status=${resp.status}, error=${errorType}${lockedModel ? ', lockedModel=' + lockedModel : ''}`);

      // Official semantics (classifyTurnFailure): waiting_room_required is a
      // session_ended — the user must send the message again to start a new
      // session. It must NOT be auto-retried here: fast re-admission after a
      // 428 trips the server's rate limiter (rate_limited), which then also
      // throttles the other models on the same account. Invalidate + surface
      // the upstream message verbatim.
      if (errorType === 'waiting_room_required') {
        tokenPool.invalidateSession(token, actualModel);
        if (requestedModel !== actualModel) tokenPool.invalidateSession(token, requestedModel);
        writeUpstreamError(res, resp.status, errorBodyStr);
        return;
      }
      // waiting_room_queued: official FREEBUFF_GATE_CODES says
      // endsTheSession: false — the session survives, the server is just at
      // capacity. Fall through to the 429 retry path below instead of
      // invalidating. (The 429 branch handles the actual backoff.)

      if (errorType === 'freebuff_update_required' || resp.status === 426) {
        console.log(`[Version] Server requires update, invalidating session and retrying...`);
      }
      tokenPool.invalidateSession(token, actualModel);
      if (requestedModel !== actualModel) tokenPool.invalidateSession(token, requestedModel);

      if (errorType === 'session_model_mismatch' && lockedModel) {
        // Official semantics: a mismatch is resolved by switching to the
        // server-bound model, NEVER by ending the session to "unlock" — the
        // server re-binds the same model and the churn burns quota (fresh
        // admission instance at 0.1h granularity).
        console.log(`[Model Lock] Switching from ${currentModel} to ${lockedModel}`);
        await tokenPool.setLockedModel(token, lockedModel);
        tokenPool.invalidateSession(token, lockedModel);
        currentModel = lockedModel;
      }
      continue;
    }

    if (isRunInvalid(resp.status, errorBodyStr)) {
      // Official behavior: a dead run is NOT restarted — the run is closed
      // with a failed FINISH and the error is surfaced as-is.
      console.log(`run ${chatRunId} invalid, failing run`);
      setImmediate(() => finalizeRunFailed(client, token, run, errorBodyStr.substring(0, 5000)));
      writeUpstreamError(res, resp.status, errorBodyStr);
      return;
    }

    // Final error path: official sends a failed FINISH (errorMessage truncated
    // to 5000) whenever the run cannot complete.
    setImmediate(() => finalizeRunFailed(client, token, run, errorBodyStr.substring(0, 5000)));
    console.error(`upstream error response: ${errorBodyStr}`);
    writeUpstreamError(res, resp.status, errorBodyStr);
    return;
  }

  writeError(res, 502, 'upstream run expired twice in a row', 'server_error', '');
}

async function writeOpenAISuccessResponse(res, resp) {
  const HOP_BY_HOP = new Set(['content-length', 'content-encoding', 'transfer-encoding']);
  for (const [key, values] of Object.entries(resp.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    res.setHeader(key, values);
  }
  res.writeHead(resp.status);
  let messageId = null;
  let model = null;

  if (resp.headers['content-type']?.includes('text/event-stream')) {
    const body = resp.body;
    model = await pipeBodyToResponseAndCaptureModel(body, res);
  } else {
    const buffer = await readBodyText(resp.body);
    res.end(buffer);
    try { const parsed = JSON.parse(buffer); if (parsed.id) messageId = parsed.id; if (parsed.model) model = parsed.model; } catch (e) {}
  }

  return { messageId, model };
}

async function pipeBodyToResponseAndCaptureModel(body, res) {
  let model = null;
  let buffer = '';
  let captured = false;

  function processChunk(chunk) {
    const str = chunk instanceof Buffer ? chunk.toString() : typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    if (!captured) {
      buffer += str;
      const match = buffer.match(/data:\s*(\{.*?\})\n\n/);
      if (match) {
        captured = true;
        try { const parsed = JSON.parse(match[1]); if (parsed.model) model = parsed.model; } catch (_) {}
        res.write(Buffer.from(buffer));
        buffer = '';
        return;
      }
    }
    res.write(chunk instanceof Buffer ? chunk : Buffer.from(typeof chunk === 'string' ? chunk : chunk));
  }

  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      body.on('data', chunk => { processChunk(chunk); });
      body.on('end', () => { if (!captured) { res.write(Buffer.from(buffer)); } res.end(); resolve(model); });
      body.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const reader = body.getReader();
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { if (!captured) { res.write(Buffer.from(buffer)); } res.end(); resolve(model); return; }
        processChunk(value);
        pump();
      }).catch(reject);
    }
    pump();
  });
}

function writePassthroughError(res, statusCode, body) {
  const trimmed = body.trim();
  try { const payload = JSON.parse(trimmed); writeOpenAIError(res, statusCode, payload.error?.message || payload.message || trimmed, payload.error?.type || 'upstream_error', payload.error?.code || ''); }
  catch (e) { writeOpenAIError(res, statusCode, trimmed, 'upstream_error', ''); }
}

function writeClaudePassthroughError(res, statusCode, body) {
  const trimmed = body.trim();
  try { const payload = JSON.parse(trimmed); writeClaudeError(res, statusCode, payload.error?.message || payload.message || trimmed, 'api_error'); }
  catch (e) { writeClaudeError(res, statusCode, trimmed, 'api_error'); }
}

// --- Main Request Handler ---
async function handleRequest(req, res) {
  const config = state.config;
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (config.apiKeys && config.apiKeys.length > 0 && !authorized(req)) {
    if (isClaudeRequestPath(pathname)) writeClaudeError(res, 401, 'invalid proxy api key', 'authentication_error');
    else writeOpenAIError(res, 401, 'invalid proxy api key', 'authentication_error', '');
    return;
  }

  if (pathname === '/dashboard' || pathname === '/') {
    const dashboardPath = path.join(__dirname, '..', 'dashboard.html');
    if (fs.existsSync(dashboardPath)) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(dashboardPath)); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Dashboard not found'); return;
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') { writeJSON(res, 200, config); return; }
    if (req.method === 'POST') {
      try { const body = await readBody(req); const newConfig = JSON.parse(body); state.config = { ...config, ...newConfig }; saveConfig(state.config); writeJSON(res, 200, { success: true, config: state.config }); }
      catch (e) { writeJSON(res, 400, { error: e.message }); }
      return;
    }
  }

  if (pathname === '/api/tokens' && req.method === 'GET') {
    const maskedTokens = (config.authTokens || []).map(t => {
      const masked = t.substring(0, 8) + '...' + t.substring(t.length - 4);
      const banned = state.tokenPool ? state.tokenPool.isTokenBanned(t) : false;
      const invalid = state.tokenPool ? state.tokenPool.invalidTokens.has(t) : false;
      return {
        token: masked,
        fullLength: t.length,
        banned,
        banned_reason: banned ? state.tokenPool.getBannedTokens()[masked]?.reason : null,
        invalid,
        invalid_reason: invalid ? state.tokenPool.getInvalidTokens()[masked]?.reason : null,
        cooldown_ms: state.tokenPool ? state.tokenPool.cooldownRemainingMs(t) : 0,
      };
    });
    writeJSON(res, 200, { tokens: maskedTokens, count: maskedTokens.length, invalid_tokens: state.tokenPool ? state.tokenPool.getInvalidTokens() : {} }); return;
  }

  // Official Freebuff sign-in flow (issue + poll, see src/oauth.js).
  // POST /api/auth/start  -> { attemptId, loginUrl, expiresAt }
  // POST /api/auth/status -> { attemptId } -> pending | done { token, user } | expired
  // POST /api/auth/cancel -> { attemptId }
  if (pathname === '/api/auth/start' && req.method === 'POST') {
    try { const result = await oauth.startLoginAsync(); writeJSON(res, 200, result); }
    catch (e) { writeJSON(res, 502, { error: e.message }); }
    return;
  }

  if (pathname === '/api/auth/status' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { attemptId } = JSON.parse(body);
      if (!attemptId || typeof attemptId !== 'string') { writeJSON(res, 400, { error: 'attemptId required' }); return; }
      const result = await oauth.checkLogin(attemptId);
      if (result.status === 'done' && result.token) {
        if (!state.config.authTokens) state.config.authTokens = [];
        if (!state.config.authTokens.includes(result.token)) {
          state.config.authTokens.push(result.token);
          saveConfig(state.config);
          await reloadTokenPool();
          console.log('[OAuth] New auth token added via official sign-in flow');
        }
        result.tokenAdded = true;
        delete result.token;
      }
      writeJSON(res, 200, result);
    } catch (e) { writeJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/auth/cancel' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { attemptId } = JSON.parse(body);
      oauth.cancelLogin(attemptId);
      writeJSON(res, 200, { ok: true });
    } catch (e) { writeJSON(res, 400, { error: e.message }); }
    return;
  }

  if (pathname === '/api/models' && req.method === 'GET') { writeJSON(res, 200, { models: state.modelRegistry.getModels(), model_metadata: state.modelRegistry.getAllModelMetadata() }); return; }

  if (pathname === '/api/bg' && req.method === 'GET') {
    try { const response = await fetch('https://peapix.com/bing/feed'); const data = await response.json(); const item = Array.isArray(data) ? data[0] : data; const imgUrl = item.fullUrl || item.imageUrl || item.url || ''; if (imgUrl) writeJSON(res, 200, { url: imgUrl }); else writeJSON(res, 404, { error: 'not found' }); }
    catch (e) { writeJSON(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/ads' && req.method === 'GET') {
    const token = (config.authTokens || [])[0];
    if (!token) { writeJSON(res, 200, []); return; }
    try {
      const sessionId = crypto.randomUUID();
      // Official slot auction (Desktop-Below-Chat): NO surface, NO provider,
      // empty messages, sessionId "desktop-slot" fallback, Desktop UA.
      const body = {
        placementId: 'Desktop-Below-Chat',
        messages: [],
        sessionId: 'desktop-slot',
        device: { os: 'macos', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', locale: Intl.DateTimeFormat().resolvedOptions().locale || 'en-US' },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      };
      const resp = await proxiedFetch(config.upstreamBaseURL + '/api/v1/ads', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': FREE_DESKTOP_ADS_USER_AGENT, 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) { writeJSON(res, 200, []); return; }
      const data = await resp.json();
      console.log('[Ads] Response:', JSON.stringify(data).substring(0, 500));
      writeJSON(res, 200, data);
    } catch (e) { console.error('[Ads] Error:', e.message); writeJSON(res, 200, []); }
    return;
  }

  if (pathname === '/api/ads/impression' && req.method === 'POST') {
    const token = (config.authTokens || [])[0];
    if (!token) { writeJSON(res, 200, { success: false }); return; }
    try {
      const body = await readBody(req);
      const { impUrl, mode } = JSON.parse(body);
      const resp = await proxiedFetch(config.upstreamBaseURL + '/api/v1/ads/impression', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': FREE_DESKTOP_ADS_USER_AGENT, 'Accept': 'application/json' },
        body: JSON.stringify({ impUrl, mode: mode || 'desktop' }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await resp.json();
      writeJSON(res, 200, data);
    } catch (e) { writeJSON(res, 200, { success: false, error: e.message }); }
    return;
  }

  if (pathname === '/api/ads/click' && req.method === 'POST') {
    const token = (config.authTokens || [])[0];
    if (!token) { writeJSON(res, 200, { success: false }); return; }
    try {
      const body = await readBody(req);
      const { impUrl } = JSON.parse(body);
      const resp = await proxiedFetch(config.upstreamBaseURL + '/api/v1/ads/click', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': FREE_DESKTOP_ADS_USER_AGENT, 'Accept': 'application/json' },
        body: JSON.stringify({ impUrl }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await resp.json();
      writeJSON(res, 200, data);
    } catch (e) { writeJSON(res, 200, { success: false, error: e.message }); }
    return;
  }

  if (pathname === '/api/streak' && req.method === 'GET') {
    // Official desktop: GET /api/streak (UI fetch on status panel open) →
    // upstream GET /api/v1/freebuff/streak. Not per-turn traffic.
    const token = (config.authTokens || [])[0];
    if (!token) { writeJSON(res, 200, { streak: null }); return; }
    try {
      const data = await state.tokenPool.client.getStreak(token);
      writeJSON(res, 200, data && typeof data === 'object' ? data : { streak: null });
    } catch (e) { writeJSON(res, 200, { streak: null, error: e.message }); }
    return;
  }

  if (pathname === '/api/session/unlock' && req.method === 'POST') {
    if (!state.tokenPool) { writeJSON(res, 503, { ok: false, error: 'token pool not ready' }); return; }
    try {
      const unlocked = await state.tokenPool.clearAllLockedModels();
      console.log(`[Unlock] Cleared locked models for ${unlocked.length} token(s)`);
      writeJSON(res, 200, { ok: true, unlocked_count: unlocked.length });
    } catch (e) {
      writeJSON(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (pathname === '/healthz') { await handleHealthz(req, res); return; }
  if (pathname === '/v1/models') { await handleModels(req, res); return; }
  if (pathname === '/v1/chat/completions') { await debounceRequest(); await handleChatCompletions(req, res); return; }
  if (pathname === '/v1/messages') { await debounceRequest(); await handleClaudeMessages(req, res); return; }
  if (pathname === '/v1/messages/count_tokens') { await handleClaudeCountTokens(req, res); return; }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// --- Country Detection ---
async function detectCountry() {
  try {
    const resp = await proxiedFetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data.country_code) {
        state.detectedCountry = data.country_code;
        console.log(`[Country] Detected: ${state.detectedCountry}`);
        return;
      }
    }
  } catch (_) {}
  try {
    const resp = await proxiedFetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data.country) {
        state.detectedCountry = data.country;
        console.log(`[Country] Detected: ${state.detectedCountry}`);
        return;
      }
    }
  } catch (_) {}
  console.log('[Country] Could not detect country');
}

module.exports = {
  authorized,
  isClaudeRequestPath,
  writeJSON,
  writeOpenAIError,
  writeClaudeError,
  readBody,
  handleHealthz,
  handleModels,
  handleChatCompletions,
  handleClaudeMessages,
  handleClaudeCountTokens,
  countOpenAIPayloadTokens,
  detectAccountSuspension,
  proxyChatRequest,
  writeOpenAISuccessResponse,
  pipeBodyToResponseAndCaptureModel,
  writePassthroughError,
  writeClaudePassthroughError,
  handleRequest,
  detectCountry,
};