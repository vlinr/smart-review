/**
 * Review stability helpers: catch "hedged defect, zero issues" outputs
 * so strict mode can retry instead of silently passing.
 */

import { blockHasRequiredIssueFields } from '../utils/issue-field-normalize.js';

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

function splitProblemNumberBlocks(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const byProblem = raw.split(/\n(?=问题\d+[:：]|Issue\s*\d+[:：]?)/i).map((b) => b.trim()).filter(Boolean);
  if (byProblem.length > 1 || /^问题\d+[:：]|^Issue\s*\d+/im.test(raw)) {
    return byProblem;
  }
  return [];
}

export function countCompleteIssueBlocks(text) {
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
  if (blocks.length === 0) {
    blocks = splitProblemNumberBlocks(text);
  }
  return blocks.filter(blockHasRequiredIssueFields).length;
}

export function hasHedgeDismissalLanguage(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  return HEDGE_DISMISSAL_RE.some((re) => re.test(raw));
}

/**
 * True when the model hedges about a possible runtime defect but produced
 * no complete issue blocks (and did not return explicit none).
 * "needs human confirmation" inside a complete Medium issue is OK —
 * including 问题N / Issue N format (not only legacy marker blocks).
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
