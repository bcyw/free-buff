#!/usr/bin/env node
/**
 * Freebuff 官方 CLI 登录流（复刻官方 orchestrator/auth-host 的 issue+poll 逻辑）：
 *   1. POST {AUTH_HOST}/api/auth/cli/code   body: { fingerprintId }（客户端生成 UUID）
 *        → { loginUrl, fingerprintHash, expiresAt, expiresInMs? }
 *   2. 浏览器打开 loginUrl 完成登录
 *   3. GET  {AUTH_HOST}/api/auth/cli/status?fingerprintId=&fingerprintHash=&expiresAt=
 *        每 2s 轮询（POLL_INTERVAL_MS），10s 单次超时（POLL_REQUEST_TIMEOUT_MS）
 *        → { user: { authToken, id, email, name } }
 *   4. 保存到 <项目>/.config/credentials.json（官方 CLI 格式，供 loadFreebuffCLITokens
 *      自动读取）+ <项目>/.config/tokens.json（多账号，0600 权限，仿 cline-gateway）
 *      读取时优先项目 .config，官方 ~/.config/manicode/credentials.json 仍作为 fallback。
 *
 * 用法：
 *   node src/oauth.js                          # 交互式登录（自动打开浏览器）
 *   FREEBUFF_AUTH_HOST=https://freebuff.com node src/oauth.js   # 自定义 AUTH_HOST
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Route the sign-in flow through the configured upstream proxy too: the
// auth host is a US service and the usage tier is resolved per-request from
// the egress IP — keeping the login flow on the same egress as usage avoids
// region inconsistencies.
const { proxiedFetch } = require('./net-agent');
const fetch = proxiedFetch;

const AUTH_HOST = (process.env.FREEBUFF_AUTH_HOST || 'https://freebuff.com').replace(/\/+$/, '');
const POLL_INTERVAL_MS = 2000;
const ISSUE_REQUEST_TIMEOUT_MS = 15000;
const POLL_REQUEST_TIMEOUT_MS = 10000;
const CODE_LIFETIME_FALLBACK_MS = 3600000; // 1h（官方 CLI_AUTH_CODE_LIFETIME_MS）
const CODE_LIFETIME_MAX_MS = 7200000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  attempts: new Map(), // attemptId -> { fingerprintId, fingerprintHash, expiresAt, loginUrl, deadline, startedAt }
};

function codeLifetimeMs(expiresInMs) {
  if (typeof expiresInMs === 'number' && Number.isFinite(expiresInMs) && expiresInMs > 0) {
    return Math.min(expiresInMs, CODE_LIFETIME_MAX_MS);
  }
  return CODE_LIFETIME_FALLBACK_MS;
}

async function issue(signal) {
  const fingerprintId = crypto.randomUUID();
  let res;
  try {
    res = await fetch(`${AUTH_HOST}/api/auth/cli/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprintId }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(ISSUE_REQUEST_TIMEOUT_MS)]),
    });
  } catch (e) {
    throw new Error(`Could not reach ${AUTH_HOST}: ${e.message}`);
  }
  if (!res.ok) throw new Error(`The sign-in service at ${AUTH_HOST} returned HTTP ${res.status}.`);
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') throw new Error('login code response is invalid');
  if (typeof data.loginUrl !== 'string' || !data.loginUrl) throw new Error('login code response missing loginUrl');
  const fingerprintHash = typeof data.fingerprintHash === 'string' ? data.fingerprintHash.trim() : '';
  if (!fingerprintHash) throw new Error('login code response missing fingerprintHash');
  const expiresAt = Number(data.expiresAt);
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) throw new Error('login code response has invalid expiresAt');
  return {
    attemptId: crypto.randomUUID(),
    fingerprintId,
    fingerprintHash,
    expiresAt,
    deadline: Date.now() + codeLifetimeMs(data.expiresInMs),
    loginUrl: data.loginUrl,
  };
}

async function pollOnce(attempt) {
  const url = new URL(`${AUTH_HOST}/api/auth/cli/status`);
  url.searchParams.set('fingerprintId', attempt.fingerprintId);
  url.searchParams.set('fingerprintHash', attempt.fingerprintHash);
  url.searchParams.set('expiresAt', String(attempt.expiresAt));
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data && data.user ? data.user : null;
}

// 轮询直到拿到 user 或超时。返回 { user } | { expired: true }
async function pollUntilDone(attempt, { onWait } = {}) {
  while (Date.now() < attempt.deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() >= attempt.deadline) break;
    let user = null;
    try { user = await pollOnce(attempt); } catch (_) { /* transient, retry */ }
    if (user && typeof user.authToken === 'string' && user.authToken) {
      return { user };
    }
    if (onWait) onWait();
  }
  return { expired: true };
}

// --- storage ---
// 项目内 credentials（本代理的主保存位置；读取端 config.js 会优先读这里，
// 官方 ~/.config/manicode/credentials.json 仍作为 fallback 兼容）
function projectCredentialsPath() {
  return path.join(__dirname, '..', '.config', 'credentials.json');
}

function projectTokensPath() {
  return path.join(__dirname, '..', '.config', 'tokens.json');
}

function saveManicodeCredentials(user) {
  const p = projectCredentialsPath();
  let data = {};
  if (fs.existsSync(p)) {
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  }
  data.default = {
    id: user.id || data.default?.id,
    name: user.name || data.default?.name || '',
    email: user.email || data.default?.email || '',
    authToken: user.authToken,
    fingerprintId: user.fingerprintId || data.default?.fingerprintId || '',
    fingerprintHash: user.fingerprintHash || data.default?.fingerprintHash || '',
  };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  try { fs.chmodSync(p, 0o600); } catch (_) {}
}

// 多账号累加保存（按 email 去重），0600 权限（仿 cline-gateway oauth.js）
function saveProjectTokens(user) {
  const p = projectTokensPath();
  let arr = [];
  if (fs.existsSync(p)) {
    try { arr = JSON.parse(fs.readFileSync(p, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch (_) { arr = []; }
  }
  const entry = { authToken: user.authToken, id: user.id || null, email: user.email || null, name: user.name || null, savedAt: new Date().toISOString() };
  const idx = entry.email ? arr.findIndex((t) => t.email === entry.email) : arr.findIndex((t) => t.authToken === entry.authToken);
  if (idx >= 0) arr[idx] = { ...arr[idx], ...entry };
  else arr.push(entry);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(arr, null, 2) + '\n');
  try { fs.chmodSync(p, 0o600); } catch (_) {}
}

// --- HTTP-mode helpers (used by handlers.js: /api/auth/start, /api/auth/status) ---
async function startLoginAsync() {
  const attempt = await issue(new AbortController().signal);
  state.attempts.set(attempt.attemptId, attempt);
  for (const [id, a] of state.attempts) {
    if (Date.now() >= a.deadline) state.attempts.delete(id);
  }
  return { attemptId: attempt.attemptId, loginUrl: attempt.loginUrl, expiresAt: attempt.expiresAt };
}

async function checkLogin(attemptId) {
  const attempt = state.attempts.get(attemptId);
  if (!attempt) return { status: 'not_found' };
  if (Date.now() >= attempt.deadline) {
    state.attempts.delete(attemptId);
    return { status: 'expired' };
  }
  let user = null;
  try { user = await pollOnce(attempt); } catch (_) {}
  if (user && typeof user.authToken === 'string' && user.authToken) {
    state.attempts.delete(attemptId);
    try {
      saveManicodeCredentials(user);
      saveProjectTokens(user);
      console.log(`[OAuth] Login saved: ${user.email || user.id || 'unknown'} → .config/credentials.json + .config/tokens.json`);
    } catch (e) {
      console.error(`[OAuth] Save failed: ${e.message}`);
      return { status: 'save_failed' };
    }
    return {
      status: 'done',
      token: user.authToken,
      user: {
        id: user.id || null,
        email: user.email || null,
        name: user.name || null,
      },
    };
  }
  return { status: 'pending', expiresAt: attempt.expiresAt };
}

function cancelLogin(attemptId) {
  state.attempts.delete(attemptId);
}

function getLoginAttempts() {
  const out = {};
  for (const [id, a] of state.attempts) {
    out[id] = { expiresAt: a.expiresAt, loginUrl: a.loginUrl };
  }
  return out;
}

// ---------------------------------------------------------------- CLI main
async function main() {
  console.log('='.repeat(60));
  console.log('Freebuff 官方登录（CLI code 流）');
  console.log(`AUTH_HOST: ${AUTH_HOST}`);
  console.log('='.repeat(60));

  const attempt = await issue(new AbortController().signal);
  console.log('1. 在浏览器中完成登录（自动打开，失败请手动复制）:');
  console.log(`   ${attempt.loginUrl}`);
  console.log(`2. 代码有效期: ${Math.round((attempt.deadline - Date.now()) / 60000)} 分钟`);
  console.log('='.repeat(60));

  try {
    const { exec } = require('child_process');
    const opener = process.platform === 'darwin'
      ? `open "${attempt.loginUrl}"`
      : process.platform === 'win32'
        ? `start "" "${attempt.loginUrl}"`
        : `xdg-open "${attempt.loginUrl}" >/dev/null 2>&1 &`;
    exec(opener, (err) => { if (err) console.log('   (未能自动打开浏览器，请手动复制链接)'); });
  } catch (_) {}

  let waited = false;
  const result = await pollUntilDone(attempt, { onWait: () => { if (!waited) { waited = true; console.log('   等待授权确认...'); } } });
  if (result.expired) {
    console.error('\n登录超时，请重新运行。');
    process.exit(1);
  }

  const user = result.user;
  saveManicodeCredentials(user);
  saveProjectTokens(user);

  console.log('='.repeat(60));
  console.log(`账号:     ${user.email || 'unknown'}`);
  console.log(`id:       ${user.id || 'unknown'}`);
  console.log(`token:    ${user.authToken.slice(0, 8)}...${user.authToken.slice(-4)}`);
  console.log(`已保存到: ${projectCredentialsPath()}`);
  console.log(`          ${projectTokensPath()}`);
  console.log('启动代理: node proxy.js');
  console.log('='.repeat(60));
}

if (require.main === module) {
  main().catch((e) => { console.error(`\n登录失败: ${e.message}`); process.exit(1); });
}

module.exports = {
  startLoginAsync,
  checkLogin,
  cancelLogin,
  getLoginAttempts,
  issue,
  pollUntilDone,
  saveManicodeCredentials,
  saveProjectTokens,
  AUTH_HOST,
};