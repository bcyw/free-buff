// Anthropic <-> OpenAI conversion + Claude SSE streaming writer.

const { isNodeStream, readBodyText } = require('./util');

// --- Conversion ---
function convertClaudeMessagesRequestToOpenAI(body) {
  const root = JSON.parse(body);
  const modelName = (root.model || '').trim();
  if (!modelName) throw new Error('model is required');
  const stream = root.stream || false;
  const out = { model: modelName, messages: [], stream };
  if (root.max_tokens && root.max_tokens > 0) out.max_tokens = root.max_tokens;
  if (root.temperature !== undefined) out.temperature = root.temperature;
  else if (root.top_p !== undefined) out.top_p = root.top_p;
  const messages = [];
  if (root.system) {
    const sysText = typeof root.system === 'string' ? root.system : Array.isArray(root.system) ? root.system.filter(p => p && p.type === 'text').map(p => p.text).join('\n') : '';
    if (sysText.trim()) messages.push({ role: 'system', content: sysText.trim() });
  }
  if (!Array.isArray(root.messages)) throw new Error('messages must be an array');
  for (const rawMessage of root.messages) {
    if (!rawMessage || typeof rawMessage !== 'object') continue;
    const role = (rawMessage.role || '').trim();
    if (!role) continue;
    const content = rawMessage.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
    if (text.trim()) messages.push({ role, content: text.trim() });
  }
  out.messages = messages;
  return { payload: out, modelName, stream };
}

function convertOpenAINonStreamResponseToClaude(body) {
  const response = JSON.parse(body);
  const message = { id: response.id || '', type: 'message', role: 'assistant', model: response.model || '', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  let hasToolCall = false;
  if (response.choices && response.choices.length > 0) {
    const choice = response.choices[0];
    const text = choice.message && choice.message.content;
    if (text && typeof text === 'string' && text.trim()) message.content.push({ type: 'text', text: text.trim() });
    if (choice.message && choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        hasToolCall = true;
        message.content.push({ type: 'tool_use', id: tc.id || '', name: (tc.function || {}).name || '', input: parseJSONObject((tc.function || {}).arguments) });
      }
    }
    if (choice.finish_reason) message.stop_reason = mapOpenAIFinishReasonToClaude(choice.finish_reason);
  }
  if (response.usage) { message.usage.input_tokens = response.usage.prompt_tokens || 0; message.usage.output_tokens = response.usage.completion_tokens || 0; }
  if (message.stop_reason === 'end_turn' && hasToolCall) message.stop_reason = 'tool_use';
  return JSON.stringify(message);
}

function parseJSONObject(raw) { if (!raw) return {}; try { const v = JSON.parse(raw); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; } catch (e) { return {}; } }
function mapOpenAIFinishReasonToClaude(reason) { const r = (reason || '').toLowerCase().trim(); if (r === 'tool_calls' || r === 'function_call') return 'tool_use'; if (r === 'length') return 'max_tokens'; return 'end_turn'; }

// --- Claude SSE streaming (OpenAI SSE -> Anthropic SSE) ---
function writeSSE(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function pipeOpenAIToClaudeStream(body, res) {
  let model = null;
  let id = null;
  let started = false;
  let blockIndex = 0;
  let textBlockOpen = false;
  let textBlockIndex = -1;
  const toolBlocks = new Map();
  let stopReason = null;
  const usage = { input_tokens: 0, output_tokens: 0 };

  function ensureMessageStart() {
    if (started) return;
    started = true;
    const message = {
      id: id || ('msg_' + Math.random().toString(36).substring(2, 18)),
      type: 'message',
      role: 'assistant',
      model: model || '',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    writeSSE(res, 'message_start', { type: 'message_start', message });
  }

  function openTextBlock() {
    if (textBlockOpen) return;
    textBlockOpen = true;
    textBlockIndex = blockIndex++;
    writeSSE(res, 'content_block_start', { type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } });
  }

  function closeTextBlock() {
    if (!textBlockOpen) return;
    textBlockOpen = false;
    writeSSE(res, 'content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
  }

  function ensureToolBlock(toolIndex, toolId, toolName) {
    if (toolBlocks.has(toolIndex)) return;
    const aiIndex = blockIndex++;
    toolBlocks.set(toolIndex, aiIndex);
    writeSSE(res, 'content_block_start', { type: 'content_block_start', index: aiIndex, content_block: { type: 'tool_use', id: toolId || `toolu_${toolIndex}`, name: toolName || '', input: {} } });
  }

  function handleOpenAIChunk(data) {
    if (!data || typeof data !== 'object') return;
    if (data.model) model = data.model;
    if (data.id) id = data.id;
    if (data.usage) {
      if (data.usage.prompt_tokens != null) usage.input_tokens = data.usage.prompt_tokens;
      if (data.usage.completion_tokens != null) usage.output_tokens = data.usage.completion_tokens;
    }
    if (!data.choices || data.choices.length === 0) return;
    const choice = data.choices[0];
    const delta = choice.delta || {};
    if (delta.content) {
      ensureMessageStart();
      openTextBlock();
      writeSSE(res, 'content_block_delta', { type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: delta.content } });
    }
    if (Array.isArray(delta.tool_calls)) {
      ensureMessageStart();
      closeTextBlock();
      for (const tc of delta.tool_calls) {
        const ti = tc.index != null ? tc.index : 0;
        ensureToolBlock(ti, tc.id, tc.function && tc.function.name);
        const partial = tc.function && tc.function.arguments;
        if (partial) {
          writeSSE(res, 'content_block_delta', { type: 'content_block_delta', index: toolBlocks.get(ti), delta: { type: 'input_json_delta', partial_json: partial } });
        }
      }
    }
    if (choice.finish_reason) stopReason = mapOpenAIFinishReasonToClaude(choice.finish_reason);
  }

  let buf = '';
  let dataLines = [];
  function processLines(chunkStr) {
    buf += chunkStr;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        const payload = dataLines.join('\n').trim();
        dataLines = [];
        if (payload && payload !== '[DONE]') { try { handleOpenAIChunk(JSON.parse(payload)); } catch (_) {} }
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }

  function onChunk(chunk) {
    const str = chunk instanceof Buffer ? chunk.toString() : typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    processLines(str);
  }

  if (isNodeStream(body)) {
    await new Promise((resolve, reject) => {
      body.on('data', onChunk);
      body.on('end', resolve);
      body.on('error', reject);
    });
  } else {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(value);
    }
  }

  if (dataLines.length > 0) {
    const payload = dataLines.join('\n').trim();
    if (payload && payload !== '[DONE]') { try { handleOpenAIChunk(JSON.parse(payload)); } catch (_) {} }
  }

  ensureMessageStart();
  closeTextBlock();
  for (const aiIndex of toolBlocks.values()) {
    writeSSE(res, 'content_block_stop', { type: 'content_block_stop', index: aiIndex });
  }
  writeSSE(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  writeSSE(res, 'message_stop', { type: 'message_stop' });
  return model;
}

async function writeClaudeSuccessResponse(res, resp, requestedModel, stream) {
  if (stream) {
    res.writeHead(resp.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const model = await pipeOpenAIToClaudeStream(resp.body, res);
    return { messageId: null, model };
  }
  const body = await readBodyText(resp.body);
  const converted = convertOpenAINonStreamResponseToClaude(body);
  res.writeHead(resp.status, { 'Content-Type': 'application/json' });
  res.end(converted);
  let messageId = null;
  let model = null;
  try { const parsed = JSON.parse(body); if (parsed.id) messageId = parsed.id; if (parsed.model) model = parsed.model; } catch (e) {}
  return { messageId, model };
}

module.exports = {
  convertClaudeMessagesRequestToOpenAI,
  convertOpenAINonStreamResponseToClaude,
  parseJSONObject,
  mapOpenAIFinishReasonToClaude,
  writeSSE,
  pipeOpenAIToClaudeStream,
  writeClaudeSuccessResponse,
};