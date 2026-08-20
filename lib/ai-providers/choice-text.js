/**
 * 从 OpenAI 兼容响应里取出可见正文。
 * 思考链模型常把 token 花在 reasoning_content，message.content 为空。
 */

function collectText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    return collectText(value.text || value.content || value.output_text || '');
  }
  return String(value);
}

export function extractChoiceParts(choice = {}) {
  const message = choice.message || {};
  const visible = collectText(message.content).trim();
  const reasoning = collectText(
    message.reasoning_content
    || message.reasoning
    || message.thinking
    || choice.reasoning_content
  ).trim();
  return { visible, reasoning };
}

export function extractResponseParts(response) {
  return extractChoiceParts(response?.choices?.[0] || {});
}

function isUsableAsContent(text) {
  if (!text) return false;
  if (/\[TOOL_CALL\]/i.test(text)) return true;
  if (/\[REVIEW_FINAL\]/i.test(text)) return true;
  if (/(文件路径|File Path|风险原因|Reason|修改建议|Suggestion)\s*[:：]/.test(text)) return true;
  if (/^问题\d+[:：]/m.test(text) || /^Issue\s*\d+/mi.test(text)) return true;
  return false;
}

export function hydrateResponseContent(response) {
  if (!response?.choices?.[0]) return response;
  const choice = response.choices[0];
  const { visible, reasoning } = extractChoiceParts(choice);
  if (!choice.message || typeof choice.message !== 'object') {
    choice.message = { content: visible };
    return response;
  }
  if (visible) {
    choice.message.content = visible;
  } else if (isUsableAsContent(reasoning)) {
    choice.message.content = reasoning;
  } else if (choice.message.content == null) {
    choice.message.content = '';
  }
  return response;
}
