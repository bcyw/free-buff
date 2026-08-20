// Upstream egress proxy (region control).
//
// The Freebuff access tier (full/limited) is a REGION property resolved from
// the caller's IP country. Setting UPSTREAM_PROXY in config.json routes every
// request TO codebuff.com (sessions, chat, ads, agent-runs) and the country
// probes through the configured proxy, so the tier is judged on the proxy's
// region instead of the host's. Leave empty for direct egress.
//
// Supported schemes: http://, https:// (CONNECT tunnel), socks4://, socks5://
// (credentials may be embedded: socks5://user:pass@host:port).
//
// Node-fetch requests get an `agent` (HttpsProxyAgent/SocksProxyAgent);
// the local dashboards' fetch calls are routed through node-fetch as well so
// both paths share one egress.

const nodeFetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { loadConfig } = require('./config');

let cachedUrl = null;
let cachedAgent = null;

function resolveProxyUrl() {
  return (loadConfig().upstreamProxy || '').trim() || null;
}

function refresh() {
  const url = resolveProxyUrl();
  if (url === cachedUrl) return;
  cachedUrl = url;
  cachedAgent = null;
  if (!url) {
    console.log('[Proxy] upstream egress: direct');
    return;
  }
  cachedAgent = /^socks/i.test(url)
    ? new SocksProxyAgent(url)
    : new HttpsProxyAgent(url);
  console.log(`[Proxy] upstream egress via: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
}

refresh();

function getAgent() {
  return cachedAgent;
}

function proxiedFetch(url, opts = {}) {
  return cachedAgent
    ? nodeFetch(url, { ...opts, agent: cachedAgent })
    : nodeFetch(url, opts);
}

module.exports = { getAgent, proxiedFetch };
