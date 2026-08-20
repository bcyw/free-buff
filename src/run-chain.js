// Run chain helpers aligned with the official agent-runs lifecycle:
// official base2/base3 free roots are SINGLE-loop agents — one START, one
// FINISH, no context-pruner child (that id is a stub in the official runtime
// and never creates a real run), no gemini parent/chat structure. Each proxied
// chat request is one LLM iteration: step 1, totalSteps 1.

const { GEMINI_SUBAGENT_IDS } = require('./constants');

async function startRunChainNormal(client, token, agentID) {
  const startedAt = new Date().toJSON();
  const runId = await client.startRun(token, agentID, []);
  return { runId, agentId: agentID, startedAt };
}

async function startRunChainGemini(client, token, agentID) {
  const startedAt = new Date().toJSON();
  const runId = await client.startRun(token, agentID, []);
  return { runId, agentId: agentID, startedAt };
}

async function finalizeRunChainNormal(client, token, run, messageId) {
  try {
    client.addPendingStep(token, run.runId, { stepNumber: 1, messageId, startTime: run.startedAt });
    await client.finishRun(token, run.runId, 1);
  } catch (e) { console.error(`finalize run failed: ${e.message}`); }
}

async function finalizeRunChainGemini(client, token, run, messageId) {
  try {
    client.addPendingStep(token, run.runId, { stepNumber: 1, messageId, startTime: run.startedAt });
    await client.finishRun(token, run.runId, 1);
  } catch (e) { console.error(`finalize gemini run failed: ${e.message}`); }
}

async function startRunChainSimple(client, token, agentID) {
  const startedAt = new Date().toJSON();
  const runId = await client.startRun(token, agentID, []);
  return { runId, agentId: agentID, startedAt };
}

async function finalizeRunChainSimple(client, token, run, messageId) {
  try {
    client.addPendingStep(token, run.runId, { stepNumber: 1, messageId, startTime: run.startedAt });
    await client.finishRun(token, run.runId, 1);
  } catch (e) { console.error(`finalize simple run failed: ${e.message}`); }
}

// Official failure path: a failed run gets a FINISH with status failed +
// errorMessage (truncated to 5000 chars server-side).
async function finalizeRunFailed(client, token, run, errorMessage) {
  if (!run || !run.runId) return;
  try {
    await client.finishRun(token, run.runId, 0, { status: 'failed', errorMessage: String(errorMessage || 'run failed').substring(0, 5000) });
  } catch (e) { console.error(`finalize failed run: ${e.message}`); }
}

function isGeminiModel(canonicalModel) {
  return canonicalModel.startsWith('google/gemini-');
}

function getGeminiSubagentId(canonicalModel) {
  if (GEMINI_SUBAGENT_IDS[canonicalModel]) return GEMINI_SUBAGENT_IDS[canonicalModel];
  if (canonicalModel.includes('pro')) return 'thinker-with-files-gemini';
  return 'basher';
}

module.exports = {
  startRunChainNormal,
  startRunChainGemini,
  finalizeRunChainNormal,
  finalizeRunChainGemini,
  startRunChainSimple,
  finalizeRunChainSimple,
  finalizeRunFailed,
  isGeminiModel,
  getGeminiSubagentId,
};