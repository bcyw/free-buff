// Generic utilities (no Freebuff-specific business logic).
// Model alias resolution and schema normalization live here too.

const crypto = require('crypto');
const https = require('https');

const { CANONICAL_MODEL_ALIASES, BLACKLISTED_MODEL_PATTERNS } = require('./constants');
const { state } = require('./state');

function isBlacklistedModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  return BLACKLISTED_MODEL_PATTERNS.some(re => re.test(modelId));
}

// --- Request debounce (1.3s minimum gap between upstream requests) ---
let lastRequest = 0;
async function debounceRequest() {
  const now = Date.now();
  const elapsed = now - lastRequest;
  if (elapsed < 1300) {
    await new Promise(r => setTimeout(r, 1300 - elapsed));
  }
  lastRequest = Date.now();
}

function parseDuration(str) {
  if (!str) return 0;
  const match = str.match(/^(\d+)(h|m|s)$/);
  if (!match) return 0;
  const value = parseInt(match[1]);
  const unit = match[2];
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 's') return value * 1000;
  return 0;
}

function canonicalModelName(model) {
  return CANONICAL_MODEL_ALIASES[model] || model;
}

function modelSlug(model) {
  return model ? String(model).split('/').pop() : model;
}

function resolveFullModelId(model) {
  if (!model) return model;
  const canonical = canonicalModelName(model);
  if (canonical !== model) return canonical;
  const registry = state.modelRegistry;
  const slugged = registry && registry.slugToModel ? registry.slugToModel.get(model) : undefined;
  return slugged || model;
}

function generateClientSessionId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const buf = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 13; i++) out += alphabet[buf[i % buf.length] % 36];
  return out;
}

function cloneMap(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) output[key] = cloneMap(value);
    else if (Array.isArray(value)) output[key] = cloneSlice(value);
    else output[key] = value;
  }
  return output;
}

function cloneSlice(input) {
  return input.map(v => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return cloneMap(v);
    if (Array.isArray(v)) return cloneSlice(v);
    return v;
  });
}

// --- Tool schema normalization (resolve $ref / definitions) ---
function normalizeToolSchemas(tools) {
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const fn = tool.function;
    if (!fn || typeof fn !== 'object') continue;
    const params = fn.parameters;
    if (!params || typeof params !== 'object') continue;
    fn.parameters = normalizeSchemaMap(params, extractDefinitions(params), 12);
  }
}

function extractDefinitions(schema) {
  const merged = {};
  if (schema.definitions && typeof schema.definitions === 'object') Object.assign(merged, schema.definitions);
  if (schema['$defs'] && typeof schema['$defs'] === 'object') Object.assign(merged, schema['$defs']);
  return Object.keys(merged).length > 0 ? merged : null;
}

function normalizeSchemaMap(node, defs, maxDepth) {
  if (maxDepth <= 0) return cloneMap(node);
  defs = mergeDefinitions(defs, extractDefinitions(node));
  const replaced = tryResolveRef(node, defs);
  if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) {
    return normalizeSchemaMap(replaced, defs, maxDepth - 1);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'definitions' || key === '$defs' || key === 'nullable') continue;
    normalized[key] = normalizeSchemaValue(value, defs, maxDepth - 1);
  }
  simplifyNullableCombinator(normalized, 'anyOf');
  simplifyNullableCombinator(normalized, 'oneOf');
  normalizeTypeField(normalized);
  normalizeEnumField(normalized);
  if (normalized.const === null) delete normalized.const;
  return normalized;
}

function normalizeSchemaValue(value, defs, maxDepth) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeSchemaMap(value, defs, maxDepth);
  if (Array.isArray(value)) return value.map(v => normalizeSchemaValue(v, defs, maxDepth));
  return value;
}

function mergeDefinitions(parent, local) {
  if (!parent) return local;
  if (!local) return parent;
  return { ...parent, ...local };
}

function tryResolveRef(node, defs) {
  if (!defs || typeof node.$ref !== 'string' || Object.keys(node).length !== 1) return null;
  const ref = node.$ref;
  let name = '';
  if (ref.startsWith('#/definitions/')) name = ref.slice('#/definitions/'.length);
  else if (ref.startsWith('#/$defs/')) name = ref.slice('#/$defs/'.length);
  if (!name || !defs[name]) return null;
  const def = defs[name];
  return typeof def === 'object' && !Array.isArray(def) ? cloneMap(def) : def;
}

function simplifyNullableCombinator(schema, key) {
  const rawOptions = schema[key];
  if (!Array.isArray(rawOptions)) return;
  const filtered = rawOptions.filter(opt => !isNullSchema(opt));
  if (filtered.length === 0) { delete schema[key]; return; }
  if (filtered.length === 1 && filtered[0] && typeof filtered[0] === 'object' && !Array.isArray(filtered[0])) {
    delete schema[key];
    Object.assign(schema, filtered[0]);
    return;
  }
  schema[key] = filtered;
}

function isNullSchema(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === 'null') return true;
  if (schema.const === null) return true;
  if (Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === null) return true;
  return false;
}

function normalizeTypeField(schema) {
  const rawType = schema.type;
  if (typeof rawType === 'string') return;
  if (!Array.isArray(rawType)) return;
  const nonNull = rawType.filter(t => typeof t === 'string' && t !== 'null' && t.trim());
  if (nonNull.length === 0) delete schema.type;
  else schema.type = nonNull[0];
}

function normalizeEnumField(schema) {
  const enumValues = schema.enum;
  if (!Array.isArray(enumValues)) return;
  const seen = new Set();
  const filtered = [];
  for (const entry of enumValues) {
    if (entry === null) continue;
    const key = `${typeof entry}:${JSON.stringify(entry)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(entry);
  }
  if (filtered.length === 0) { delete schema.enum; return; }
  schema.enum = filtered;
}

// --- Session / run error classification ---
function isSessionInvalid(statusCode, errorBody) {
  if (statusCode === 426) return true; // freebuff_update_required
  if (statusCode < 400) return false;
  try {
    const payload = JSON.parse(errorBody);
    const error = payload.error || payload.code || '';
    const retryableErrors = ['freebuff_update_required', 'waiting_room_required', 'waiting_room_queued', 'session_superseded', 'session_expired', 'session_model_mismatch'];
    return retryableErrors.includes(error);
  } catch (e) { return false; }
}

function isRunInvalid(statusCode, body) {
  if (statusCode !== 400) return false;
  const msg = body.toLowerCase();
  return msg.includes('runid not found') || msg.includes('runid not running');
}

// --- Body / stream helpers ---
function isNodeStream(body) {
  return body && typeof body.pipe === 'function' && typeof body.on === 'function';
}

function readBodyText(body) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      body.on('data', c => chunks.push(c));
      body.on('end', () => resolve(Buffer.concat(chunks).toString()));
      body.on('error', reject);
    });
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    return new Promise((resolve, reject) => {
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) { resolve(Buffer.concat(chunks).toString()); return; }
          chunks.push(Buffer.from(value));
          pump();
        }).catch(reject);
      }
      pump();
    });
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    return (async () => {
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    })();
  }
  return String(body);
}

function pipeBodyToResponse(body, res) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      body.on('data', chunk => res.write(chunk));
      body.on('end', () => { res.end(); resolve(); });
      body.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const reader = body.getReader();
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { res.end(); resolve(); return; }
        res.write(value);
        pump();
      }).catch(reject);
    }
    pump();
  });
}

function httpGet(url, options = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json', ...options.headers }, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', () => resolve({ status: 0, data: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: '' }); });
  });
}

function versionCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

module.exports = {
  debounceRequest,
  isBlacklistedModel,
  parseDuration,
  canonicalModelName,
  modelSlug,
  resolveFullModelId,
  generateClientSessionId,
  cloneMap,
  cloneSlice,
  normalizeToolSchemas,
  isSessionInvalid,
  isRunInvalid,
  isNodeStream,
  readBodyText,
  pipeBodyToResponse,
  httpGet,
  versionCompare,
};