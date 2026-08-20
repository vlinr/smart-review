export function normalizeReviewSnippet(text) {
  return String(text || '')
    .split('\n')
    .map((line) => String(line || '')
      .replace(/^\s*[+\-]\s?/, '')
      .replace(/^\s*>?\s*\d+\|\s*/, '')
      .replace(/^\s*\[\d+\]\s*/, '')
      .trim())
    .filter(Boolean)
    .join('\n');
}

function fileName(filePath) {
  return String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
}

export function pathsReferToSameFile(left, right) {
  const a = String(left || '').replace(/\\/g, '/');
  const b = String(right || '').replace(/\\/g, '/');
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith('/' + b) || b.endsWith('/' + a)) return true;
  return fileName(a) === fileName(b) && fileName(a) !== '';
}

export function buildChangeHaystack(fileDataList = []) {
  const byFile = new Map();
  for (const fileData of fileDataList) {
    const key = String(fileData?.filePath || '').replace(/\\/g, '/');
    if (!key) continue;
    const parts = (fileData.segments || []).map((segment) => normalizeReviewSnippet(segment?.content || ''));
    byFile.set(key, parts.filter(Boolean).join('\n'));
  }
  return byFile;
}

function haystackForIssue(issueFile, haystackByFile) {
  const chunks = [];
  for (const [pathKey, text] of haystackByFile.entries()) {
    if (pathsReferToSameFile(pathKey, issueFile)) chunks.push(text);
  }
  return chunks.join('\n');
}

export function isIssueInChangeScope(issue, haystackByFile, fileList = []) {
  const issueFile = String(issue?.file || '').replace(/\\/g, '/');
  const allowed = (fileList || []).map((item) => String(item || '').replace(/\\/g, '/')).filter(Boolean);
  const fileAllowed = allowed.some((item) => pathsReferToSameFile(item, issueFile));
  if (!fileAllowed) return false;

  const snippet = normalizeReviewSnippet(issue?.snippet);
  if (!snippet) return true;

  let hay = haystackForIssue(issueFile, haystackByFile);
  if (!hay.trim()) {
    hay = Array.from(haystackByFile.values()).join('\n');
  }
  const compactHay = hay.replace(/\s+/g, ' ');
  const lines = snippet.split('\n').map((line) => line.trim()).filter((line) => line.length >= 6);
  const candidates = lines.length > 0 ? lines : [snippet];
  return candidates.some((line) => hay.includes(line) || compactHay.includes(line.replace(/\s+/g, ' ')));
}

export function filterIssuesToChangeScope(issues = [], fileDataList = [], fileList = []) {
  const haystackByFile = buildChangeHaystack(fileDataList);
  const allowedFiles = fileList.length > 0
    ? fileList
    : fileDataList.map((item) => item.filePath).filter(Boolean);
  const kept = [];
  const dropped = [];
  for (const issue of issues || []) {
    if (isIssueInChangeScope(issue, haystackByFile, allowedFiles)) {
      kept.push(issue);
    } else {
      dropped.push(issue);
    }
  }
  return { kept, dropped };
}
