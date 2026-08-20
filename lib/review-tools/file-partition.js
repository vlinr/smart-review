function normalizeRel(filePath = '', projectRoot = '') {
  const raw = String(filePath || '').replace(/\\/g, '/');
  if (!raw) return '';
  const root = String(projectRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && (raw === root || raw.startsWith(`${root}/`))) {
    return raw.slice(root.length + (raw === root ? 0 : 1));
  }
  return raw.replace(/^\.\//, '');
}

/**
 * 把 --files 名单拆成：有可审 diff 的走增量，完全没有 git 变更的回退整文件。
 * 出现在 git diff 里但没有可审新增行（仅删除）的文件不回退整文件。
 */
export function partitionSpecificFiles(requestedPaths = [], reviewData = [], touchedPaths = [], projectRoot = '') {
  const reviewed = new Set(
    (reviewData || []).map((item) => normalizeRel(item?.filePath, projectRoot)).filter(Boolean)
  );
  const touched = new Set(
    (touchedPaths || []).map((item) => normalizeRel(item, projectRoot)).filter(Boolean)
  );
  const fullPaths = [];
  for (const requested of requestedPaths || []) {
    const rel = normalizeRel(requested, projectRoot);
    if (!rel) continue;
    if (reviewed.has(rel) || touched.has(rel)) continue;
    fullPaths.push(requested);
  }
  return {
    diffReviewData: reviewData || [],
    fullPaths
  };
}
