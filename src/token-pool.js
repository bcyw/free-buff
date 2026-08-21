// Token pool: round-robin token selection + per (token, model) session cache
// with mutex, model-lock handling, and the 45s upstream session heartbeat.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { SESSION_HEARTBEAT_INTERVAL_MS } = require('./constants');

// TTL for the zero-cost quota snapshot cache (refreshQuotaSnapshot).
const QUOTA_CACHE_TTL_MS = 30 * 1000;

// Persisted-session store: instanceIds survive restarts (official
// persistedInstanceId semantics). On boot a restored session is treated as
// "needs re-validation": ensureSession runs a GET before reusing it, so a
// stale instance never burns a fresh admission.
const SESSION_STORE_FILE = path.join(__dirname, '..', '.config', 'sessions.json');

class TokenPool {
  constructor(tokens, cfg, client) {
    this.tokens = tokens;
    this.cfg = cfg;
    this.client = client;
    this.currentIndex = 0;
    this.sessions = new Map();
    this.lockedModels = new Map();
    this.mutex = Promise.resolve();
    this.heartbeatTimer = null;
    this.heartbeatInterval = SESSION_HEARTBEAT_INTERVAL_MS;
    this.bannedTokens = new Map(); // token -> { reason, at }
    this.cooldowns = new Map(); // token -> cooldownUntilMs (429 rate-limit)
    this.invalidTokens = new Map(); // token -> { reason, at } (401, sign-in expired)
    this.quotaCache = new Map(); // token -> { at, rateLimitsByModel, accessTier, desktopSessionCounts }
    this.sessionDetails = new Map(); // token -> latest non-consuming server detail
    this._restorePersistedSessions();
  }

  // --- Persisted sessions (restart-safe instanceIds) ---
  _restorePersistedSessions() {
    try {
      if (!fs.existsSync(SESSION_STORE_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(SESSION_STORE_FILE, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      let restored = 0;
      for (const [key, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.instanceID !== 'string' || !entry.instanceID) continue;
        // Restore with the persisted expiresAt (not epoch): the 45s heartbeat
        // must keep beating this instance across restarts, which it only does
        // while `expiresAt` is a real time within the 30min grace window.
        // ensureSession still re-validates via GET before any reuse, so a
        // stale instance is never trusted blindly.
        const persistedExpiry = entry.expiresAt ? new Date(entry.expiresAt) : new Date(0);
        this.sessions.set(key, {
          status: 'active',
          instanceID: entry.instanceID,
          expiresAt: persistedExpiry,
          model: entry.model || null,
          accessTier: entry.accessTier || null,
          restored: true,
        });
        restored++;
      }
      if (restored > 0) console.log(`[Session] Restored ${restored} persisted session instance(s) from disk`);
    } catch (e) {
      console.error(`[Session] Failed to restore persisted sessions: ${e.message}`);
    }
  }

  _persistSessions() {
    try {
      const out = {};
      for (const [key, session] of this.sessions) {
        if (!session || !session.instanceID) continue;
        out[key] = {
          instanceID: session.instanceID,
          expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
          model: session.model || null,
          accessTier: session.accessTier || null,
        };
      }
      fs.mkdirSync(path.dirname(SESSION_STORE_FILE), { recursive: true });
      fs.writeFileSync(SESSION_STORE_FILE, JSON.stringify(out, null, 2));
    } catch (e) {
      console.error(`[Session] Failed to persist sessions: ${e.message}`);
    }
  }

  // --- Banned-token support ---
  // Removes the token from rotation and tears down its sessions. Called by the
  // runtime detector (chat response account_suspended / session status banned)
  // and by the startup validator for tokens probed as banned.
  async markTokenBanned(token, reason) {
    const masked = token.substring(0, 8) + '...' + token.substring(token.length - 4);
    const already = this.bannedTokens.has(token);
    this.bannedTokens.set(token, { reason: reason || 'account suspended', at: new Date().toISOString() });
    if (!already) {
      this.tokens = this.tokens.filter(t => t !== token);
      console.error(`[Banned] Token ${masked} removed from rotation: ${reason || 'account suspended'}`);
    }
    await this.endAllSessionsForToken(token);
  }

  isTokenBanned(token) { return this.bannedTokens.has(token); }

  getBannedTokens() {
    const out = {};
    for (const [token, info] of this.bannedTokens) {
      out[token.substring(0, 8) + '...' + token.substring(token.length - 4)] = info;
    }
    return out;
  }

  // --- 429 cooldown (mirrors cline-gateway) ---
  enterCooldown(token, ms = 60000) {
    this.cooldowns.set(token, Date.now() + ms);
    console.warn(`[Cooldown] Token ${token.substring(0, 8)}... cooling down ${Math.round(ms / 1000)}s (rate limited)`);
  }

  cooldownRemainingMs(token) {
    const until = this.cooldowns.get(token) || 0;
    return until > Date.now() ? until - Date.now() : 0;
  }

  // --- 401 invalid token (sign-in expired / revoked) ---
  async markTokenInvalid(token, reason) {
    const masked = token.substring(0, 8) + '...' + token.substring(token.length - 4);
    const already = this.invalidTokens.has(token);
    this.invalidTokens.set(token, { reason: reason || 'sign-in expired', at: new Date().toISOString() });
    if (!already) {
      this.tokens = this.tokens.filter(t => t !== token);
      console.error(`[Invalid] Token ${masked} removed from rotation: ${reason || 'sign-in expired'} — re-login (node oauth.js)`);
    }
    await this.endAllSessionsForToken(token);
  }

  getInvalidTokens() {
    const out = {};
    for (const [token, info] of this.invalidTokens) {
      out[token.substring(0, 8) + '...' + token.substring(token.length - 4)] = info;
    }
    return out;
  }

  async withLock(fn) {
    let release;
    const p = new Promise(r => release = r);
    const old = this.mutex;
    this.mutex = p;
    await old;
    try { return await fn(); } finally { release(); }
  }

  // Round-robin with cooldown skip (mirrors cline-gateway: skip cooling accounts).
  getToken() {
    if (this.tokens.length === 0) return null;
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[this.currentIndex % this.tokens.length];
      this.currentIndex++;
      if (this.cooldownRemainingMs(token) > 0) continue;
      return token;
    }
    return null; // all tokens in cooldown
  }


  sessionKey(token, model) { return `${token}:${model}`; }

  _tokenFromKey(key) {
    // key = `${token}:${model}`; token is a UUID, model is `publisher/name`.
    const idx = key.lastIndexOf(':');
    return idx === -1 ? key : key.slice(0, idx);
  }

  _sessionFromState(state) {
    const instanceID = (state.instanceId || '').trim();
    const expiresAt = state.expiresAt ? new Date(state.expiresAt) : null;
    const countryCode = state.countryCode || null;
    const remainingMs = state.remainingMs || null;
    const accessTier = state.accessTier || null;
    const countryBlockReason = state.countryBlockReason || null;
    const model = state.model || null;
    // Official SessionManager.absorb(): the session body carries per-model
    // quota info (`rateLimitsByModel`), surfaced to the UI as quotaByModel.
    // x-freebuff-include-unused-rate-limits: 1 makes the server include
    // even unexhausted model quotas.
    const rateLimitsByModel = state.rateLimitsByModel || null;
    // Admission body entitlement fields (server-computed):
    // entitlementBreakdown { base, referral, streak } + limit + recentCount
    // + period + resetAt + retryAfterMs.
    const entitlement = state.entitlementBreakdown || null;
    const quota = {
      limit: state.limit ?? null,
      recentCount: state.recentCount ?? null,
      period: state.period || null,
      resetAt: state.resetAt || null,
      retryAfterMs: state.retryAfterMs ?? null,
      windowHours: state.windowHours ?? null,
      resetTimeZone: state.resetTimeZone || null,
      entitlementBreakdown: entitlement,
    };
    return {
      status: state.status || 'active', instanceID, expiresAt, countryCode, remainingMs,
      accessTier, countryBlockReason, model, rateLimitsByModel, quota,
      message: state.message || null,
      requestedModel: state.requestedModel || null,
      availableHours: state.availableHours || null,
    };
  }

  // Official explicit model switch (CLI "End your active X session to
  // switch?" flow): DELETE the old instance, then POST the requested model.
  // Only valid on FULL tier where the catalog has multiple models; on the
  // limited tier the server coerces every pick to its single model, so
  // switching there would just churn quota for nothing.
  async switchSession(token, requestedModel, oldInstanceID) {
    if (oldInstanceID) {
      try { await this.client.endSession(token, oldInstanceID); } catch (e) {
        console.error(`${token.substring(0, 8)}...: switch: endSession(${oldInstanceID.substring(0, 12)}...) failed: ${e.message}`);
      }
    } else {
      // No known instance: release whatever the server holds for this user.
      try { await this.client.endSession(token); } catch (_) {}
    }
    const state = await this.client.createSession(token, requestedModel, crypto.randomUUID());
    const polled = await this.pollUntilReady(token, requestedModel, state);
    const instanceID = (polled.instanceId || '').trim();
    if (!instanceID) throw new Error('switch session: active response missing instanceId');
    const session = this._sessionFromState(polled);
    const boundModel = session.model || requestedModel;
    const newKey = this.sessionKey(token, boundModel);
    await this.withLock(async () => { this.sessions.delete(newKey); this.sessions.set(newKey, session); });
    this._persistSessions();
    console.log(`[DEBUG] ensureSession: switched to ${boundModel} instanceID=${instanceID} (tier=${session.accessTier})`);
    return { instanceID, model: boundModel, accessTier: session.accessTier };
  }

  async ensureSession(token, model) {
    const requestedModel = model;
    const locked = await this.withLock(async () => this.lockedModels.get(token));
    if (locked && locked !== requestedModel) {
      // Voluntary model switch: release the old locked session and admit
      // the newly requested model. Burns 0.1h quota per switch but allows
      // the user to freely choose models.
      console.log(`${token.substring(0, 8)}...: switching from locked model ${locked} to requested ${requestedModel}`);
      const oldKey = this.sessionKey(token, locked);
      const oldSession = await this.withLock(async () => this.sessions.get(oldKey));
      if (oldSession && oldSession.instanceID) {
        try { await this.client.endSession(token, oldSession.instanceID); } catch (_) {}
      }
      await this.withLock(async () => {
        this.lockedModels.delete(token);
        this.sessions.delete(oldKey);
      });
      this._persistSessions();
    }
    let key = this.sessionKey(token, model);
    // One active session per account (official desktop semantics): if another
    // model's session is still alive in the cache (within its grace window),
    // release it BEFORE admitting the requested model — otherwise the server
    // ends up holding two live sessions and the heartbeat keeps both alive.
    {
      const stale = await this.withLock(async () => {
        const graceMs = 30 * 60 * 1000;
        for (const [k, s] of this.sessions.entries()) {
          if (!k.startsWith(token + ':')) continue;
          if (k === key) continue;
          if (s && s.status === 'active' && s.instanceID &&
              (!s.expiresAt || Date.now() < s.expiresAt.getTime() + graceMs)) {
            return { k, instanceID: s.instanceID, model: s.model || k.slice(token.length + 1) };
          }
        }
        return null;
      });
      if (stale) {
        console.log(`${token.substring(0, 8)}...: releasing stale live session ${stale.model} (${stale.instanceID.substring(0, 12)}...) before admitting ${requestedModel}`);
        try { await this.client.endSession(token, stale.instanceID); } catch (e) {
          console.error(`${token.substring(0, 8)}...: failed to release stale session: ${e.message}`);
        }
        await this.withLock(async () => { this.sessions.delete(stale.k); });
        this._persistSessions();
      }
    }
    for (let i = 0; i < 3; i++) {
      const ready = await this.withLock(async () => {
        const session = this.sessions.get(key);
        if (!session) return { ready: false };
        if (session.status === 'active' && session.instanceID) {
          // Official grace semantics (FREEBUFF_SESSION_GRACE_MS): a session is
          // reusable until 30min AFTER its expiresAt; never churn instances
          // early. The server keeps the slot alive via heartbeats.
          const graceMs = 30 * 60 * 1000;
          if (!session.expiresAt || Date.now() < session.expiresAt.getTime() + graceMs) {
            return { ready: true, instanceID: session.instanceID, model: session.model || model, accessTier: session.accessTier };
          }
        }
        return { ready: false };
      });
      if (ready.ready) return { instanceID: ready.instanceID, model: ready.model, accessTier: ready.accessTier };

      try {
        let state;
        const current = await this.withLock(async () => this.sessions.get(key));
        // Official semantics: the instanceId is a client-generated UUID bound
        // to the (token, model) slot; POST admission carries it.
        const instanceId = (current && current.instanceID) || crypto.randomUUID();
        if (current && current.status === 'active' && current.instanceID) {
          try { state = await this.client.getSession(token, current.instanceID); } catch (e) {
            if (e.message === 'freebuff_update_required') throw e;
            state = await this.client.createSession(token, model, instanceId);
          }
        } else {
          state = await this.client.createSession(token, model, instanceId);
        }
        state = await this.pollUntilReady(token, model, state);
        console.log(`[DEBUG] ensureSession: pollUntilReady result: status=${state.status}, instanceId=${state.instanceId}, countryBlockReason=${state.countryBlockReason || 'none'}, accessTier=${state.accessTier || 'none'}`);

        const instanceID = (state.instanceId || '').trim();
        if (!instanceID) throw new Error('free session active response missing instanceId');
        const session = this._sessionFromState(state);
        const boundModel = session.model;
        let returnModel = model;
        if (boundModel && boundModel !== requestedModel) {
          // Tier of the CURRENT egress (refreshSession is a zero-cost probe):
          // a session admitted under the old region can carry a stale
          // accessTier, but switching decisions must follow the live tier.
          let tier = session.accessTier;
          if (tier !== 'full') {
            try {
              const rt = await this.client.refreshSession(token);
              if (rt && rt.accessTier) tier = rt.accessTier;
            } catch (_) {}
          }
          if (tier === 'full') {
            // Full tier: catalog has multiple models — the server bound the
            // session to a model the client didn't ask for, so perform the
            // official explicit switch (DELETE + re-POST the requested model).
            // If the switch itself gets re-bound, accept it (server decides).
            console.log(`${key.substring(0, 20)}...: full tier — server bound to ${boundModel} (requested ${requestedModel}), switching explicitly`);
            try {
              const switched = await this.switchSession(token, requestedModel, instanceID);
              return switched;
            } catch (switchErr) {
              console.error(`${key.substring(0, 20)}...: explicit switch failed (${switchErr.message}), accepting bound model ${boundModel}`);
            }
          } else {
            console.log(`${key.substring(0, 20)}...: server bound session to ${boundModel} (requested ${requestedModel}), accepting bound model`);
          }
          await this.withLock(async () => { this.lockedModels.set(token, boundModel); });
          const boundKey = this.sessionKey(token, boundModel);
          await this.withLock(async () => { this.sessions.delete(key); this.sessions.set(boundKey, session); });
          this._persistSessions();
          returnModel = boundModel;
        } else {
          await this.withLock(async () => { this.sessions.set(key, session); });
          this._persistSessions();
        }
        console.log(`[DEBUG] ensureSession: returning instanceID=${instanceID} model=${returnModel} accessTier=${session.accessTier}`);
        return { instanceID, model: returnModel, accessTier: session.accessTier };
      } catch (e) {
        const errorMsg = e.message || '';
        if (errorMsg.includes('model_locked')) {
          let lockedModel = null;
          let lockedTier = null;
          try { const parsed = JSON.parse(errorMsg); if (parsed.type === 'model_locked' && parsed.body) { if (parsed.body.currentModel) lockedModel = parsed.body.currentModel; if (parsed.body.accessTier) lockedTier = parsed.body.accessTier; } } catch (_) {}
          // Official semantics (freebuff-session.ts model_locked): the
          // account ALREADY holds an active session bound to currentModel.
          // The server keeps the slot alive — destroying it and re-admitting
          // would burn another quota unit (~1 session).
          if (lockedTier === 'full') {
            // Full tier: explicit switch is legitimate (client asked for a
            // different catalog model). Release the locked session and
            // re-admit the REQUESTED model — this is the CLI's confirmed
            // "End your active X session to switch?" flow, done automatically.
            console.log(`${key.substring(0, 20)}...: full tier — model_locked on ${lockedModel}, switching explicitly to ${requestedModel}`);
            try {
              const remote = await this.client.refreshSession(token);
              const oldInstance = (remote && remote.status === 'active' && remote.instanceId) || null;
              return await this.switchSession(token, requestedModel, oldInstance);
            } catch (switchErr) {
              console.error(`${key.substring(0, 20)}...: full-tier switch failed (${switchErr.message}), falling through to reuse`);
            }
          } else {
            console.log(`${key.substring(0, 20)}...: tier ${lockedTier || 'unknown'} — model_locked on ${lockedModel}, reusing live session (no churn)`);
          }
          // Limited tier (or unknown tier): reuse the live server session.
          // Destroying and re-admitting on every mismatch burns quota and
          // the server re-binds the same model anyway (model_locked).
          try {
            const remote = await this.client.refreshSession(token);
            if (remote && remote.status === 'active' && remote.instanceId) {
              const remoteSession = this._sessionFromState(remote);
              const reuseModel = remoteSession.model || lockedModel || model;
              const reuseKey = this.sessionKey(token, reuseModel);
              await this.withLock(async () => {
                this.sessions.delete(key);
                this.lockedModels.set(token, reuseModel);
                this.sessions.set(reuseKey, remoteSession);
              });
              this._persistSessions();
              console.log(`${key.substring(0, 20)}...: server holds live session for ${reuseModel} (instanceId=${remote.instanceId}), reusing it (no churn)`);
              return { instanceID: remote.instanceId, model: reuseModel, accessTier: remoteSession.accessTier };
            }
            console.log(`${key.substring(0, 20)}...: model_locked but no live server session (${remote && remote.status}), falling back`);
          } catch (reuseErr) {
            console.error(`${key.substring(0, 20)}...: live-session reuse failed (${reuseErr.message}), falling back`);
          }
          if (lockedModel) {
            console.log(`${key.substring(0, 20)}...: server locked to ${lockedModel}, switching to locked model`);
            await this.endAllSessionsForToken(token);
            try { await this.client.endSession(token); } catch (_) {}
            try {
              const lockedState = await this.client.createSession(token, lockedModel, crypto.randomUUID());
              const polled = await this.pollUntilReady(token, lockedModel, lockedState);
              const instanceID = (polled.instanceId || '').trim();
              if (instanceID) {
                const newKey = this.sessionKey(token, lockedModel);
                const session = this._sessionFromState(polled);
                await this.withLock(async () => {
                  this.sessions.delete(key);
                  this.lockedModels.set(token, lockedModel);
                  this.sessions.set(newKey, session);
                });
                this._persistSessions();
                console.log(`[DEBUG] ensureSession: switched to locked model ${lockedModel} instanceID=${instanceID}`);
                return { instanceID, model: lockedModel, accessTier: session.accessTier };
              }
            } catch (switchErr) {
              console.error(`${key.substring(0, 20)}...: failed to switch to locked model ${lockedModel} (${switchErr.message}), retrying`);
            }
            const newKey = this.sessionKey(token, lockedModel);
            await this.withLock(async () => { this.sessions.delete(key); this.lockedModels.set(token, lockedModel); });
            model = lockedModel;
            key = newKey;
            continue;
          }
          console.log(`${key.substring(0, 20)}...: session locked to different model, ending all upstream sessions`);
          await this.endAllSessionsForToken(token);
          try { await this.client.endSession(token); } catch (e2) { console.error(`endSession(no-id) failed: ${e2.message}`); }
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        if (errorMsg === 'freebuff_update_required') {
          console.log(`${key.substring(0, 20)}...: freebuff_update_required, clearing session and retrying`);
          await this.endAllSessionsForToken(token);
          try { await this.client.endSession(token); } catch (e2) { console.error(`endSession(no-id) failed: ${e2.message}`); }
          continue;
        }
        // Official quota errors (classifyTurnFailure → freebuff_quota): the
        // server needs cooldown time — retrying immediately just feeds the
        // limiter. Surface to the client at once. NOTE: sessionErrorFor keeps
        // the machine status on err.status (message is human copy, so
        // message-regex matching below would never fire).
        if (e.status === 'rate_limited' || e.status === 'spend_limited' || e.status === 'ip_capped'
          || /rate_limited|spend_limited|ip_capped|quota/.test(errorMsg)) {
          await this.withLock(async () => { this.sessions.delete(key); this._persistSessions(); });
          throw e;
        }
        await this.withLock(async () => { this.sessions.delete(key); this._persistSessions(); });
        console.error(`${key.substring(0, 20)}...: session error: ${e.message}`);
        if (i === 2) throw e;
      }
    }
  }

  async getLockedModel(token) {
    return await this.withLock(async () => this.lockedModels.get(token) || null);
  }

  // Zero-cost quota snapshot (official refreshTier GET with the
  // x-freebuff-include-unused-rate-limits: 1 header). The POST admission body
  // omits per-model rate limits, so this is the non-consuming path that fills
  // `rateLimitsByModel` for the UI. Cached for QUOTA_CACHE_TTL_MS so a
  // dashboard poll doesn't hammer upstream; on cache hit nothing is fetched.
  async refreshQuotaSnapshot(token) {
    const cached = this.quotaCache.get(token);
    if (cached && Date.now() - cached.at < QUOTA_CACHE_TTL_MS) return cached;
    try {
      const rt = await this.client.refreshSession(token);
      const snap = {
        at: Date.now(),
        rateLimitsByModel: (rt && rt.rateLimitsByModel) || null,
        accessTier: (rt && rt.accessTier) || null,
        desktopSessionCounts: (rt && rt.desktopSessionCounts) || null,
        referral: (rt && rt.referral) || null,
        status: (rt && rt.status) || 'none',
        message: (rt && rt.message) || null,
        requestedModel: (rt && rt.requestedModel) || null,
        currentModel: (rt && (rt.currentModel || rt.model)) || null,
        availableHours: (rt && rt.availableHours) || null,
        queueDepthByModel: (rt && (rt.queueDepthByModel || rt.queue_depth_by_model)) || null,
        stale: false,
      };
      this.quotaCache.set(token, snap);
      this.sessionDetails.set(token, snap);
      return snap;
    } catch (e) {
      // Refresh failed (network): return any stale snapshot rather than null so
      // the UI keeps showing the last known quota.
      const stale = cached ? { ...cached, stale: true, error: e.message } : null;
      if (stale) this.sessionDetails.set(token, stale);
      return stale;
    }
  }

  // Drop the cached quota snapshot (e.g. right after a chat turn consumed
  // quota) so the next refreshQuotaSnapshot re-fetches instead of serving
  // pre-turn numbers for up to QUOTA_CACHE_TTL_MS.
  invalidateQuotaSnapshot(token) {
    this.quotaCache.delete(token);
  }

  async setLockedModel(token, model) {
    await this.withLock(async () => { this.lockedModels.set(token, model); });
  }

  async clearAllLockedModels() {
    const all = [];
    const tokens = this.tokens.slice();
    for (const token of tokens) {
      const locked = await this.withLock(async () => {
        const m = this.lockedModels.get(token) || null;
        this.lockedModels.delete(token);
        return m;
      });
      if (locked) all.push({ token, lockedModel: locked });
    }
    for (const { token } of all) {
      await this.endAllSessionsForToken(token);
      try { await this.client.endSession(token); } catch (e) { console.error(`endSession(no-id) failed: ${e.message}`); }
    }
    return all;
  }

  async endAllSessionsForToken(token) {
    const keysToDelete = [];
    await this.withLock(async () => {
      for (const key of this.sessions.keys()) {
        if (key.startsWith(token + ':')) {
          keysToDelete.push(key);
        }
      }
    });
    for (const key of keysToDelete) {
      const session = await this.withLock(async () => this.sessions.get(key));
      if (session && session.instanceID) {
        try {
          await this.client.endSession(token, session.instanceID);
        } catch (e) {
          console.error(`Failed to end session ${session.instanceID}: ${e.message}`);
        }
      }
      await this.withLock(async () => { this.sessions.delete(key); });
    }
    if (keysToDelete.length > 0) this._persistSessions();
  }

  // Official desktop semantics: NO polling loop — admission is a single POST
  // and anything other than `active` is a terminal error surfaced with the
  // official errorFor() copy (SessionManager.errorFor); the user must retry
  // after the reset/cooldown, never auto-poll.
  async pollUntilReady(token, model, state) {
    const status = (state.status || '').trim();
    if (status === 'active') return state;
    if (status === 'disabled') return state; // tolerated no-session state
    throw sessionErrorFor(state, model, state.accessTier);
  }

  invalidateSession(token, model) {
    const key = this.sessionKey(token, model);
    this.withLock(async () => { this.sessions.delete(key); this._persistSessions(); });
  }

  // --- Heartbeat (new) ---
  // Official CLI/desktop keep the free session alive with a GET session call
  // carrying x-freebuff-heartbeat: 1 every 45s. Without it, long pauses
  // between proxied requests let upstream expire the session.
  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this._heartbeatTick(), this.heartbeatInterval);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    console.log(`[Heartbeat] started (every ${Math.round(this.heartbeatInterval / 1000)}s)`);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async _heartbeatTick() {
    let entries;
    try {
      entries = await this.withLock(async () => [...this.sessions.entries()]);
    } catch (e) { return; }
    for (const [key, session] of entries) {
      if (!session || session.status !== 'active' || !session.instanceID) continue;
      // Official: only beat sessions within the 30min grace window.
      const graceMs = 30 * 60 * 1000;
      if (session.expiresAt && Date.now() >= session.expiresAt.getTime() + graceMs) continue;
      const token = this._tokenFromKey(key);
      try {
        await this.client.heartbeat(token, session.instanceID);
      } catch (e) {
        // heartbeat() never throws; belt and suspenders.
      }
    }
  }
}

// Official errorFor() message table (SessionManager.errorFor, orchestrator
// 122195-122258): maps admission body.status to the same user-facing copy the
// desktop shows. Keeps status in the error name so callers can classify.
const SUPPORT_EMAIL = 'support@codebuff.com';
function formatRetryDelay(ms) {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return 'a bit';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h`;
}
function sessionErrorFor(body, model, accessTier) {
  const status = body.status || 'error';
  const tier = accessTier || null;
  const msg = (() => {
    switch (status) {
      case 'premium_slot_taken':
        return tier === 'limited'
          ? `Freebuff is limited to one tab at a time on your network. Another tab is running ${body.currentModel} — use that tab, or close it and try again.`
          : `Another tab is using a premium model (${body.currentModel}). Switch this tab to an unlimited model, or change the other tab.`;
      case 'rate_limited':
        return body.period === 'pacific_week'
          ? `Weekly limit reached for ${body.model}. Come back after the weekly reset.`
          : tier === 'limited'
            ? `Daily free limit reached for ${body.model}. Come back after the daily reset.`
            : `Daily limit reached for ${body.model}. Try an unlimited model or come back after the reset.`;
      case 'spend_limited':
        return `${body.message || 'Free usage is temporarily limited.'} Come back in ${formatRetryDelay(body.retryAfterMs)} — your free usage resets automatically at midnight Pacific.`;
      case 'ip_capped':
        return `${body.activeUsersForIp || 'Others'} are already using Freebuff from your network, which is the most we allow at once. Try again in ${formatRetryDelay(body.retryAfterMs)} — a slot opens as soon as one of them finishes.`;
      case 'model_unavailable':
        return `${body.requestedModel} isn't available right now (${body.availableHours}).`;
      case 'banned':
        return `This account has been suspended and can't use Freebuff. If you think this is a mistake, contact ${SUPPORT_EMAIL || 'support@freebuff.com'}.`;
      case 'country_blocked':
        return 'Free mode is not available from your current network.';
      case 'session_limit_reached':
        return tier === 'limited'
          ? 'Freebuff is limited to one tab at a time on your network. Close the other hosted-model tab and try again.'
          : body.bucket === 'premium'
            ? 'Another tab is using the premium-model slot. Switch this tab to an unlimited model, or change the other tab.'
            : `All ${body.limit || 3} unlimited-model tabs are in use. Close one or switch one to a local agent, then try again.`;
      default:
        return `Could not start a Freebuff session for ${model}.`;
    }
  })();
  const err = new Error(msg);
  err.name = 'FreebuffSessionError';
  err.status = status;
  err.body = body;
  return err;
}

module.exports = { TokenPool, sessionErrorFor };
