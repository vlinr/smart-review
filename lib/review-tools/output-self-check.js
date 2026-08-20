/**
 * Programmatic output self-check (no AI).
 * Sanitization stays in parse/normalize; this module only judges and reports reasons.
 */

import { isIssueFieldLine } from '../utils/issue-field-normalize.js';
import { hasHedgedDefectWithoutIssue } from './review-stability.js';
import {
  extractFinalReviewContent,
  hasIssueShape,
  isNoIssueText,
  looksIncompleteReview
} from './output-continue.js';

const FIELD_DUP_RE = /(?:风险等级|Risk\s*Level|代码片段|Code\s*Snippet|行号(?:范围)?|Line(?:\s*Range)?)\s*[:：]/gi;

function splitProblemBlocks(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (/^问题\d+[:：]/.test(line.trim()) || /^Issue\s*\d+[:：]?/i.test(line.trim())) {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks.filter((b) => b.trim());
}

/**
 * True when a single issue block repeats the same report field labels
 * (typical continue/finalize overlap garbage).
 */
export function hasDuplicatedIssueFields(content) {
  const text = extractFinalReviewContent(content);
  if (!text || isNoIssueText(text)) return false;
  const blocks = splitProblemBlocks(text);
  const targets = blocks.length > 1
    ? blocks
    : text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  for (const block of targets) {
    const labels = String(block).match(FIELD_DUP_RE) || [];
    const counts = new Map();
    for (const label of labels) {
      const key = String(label).toLowerCase().replace(/\s+/g, '');
      counts.set(key, (counts.get(key) || 0) + 1);
      if (counts.get(key) >= 2) return true;
    }
  }
  return false;
}

/**
 * True when parsed issue snippets still contain report field lines.
 */
export function hasPollutedParsedSnippets(issues = []) {
  return (issues || []).some((issue) => {
    const snippet = String(issue?.snippet || '');
    if (!snippet.trim()) return false;
    return snippet.split('\n').some((line) => isIssueFieldLine(line));
  });
}

/**
 * @param {string} content
 * @param {{ issueCount?: number, issues?: object[], extractFinalReviewContent?: Function, isNoIssueText?: Function }} [options]
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function inspectReviewOutput(content, options = {}) {
  const issueCount = Number(options.issueCount || 0);
  const issues = options.issues || [];
  const extract = options.extractFinalReviewContent || extractFinalReviewContent;
  const isNone = options.isNoIssueText || isNoIssueText;
  const reasons = [];

  const text = extract(content);
  if (!String(content || '').trim()) {
    return { ok: false, reasons: ['empty'] };
  }
  if (/\[TOOL_CALL\]/i.test(text) && !hasIssueShape(text) && !isNone(text)) {
    return { ok: false, reasons: ['tool_only'] };
  }
  if (isNone(text)) {
    if (hasHedgedDefectWithoutIssue(content, { extractFinalReviewContent: extract, isNoIssueText: isNone })) {
      return { ok: false, reasons: ['hedge_without_issue'] };
    }
    return { ok: true, reasons: [] };
  }

  if (looksIncompleteReview(content) && issueCount <= 0) {
    reasons.push('unclosed_or_incomplete');
  }
  if (issueCount <= 0 && hasIssueShape(text)) {
    reasons.push('issue_shaped_unparsed');
  }
  if (hasHedgedDefectWithoutIssue(content, { extractFinalReviewContent: extract, isNoIssueText: isNone })) {
    reasons.push('hedge_without_issue');
  }
  // Duplicated labels: fail the gate only when we could not produce usable issues yet.
  // If issueCount > 0, parse/normalize already salvaged the report for display.
  if (hasDuplicatedIssueFields(content) && issueCount <= 0) {
    reasons.push('duplicated_fields');
  }
  if (hasPollutedParsedSnippets(issues)) {
    reasons.push('polluted_snippet');
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Strict / skill gate: only reject cases that cannot be fixed by parse/sanitize.
 * Duplicated field labels are NOT a reject reason — parse already cleans them, and
 * forcing an AI rewrite often collapses a multi-issue report into one broken issue.
 */
export function shouldRejectForSelfCheck(content, options = {}) {
  if (hasHedgedDefectWithoutIssue(content, {
    extractFinalReviewContent: options.extractFinalReviewContent || extractFinalReviewContent,
    isNoIssueText: options.isNoIssueText || isNoIssueText
  })) {
    return true;
  }
  if (hasPollutedParsedSnippets(options.issues || [])) return true;
  return false;
}
