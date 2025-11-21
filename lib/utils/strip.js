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
  result = result.replace(/[ \t]+\r?\n/g, '\n');
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
    // 在 JSX/TSX 中移除注释包裹：{/* ... */}，避免残留孤立的大括号
    if (ext === '.jsx' || ext === '.tsx') {
      // 仅匹配单行的注释包裹：限制为 { + 空格/Tab + /*...*/ + 空格/Tab + }
      // 防止错误地从上一行的 {（如 enum {...}）起始到后续任意注释块闭合的 } 形成巨大范围
      addByRegex(/\{[ \t]*\/\*[\s\S]*?\*\/[ \t]*\}/g);
    }
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
  // 合并重叠区间，避免重复剥离导致索引错位
  if (ranges.length > 1) {
    ranges.sort((a, b) => a.start - b.start);
    const merged = [];
    let prev = ranges[0];
    for (let i = 1; i < ranges.length; i++) {
      const cur = ranges[i];
      if (cur.start <= prev.end) {
        prev.end = Math.max(prev.end, cur.end);
      } else {
        merged.push(prev);
        prev = cur;
      }
    }
    merged.push(prev);
    return merged;
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
  result = result.replace(/[ \t]+\r?\n/g, '\n');
  result = result.split('\n').filter(line => line.trim().length > 0).join('\n');
  return result;
}

// 组合剥离并返回行号映射：对AI输入进行“先映射后剥离”
// 返回的 lineMap 是按照清洗后每一行对应的源文件行号（1-based）。
export async function prepareForAIWithLineMap(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const commentRanges = computeCommentRanges(content, ext);
  // 不保留单行文档注释（/** ... */），统一作为注释剔除
  const isPreservedDocBlock = () => false;

  // 计算每行起始偏移，便于在行维度内裁剪注释片段
  const lines = content.split('\n');
  const lineOffsets = [];
  let offset = 0;
  for (const ln of lines) { lineOffsets.push(offset); offset += ln.length + 1; }

  // 识别禁用标记所作用的行（保持与 stripNoReviewForAI 语义一致）
  const nextToken = 'review-disable-next-line';
  const startToken = 'review-disable-start';
  const endToken = 'review-disable-end';
  const disabled = new Set();
  let pendingBlockStartLine = null;
  for (const r of commentRanges) {
    const lower = content.slice(r.start, r.end).toLowerCase();
    const lineIdx = content.substring(0, r.start).split('\n').length - 1; // token 所在行索引
    if (lower.includes(nextToken)) {
      const nx = lineIdx + 1;
      if (nx >= 0 && nx < lines.length) disabled.add(nx);
      continue;
    }
    if (lower.includes(startToken)) {
      const nx = lineIdx + 1; // 从下一行开始禁用
      if (nx >= 0 && nx < lines.length) pendingBlockStartLine = nx;
      continue;
    }
    if (lower.includes(endToken)) {
      const endLine = Math.max(0, lineIdx); // 到 end 标记所在行的上一行结束
      if (pendingBlockStartLine !== null) {
        for (let i = pendingBlockStartLine; i < endLine; i++) {
          disabled.add(i);
        }
      }
      pendingBlockStartLine = null;
      continue;
    }
  }
  if (pendingBlockStartLine !== null) {
    for (let i = pendingBlockStartLine; i < lines.length; i++) {
      disabled.add(i);
    }
  }

  // 针对每一行，按注释范围做局部裁剪；若行仅剩空白则丢弃
  const cleanLines = [];
  const lineMap = [];
  for (let i = 0; i < lines.length; i++) {
    if (disabled.has(i)) continue; // 整行禁用
    const raw = lines[i];
    const start = lineOffsets[i];
    const end = start + raw.length;

    // 以当前行的可保留区间为基础，逐个剔除与之相交的注释区间
    let segments = [{ start, end }];
    for (const cr of commentRanges) {
      // 跳过保留的文档注释块
      if (isPreservedDocBlock(cr)) continue;
      if (cr.start >= end || cr.end <= start) continue; // 与该行无交集
      const rs = Math.max(cr.start, start);
      const re = Math.min(cr.end, end);
      const nextSegs = [];
      for (const s of segments) {
        if (re <= s.start || rs >= s.end) {
          nextSegs.push(s);
        } else {
          if (rs > s.start) nextSegs.push({ start: s.start, end: rs });
          if (re < s.end) nextSegs.push({ start: re, end: s.end });
        }
      }
      segments = nextSegs;
    }

    const rebuilt = segments.map(s => content.slice(s.start, s.end)).join('');
    // 去除行尾空白（含 CR），保持前导缩进；用于决定是否是“空行”再丢弃
    const trimmedRight = rebuilt.replace(/[ \t\r]+$/g, '');
    if (trimmedRight.trim().length === 0) {
      continue; // 清洗后为空行则跳过
    }
    cleanLines.push(trimmedRight);
    lineMap.push(i + 1); // 使用源文件的行号（1-based）
  }

  const cleaned = cleanLines.join('\n');
  return { cleaned, clean: cleaned, lineMap };
}