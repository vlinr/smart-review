import path from 'path';

// 复用 reviewer 中的注释范围计算逻辑的轻量版本
export async function stripCommentsForAI(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const ranges = computeCommentRanges(content, ext);
  if (ranges.length === 0) return content;
  // 直接删除注释内容，并在末尾统一折叠多余空白行
  let result = content;
  ranges.sort((a,b) => b.start - a.start).forEach(r => {
    result = result.slice(0, r.start) + result.slice(r.end);
  });
  // 删除所有空白行：移除行尾空白，滤掉空行
  result = result.replace(/[ \t]+\n/g, '\n');
  result = result.split('\n').filter(line => line.trim().length > 0).join('\n');
  return result;
}

function computeCommentRanges(content, ext) {
  const ranges = [];
  const pushRange = (start, end) => {
    if (start >= 0 && end > start) ranges.push({ start, end });
  };
  const addByRegex = (regex) => {
    let m;
    while ((m = regex.exec(content)) !== null) {
      pushRange(m.index, m.index + m[0].length);
    }
  };
  const jsLike = ['.js','.jsx','.ts','.tsx','.java','.go','.c','.cpp','.h','.rs','.php'];
  if (jsLike.includes(ext)) {
    addByRegex(/\/\/.*|\/\*[\s\S]*?\*\//g);
  } else if (ext === '.py' || ext === '.rb') {
    addByRegex(/(^|\s)#.*$/gm);
  } else if (ext === '.html' || ext === '.svelte') {
    addByRegex(/<!--[\s\S]*?-->/g);
  } else if (ext === '.css' || ext === '.scss' || ext === '.less') {
    addByRegex(/\/\*[\s\S]*?\*\//g);
  } else {
    addByRegex(/\/\/.*|\/\*[\s\S]*?\*\//g);
    addByRegex(/(^|\s)#.*$/gm);
    addByRegex(/<!--[\s\S]*?-->/g);
  }
  return ranges;
}

// 剔除“代码内禁用”范围以避免AI分析受影响（保留换行，稳定行号）
export async function stripNoReviewForAI(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const commentRanges = computeCommentRanges(content, ext);
  // 固定令牌：与 reviewer 的 computeDisableRanges 保持一致
  const nextToken = 'review-disable-next-line';
  const startToken = 'review-disable-start';
  const endToken = 'review-disable-end';

  // 每行起始偏移
  const lineOffsets = [];
  const lines = content.split('\n');
  let offset = 0;
  for (const ln of lines) { lineOffsets.push(offset); offset += ln.length + 1; }

  const suppressRanges = [];
  let pendingBlockStart = null;
  for (const r of commentRanges) {
    const lower = content.slice(r.start, r.end).toLowerCase();
    if (lower.includes(nextToken)) {
      const lineIdx = content.substring(0, r.start).split('\n').length - 1;
      const nextStart = lineOffsets[lineIdx + 1];
      const nextEnd = lineOffsets[lineIdx + 2] ?? content.length;
      if (Number.isFinite(nextStart)) suppressRanges.push({ start: nextStart, end: nextEnd });
      continue;
    }
    if (lower.includes(startToken)) {
      const lineIdx = content.substring(0, r.start).split('\n').length - 1;
      const nextStart = lineOffsets[lineIdx + 1];
      if (Number.isFinite(nextStart)) pendingBlockStart = nextStart;
      continue;
    }
    if (lower.includes(endToken)) {
      const lineIdx = content.substring(0, r.start).split('\n').length - 1;
      const endStart = lineOffsets[lineIdx];
      if (Number.isFinite(pendingBlockStart)) {
        const startPos = pendingBlockStart;
        const endPos = Number.isFinite(endStart) ? endStart : content.length;
        if (startPos < endPos) suppressRanges.push({ start: startPos, end: endPos });
      }
      pendingBlockStart = null;
      continue;
    }
  }
  if (Number.isFinite(pendingBlockStart)) {
    suppressRanges.push({ start: pendingBlockStart, end: content.length });
  }

  if (suppressRanges.length === 0) return content;
  // 直接删除禁用范围，并折叠空白行以减少无意义的空行
  let result = content;
  suppressRanges.sort((a,b) => b.start - a.start).forEach(r => {
    result = result.slice(0, r.start) + result.slice(r.end);
  });
  // 删除所有空白行：去除行尾空白，并移除空行
  result = result.replace(/[ \t]+\n/g, '\n');
  result = result.split('\n').filter(line => line.trim().length > 0).join('\n');
  return result;
}