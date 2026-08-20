// Token validation with account-level detection.
//
// Account detection (new): before the expensive createSession probe, each
// token is checked with a fast GET /api/v1/me?fields=id,email,banned,created_at
// (8s timeout). Outcomes:
//   - banned:true            -> account banned (upstream suspended it for
//                               third-party client/proxy use, etc.)
//   - HTTP 401/403           -> token no longer valid
//   - HTTP 200, banned:false -> account OK; then the legacy createSession
//                               probe decides free-session usability
//   - probe failure          -> fall through to legacy createSession probe so
//                               transient network issues don't reject tokens
//
// Runtime ban detection lives in handlers.proxyChatRequest (chat response with
// account_suspended / banned) which calls tokenPool.markTokenBanned().

const { UpstreamClient } = require('./upstream');
const { TokenPool } = require('./token-pool');
const { loadConfig } = require('./config');
const { state } = require('./state');

const ME_PROBE_TIMEOUT_MS = 8000;

/**
 * Fast account-status probe. Returns one of:
 *   { status: 'banned', email, reason }
 *   { status: 'invalid', reason }            (401/403 / malformed)
 *   { status: 'ok', email, id }
 *   { status: 'unknown', reason }            (network or probe failure)
 */
async function checkAccountStatus(token) {
  const client = new UpstreamClient(state.config);
  try {
    const me = await client.getMe(token, ME_PROBE_TIMEOUT_MS);
    const body = (me.body || '').substring(0, 400);

    if (me.status === 401 || me.status === 403) {
      return { status: 'invalid', reason: `HTTP ${me.status}: token rejected by upstream` };
    }
    if (me.status >= 200 && me.status < 300 && me.data) {
      if (me.data.banned === true) {
        return {
          status: 'banned',
          email: me.data.email || null,
          id: me.data.id || null,
          reason: 'account banned by Freebuff (suspended)',
        };
      }
      return { status: 'ok', email: me.data.email || null, id: me.data.id || null };
    }
    // Non-2xx that isn't 401/403: still try the legacy probe.
    return { status: 'unknown', reason: `me probe HTTP ${me.status}: ${body}` };
  } catch (e) {
    return { status: 'unknown', reason: e.message };
  }
}

/**
 * Validate one token. Returns:
 *   { valid: true,  token, masked, status: 'active', email }
 *   { valid: false, token, masked, status: 'banned'|'invalid'|'error', reason, email }
 */
async function validateToken(token) {
  const masked = token.substring(0, 8) + '...' + token.substring(token.length - 4);
  const base = { token, masked };

  // 1) Account-level fast probe.
  const acct = await checkAccountStatus(token);
  if (acct.status === 'banned') {
    console.error(`Token ${masked} is BANNED (account suspended): ${acct.reason}${acct.email ? ` (${acct.email})` : ''}`);
    return { ...base, valid: false, status: 'banned', reason: acct.reason, email: acct.email };
  }
  if (acct.status === 'invalid') {
    console.error(`Token ${masked} is INVALID: ${acct.reason}`);
    return { ...base, valid: false, status: 'invalid', reason: acct.reason, email: acct.email };
  }
  if (acct.status === 'ok') {
    console.log(`Token ${masked} account OK${acct.email ? ` (${acct.email})` : ''}`);
  } else {
    console.log(`Token ${masked} me-probe inconclusive (${acct.reason}), falling back to session probe`);
  }

  // 2) Session status probe — official refreshTier GET (no instance header,
  // no admission): verifies token validity + free-session availability WITHOUT
  // creating an instance. A POST admission probe would burn ≥0.1h of quota
  // per boot (rounded-up 0.1h granularity) and leave orphan slots.
  try {
    const client = new UpstreamClient(state.config);
    const session = await client.refreshSession(token);
    const status = (session && session.status) || '';
    if (status === 'banned') {
      console.error(`Token ${masked} is BANNED (session status=banned)`);
      return { ...base, valid: false, status: 'banned', reason: 'session probe returned status=banned', email: acct.email };
    }
    if (status === 'unauthenticated' || status === 'disabled') {
      console.error(`Token ${masked} is ${status.toUpperCase()} (session status=${status})`);
      return { ...base, valid: false, status, reason: `session probe returned status=${status}`, email: acct.email };
    }
    // none / active / rate_limited / spend_limited / ip_capped / … all mean
    // the token is valid — quota states are informational only (rate_limited
    // is NOT invalid; the account is fine, it is simply out of free hours
    // until the daily reset). Surface the quota snapshot for the UI.
    const quota = session && session.rateLimitsByModel ? session.rateLimitsByModel : null;
    return { ...base, valid: true, status: 'active', email: acct.email, quota };
  } catch (e) {
    // GET failed entirely (network/auth). Do NOT fall back to a POST
    // admission here — that would burn quota on every boot. The caller's
    // "use configured tokens anyway" fallback keeps the pool running.
    console.error(`Token ${masked} validation error: ${e.message}`);
    return { ...base, valid: false, status: 'error', reason: e.message, email: acct.email };
  }
}

async function validateAllTokens() {
  if (!state.config.authTokens || state.config.authTokens.length === 0) { console.log('No auth tokens configured'); return []; }
  const results = [];
  for (const token of state.config.authTokens) {
    const result = await validateToken(token);
    results.push(result);
    if (result.valid) console.log(`Token ${result.masked} is valid`);
    else if (result.status === 'banned') console.log(`Token ${result.masked} is BANNED (${result.reason || 'account suspended'})`);
    else console.log(`Token ${result.masked} is INVALID (${result.status}: ${result.reason || ''})`);
  }
  return results;
}

async function reloadTokenPool() {
  state.config = loadConfig();
  const client = new UpstreamClient(state.config);
  if (state.tokenPool) state.tokenPool.stopHeartbeat();
  state.tokenPool = new TokenPool(state.config.authTokens, state.config, client);
  state.tokenPool.startHeartbeat();
  console.log(`TokenPool reloaded with ${state.config.authTokens.length} token(s)`);
}

module.exports = {
  checkAccountStatus,
  validateToken,
  validateAllTokens,
  reloadTokenPool,
};