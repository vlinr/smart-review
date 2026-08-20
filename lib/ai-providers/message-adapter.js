import { resolveOptionalNumber, resolveOptionalPositiveInt } from '../utils/optional-config.js';

export function resolveOptionalMaxTokens(...candidates) {
  return resolveOptionalPositiveInt(...candidates);
}

export function omitUndefinedMaxTokens(params = {}) {
  const next = { ...params };
  const maxTokens = resolveOptionalMaxTokens(next.max_tokens);
  if (maxTokens) {
    next.max_tokens = maxTokens;
  } else {
    delete next.max_tokens;
  }
  return next;
}

function pickOptionalNumber(params = {}, config = {}, aliases = []) {
  const values = [];
  for (const alias of aliases) {
    values.push(params[alias], config[alias]);
  }
  return resolveOptionalNumber(...values);
}

function setOptionalNumber(target, key, value, { integer = false } = {}) {
  if (value === undefined) {
    delete target[key];
    return;
  }
  target[key] = integer ? Math.floor(value) : value;
}

/**
 * 只把用户显式配置的采样参数带进请求。未配置则不发给模型，沿用网关/模型默认。
 */
export function normalizeChatRequest(params = {}, config = {}) {
  const request = { ...params };
  setOptionalNumber(request, 'temperature', pickOptionalNumber(params, config, ['temperature']));
  setOptionalNumber(request, 'top_p', pickOptionalNumber(params, config, ['top_p', 'topP']));
  setOptionalNumber(request, 'frequency_penalty', pickOptionalNumber(params, config, ['frequency_penalty', 'frequencyPenalty']));
  setOptionalNumber(request, 'presence_penalty', pickOptionalNumber(params, config, ['presence_penalty', 'presencePenalty']));
  setOptionalNumber(request, 'seed', pickOptionalNumber(params, config, ['seed']), { integer: true });
  delete request.topP;
  delete request.topK;
  delete request.top_k;
  delete request.frequencyPenalty;
  delete request.presencePenalty;
  return omitUndefinedMaxTokens({
    ...request,
    max_tokens: resolveOptionalMaxTokens(params.max_tokens, config.maxResponseTokens, request.max_tokens)
  });
}

export function splitMessages(messages = []) {
  const system = [];
  const chat = [];
  for (const message of messages) {
    if (!message) continue;
    const role = String(message.role || '').toLowerCase();
    const content = String(message.content || '');
    if (!content.trim()) continue;
    if (role === 'system') {
      system.push(content);
    } else {
      chat.push({ role, content });
    }
  }
  return {
    systemText: system.join('\n\n').trim(),
    chat
  };
}

export function normalizeChatForAnthropic(chat = []) {
  const normalized = [];
  for (const message of chat) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (normalized.length === 0 && role === 'assistant') {
      normalized.push({ role: 'user', content: '(context)' });
    }
    const last = normalized[normalized.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${message.content}`;
    } else {
      normalized.push({ role, content: message.content });
    }
  }
  return normalized;
}

export function normalizeChatForGemini(chat = []) {
  const normalized = [];
  for (const message of chat) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const last = normalized[normalized.length - 1];
    if (last && last.role === role) {
      last.parts[0].text = `${last.parts[0].text}\n\n${message.content}`;
    } else {
      normalized.push({ role, parts: [{ text: message.content }] });
    }
  }
  if (normalized.length > 0 && normalized[0].role === 'model') {
    normalized.unshift({ role: 'user', parts: [{ text: '(context)' }] });
  }
  return normalized;
}

export function buildAnthropicRequest(params = {}, config = {}) {
  const { systemText, chat } = splitMessages(params.messages || []);
  const model = params.model || config.model || 'claude-3-5-sonnet-latest';
  const maxTokens = resolveOptionalMaxTokens(params.max_tokens, config.maxResponseTokens);
  const body = {
    model,
    // Anthropic 接口必填该字段；用户未限制时用较大默认，避免把输出卡死
    max_tokens: maxTokens || 32000,
    messages: normalizeChatForAnthropic(chat).map((message) => ({
      role: message.role,
      content: message.content
    }))
  };
  const temperature = pickOptionalNumber(params, config, ['temperature']);
  if (temperature !== undefined) body.temperature = temperature;
  const topP = pickOptionalNumber(params, config, ['top_p', 'topP']);
  if (topP !== undefined) body.top_p = topP;
  const topK = pickOptionalNumber(params, config, ['top_k', 'topK']);
  if (topK !== undefined) body.top_k = topK;
  if (systemText) body.system = systemText;
  return { body, model };
}

export function buildGeminiRequest(params = {}, config = {}) {
  const { systemText, chat } = splitMessages(params.messages || []);
  const model = params.model || config.model || 'gemini-1.5-flash';
  const generationConfig = {};
  const temperature = pickOptionalNumber(params, config, ['temperature']);
  if (temperature !== undefined) generationConfig.temperature = temperature;
  const topP = pickOptionalNumber(params, config, ['top_p', 'topP']);
  if (topP !== undefined) generationConfig.topP = topP;
  const topK = pickOptionalNumber(params, config, ['top_k', 'topK']);
  if (topK !== undefined) generationConfig.topK = topK;
  const maxTokens = resolveOptionalMaxTokens(params.max_tokens, config.maxResponseTokens);
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  const body = {
    contents: normalizeChatForGemini(chat)
  };
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  return { body, model };
}

export function normalizeAnthropicResponse(response = {}) {
  const content = Array.isArray(response?.content)
    ? response.content.map((item) => item?.text || '').join('\n').trim()
    : '';
  const stop = String(response?.stop_reason || '').toLowerCase();
  const finish_reason = stop === 'max_tokens' ? 'length' : (stop || 'stop');
  return { choices: [{ message: { content }, finish_reason }] };
}

export function normalizeGeminiResponse(response = {}) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((item) => item?.text || '').join('\n').trim();
  const finish = String(response?.candidates?.[0]?.finishReason || '').toLowerCase();
  const finish_reason = finish === 'max_tokens' ? 'length' : (finish || 'stop');
  return { choices: [{ message: { content }, finish_reason }] };
}

export function extractProviderError(provider, parsed = {}, status = 0) {
  const p = String(provider || 'openai').toLowerCase();
  if (p === 'anthropic') {
    return parsed?.error?.message || parsed?.message || `Anthropic HTTP ${status}`;
  }
  if (p === 'gemini') {
    return parsed?.error?.message || parsed?.error?.status || parsed?.message || `Gemini HTTP ${status}`;
  }
  return parsed?.error?.message || parsed?.message || `HTTP ${status}`;
}
