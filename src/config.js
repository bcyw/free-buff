// Config loading/saving + Freebuff CLI credential discovery.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { state } = require('./state');

function loadConfig() {
  const configPath = path.join(__dirname, '..', '.config', 'config.json');
  let rawConfig = {
    LISTEN_ADDR: ':3001',
    UPSTREAM_BASE_URL: 'https://www.codebuff.com',
    REQUEST_TIMEOUT: '15m'
  };
  if (fs.existsSync(configPath)) {
    try { rawConfig = { ...rawConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; } catch (e) { console.error('Failed to parse config.json:', e.message); }
  }
  if (process.env.LISTEN_ADDR) rawConfig.LISTEN_ADDR = process.env.LISTEN_ADDR;
  if (process.env.UPSTREAM_BASE_URL) rawConfig.UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL;
  if (process.env.REQUEST_TIMEOUT) rawConfig.REQUEST_TIMEOUT = process.env.REQUEST_TIMEOUT;
  if (process.env.AUTH_TOKENS) rawConfig.AUTH_TOKENS = process.env.AUTH_TOKENS.split(',').map(t => t.trim()).filter(Boolean);
  if (process.env.API_KEYS) rawConfig.API_KEYS = process.env.API_KEYS.split(',').map(t => t.trim()).filter(Boolean);
  if (process.env.ENABLED_MODELS) rawConfig.ENABLED_MODELS = process.env.ENABLED_MODELS.split(',').map(t => t.trim()).filter(Boolean);
  if (process.env.MOCK_COUNTRY) rawConfig.MOCK_COUNTRY = process.env.MOCK_COUNTRY.trim().toUpperCase();
  if (process.env.UPSTREAM_PROXY) rawConfig.UPSTREAM_PROXY = process.env.UPSTREAM_PROXY.trim();
  if (!rawConfig.AUTH_TOKENS || rawConfig.AUTH_TOKENS.length === 0) {
    const cliTokens = loadFreebuffCLITokens();
    if (cliTokens.length > 0) { rawConfig.AUTH_TOKENS = cliTokens; console.log(`Loaded ${cliTokens.length} token(s) from Freebuff CLI`); }
  }
  const requestTimeout = require('./util').parseDuration(rawConfig.REQUEST_TIMEOUT);
  if (!rawConfig.LISTEN_ADDR) throw new Error('LISTEN_ADDR cannot be empty');
  if (!rawConfig.UPSTREAM_BASE_URL) throw new Error('UPSTREAM_BASE_URL cannot be empty');
  if (requestTimeout <= 0) throw new Error('REQUEST_TIMEOUT must be greater than zero');
  let baseURL = rawConfig.UPSTREAM_BASE_URL.trim().replace(/\/+$/, '');
  try { const parsed = new URL(baseURL); if (parsed.host.toLowerCase() === 'codebuff.com') { parsed.host = 'www.codebuff.com'; baseURL = parsed.toString().replace(/\/+$/, ''); } } catch (e) {}
  return {
    listenAddr: rawConfig.LISTEN_ADDR,
    upstreamBaseURL: baseURL,
    authTokens: [...new Set(rawConfig.AUTH_TOKENS || [])],
    requestTimeout,
    apiKeys: [...new Set(rawConfig.API_KEYS || [])],
    mockCountry: rawConfig.MOCK_COUNTRY || null,
    upstreamProxy: rawConfig.UPSTREAM_PROXY || null,
    enabledModels: Array.isArray(rawConfig.ENABLED_MODELS) ? rawConfig.ENABLED_MODELS : null,
    legacyDisabledModels: Array.isArray(rawConfig.DISABLED_MODELS) ? rawConfig.DISABLED_MODELS : null,
    actingUserId: rawConfig.ACTING_USER_ID || process.env.ACTING_USER_ID || loadActingUserId() || null
  };
}

function loadFreebuffCLITokens() {
  const tokens = [];
  const credFile = 'credentials.json';
  const subPath = path.join('.config', 'manicode', credFile);

  const searchPaths = [];
  const seen = new Set();
  const addPath = (p) => {
    const resolved = path.resolve(p);
    if (!seen.has(resolved)) { seen.add(resolved); searchPaths.push(resolved); }
  };

  // 优先：项目内 credentials（OAuth 新保存位置）
  addPath(path.join(__dirname, '..', '.config', credFile));

  const home = os.homedir();
  addPath(path.join(home, subPath));

  const envCandidates = [
    process.env.USERPROFILE, process.env.HOME,
    (process.env.HOMEDRIVE && process.env.HOMEPATH) ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH) : null,
    process.env.APPDATA, process.env.LOCALAPPDATA, process.env.XDG_CONFIG_HOME
  ].filter(Boolean);
  for (const envDir of envCandidates) {
    if (envDir) {
      addPath(path.join(envDir, subPath));
      if (path.basename(envDir) !== 'manicode') {
        addPath(path.join(envDir, credFile));
      }
    }
  }

  if (process.platform === 'win32') {
    try {
      const root = path.parse(home).root || 'C:\\';
      const usersDir = path.join(root, 'Users');
      if (fs.existsSync(usersDir)) {
        for (const entry of fs.readdirSync(usersDir)) {
          if (entry.startsWith('.')) continue;
          const userDir = path.join(usersDir, entry);
          try {
            if (!fs.statSync(userDir).isDirectory()) continue;
          } catch (e) { continue; }
          addPath(path.join(userDir, subPath));
          addPath(path.join(userDir, 'AppData', 'Roaming', 'manicode', credFile));
          addPath(path.join(userDir, 'AppData', 'Local', 'manicode', credFile));
        }
      }
    } catch (e) {}
  } else {
    const etcPasswd = '/etc/passwd';
    try {
      const passwd = fs.readFileSync(etcPasswd, 'utf8');
      for (const line of passwd.split('\n')) {
        const parts = line.split(':');
        if (parts.length >= 6 && parts[2] !== '0' && parts[5]) {
          addPath(path.join(parts[5], subPath));
          addPath(path.join(parts[5], '.local', 'share', 'manicode', credFile));
        }
      }
    } catch (e) {}
    addPath(path.join('/root', subPath));
  }

  for (const credPath of searchPaths) {
    if (fs.existsSync(credPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        if (data.default && data.default.authToken) tokens.push(data.default.authToken);
        for (const [key, value] of Object.entries(data)) {
          if (key !== 'default' && value && value.authToken) tokens.push(value.authToken);
        }
        if (tokens.length > 0) break;
      } catch (e) { console.error('Failed to parse Freebuff CLI credentials:', e.message); }
    }
  }
  return tokens;
}

// The official acting user id (`x-freebuff-acting-user-id`) comes from the
// same credentials file — `default.id` (the user's account id, a UUID).
function loadActingUserId() {
  const credFile = 'credentials.json';
  const candidates = [
    path.join(__dirname, '..', '.config', credFile),
    path.join(os.homedir(), '.config', 'manicode', credFile),
    ...(process.env.XDG_CONFIG_HOME ? [path.join(process.env.XDG_CONFIG_HOME, 'manicode', credFile)] : []),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'manicode', credFile)] : []),
  ];
  for (const credPath of candidates) {
    if (!fs.existsSync(credPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      if (data.default && typeof data.default.id === 'string' && data.default.id) {
        return data.default.id;
      }
    } catch (e) {}
  }
  return null;
}

function saveConfig(cfg) {
  const configDir = path.join(__dirname, '..', '.config');
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.json');
  const backupPath = path.join(configDir, 'config.backup.json');
  if (!fs.existsSync(backupPath) && fs.existsSync(configPath)) {
    try { fs.copyFileSync(configPath, backupPath); } catch (e) { console.error('Failed to create config backup:', e.message); }
  }
  fs.writeFileSync(configPath, JSON.stringify({
    LISTEN_ADDR: cfg.listenAddr,
    UPSTREAM_BASE_URL: cfg.upstreamBaseURL,
    AUTH_TOKENS: cfg.authTokens,
    REQUEST_TIMEOUT: `${cfg.requestTimeout / (60 * 1000)}m`,
    API_KEYS: cfg.apiKeys,
    ENABLED_MODELS: cfg.enabledModels || []
  }, null, 2));
}

module.exports = {
  loadConfig,
  loadFreebuffCLITokens,
  loadActingUserId,
  saveConfig,
};
