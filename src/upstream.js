// Upstream HTTP client aligned with the official desktop orchestrator
// (SessionManager + getModelForRequest + agent-runs lifecycle):
//   - chat: Content-Type + Authorization + official ai-sdk UA +
//     optional x-freebuff-acting-user-id (no hand-set Connection/Host etc.)
//   - session requests: ONLY Authorization + x-freebuff-* headers — no UA, no
//     Content-Type, no Host (the runtime adds its own defaults; official code
//     sets nothing else). Response handling mirrors postAdmission:
//     a body carrying a `status` field is returned as-is (even on 4xx/409);
//     other non-2xx become retryable server_busy (5xx) or server_error (4xx).
//   - agent-runs START/FINISH: Authorization + optional x-freebuff-acting-user-id
//     only; steps buffered locally and submitted inside FINISH; FINISH failures
//     are logged and swallowed (official behavior — buffer already consumed).
//   - ads: official placementId-based body + Freebuff-Desktop UA.

const crypto = require('crypto');

const { proxiedFetch } = require('./net-agent');
// All upstream traffic (chat, sessions, ads, agent-runs) leaves through the
// configured egress proxy when UPSTREAM_PROXY is set (see net-agent.js).
const fetch = proxiedFetch;

const {
  CODEBUFF_ACCEPT_ENCODING,
  CODEBUFF_JSON_USER_AGENT,
  FREEBUFF_CLI_USER_AGENT,
  FREE_DESKTOP_ADS_USER_AGENT,
} = require('./constants');
const { state } = require('./state');
const { getChatUserAgent } = require('./versions');
const { buildAgentValidationPayload, normalizeAdMessages, getDeviceInfo, getChromeAdUserAgent } = require('./messages');

const SESSION_REQUEST_TIMEOUT_MS = 15000;
const SESSION_HEARTBEAT_TIMEOUT_MS = 10000;
const SESSION_RELEASE_TIMEOUT_MS = 5000;
const SESSION_RELEASE_RETRY_DELAYS_MS = [150, 350];
const SESSION_ADMISSION_RETRY_DELAYS_MS = [500, 1000];
const SESSION_RETRY_AFTER_CAP_MS = 3000;
const DEFAULT_ME_TIMEOUT_MS = 8000;

const FREEBUFF_INSTANCE_HEADER = 'x-freebuff-instance-id';
const FREEBUFF_MODEL_HEADER = 'x-freebuff-model';
const FREEBUFF_ACTING_USER_HEADER = 'x-freebuff-acting-user-id';
const FREEBUFF_INCLUDE_UNUSED_RATE_LIMITS_HEADER = 'x-freebuff-include-unused-rate-limits';
const FREEBUFF_MULTI_SESSION_HEADER = 'x-freebuff-multi-session';
const FREEBUFF_HEARTBEAT_HEADER = 'x-freebuff-heartbeat';
const FREEBUFF_TAKEOVER_INSTANCE_HEADER = 'x-freebuff-takeover-instance-id';

// Official fetchWithRetry for agent-runs: 408/429/5xx + network errors,
// max 4 attempts, backoff 1s -> 2s -> 4s.
const RUN_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RUN_MAX_RETRIES = 3;
const RUN_RETRY_DELAYS_MS = [1000, 2000, 4000];

class UpstreamClient {
  constructor(cfg) {
    this.baseURL = cfg.upstreamBaseURL;
    this.timeout = cfg.requestTimeout;
    this.pendingSteps = new Map(); // runId -> step[]
  }

  _hostHeader() {
    try { return new URL(this.baseURL).host; } catch (_) { return 'www.codebuff.com'; }
  }

  actingUserIdHeader() {
    const uid = state.config && state.config.actingUserId;
    return uid ? { [FREEBUFF_ACTING_USER_HEADER]: uid } : {};
  }

  // HAR-style headers for generic JSON endpoints (me/ads/etc.).
  apiHeaders(authToken, extra = {}) {
    return {
      'Accept': '*/*',
      'Accept-Encoding': CODEBUFF_ACCEPT_ENCODING,
      'Connection': 'keep-alive',
      'Host': this._hostHeader(),
      'User-Agent': CODEBUFF_JSON_USER_AGENT,
      'Authorization': `Bearer ${authToken}`,
      ...extra
    };
  }

  // Official chat headers (orchestrator getModelForRequest + postJsonToApi2).
  chatHeaders(authToken, stream = false) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      'user-agent': getChatUserAgent(),
      ...this.actingUserIdHeader(),
    };
  }

  // Official session headers: Authorization + x-freebuff-* ONLY (postAdmission
  // sets nothing else; fetch defaults fill the rest).
  sessionHeaders(authToken, extra = {}) {
    return {
      'Authorization': `Bearer ${authToken}`,
      ...extra
    };
  }

  async doJSON(authToken, pth, body, method = 'POST', extraHeaders = {}) {
    const requestURL = this.baseURL + pth;
    const headers = this.apiHeaders(authToken, {
      'Content-Type': 'application/json',
      ...extraHeaders
    });
    console.log(`[API] ${method} ${pth}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const resp = await fetch(requestURL, {
        method,
        headers,
        body: body && method !== 'GET' && method !== 'DELETE' ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await resp.text();
      const responseHeaders = {};
      resp.headers.forEach((v, k) => responseHeaders[k] = v);
      return { status: resp.status, headers: responseHeaders, body: data };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // --- agent-runs (official: Authorization + acting-user only; steps in FINISH) ---
  // fetchWithRetry semantics: retry 408/429/5xx + network errors, 1s/2s/4s.
  async runRequest(authToken, body) {
    const requestURL = this.baseURL + '/api/v1/agent-runs';
    const headers = {
      'Authorization': `Bearer ${authToken}`,
      ...this.actingUserIdHeader(),
    };
    // No Content-Type: fetch defaults to text/plain;charset=UTF-8 like the
    // official client (which never sets it either).
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const resp = await fetch(requestURL, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const data = await resp.text();
        if (resp.status >= 200 && resp.status < 300) {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (_) {}
          return { status: resp.status, body: data, data: parsed };
        }
        if (RUN_RETRY_STATUSES.has(resp.status)) {
          if (attempt < RUN_MAX_RETRIES) {
            await new Promise(r => setTimeout(r, RUN_RETRY_DELAYS_MS[attempt]));
            continue;
          }
        }
        return { status: resp.status, body: data, data: null };
      } catch (e) {
        clearTimeout(timer);
        if (attempt < RUN_MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RUN_RETRY_DELAYS_MS[attempt]));
          continue;
        }
        throw e;
      }
    }
  }

  async startRun(authToken, agentID, ancestorRunIds = []) {
    const resp = await this.runRequest(authToken, { action: 'START', agentId: agentID, ancestorRunIds });
    if (resp.status < 200 || resp.status >= 300 || !resp.data || !resp.data.runId) {
      throw new Error(`start run failed ${resp.status}: ${resp.body || 'missing runId'}`);
    }
    return resp.data.runId;
  }

  // Local step buffer; submitted inside finishRun (official pendingAgentSteps).
  addPendingStep(authToken, runID, { stepNumber, childRunIds = [], messageId = null, startTime, status = 'completed', credits } = {}) {
    let entries = this.pendingSteps.get(runID);
    if (!entries) { entries = []; this.pendingSteps.set(runID, entries); }
    const step = {
      id: crypto.randomUUID(),
      stepNumber,
      ...(credits !== undefined ? { credits } : {}),
      ...(childRunIds.length > 0 ? { childRunIds } : {}),
      messageId, // required key; null for programmatic steps
      ...(status !== 'completed' ? { status } : {}), // official: only sent when not completed
      startTime: startTime || new Date().toJSON(),
    };
    entries.push(step);
  }

  async finishRun(authToken, runID, totalSteps, { status = 'completed', directCredits = 0, totalCredits = 0, errorMessage } = {}) {
    const steps = this.pendingSteps.get(runID) || [];
    this.pendingSteps.delete(runID); // consumed before the request (official)
    const body = {
      action: 'FINISH',
      runId: runID,
      status,
      totalSteps,
      directCredits,
      totalCredits,
      ...(errorMessage !== undefined ? { errorMessage: String(errorMessage).substring(0, 5000) } : {}),
      steps,
    };
    const resp = await this.runRequest(authToken, body);
    if (resp.status < 200 || resp.status >= 300) {
      // Official: log and swallow (buffer already deleted, no replay).
      console.error(`[Run] finish failed (${resp.status}) run ${runID}: ${String(resp.body || '').substring(0, 200)}`);
    }
  }

  chatCompletions(authToken, body) {
    const requestURL = this.baseURL + '/api/v1/chat/completions';
    const isStream = body && body.stream === true;
    const headers = this.chatHeaders(authToken, isStream);
    if (process.env.WIRE_DEBUG) {
      console.log('[WIRE] headers:', JSON.stringify(headers));
      console.log('[WIRE] body:', JSON.stringify(body));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const fetchOpts = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      compress: true,
    };
    return fetch(requestURL, fetchOpts).then(resp => {
      clearTimeout(timer);
      const responseHeaders = {};
      resp.headers.forEach((v, k) => responseHeaders[k] = v);
      return { status: resp.status, headers: responseHeaders, body: resp.body };
    }).catch(e => {
      clearTimeout(timer);
      throw e;
    });
  }

  // --- sessions (official SessionManager semantics) ---
  // POST admission: no body; client-generated instanceId; multi-session flag.
  // On premium_slot_taken the official client absorbs the response and retries
  // admission with x-freebuff-takeover-instance-id: <currentInstanceId> to take
  // over the occupying instance (orchestrator ensureSerialized).
  async createSession(authToken, model = '', instanceId = crypto.randomUUID(), { takeoverInstanceId } = {}) {
    const headers = {
      [FREEBUFF_MULTI_SESSION_HEADER]: '1',
      [FREEBUFF_INSTANCE_HEADER]: instanceId,
      ...(model ? { [FREEBUFF_MODEL_HEADER]: model } : {}),
      ...(takeoverInstanceId ? { [FREEBUFF_TAKEOVER_INSTANCE_HEADER]: takeoverInstanceId } : {}),
    };
    const opts = { timeoutMs: SESSION_REQUEST_TIMEOUT_MS, retries: SESSION_ADMISSION_RETRY_DELAYS_MS };
    const state = await this.doSessionRequest('POST', authToken, headers, opts);
    if (state && state.status === 'premium_slot_taken' && state.currentInstanceId && state.currentInstanceId !== instanceId) {
      console.log(`[Session] premium slot taken by ${state.currentInstanceId}, taking over (official takeover flow)`);
      return await this.doSessionRequest('POST', authToken, {
        ...headers,
        [FREEBUFF_TAKEOVER_INSTANCE_HEADER]: state.currentInstanceId,
      }, opts);
    }
    return state;
  }

  // GET refresh (global state, no instance) — official refreshTier.
  refreshSession(authToken) {
    const headers = {
      [FREEBUFF_MULTI_SESSION_HEADER]: '1',
      [FREEBUFF_INCLUDE_UNUSED_RATE_LIMITS_HEADER]: '1',
    };
    return this.doSessionRequest('GET', authToken, headers, { timeoutMs: SESSION_REQUEST_TIMEOUT_MS });
  }

  // GET per-instance status (polling path).
  getSession(authToken, instanceID) {
    const headers = {
      [FREEBUFF_MULTI_SESSION_HEADER]: '1',
      [FREEBUFF_INCLUDE_UNUSED_RATE_LIMITS_HEADER]: '1',
      [FREEBUFF_INSTANCE_HEADER]: instanceID,
    };
    return this.doSessionRequest('GET', authToken, headers, { timeoutMs: SESSION_REQUEST_TIMEOUT_MS });
  }

  endSession(authToken, instanceID = '') {
    const headers = {
      [FREEBUFF_MULTI_SESSION_HEADER]: '1',
      ...(instanceID ? { [FREEBUFF_INSTANCE_HEADER]: instanceID } : {}),
    };
    return this.doSessionRequest('DELETE', authToken, headers, { timeoutMs: SESSION_RELEASE_TIMEOUT_MS, retries: SESSION_RELEASE_RETRY_DELAYS_MS });
  }

  async doSessionRequest(method, authToken, extraHeaders = {}, { timeoutMs = SESSION_REQUEST_TIMEOUT_MS, retries = [] } = {}) {
    const requestURL = this.baseURL + '/api/v1/freebuff/session';

    const attempt = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(requestURL, {
          method,
          headers: this.sessionHeaders(authToken, extraHeaders),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const data = await resp.text();
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) {}

        if (resp.status < 200 || resp.status >= 300) {
          if (resp.status === 426 || data.includes('freebuff_update_required')) throw new Error('freebuff_update_required');
          if (parsed && parsed.type === 'model_locked') throw new Error(JSON.stringify({ type: 'model_locked', body: parsed }));
          // Official postAdmission: a body carrying a `status` field is
          // returned as-is even on 4xx/409 (e.g. premium_slot_taken).
          if (parsed && parsed.status) return parsed;
          const err = new Error(`free session request failed ${resp.status}: ${data}`);
          err.status = resp.status;
          err.retryable = resp.status >= 500;
          throw err;
        }
        return parsed || {};
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
    };

    for (let i = 0; ; i++) {
      try {
        return await attempt();
      } catch (e) {
        if (e.message === 'freebuff_update_required' || e.message.includes('model_locked')) throw e;
        const delay = retries[i];
        if (delay === undefined) throw e;
        // Official: retry only 5xx / timeout / transient network errors,
        // delay = min(max(backoff, retryAfterMs), 3000).
        const status = e.status || 0;
        const retryable = e.retryable === true || status === 0 || (e.name === 'AbortError' || e.message.includes('abort'));
        if (!retryable) throw e;
        await new Promise(r => setTimeout(r, Math.min(Math.max(delay, e.retryAfterMs || 0), SESSION_RETRY_AFTER_CAP_MS)));
      }
    }
  }

  // Official 45s keep-alive: GET session with x-freebuff-heartbeat: 1.
  async heartbeat(authToken, instanceID, timeoutMs = SESSION_HEARTBEAT_TIMEOUT_MS) {
    const requestURL = this.baseURL + '/api/v1/freebuff/session';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = this.sessionHeaders(authToken, {
        [FREEBUFF_MULTI_SESSION_HEADER]: '1',
        [FREEBUFF_INSTANCE_HEADER]: instanceID,
        [FREEBUFF_HEARTBEAT_HEADER]: '1',
      });
      const resp = await fetch(requestURL, { method: 'GET', headers, signal: controller.signal });
      clearTimeout(timer);
      // Official: body is cancelled, not read.
      try { await resp.body?.cancel(); } catch (_) {}
      if (resp.status >= 400) {
        console.log(`[Heartbeat] session ${instanceID.substring(0, 12)}... failed (${resp.status})`);
      }
      return { status: resp.status };
    } catch (e) {
      clearTimeout(timer);
      return { status: 0, error: e.message };
    }
  }

  // --- Account detection ---
  // GET /api/v1/me?fields=id,email,banned,created_at — quick account probe.
  // Official getUserInfoFromApiKey sends ONLY Authorization (no UA).
  async getMe(authToken, timeoutMs = DEFAULT_ME_TIMEOUT_MS) {
    const requestURL = this.baseURL + '/api/v1/me?fields=id,email,banned,created_at';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(requestURL, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${authToken}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(data); } catch (e) {}
      return { status: resp.status, body: data, data: parsed };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // Official SDK remote validate (CLI-only; desktop never calls it): headers
  // are ONLY Content-Type — no Authorization, no UA. Kept for the dashboard.
  async validateAgents(authToken) {
    const agentDefs = buildAgentValidationPayload();
    const resp = await this.doJSON(authToken, '/api/agents/validate', { agentDefinitions: agentDefs }, 'POST', { 'Content-Type': 'application/json' });
    if (resp.status >= 200 && resp.status < 300) {
      console.log('[Agents] Validation completed');
    } else {
      console.log(`[Agents] Validation failed (${resp.status}), continuing with server configs`);
    }
  }

  // Official inline ad request (fire-and-forget, never blocks chat):
  // surface routes the inline slot server-side; placementId + messages +
  // sessionId + device + browser-UA are the exact official wire fields.
  async requestAds(authToken, provider, messages = [], sessionId = '') {
    const body = {
      surface: 'cli_chat',
      placementId: 'Desktop-Inline-Chat',
      messages: normalizeAdMessages(messages),
      sessionId: sessionId || 'desktop-slot',
      device: getDeviceInfo(),
      userAgent: getChromeAdUserAgent(),
    };
    const headers = {
      'Authorization': `Bearer ${authToken}`,
      'content-type': 'application/json',
      'User-Agent': FREE_DESKTOP_ADS_USER_AGENT,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(this.baseURL + '/api/v1/ads', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(data); } catch (_) {}
      if (!resp.ok) return { status: resp.status, ads: [] };
      const ads = Array.isArray(parsed && parsed.ads) ? parsed.ads.filter(a => a && a.title && a.url) : [];
      return { status: resp.status, ads, body: data };
    } catch (e) {
      clearTimeout(timer);
      return { status: 0, ads: [], error: e.message };
    }
  }

  async getStreak(authToken) {
    return await this.doJSON(authToken, '/api/v1/freebuff/streak', null, 'GET');
  }

  // Official impression: { impUrl, mode: "desktop" }.
  async reportCodebuffImpression(authToken, impUrl) {
    if (!impUrl) return;
    try {
      return await this.doJSON(authToken, '/api/v1/ads/impression', { impUrl, mode: 'desktop' }, 'POST', { 'User-Agent': FREE_DESKTOP_ADS_USER_AGENT });
    } catch (e) { return null; }
  }

  // Official click: { impUrl } — no mode field.
  async reportCodebuffClick(authToken, impUrl) {
    if (!impUrl) return;
    try {
      return await this.doJSON(authToken, '/api/v1/ads/click', { impUrl }, 'POST', { 'User-Agent': FREE_DESKTOP_ADS_USER_AGENT });
    } catch (e) { return null; }
  }
}

module.exports = {
  UpstreamClient,
  FREEBUFF_INSTANCE_HEADER,
  FREEBUFF_MODEL_HEADER,
  FREEBUFF_ACTING_USER_HEADER,
  FREEBUFF_MULTI_SESSION_HEADER,
  FREEBUFF_HEARTBEAT_HEADER,
  SESSION_REQUEST_TIMEOUT_MS,
  SESSION_HEARTBEAT_TIMEOUT_MS,
};