// Runtime version refresh (Freebuff CLI / Bun / SDK compat) + proxy self-update check.

const { FREEBUFF2API_RS_SOURCE, PROXY_VERSION, NPM_PACKAGE_NAME } = require('./constants');
const { state } = require('./state');
const { httpGet, versionCompare } = require('./util');

function getApiUserAgent() { return `Bun/${state.versions.bun}`; }
// Official wire UA (desktop orchestrator getModelForRequest + provider-utils):
//   ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/node.js/v24.x
// getRuntimeEnvironmentUserAgent in ai-sdk/provider-utils returns
// "runtime/node.js/v<version>" under Node (and under Bun, which simulates
// process.versions.node). We used "runtime/browser" before — wrong fingerprint.
function runtimeUserAgentSuffix() {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    return `runtime/node.js/${process.version}`;
  }
  if (typeof Bun !== 'undefined') return 'runtime/bun';
  return 'runtime/unknown';
}
function getChatUserAgent() {
  return `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/${state.versions.aiSdkProviderUtils} ${runtimeUserAgentSuffix()}`;
}
function getAdsUserAgent() { return `Freebuff-CLI/${state.versions.freebuffCli}`; }

async function checkAndUpdateVersions() {
  const updates = [];

  try {
    const { status, data } = await httpGet(FREEBUFF2API_RS_SOURCE, { headers: { 'Accept': 'text/plain' } });
    if (status === 200) {
      const bunMatch = data.match(/"Bun\/(\d+\.\d+\.\d+)"/);
      if (bunMatch && bunMatch[1] !== state.versions.bun) {
        updates.push(`Bun: ${state.versions.bun} -> ${bunMatch[1]}`);
        state.versions.bun = bunMatch[1];
      }
    }
  } catch (e) {
    console.error(`[Versions] Failed to fetch RS source: ${e.message}`);
  }

  try {
    const { status: npmStatus, data: npmData } = await httpGet('https://registry.npmjs.org/freebuff/latest');
    if (npmStatus === 200) {
      try {
        const pkg = JSON.parse(npmData);
        if (pkg.version && pkg.version !== state.versions.freebuffCli) {
          updates.push(`Freebuff-CLI: ${state.versions.freebuffCli} -> ${pkg.version}`);
          state.versions.freebuffCli = pkg.version;
          state.versions.aiSdkCompat = pkg.version;
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error(`[Versions] Failed to fetch npm registry: ${e.message}`);
  }

  if (updates.length > 0) {
    console.log(`[Versions] Updated: ${updates.join(', ')}`);
    return true;
  }
  return false;
}

async function checkProxyVersion() {
  try {
    const { status, data } = await httpGet(`https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`);
    if (status !== 200) return;
    const pkg = JSON.parse(data);
    const latest = pkg.version;
    if (!latest || versionCompare(latest, PROXY_VERSION) <= 0) return;

    const msg = `Freebuff Proxy is outdated!\n\nCurrent: v${PROXY_VERSION}\nLatest:  v${latest}\n\nUpdate with: npm install -g ${NPM_PACKAGE_NAME}\nor: cd ${__dirname} && npm install\n\nThe proxy will now close.`;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  OUTDATED: v${PROXY_VERSION} -> v${latest}`);
    console.log(`  Update: npm install -g ${NPM_PACKAGE_NAME}`);
    console.log(`${'='.repeat(60)}\n`);

    if (process.platform === 'win32') {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const vbsPath = path.join(os.tmpdir(), 'freebuff_alert.vbs');
      fs.writeFileSync(vbsPath, `MsgBox "Freebuff Proxy is outdated!" & vbCrLf & vbCrLf & "Current: v${PROXY_VERSION}" & vbCrLf & "Latest:  v${latest}" & vbCrLf & vbCrLf & "Run: npm install -g ${NPM_PACKAGE_NAME}", vbExclamation, "Freebuff Proxy - Update Required"`);
      const { execSync } = require('child_process');
      try { execSync(`cscript //nologo "${vbsPath}"`, { timeout: 30000 }); } catch {}
      try { fs.unlinkSync(vbsPath); } catch {}
    }

    process.exit(1);
  } catch (e) {
    // silent fail
  }
}

module.exports = {
  getApiUserAgent,
  getChatUserAgent,
  getAdsUserAgent,
  runtimeUserAgentSuffix,
  checkAndUpdateVersions,
  checkProxyVersion,
};