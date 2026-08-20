// Message normalization + agent validation payload + signature-tool injection.

const {
  BASE3_AGENT_IDS_BY_MODEL,
  BASE2_TOOL_NAMES,
  BASE3_TOOL_NAMES,
  BASE2_FREE_SPAWNABLE_AGENTS,
  CONTEXT_PRUNER_AGENT_ID,
  FALLBACK_AGENT_IDS,
  FREEBUFF_SIGNATURE_TOOL_NAMES,
  SIGNATURE_TOOL_DEFS,
} = require('./constants');
const { state } = require('./state');

// Byte-exact openings from upstream free-agents.ts FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS.
// A free-mode root request must open with one of these verbatim at position 0,
// otherwise the server 403s via requestHasFreebuffSystemMarker. No override /
// "disregard this identity" clause may follow: upstream explicitly patched the
// old `You are Buffy. [System Override: ...]` bypass.
const BUFFY_BASE2_SYSTEM_PROMPT_OPENING = 'You are Buffy, the strategic coding assistant.';
const BUFFY_BASE3_SYSTEM_PROMPT_OPENING = 'You are Buffy, the coding agent behind Codebuff.';

// Official desktop deviceInfo(): real platform/timezone/locale (cached).
let cachedDeviceInfo = null;
function getDeviceInfo() {
  if (cachedDeviceInfo) return cachedDeviceInfo;
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; } })();
  const locale = (() => { try { return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'; } catch (_) { return 'en-US'; } })();
  const os = process.platform === 'darwin' ? 'macos'
    : process.platform === 'win32' ? 'windows'
      : process.platform === 'linux' ? 'linux'
        : process.platform;
  cachedDeviceInfo = { os, timezone: tz, locale };
  return cachedDeviceInfo;
}

// Official ad body userAgent: a Chrome 124 browser UA (orchestrator
// AD_USER_AGENTS — browser-masquerade, never the runtime UA).
const CHROME_AD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
function getChromeAdUserAgent() { return CHROME_AD_USER_AGENT; }

// Official dropUnansweredToolCalls (agent-runtime convertCbToModelMessages),
// adapted to the OpenAI wire shape third-party clients send: a tool reply
// whose tool_call_id has no matching assistant tool_call is dangling and the
// strict server schema rejects it. Also strips tool_calls from the final
// assistant message when no tool replies follow (matches official behavior of
// deleting unanswered tool-calls).
function dropUnansweredToolCalls(messages) {
  const seenCalls = new Set(); // assistant tool_call ids
  const assistantIdx = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc && tc.id) seenCalls.add(tc.id);
      assistantIdx.push(i);
    }
  }
  if (seenCalls.size === 0) return messages;
  const out = messages.filter((m) => !(m && m.role === 'tool' && m.tool_call_id && !seenCalls.has(m.tool_call_id)));
  return out;
}

function normalizeChatMessages(messages, opening = BUFFY_BASE2_SYSTEM_PROMPT_OPENING) {
  if (!Array.isArray(messages)) return [];
  const normalized = [];
  let hasSystem = false;
  for (const msg of dropUnansweredToolCalls(messages)) {
    if (!msg || typeof msg !== 'object') continue;
    const item = { ...msg };
    if (item.role === 'developer') item.role = 'system';
    if (item.role === 'system') {
      hasSystem = true;
      let content = item.content || '';
      if (typeof content === 'string' && !content.startsWith(opening)) {
        item.content = opening + '\n\n' + content;
      }
    }
    normalized.push(item);
  }
  if (!hasSystem) {
    normalized.unshift({
      role: 'system',
      content: opening,
    });
  }
  return normalized;
}

function normalizeAdMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(msg => ({
    role: msg.role === 'developer' ? 'system' : (msg.role || 'user'),
    content: typeof msg.content === 'string' ? msg.content : (msg.content && Array.isArray(msg.content) ? msg.content.map(p => p.text || '').join('\n') : ''),
  }));
}

function buildAgentValidationPayload() {
  const pairs = [];
  const seen = new Set();
  const add = (id, model, base3) => {
    if (!id || !model || seen.has(id)) return;
    seen.add(id);
    pairs.push({ id, model, base3 });
  };

  for (const [model, agent] of Object.entries(BASE3_AGENT_IDS_BY_MODEL)) add(agent, model, true);
  const registry = state.modelRegistry;
  if (registry) {
    for (const model of registry.getModels()) {
      const agent = registry.getAgentForModel(model) || FALLBACK_AGENT_IDS[model];
      if (agent && agent.startsWith('base3-')) add(agent, model, true);
    }
  }
  // Keep the legacy roots valid for max-context tiers and staggered clients.
  add('base2-free', 'minimax/minimax-m3', false);
  add('base2-free-deepseek', 'deepseek/deepseek-v4-pro', false);
  add('base2-free-deepseek-flash', 'deepseek/deepseek-v4-flash', false);
  add('base2-free-mimo', 'mimo/mimo-v2.5', false);
  add(CONTEXT_PRUNER_AGENT_ID, 'deepseek/deepseek-v4-flash', false);

  return {
    agentDefinitions: pairs.map(a => ({
      id: a.id,
      publisher: 'codebuff',
      model: a.model,
      displayName: `Freebuff ${a.model}`,
      spawnerPrompt: 'Advanced coding agent that explores, edits, and verifies the user\'s project',
      inputSchema: { prompt: { type: 'string', description: 'A coding task to complete' }, params: { type: 'object', properties: {}, required: [] } },
      outputMode: 'last_message',
      includeMessageHistory: true,
      toolNames: a.base3 ? BASE3_TOOL_NAMES : BASE2_TOOL_NAMES,
      spawnableAgents: a.base3 ? [] : BASE2_FREE_SPAWNABLE_AGENTS,
      systemPrompt: a.base3
        ? 'You are Buffy, the coding agent behind Codebuff.\n\nCurrent date: 2026-08-15.'
        : 'You are Buffy, the strategic coding assistant.\n\nCurrent date: 2026-08-15.',
    })),
  };
}

/** Ensure a proxied chat body carries at least one Freebuff signature tool. */
function ensureSignatureTool(body) {
  if (!body || !Array.isArray(body.tools) || body.tools.length === 0) return;
  const names = body.tools
    .map((t) => t && t.function && t.function.name)
    .filter(Boolean);
  if (names.some((n) => FREEBUFF_SIGNATURE_TOOL_NAMES.has(n))) return;
  body.tools.push(...SIGNATURE_TOOL_DEFS);
}

module.exports = {
  BUFFY_BASE2_SYSTEM_PROMPT_OPENING,
  BUFFY_BASE3_SYSTEM_PROMPT_OPENING,
  normalizeChatMessages,
  normalizeAdMessages,
  buildAgentValidationPayload,
  ensureSignatureTool,
  getDeviceInfo,
  getChromeAdUserAgent,
};