// Mutable shared runtime state. Modules read/write this instead of holding
// their own copies of the globals that used to live at the top of proxy.js.

const { INITIAL_BUN_VERSION, INITIAL_AI_SDK_PROVIDER_UTILS_VERSION, INITIAL_FREEBUFF_CLI_VERSION } = require('./constants');

const IS_BUN = typeof Bun !== 'undefined';
const RUNTIME_VERSION = IS_BUN ? Bun.version : process.version.replace('v', '');

const state = {
  isBun: IS_BUN,
  runtimeVersion: RUNTIME_VERSION,
  versions: {
    bun: INITIAL_BUN_VERSION,
    aiSdkProviderUtils: INITIAL_AI_SDK_PROVIDER_UTILS_VERSION,
    freebuffCli: INITIAL_FREEBUFF_CLI_VERSION,
    aiSdkCompat: INITIAL_FREEBUFF_CLI_VERSION,
  },
  config: null,
  modelRegistry: null,
  tokenPool: null,
  startTime: new Date(),
  detectedCountry: null,
  // Official desktop semantics: trace_session_id is created once per desktop
  // session (process lifetime) and reused across every turn. Lazily created
  // on first proxied chat request.
  traceSessionId: null,
};

module.exports = { state };