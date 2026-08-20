/**
 * Normalize / match AI issue field labels across bilingual, markdown-bold,
 * halfwidth/fullwidth colon, and continue-duplication variants.
 */

const FIELD_PATTERNS = [
  ['file', /^(?:\*\*)?(?:文件路径|File\s*Path)(?:\s*\([^)]*\))?(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/i],
  ['snippet', /^(?:\*\*)?(?:代码片段|Code\s*Snippet)(?:\s*\([^)]*\))?(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/i],
  ['risk', /^(?:\*\*)?(?:风险等级|Risk\s*Level)(?:\s*\([^)]*\))?(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/i],
  ['reason', /^(?:\*\*)?(?:风险原因|Risk\s*Reason|Reason)(?:\s*\([^)]*\))?(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/i],
  ['suggestion', /^(?:\*\*)?(?:修改建议|修复建议|Suggestions?)(?:\s*\([^)]*\))?(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/i],
  ['fixSnippet', /^(?:\*\*)?(?:修复代码|Fix\s*Code|Applied\s*Fix)(?:\s*\([^)]*\))?(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/i],
  ['lineRange', /^(?:\*\*)?(?:行号范围|Line\s*Range)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/i],
  ['line', /^(?:\*\*)?(?:行号|Line)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/i]
];

/**
 * @returns {{ kind: string, value: string } | null}
 */
export function matchIssueFieldLine(line) {
  const tline = String(line ?? '').trim();
  if (!tline) return null;
  for (const [kind, re] of FIELD_PATTERNS) {
    const m = tline.match(re);
    if (m) {
      return { kind, value: tline.slice(m[0].length).trim() };
    }
  }
  return null;
}

/**
 * Normalize bilingual / variant AI issue field labels to canonical forms
 * expected by FIELD_LABELS parsing (e.g. `文件路径 (File Path):` → `File Path:`).
 */
export function normalizeIssueLabelLine(line) {
  const matched = matchIssueFieldLine(line);
  if (!matched) return String(line ?? '');
  const canonical = {
    file: 'File Path:',
    snippet: 'Code Snippet:',
    risk: 'Risk Level:',
    reason: 'Risk Reason:',
    suggestion: 'Suggestions:',
    fixSnippet: 'Fix Code:',
    lineRange: 'Line Range:',
    line: 'Line:'
  }[matched.kind];
  if (!canonical) return String(line ?? '');
  return `${canonical}${matched.value}`;
}

export function isIssueFieldLine(line) {
  const tline = String(line ?? '').trim();
  if (!tline) return false;
  if (/^\*\*-----/.test(tline)) return true;
  if (/^问题\d+[:：]/.test(tline) || /^Issue\s*\d+[:：]?/i.test(tline)) return true;
  return matchIssueFieldLine(tline) != null;
}

/**
 * Remove duplicated report field lines that leaked into a code snippet
 * (common when output-continue overlaps mid-issue).
 */
export function stripIssueFieldLinesFromSnippet(snippet) {
  return String(snippet ?? '')
    .split('\n')
    .filter((line) => !isIssueFieldLine(line))
    .join('\n')
    .trim();
}

/**
 * Parse "5" or "27-29" style location values from 行号 / 行号范围 fields.
 * @returns {{ start: number, end: number } | null}
 */
export function parseIssueLineLocation(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const range = raw.match(/^(\d+)\s*[-~—–]\s*(\d+)\s*$/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) {
      return { start, end };
    }
    return null;
  }
  const single = raw.match(/^(\d+)\s*$/);
  if (single) {
    const n = Number(single[1]);
    if (Number.isFinite(n) && n > 0) return { start: n, end: n };
  }
  return null;
}

/**
 * Detect format-template echoes from the system prompt
 * (e.g. `{specific code snippet...}`, `{...}`, `<absolute-file-path>`).
 */
export function isFormatPlaceholderText(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/^\{+\.*\}+$/.test(s)) return true;
  if (/^\{[^}]{0,120}\}$/.test(s)) return true;
  if (/specific code snippet/i.test(s)) return true;
  if (/absolute file path/i.test(s)) return true;
  if (/detailed reason/i.test(s)) return true;
  if (/specific,\s*actionable/i.test(s)) return true;
  if (/Critical\/High\/Medium\/Low/i.test(s)) return true;
  if (/^<(absolute-file-path|concrete-code|risk-level|reason|suggestion)>$/i.test(s)) return true;
  return false;
}

export function isFormatPlaceholderIssue(issue) {
  if (!issue || typeof issue !== 'object') return false;
  if (isFormatPlaceholderText(issue.file)) return true;
  if (isFormatPlaceholderText(issue.snippet)) return true;
  if (isFormatPlaceholderText(issue.message)) return true;
  if (isFormatPlaceholderText(issue.suggestion)) return true;
  return false;
}
