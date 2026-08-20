// Model registry: fetches live model/agent maps from GitHub, falls back to a
// hardcoded table when the network is unavailable (e.g. CN network blocks).

const https = require('https');
const { getAgent } = require('./net-agent');

const {
  FREE_AGENTS_SOURCE_URL,
  FREEBUFF_MODELS_SOURCE_URL,
  FREEBUFF_MODEL_IDS_SOURCE_URL,
  MODEL_CONFIG_SOURCE_URL,
  MODEL_REFRESH_INTERVAL,
  BASE3_AGENT_IDS_BY_MODEL,
} = require('./constants');
const { isBlacklistedModel } = require('./util');

class ModelRegistry {
  // Baseline model table — kept in sync with the official orchestrator.js
  // constants (FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL / SUPPORTED_FREEBUFF_MODELS).
  // The GitHub hot-update path can replace this at runtime.
  static HARDCODED_MODELS = [
    { model: 'deepseek/deepseek-v4-pro', agent: 'base3-free-deepseek', displayName: 'DeepSeek V4 Pro', premium: true, multimodal: false },
    { model: 'deepseek/deepseek-v4-flash', agent: 'base3-free-deepseek-flash', displayName: 'DeepSeek V4 Flash', premium: false, multimodal: false, free: true },
    { model: 'openai/gpt-5.6-luna', agent: 'base3-free-luna', displayName: 'GPT-5.6 Luna', premium: true, multimodal: true },
    { model: 'minimax/minimax-m3', agent: 'base3-free-minimax-m3', displayName: 'MiniMax M3', premium: true, multimodal: true },
    { model: 'mimo/mimo-v2.5', agent: 'base3-free-mimo', displayName: 'MiMo 2.5', premium: false, multimodal: true, free: true },
    { model: 'anthropic/claude-fable-5', agent: 'base3-free-fable', displayName: 'Claude Fable 5', premium: true, multimodal: true },
    { model: 'google/gemini-3.1-flash-lite', agent: 'basher', displayName: 'Gemini 3.1 Flash Lite', premium: false, multimodal: false, free: true },
    { model: 'google/gemini-3.1-pro-preview', agent: 'thinker-with-files-gemini', displayName: 'Gemini 3.1 Pro', premium: true, multimodal: false, free: true },
  ];

  constructor() {
    this.agentModels = new Map();
    this.modelToAgent = new Map();
    this.modelToParentAgent = new Map();
    this.modelToSessionModel = new Map();
    this.modelDisplayNames = new Map();
    this.modelMetadata = new Map();
    this.slugToModel = new Map();
    this.allModels = [];
    this.lastOK = null;
    this.refreshTimer = null;
  }

  async start() {
    // Apply the hardcoded table first so the proxy is ready immediately —
    // GitHub fetches must never block startup (CN network times out).
    this.applyHardcoded();
    // Background non-blocking refresh: fetch the official source files and
    // hot-update the registry when they land. Failure is silent; the
    // hardcoded table keeps serving.
    this.refresh().catch(e => console.error('Model registry: background refresh failed:', e.message));
    this.refreshTimer = setInterval(() => { this.refresh().catch(e => console.error('Model registry: periodic refresh failed:', e.message)); }, MODEL_REFRESH_INTERVAL);
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  stop() {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  applyHardcoded() {
    const modelToAgent = new Map();
    const allModels = [];
    const modelDisplayNames = new Map();
    const modelMetadata = new Map();
    const agentModels = new Map();

    for (const entry of ModelRegistry.HARDCODED_MODELS) {
      if (isBlacklistedModel(entry.model)) { console.log(`Model registry: blacklisted hardcoded model excluded: ${entry.model}`); continue; }
      modelToAgent.set(entry.model, entry.agent);
      allModels.push(entry.model);
      modelDisplayNames.set(entry.model, entry.displayName);
      modelMetadata.set(entry.model, { displayName: entry.displayName, premium: entry.premium, multimodal: entry.multimodal, free: entry.free || false });
      if (!agentModels.has(entry.agent)) agentModels.set(entry.agent, []);
      agentModels.get(entry.agent).push(entry.model);
    }

    allModels.sort();
    this.agentModels = agentModels;
    this.modelToAgent = modelToAgent;
    this.allModels = allModels;
    this.modelDisplayNames = modelDisplayNames;
    this.modelMetadata = modelMetadata;
    this.lastOK = new Date();
    this.slugToModel = new Map();
    for (const m of this.allModels) {
      const slug = m.split('/').pop();
      if (slug && !this.slugToModel.has(slug)) this.slugToModel.set(slug, m);
    }
    console.log(`Model registry: hardcoded ${allModels.length} models: ${allModels.join(', ')}`);
  }

  async refresh() {
    // GitHub hot-update path. The hardcoded table (applyHardcoded) is the
    // baseline; this only runs in the background and replaces the registry
    // wholesale when a fetch succeeds.
    try {
      const [modelsSource, agentsSource, configSource, modelIdsSource] = await Promise.all([
        this.fetchSource(FREEBUFF_MODELS_SOURCE_URL),
        this.fetchSource(FREE_AGENTS_SOURCE_URL),
        this.fetchSource(MODEL_CONFIG_SOURCE_URL),
        this.fetchSource(FREEBUFF_MODEL_IDS_SOURCE_URL)
      ]);

      const objectLiterals = this.parseObjectLiterals(configSource);
      const modelConstants = this.parseConstants(modelsSource, objectLiterals);
      const agentConstants = this.parseConstants(agentsSource);
      const modelIdConstants = this.parseConstants(modelIdsSource);
      const variableMap = new Map([...modelIdConstants, ...modelConstants, ...agentConstants]);

      const rootAgentMapping = this.parseRootAgentModelMapping(agentsSource, variableMap);
      for (const [model, agent] of Object.entries(BASE3_AGENT_IDS_BY_MODEL)) {
        if (!rootAgentMapping.has(model)) rootAgentMapping.set(model, agent);
      }
      const GEMINI_FALLBACK_ENTRIES = [
        ['google/gemini-3.1-flash-lite', 'basher'],
        ['google/gemini-3.5-flash-lite', 'basher'],
        ['google/gemini-3.1-pro-preview', 'thinker-with-files-gemini'],
        ['google/gemini-2.5-flash-lite', 'file-picker'],
      ];
      for (const [model, agent] of GEMINI_FALLBACK_ENTRIES) {
        if (!rootAgentMapping.has(model)) rootAgentMapping.set(model, agent);
      }
      const allAgentModels = this.parseAllFreeModels(agentsSource, variableMap);
      for (const [agent, models] of allAgentModels) {
        for (const model of models) {
          if (!rootAgentMapping.has(model)) rootAgentMapping.set(model, agent);
        }
      }
      const parsedMetadata = this.parseModelMetadata(modelsSource, variableMap);

      if (rootAgentMapping.size > 0) {
        const modelToAgent = new Map();
        const allModels = [];
        const modelDisplayNames = new Map();
        const modelMetadata = new Map();
        const agentModels = new Map();

        for (const [model, agent] of rootAgentMapping) {
          if (isBlacklistedModel(model)) { console.log(`Model registry: blacklisted model excluded: ${model}`); continue; }
          modelToAgent.set(model, agent);
          allModels.push(model);
          const meta = parsedMetadata.get(model);
          const displayName = meta ? meta.displayName : model.split('/').pop();
          modelDisplayNames.set(model, displayName);
          modelMetadata.set(model, meta || { displayName, premium: false, multimodal: false, free: false });
          if (!agentModels.has(agent)) agentModels.set(agent, []);
          agentModels.get(agent).push(model);
        }

        allModels.sort();
        this.agentModels = agentModels;
        this.modelToAgent = modelToAgent;
        this.allModels = allModels;
        this.modelDisplayNames = modelDisplayNames;
        this.modelMetadata = modelMetadata;
        this.lastOK = new Date();
        this.rebuildSlugMap();
        console.log(`Model registry: fetched ${allModels.length} models from GitHub: ${allModels.join(', ')}`);
      }
    } catch (e) {
      console.error('Model registry: GitHub fetch failed (keeping hardcoded table):', e.message);
    }
  }

  rebuildSlugMap() {
    this.slugToModel = new Map();
    for (const m of this.allModels) {
      const slug = m.split('/').pop();
      if (slug && !this.slugToModel.has(slug)) this.slugToModel.set(slug, m);
    }
  }

  fetchSource(urlStr) {
    return new Promise((resolve, reject) => {
      const agent = getAgent();
      const req = https.get(urlStr, agent ? { agent } : {}, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  parseConstants(source, objectLiterals) {
    const constants = new Map();
    const pattern = /export const (\w+)\s*=\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = pattern.exec(source)) !== null) constants.set(match[1], match[2]);
    if (objectLiterals) {
      const refPattern = /export const (\w+)\s*=\s*(\w+)\.(\w+)/g;
      while ((match = refPattern.exec(source)) !== null) {
        const key = `${match[2]}.${match[3]}`;
        if (objectLiterals.has(key)) constants.set(match[1], objectLiterals.get(key));
      }
    }
    return constants;
  }

  parseObjectLiterals(source) {
    const result = new Map();
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const objMatch = lines[i].match(/^(?:export\s+)?const\s+(\w+)\s*=\s*\{$/);
      if (!objMatch) continue;
      const objName = objMatch[1];
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        const line = lines[j].trim();
        if (line.startsWith('}')) break;
        const propMatch = line.match(/^(\w+):\s*['"]([^'"]+)['"]/);
        if (propMatch) result.set(`${objName}.${propMatch[1]}`, propMatch[2]);
      }
    }
    return result;
  }

  parseAllFreeModels(source, variableMap) {
    const blockPattern = /(?:'([^']+)'|(\w+)|\[([^\]]+)\])\s*:\s*new\s+Set\(\[([^\]]*)\]\)/g;
    const result = new Map();
    let match;
    while ((match = blockPattern.exec(source)) !== null) {
      const agentID = match[1] || match[2] || (variableMap.get(match[3]) || match[3]);
      const modelsStr = match[4];
      const models = [];
      const tokenPattern = /(?:'([^']+)')|(\w+)/g;
      let tokenMatch;
      while ((tokenMatch = tokenPattern.exec(modelsStr)) !== null) {
        if (tokenMatch[1]) models.push(tokenMatch[1].trim());
        else if (tokenMatch[2] && variableMap.has(tokenMatch[2])) models.push(variableMap.get(tokenMatch[2]));
      }
      if (models.length > 0) result.set(agentID, models);
    }
    return result;
  }

  parseRootAgentModelMapping(source, variableMap) {
    const result = new Map();
    // Prefer the base3 maps when present. The upstream keeps base2 roots for
    // compatibility, but the current free CLI routes selectable models through
    // base3, whose direct tool set matches coding-agent clients.
    const mapNames = [
      'FREEBUFF_ROOT_AGENT_ID_BY_MODEL',
      'FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL',
      'FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL',
    ];
    for (const mapName of mapNames) {
      const blockPattern = new RegExp(`${mapName}[^\\{]*\\{([^}]+)\\}`, 's');
      const blockMatch = blockPattern.exec(source);
      if (!blockMatch) continue;
      const entryPattern = /\[(\w+)\]\s*:\s*'([^']+)'/g;
      let m;
      while ((m = entryPattern.exec(blockMatch[1])) !== null) {
        const modelId = variableMap.get(m[1]);
        if (modelId) result.set(modelId, m[2]);
      }
    }
    return result;
  }

  buildModelMapping(agentModels, rootAgentMapping) {
    const modelToAgent = new Map();
    const allModels = [];
    for (const [model, rootAgent] of rootAgentMapping) {
      modelToAgent.set(model, rootAgent);
      allModels.push(model);
    }
    allModels.sort();
    return { modelToAgent, allModels };
  }

  parseDisplayNames(source) {
    const map = new Map();
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const idMatch = lines[i].match(/id:\s*(\w+|'[^']*')/);
      if (!idMatch) continue;
      let idRef = idMatch[1];
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const dnMatch = lines[j].match(/displayName:\s*'([^']+)'/);
        if (dnMatch) {
          const id = idRef.startsWith("'") ? idRef.slice(1, -1) : idRef;
          map.set(id, dnMatch[1]);
          break;
        }
      }
    }
    const resolved = new Map();
    const constPattern = /export const (\w+)\s*=\s*['"]([^'"]+)['"]/g;
    let cm;
    while ((cm = constPattern.exec(source)) !== null) {
      if (map.has(cm[1])) resolved.set(cm[2], map.get(cm[1]));
    }
    return resolved;
  }

  parseModelMetadata(source, variableMap) {
    const result = new Map();
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const blockMatch = lines[i].match(/^const\s+(\w+)\s*=\s*\{$/);
      if (!blockMatch) continue;
      const varName = blockMatch[1];
      let id = null, displayName = null, premium = false, multimodal = false, free = false;
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        const line = lines[j];
        if (line.trim().startsWith('}')) break;
        const idMatch = line.match(/id:\s*(\w+|'[^']*')/);
        if (idMatch) {
          const ref = idMatch[1];
          id = ref.startsWith("'") ? ref.slice(1, -1) : (variableMap.get(ref) || ref);
        }
        const dnMatch = line.match(/displayName:\s*'([^']+)'/);
        if (dnMatch) displayName = dnMatch[1];
        const premMatch = line.match(/premium:\s*(true|false)/);
        if (premMatch) premium = premMatch[1] === 'true';
        const mmMatch = line.match(/multimodal:\s*(true|false)/);
        if (mmMatch) multimodal = mmMatch[1] === 'true';
        const freeMatch = line.match(/free:\s*(true|false)/);
        if (freeMatch) free = freeMatch[1] === 'true';
      }
      if (id && displayName) result.set(id, { displayName, premium, multimodal, free });
    }
    return result;
  }

  getDisplayName(model) {
    return this.modelDisplayNames.get(model) || model.split('/').pop();
  }

  getModels() { return [...this.allModels]; }
  hasModel(model) { return this.modelToAgent.has(model); }
  getAgentForModel(model) { return this.modelToAgent.get(model); }
  getAgentIDs() { return Array.from(new Set(this.modelToAgent.values())); }
  getModelMetadata(model) { return this.modelMetadata.get(model) || null; }
  getAllModelMetadata() {
    const obj = {};
    for (const [k, v] of this.modelMetadata) obj[k] = v;
    return obj;
  }
}

module.exports = { ModelRegistry };