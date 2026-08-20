const RISK_WEIGHT = { critical: 5, high: 4, medium: 3, low: 2, suggestion: 1 };

export function stripCodeFences(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```[\w-]*\n?([\s\S]*?)\n?```$/);
  if (fenced) return fenced[1].trim();
  const inline = trimmed.match(/```[\w-]*\n?([\s\S]*?)\n?```/);
  return inline ? inline[1].trim() : trimmed;
}

export function stripLineNumberPrefixes(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/^\s*[+ ]?\[\d+\]\s?/, ''))
    .join('\n');
}

export function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function issueKey(issue) {
  const file = String(issue.file || '').trim();
  const message = String(issue.message || '').trim().slice(0, 120);
  const snippet = String(issue.snippet || '').trim().slice(0, 200);
  return `${file}::${message || snippet}`;
}

export function isRiskEligible(risk, maxRisk = 'medium') {
  const issueWeight = RISK_WEIGHT[String(risk || 'suggestion').toLowerCase()] || 0;
  const maxWeight = RISK_WEIGHT[String(maxRisk || 'medium').toLowerCase()] || 3;
  return issueWeight <= maxWeight;
}

export function applyFixToContent(content, issue) {
  const fixText = stripCodeFences(issue.fixSnippet);
  if (!fixText) {
    return { ok: false, reason: 'empty_fix' };
  }

  const lines = String(content || '').split('\n');
  const start = Number(issue.lineStart || issue.line);
  const end = Number(issue.lineEnd || issue.line);

  if (Number.isFinite(start) && start > 0 && start <= lines.length) {
    const endLine = Number.isFinite(end) && end >= start ? Math.min(end, lines.length) : start;
    const fixLines = fixText.split('\n');
    const next = [
      ...lines.slice(0, start - 1),
      ...fixLines,
      ...lines.slice(endLine)
    ];
    return { ok: true, content: next.join('\n'), method: 'line_range' };
  }

  const snippet = stripLineNumberPrefixes(issue.snippet || '').trim();
  if (snippet && content.includes(snippet)) {
    return { ok: true, content: content.replace(snippet, fixText), method: 'snippet_replace' };
  }

  if (snippet) {
    const contentNorm = normalizeWhitespace(stripLineNumberPrefixes(content));
    const snippetNorm = normalizeWhitespace(snippet);
    if (contentNorm.includes(snippetNorm)) {
      const idx = contentNorm.indexOf(snippetNorm);
      const before = content.slice(0, idx);
      const after = content.slice(idx + snippetNorm.length);
      return { ok: true, content: `${before}${fixText}${after}`, method: 'normalized_replace' };
    }
  }

  return { ok: false, reason: 'no_anchor' };
}

export function applyFixesToFile(filePath, issues, options = {}) {
  const dryRun = options.dryRun === true;
  let content = options.content;
  if (content === undefined) {
    const fs = options.fs;
    if (!fs?.readFileSync) {
      return { filePath, applied: [], failed: issues.map((issue) => ({ issue, reason: 'no_fs' })), changed: false };
    }
    content = fs.readFileSync(filePath, 'utf8');
  }

  const applied = [];
  const failed = [];
  let current = content;

  for (const issue of issues) {
    const result = applyFixToContent(current, issue);
    if (!result.ok) {
      failed.push({ issue, reason: result.reason });
      continue;
    }
    current = result.content;
    applied.push({ issue, method: result.method });
  }

  if (!dryRun && applied.length > 0 && current !== content && options.fs?.writeFileSync) {
    options.fs.writeFileSync(filePath, current, 'utf8');
  }

  return {
    filePath,
    applied,
    failed,
    changed: applied.length > 0 && current !== content
  };
}

export function groupIssuesByFile(issues = []) {
  const map = new Map();
  for (const issue of issues) {
    const file = String(issue.file || '').trim();
    if (!file) continue;
    if (!map.has(file)) map.set(file, []);
    map.get(file).push(issue);
  }
  return map;
}

export async function applyFixes(issues, projectRoot, options = {}) {
  const fs = options.fs;
  const path = options.path;
  const dryRun = options.dryRun === true;
  const byFile = groupIssuesByFile(issues);
  const appliedAll = [];
  const failedAll = [];
  const files = new Set();

  for (const [file, fileIssues] of byFile.entries()) {
    const absPath = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    const result = applyFixesToFile(absPath, fileIssues, { dryRun, fs });
    appliedAll.push(...result.applied);
    failedAll.push(...result.failed);
    if (result.changed) files.add(absPath);
  }

  return { applied: appliedAll, failed: failedAll, files: [...files] };
}
