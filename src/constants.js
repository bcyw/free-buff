// Immutable constants for the Freebuff2Opencode proxy.
// Version strings that change at runtime live in ./state.js (state.versions).

const FREE_AGENTS_SOURCE_URL = 'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/free-agents.ts';
const FREEBUFF_MODELS_SOURCE_URL = 'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/freebuff-models.ts';
const FREEBUFF_MODEL_IDS_SOURCE_URL = 'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/freebuff-model-ids.ts';
const MODEL_CONFIG_SOURCE_URL = 'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/model-config.ts';
const FREEBUFF2API_RS_SOURCE = 'https://raw.githubusercontent.com/XxxXTeam/freebuff2api_rs/main/src/codebuff.rs';

const MODEL_REFRESH_INTERVAL = 6 * 60 * 60 * 1000;
const TOKEN_RELOAD_INTERVAL = 5 * 60 * 1000;

const PROXY_VERSION = '1.0.0';
const NPM_PACKAGE_NAME = 'freebuff-proxy';

// Initial version strings; refreshed at runtime into state.versions.
// provider-utils 3.0.25 matches the current desktop orchestrator bundle.
const INITIAL_BUN_VERSION = '1.3.11';
const INITIAL_AI_SDK_PROVIDER_UTILS_VERSION = '3.0.25';
const INITIAL_FREEBUFF_CLI_VERSION = '0.0.96';

const CODEBUFF_ACCEPT_ENCODING = 'gzip, deflate';
const CODEBUFF_JSON_USER_AGENT = 'Bun/1.3.11';
// Keep in sync with the installed CLI (`npm ls -g freebuff`). A stale version
// here trips the upstream `freebuff_update_required` (426) gate.
const FREEBUFF_CLI_USER_AGENT = 'Freebuff-CLI/0.0.149';
// Official desktop ads requests carry `Freebuff-Desktop/<ver>` (orchestrator
// AD_USER_AGENTS); 0.0.61 is the bundle we reverse-engineered.
const FREE_DESKTOP_ADS_USER_AGENT = 'Freebuff-Desktop/0.0.61';

// Official ai-sdk user-agent used by the real SDK for chat requests
// (see orchestrator: ai-sdk/openai-compatible/${VERSION}/codebuff).
const AI_SDK_COMPAT_USER_AGENT = 'ai-sdk/openai-compatible/1.0.25/codebuff';

const CANONICAL_MODEL_ALIASES = {
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  'deepseek-v3.1-terminus': 'deepseek/deepseek-v4-pro',
  'mimo-v2.5': 'mimo/mimo-v2.5',
  'minimax-m3': 'minimax/minimax-m3',
  'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'luna': 'openai/gpt-5.6-luna',
  'glm-5.2': 'z-ai/glm-5.2',
  'claude-fable-5': 'anthropic/claude-fable-5',
  'kimi-k3': 'crof/kimi-k3-eco',
  'muse-spark': 'meta/muse-spark-1.2-contributor',
  'gemini-3.1-flash-lite': 'google/gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite': 'google/gemini-3.5-flash-lite',
  'gemini-3.1-pro': 'google/gemini-3.1-pro-preview',
  'gemini-pro': 'google/gemini-3.1-pro-preview',
};

const FALLBACK_AGENT_IDS = {
  // Current Freebuff CLI roots use the base3 single-loop harness. Keep these
  // fallbacks in sync with FREEBUFF_*_BASE3_AGENT_ID_BY_MODEL in free-agents.ts
  // so a GitHub refresh failure still starts a tool-capable coding agent.
  'minimax/minimax-m3': 'base3-free-minimax-m3',
  'deepseek/deepseek-v4-pro': 'base3-free-deepseek',
  'deepseek/deepseek-v4-flash': 'base3-free-deepseek-flash',
  'mimo/mimo-v2.5': 'base3-free-mimo',
  'openai/gpt-5.6-luna': 'base3-free-luna',
  'z-ai/glm-5.2': 'base3-free-glm',
  'anthropic/claude-fable-5': 'base3-free-fable',
  'crof/kimi-k3-eco': 'base3-free-kimi-k3-eco',
  'meta/muse-spark-1.2-contributor': 'base3-free-muse-spark',
  'deepseek/deepseek-v4-pro-max': 'base2-free-deepseek-pro-max',
  'deepseek/deepseek-v4-flash-max': 'base2-free-deepseek-flash-max',
  'openai/gpt-5.6-luna-max': 'base2-free-luna-max',
  'google/gemini-2.5-flash-lite': 'file-picker',
  'google/gemini-3.1-flash-lite': 'basher',
  'google/gemini-3.5-flash-lite': 'basher',
  'google/gemini-3.1-pro-preview': 'thinker-with-files-gemini',
};

const GEMINI_PARENT_AGENT_ID = 'base2-free-deepseek-flash';
const GEMINI_SUBAGENT_IDS = {
  'google/gemini-2.5-flash-lite': 'file-picker',
  'google/gemini-3.1-flash-lite': 'basher',
  'google/gemini-3.5-flash-lite': 'basher',
  'google/gemini-3.1-pro-preview': 'thinker-with-files-gemini',
};

const CONTEXT_PRUNER_AGENT_ID = 'context-pruner';

// Freebuff's current CLI/Web base3 roots are single-loop agents: unlike base2,
// they do not spawn a context-pruner child and expose the coding tools directly.
// These IDs are also parsed from the live free-agents.ts maps below; this table
// is only the safe fallback used when GitHub is temporarily unavailable.
const BASE3_AGENT_IDS_BY_MODEL = {
  'deepseek/deepseek-v4-pro': 'base3-free-deepseek',
  'deepseek/deepseek-v4-flash': 'base3-free-deepseek-flash',
  'mimo/mimo-v2.5': 'base3-free-mimo',
  'minimax/minimax-m3': 'base3-free-minimax-m3',
  'openai/gpt-5.6-luna': 'base3-free-luna',
  'z-ai/glm-5.2': 'base3-free-glm',
  'anthropic/claude-fable-5': 'base3-free-fable',
  'crof/kimi-k3-eco': 'base3-free-kimi-k3-eco',
  'meta/muse-spark-1.2-contributor': 'base3-free-muse-spark',
};

const BASE3_TOOL_NAMES = [
  'read_files', 'str_replace', 'write_file', 'run_terminal_command',
  'code_search', 'glob', 'list_directory', 'write_todos',
  'web_search', 'read_url', 'ask_user', 'suggest_followups',
  'gravity_index', 'render_ui', 'skill',
];
const BASE2_TOOL_NAMES = [
  'spawn_agents', 'read_files', 'read_subtree', 'write_todos',
  'suggest_followups', 'str_replace', 'write_file', 'ask_user',
  'read_url', 'skill', 'set_output', 'list_directory', 'glob',
  'render_ui', 'gravity_index',
];
const BASE2_FREE_SPAWNABLE_AGENTS = [
  'file-picker', 'code-searcher', 'researcher-web', 'researcher-docs',
  'basher', 'tmux-cli', 'context-pruner',
];

// --- Foreign-client gate (mirrors upstream common/src/constants/foreign-client-signals.ts) ---
// Upstream downgrades any free-mode chat request whose toolset contains no
// Freebuff signature tool to FREEBUFF_DOWNGRADE_MODEL_ID (inclusionai/ling-3.0-tiny:free).
// Third-party harnesses (opencode, Cline, Codex...) only ship the generic names
// below, so a proxied toolset with none of ours gets silently swapped to a junk
// model. The discriminator is tool NAMES only, so injecting official signature
// tools satisfies the gate without touching the caller's toolset.
const GENERIC_TOOL_NAMES = new Set([
  'write_file', 'web_search', 'glob', 'skill', 'apply_patch',
]);
const FREEBUFF_SIGNATURE_TOOL_NAMES = new Set([
  ...BASE3_TOOL_NAMES,
  ...BASE2_TOOL_NAMES,
  'decide', // Freebuff Desktop autorun custom tool
].filter((name) => !GENERIC_TOOL_NAMES.has(name)));

const FREEBUFF_DOWNGRADE_MODEL_ID = 'inclusionai/ling-3.0-tiny:free';

// Official tool schemas (agents/base3.ts toolNames) injected only when the
// caller's toolset carries no signature tool. Chosen for low call probability
// and harmless semantics if the model does invoke them; the model still gets
// the caller's own tools for real work.
const SIGNATURE_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'write_todos',
      description: 'Write and track a todo list for multi-step tasks. Only use this when a task spans several steps and a todo list would help the user track progress.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: { type: 'string' },
            description: 'The list of tasks to track',
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_followups',
      description: 'Suggest ~3 next steps the user might want to take after your turn ends. Only use this at the very end of a turn, never mid-answer.',
      parameters: {
        type: 'object',
        properties: {
          suggestions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Suggested next steps for the user',
          },
        },
        required: ['suggestions'],
      },
    },
  },
];

const BLACKLISTED_MODEL_PATTERNS = [/glm/i];

// Official free-mode session heartbeat cadence (desktop orchestrator).
const SESSION_HEARTBEAT_INTERVAL_MS = 45000;

module.exports = {
  FREE_AGENTS_SOURCE_URL,
  FREEBUFF_MODELS_SOURCE_URL,
  FREEBUFF_MODEL_IDS_SOURCE_URL,
  MODEL_CONFIG_SOURCE_URL,
  FREEBUFF2API_RS_SOURCE,
  MODEL_REFRESH_INTERVAL,
  TOKEN_RELOAD_INTERVAL,
  PROXY_VERSION,
  NPM_PACKAGE_NAME,
  INITIAL_BUN_VERSION,
  INITIAL_AI_SDK_PROVIDER_UTILS_VERSION,
  INITIAL_FREEBUFF_CLI_VERSION,
  CODEBUFF_ACCEPT_ENCODING,
  CODEBUFF_JSON_USER_AGENT,
  FREEBUFF_CLI_USER_AGENT,
  FREE_DESKTOP_ADS_USER_AGENT,
  AI_SDK_COMPAT_USER_AGENT,
  CANONICAL_MODEL_ALIASES,
  FALLBACK_AGENT_IDS,
  GEMINI_PARENT_AGENT_ID,
  GEMINI_SUBAGENT_IDS,
  CONTEXT_PRUNER_AGENT_ID,
  BASE3_AGENT_IDS_BY_MODEL,
  BASE3_TOOL_NAMES,
  BASE2_TOOL_NAMES,
  BASE2_FREE_SPAWNABLE_AGENTS,
  GENERIC_TOOL_NAMES,
  FREEBUFF_SIGNATURE_TOOL_NAMES,
  FREEBUFF_DOWNGRADE_MODEL_ID,
  SIGNATURE_TOOL_DEFS,
  BLACKLISTED_MODEL_PATTERNS,
  SESSION_HEARTBEAT_INTERVAL_MS,
};