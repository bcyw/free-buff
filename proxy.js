// Free-Buff Proxy — entry point.
//
// Startup: load config -> refresh versions -> detect country -> model registry
// -> validate tokens (with account-ban detection) ->
// token pool (+ 45s session heartbeat) -> HTTP server.

const http = require('http');

const { TOKEN_RELOAD_INTERVAL } = require('./src/constants');
const { state } = require('./src/state');
const { loadConfig, loadFreebuffCLITokens } = require('./src/config');
const { checkAndUpdateVersions, checkProxyVersion } = require('./src/versions');
const { ModelRegistry } = require('./src/model-registry');
const { UpstreamClient } = require('./src/upstream');
const { TokenPool } = require('./src/token-pool');
const { validateToken, validateAllTokens, reloadTokenPool } = require('./src/token-validator');
const { handleRequest, detectCountry } = require('./src/handlers');

async function startServer() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  Free-Buff Proxy - Starting...                                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  try { state.config = loadConfig(); } catch (e) { console.error('Failed to load config:', e.message); process.exit(1); }

  const cliTokens = loadFreebuffCLITokens();
  if (cliTokens.length > 0) {
    console.log(`[Config] Found ${cliTokens.length} token(s) in CLI credentials`);
    state.config.authTokens = [...new Set([...(state.config.authTokens || []), ...cliTokens])];
  }

  await checkAndUpdateVersions();
  await checkProxyVersion();

  await detectCountry();
  // TEST MOCKS
  if (state.config.mockCountry) {
    state.detectedCountry = state.config.mockCountry;
    console.log(`[Country] MOCKED to: ${state.detectedCountry}`);
  }

  state.modelRegistry = new ModelRegistry();
  await state.modelRegistry.start();

  const allTokenResults = await validateAllTokens();
  const validTokens = allTokenResults.filter(r => r.valid);
  const bannedTokens = allTokenResults.filter(r => r.status === 'banned');
  const port = parseInt(state.config.listenAddr.replace(':', '')) || 3001;

  const client = new UpstreamClient(state.config);

  const tokensToUse = validTokens.length > 0
    ? validTokens.map(r => r.token)
    : state.config.authTokens;
  state.tokenPool = new TokenPool(tokensToUse, state.config, client);

  // Account detection: banned tokens are marked (removed from rotation and
  // reported via /healthz + /api/tokens) instead of silently failing later.
  for (const r of bannedTokens) {
    await state.tokenPool.markTokenBanned(r.token, r.reason || 'account banned');
  }

  if (validTokens.length === 0 && state.config.authTokens.length > 0) {
    console.log(`[Warning] No tokens passed validation (${bannedTokens.length} banned, ${allTokenResults.length - validTokens.length - bannedTokens.length} invalid/error), using ${state.config.authTokens.length} configured token(s) anyway`);
  }
  if (bannedTokens.length > 0) {
    console.log(`[Banned] ${bannedTokens.length} token(s) are banned (account suspended) and removed from rotation`);
  }

  state.tokenPool.startHeartbeat();

  const server = http.createServer(handleRequest);
  server.listen(port, '0.0.0.0', () => {
    console.log(`\nFree-Buff Proxy on http://127.0.0.1:${port}`);
    console.log(`  Upstream: ${state.config.upstreamBaseURL}`);
    console.log(`  Models: ${state.modelRegistry.getModels().length}`);
    console.log(`  API keys: ${state.config.apiKeys.length > 0 ? state.config.apiKeys.length + ' (auth enabled)' : 'none (open access)'}`);
    console.log(`  Valid tokens: ${validTokens.length}${bannedTokens.length > 0 ? ` (${bannedTokens.length} banned)` : ''}`);
    console.log('');
  });

  setInterval(async () => {
    const cliTokens = loadFreebuffCLITokens();
    if (cliTokens.length > 0) {
      const currentTokens = new Set(state.config.authTokens || []);
      const newTokens = cliTokens.filter(t => !currentTokens.has(t));
      if (newTokens.length > 0) {
        console.log(`Found ${newTokens.length} new token(s) in CLI credentials`);
        for (const token of newTokens) {
          const result = await validateToken(token);
          if (result.valid) { state.config.authTokens.push(token); console.log(`Added valid token: ${token.substring(0, 8)}...`); }
          else if (result.status === 'banned') console.log(`Skipped banned token: ${token.substring(0, 8)}...`);
        }
        if (state.config.authTokens.length > currentTokens.size) { require('./src/config').saveConfig(state.config); await reloadTokenPool(); }
      }
    }
  }, TOKEN_RELOAD_INTERVAL);

  setInterval(async () => {
    try { await checkAndUpdateVersions(); } catch (e) { /* ignore */ }
    try { await checkProxyVersion(); } catch (e) { /* ignore */ }
  }, 60 * 60 * 1000);
}

if (require.main === module) {
  startServer().catch(e => { console.error('Startup failed:', e); process.exit(1); });
}

module.exports = { startServer };