/**
 * 审查输出是否需要续写。
 * 只在输出被长度截断、或必填标记未闭合时续写；
 * 模型主动写的 [CHUNK_CONTINUE] 不算续写条件。
 */

const NO_ISSUE_TEXTS = new Set(['无', 'none', 'no issues', 'no issue']);

export function isNoIssueText(content) {
  return NO_ISSUE_TEXTS.has(String(content || '').trim().toLowerCase());
}

export function stripChunkMarkers(content) {
  return String(content || '')
    .replace(/\[CHUNK_CONTINUE\]/gi, '')
    .replace(/\[CHUNK_END\]/gi, '')
    .replace(/\[CHUNK_\d+\/\d+\]/g, '')
    .trim();
}

export function extractFinalReviewContent(content) {
  const text = stripChunkMarkers(content);
  if (!text) return '';
  const closed = Array.from(text.matchAll(/\[REVIEW_FINAL\]([\s\S]*?)\[\/REVIEW_FINAL\]/gi))
    .map((item) => String(item[1] || '').trim())
    .filter(Boolean);
  if (closed.length > 0) {
    const substantive = closed.filter((block) => !isNoIssueText(block));
    if (substantive.length > 0) return substantive.join('\n\n');
    const outside = text.replace(/\[REVIEW_FINAL\][\s\S]*?\[\/REVIEW_FINAL\]/gi, '').trim();
    if (outside && hasIssueShape(outside)) return outside;
    return closed[closed.length - 1];
  }
  // Prefer the last unclosed marker: continue/finalize restarts often leave
  // an earlier partial [REVIEW_FINAL] plus a later fuller draft.
  const opens = Array.from(text.matchAll(/\[REVIEW_FINAL\]/gi));
  if (opens.length > 0) {
    const last = opens[opens.length - 1];
    return text.slice(last.index + last[0].length).replace(/\[\/REVIEW_FINAL\]\s*$/i, '').trim();
  }
  return text;
}

export function hasIssueShape(content) {
  const text = String(content || '');
  if (
    /\*\*-----代码分析结果开始-----\*\*/.test(text) ||
    /\*\*-----Git Diff代码分析结果开始-----\*\*/.test(text) ||
    /\*\*-----Code Analysis Result Start-----\*\*/.test(text) ||
    /\*\*-----Git Diff Code Analysis Result Start-----\*\*/.test(text) ||
    /^问题\d+[:：]/m.test(text) ||
    /^Issue\s*\d+[:：]?/mi.test(text)
  ) {
    return true;
  }
  const hasPath = /(文件路径|File Path)\s*[:：]/i.test(text);
  const hasReason = /(风险原因|Reason)\s*[:：]/i.test(text);
  const hasSuggestion = /(修改建议|Suggestion)\s*[:：]/i.test(text);
  return hasPath && hasReason && hasSuggestion;
}

export function isSubstantiveAnalysisResult(content) {
  const text = extractFinalReviewContent(content);
  if (!text) return false;
  if (/\[TOOL_CALL\]/i.test(text)) return false;
  if (isNoIssueText(text)) return true;
  return hasIssueShape(text);
}

/**
 * Whether this round can be treated as a finished review.
 * - Parsed issues > 0 → success (reject only if snippet still embeds report fields)
 * - Explicit "none" / "无" → success
 * - Content looks like issues (markers / fields) but issueCount is 0 → NOT success
 *   (parse failure must not silently become "no findings")
 *
 * Structure-only programmatic checks — no AI findings self-review.
 */
export function isSuccessfulReviewOutput(content, issueCount = 0, issues = []) {
  if (Number(issueCount) > 0) {
    const polluted = (issues || []).some((issue) => {
      const snippet = String(issue?.snippet || '');
      if (!snippet.trim()) return false;
      return /(?:^|\n)\s*(?:风险等级|Risk\s*Level|代码片段|Code\s*Snippet|行号|Line)\s*[:：]/m.test(snippet);
    });
    return !polluted;
  }
  const text = extractFinalReviewContent(content);
  if (!text) return false;
  if (/\[TOOL_CALL\]/i.test(text)) return false;
  if (isNoIssueText(text)) return true;
  if (hasIssueShape(text)) return false;
  return false;
}

export function looksIncompleteReview(content) {
  const text = String(content || '');
  if (!text.trim()) return true;
  if (isNoIssueText(extractFinalReviewContent(text))) return false;
  if (/\[REVIEW_FINAL\]/i.test(text) && !/\[\/REVIEW_FINAL\]/i.test(text)) return true;
  if (/代码分析结果开始/.test(text) && !/代码分析结果结束/.test(text)) return true;
  if (/Code Analysis Result Start/.test(text) && !/Code Analysis Result End/.test(text)) return true;
  return false;
}

export function isTruncatedFinish(finishReason) {
  const reason = String(finishReason || '').toLowerCase();
  return reason === 'length' || reason === 'max_tokens';
}

/**
 * @returns {{ continue: boolean, reason: 'truncated' | 'unclosed' | 'complete' | 'max' }}
 */
export function shouldContinueOutput(content, finishReason, continueCount = 0, maxContinue = 3) {
  if (continueCount >= maxContinue) {
    return { continue: false, reason: 'max' };
  }
  if (!String(content || '').trim()) {
    return { continue: false, reason: 'empty' };
  }
  const incomplete = looksIncompleteReview(content);
  const substantive = isSubstantiveAnalysisResult(content);
  if (substantive && !incomplete) {
    return { continue: false, reason: 'complete' };
  }
  if (isTruncatedFinish(finishReason) && (incomplete || !substantive)) {
    return { continue: true, reason: 'truncated' };
  }
  if (incomplete) {
    return { continue: true, reason: 'unclosed' };
  }
  return { continue: false, reason: 'complete' };
}

export function assembleReviewChunks(chunks = []) {
  const ordered = [...chunks].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  return ordered.map((chunk) => stripChunkMarkers(chunk.content)).filter(Boolean).join('\n\n');
}
