/**
 * Review stability helpers: catch "hedged defect, zero issues" outputs
 * so strict mode can retry instead of silently passing.
 */

const HEDGE_DISMISSAL_RE = [
  /\bnot necessarily\b/i,
  /\bcan'?t be sure\b/i,
  /\bcannot be sure\b/i,
  /\bunable to (be )?sure\b/i,
  /\bpossibly defined elsewhere\b/i,
  /\bmaybe defined elsewhere\b/i,
  /\bcould be (a |an )?(global|injected)\b/i,
  /\bmay be (a |an )?(global|injected)\b/i,
  /\bperhaps (a )?global\b/i,
  /\bskip(ping)? (this|the) (as )?(demo|example)\b/i,
  /\bdemo(?:stration)? (?:only|code)\b/i,
  /不确定(是否|能不能|该不该)?/,
  /无法(完全)?确认/,
  /可能在别处(有定义|定义)/,
  /或许是(全局|注入)/,
  /示例代码.*(不必|无需|不要)(报|报告)/,
  /测试(文件|代码).*(不必|无需)(报|作为问题)/
];

function countCompleteIssueBlocks(text) {
  const markerRegexes = [
    /\*\*-----代码分析结果开始-----\*\*([\s\S]*?)\*\*-----代码分析结果结束-----\*\*/g,
    /\*\*-----Git Diff代码分析结果开始-----\*\*([\s\S]*?)\*\*-----Git Diff代码分析结果结束-----\*\*/g,
    /\*\*-----Code Analysis Result Start-----\*\*([\s\S]*?)\*\*-----Code Analysis Result End-----\*\*/g,
    /\*\*-----Git Diff Code Analysis Result Start-----\*\*([\s\S]*?)\*\*-----Git Diff Code Analysis Result End-----\*\*/g
  ];
  let blocks = [];
  for (const re of markerRegexes) {
    const matches = Array.from(String(text || '').matchAll(re));
    if (matches.length > 0) {
      blocks.push(...matches.map((m) => String(m[1] || '').trim()).filter(Boolean));
    }
  }
  if (blocks.length === 0) return 0;

  const isComplete = (blockText) => {
    const hasPath = /(文件路径|File Path)/i.test(blockText);
    const hasSnippet = /(代码片段|Code Snippet|Snippet|```)/i.test(blockText);
    const hasReason = /(风险原因|Risk Reason|Reason)/i.test(blockText);
    const hasSuggestion = /(修改建议|修复建议|Suggestions?|Suggestion)/i.test(blockText);
    return hasPath && hasSnippet && hasReason && hasSuggestion;
  };
  return blocks.filter(isComplete).length;
}

export function hasHedgeDismissalLanguage(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  return HEDGE_DISMISSAL_RE.some((re) => re.test(raw));
}

/**
 * True when the model hedges about a possible runtime defect but produced
 * no complete issue blocks (and did not return explicit none).
 * "needs human confirmation" inside a complete Medium issue is OK.
 */
export function hasHedgedDefectWithoutIssue(content, { extractFinalReviewContent, isNoIssueText } = {}) {
  const extract = extractFinalReviewContent || ((c) => String(c || '').trim());
  const isNone = isNoIssueText || ((c) => {
    const s = String(c || '').trim().toLowerCase();
    return s === '无' || s === 'none' || s === 'no issues' || s === 'no issue';
  });
  const text = extract(content);
  if (!text) return false;
  if (isNone(text)) return false;
  if (countCompleteIssueBlocks(text) > 0) return false;
  return hasHedgeDismissalLanguage(text);
}
