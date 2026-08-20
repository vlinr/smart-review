import fs from 'fs';
import path from 'path';
import { resolveImportSpec } from './import-resolver.js';
const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h', '.cs', '.php', '.rb'
]);

const SKIP_DIR_RE = /^(node_modules|\.git|dist|build|coverage|\.next|\.nuxt)(\/|$)/i;

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSymbolPatterns(symbol, kinds = ['all']) {
  const sym = escapeRegExp(symbol);
  const use = (kind) => kinds.includes('all') || kinds.includes(kind);
  const patterns = [];
  if (use('definition')) {
    patterns.push({ kind: 'definition', re: new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${sym}\\b`, 'g') });
    patterns.push({ kind: 'definition', re: new RegExp(`(?:export\\s+)?class\\s+${sym}\\b`, 'g') });
    patterns.push({ kind: 'definition', re: new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${sym}\\b`, 'g') });
    patterns.push({ kind: 'definition', re: new RegExp(`def\\s+${sym}\\s*\\(`, 'g') });
    patterns.push({ kind: 'definition', re: new RegExp(`func\\s+(?:\\([^)]*\\)\\s+)?${sym}\\s*\\(`, 'g') });
  }
  if (use('call')) {
    patterns.push({ kind: 'call', re: new RegExp(`\\b${sym}\\s*\\(`, 'g') });
    patterns.push({ kind: 'call', re: new RegExp(`\\.${sym}\\s*\\(`, 'g') });
    patterns.push({ kind: 'call', re: new RegExp(`await\\s+${sym}\\s*\\(`, 'g') });
  }
  if (use('import')) {
    patterns.push({ kind: 'import', re: new RegExp(`import\\s+${sym}\\b`, 'g') });
    patterns.push({ kind: 'import', re: new RegExp(`import\\s*\\{[^}]*\\b${sym}\\b`, 'g') });
    patterns.push({ kind: 'import', re: new RegExp(`from\\s+['"][^'"]+['"]\\s+import\\s+${sym}\\b`, 'g') });
    patterns.push({ kind: 'import', re: new RegExp(`require\\([^)]*\\).*\\b${sym}\\b`, 'g') });
  }
  if (use('export')) {
    patterns.push({ kind: 'export', re: new RegExp(`export\\s*\\{[^}]*\\b${sym}\\b`, 'g') });
    patterns.push({ kind: 'export', re: new RegExp(`export\\s+default\\s+${sym}\\b`, 'g') });
  }
  return patterns;
}

export function walkRepoFiles(root, { maxFiles = 300, pattern = '' } = {}) {
  const files = [];
  const stack = [root];
  const normalizedPattern = String(pattern || '').trim().toLowerCase();
  while (stack.length > 0 && files.length < maxFiles) {
    let current;
    try {
      current = stack.pop();
    } catch (e) {
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const abs = path.join(current, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!SKIP_DIR_RE.test(rel)) stack.push(abs);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) continue;
      if (normalizedPattern) {
        const lowerRel = rel.toLowerCase();
        const lowerName = entry.name.toLowerCase();
        const wildcard = normalizedPattern.includes('*')
          ? new RegExp(`^${normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')
          : null;
        const matched = wildcard
          ? wildcard.test(lowerName) || wildcard.test(lowerRel)
          : lowerRel.includes(normalizedPattern) || lowerName.includes(normalizedPattern);
        if (!matched) continue;
      }
      files.push({ abs, rel, name: entry.name });
    }
  }
  return files;
}

function rankSymbolMatch(match, fromPath) {
  const normFrom = String(fromPath || '').trim().replace(/\\/g, '/');
  if (!normFrom) return 0;
  const normPath = match.path.replace(/\\/g, '/');
  if (normPath === normFrom) {
    if (match.kind === 'definition') return 100;
    if (match.kind === 'call') return 90;
    return 80;
  }
  const fromDir = normFrom.includes('/') ? normFrom.slice(0, normFrom.lastIndexOf('/')) : '';
  const matchDir = normPath.includes('/') ? normPath.slice(0, normPath.lastIndexOf('/')) : '';
  if (fromDir && fromDir === matchDir) {
    if (match.kind === 'definition') return 70;
    if (match.kind === 'call' || match.kind === 'import') return 60;
    return 55;
  }
  if (fromDir && normPath.startsWith(`${fromDir}/`)) {
    if (match.kind === 'definition') return 50;
    return 40;
  }
  if (match.kind === 'definition') return 30;
  if (match.kind === 'import') return 20;
  return 10;
}

function sortSymbolMatches(matches, fromPath) {
  if (!fromPath || matches.length <= 1) return matches;
  return [...matches].sort((a, b) => rankSymbolMatch(b, fromPath) - rankSymbolMatch(a, fromPath));
}

function scanFileForSymbol(file, symbol, kinds, maxMatches, results) {
  let content = '';
  try {
    const stat = fs.statSync(file.abs);
    if (stat.size > 1024 * 1024) return;
    content = fs.readFileSync(file.abs, 'utf8');
  } catch (e) {
    return;
  }
  const lines = content.split('\n');
  const patterns = buildSymbolPatterns(symbol, kinds);
  for (let lineIdx = 0; lineIdx < lines.length && results.length < maxMatches; lineIdx++) {
    const line = lines[lineIdx];
    for (const p of patterns) {
      p.re.lastIndex = 0;
      if (p.re.test(line)) {
        results.push({
          path: file.rel,
          line: lineIdx + 1,
          kind: p.kind,
          content: line.trim().slice(0, 360)
        });
        break;
      }
    }
  }
}

export function findSymbolReferences(projectRoot, args = {}, limits = {}) {
  const symbol = String(args.symbol || '').trim();
  if (!symbol) return { ok: false, error: 'empty_symbol' };

  const relScope = String(args.path || args.scope || '').trim();
  const scopeRoot = relScope ? path.resolve(projectRoot, relScope) : projectRoot;
  if (!fs.existsSync(scopeRoot)) return { ok: false, error: 'scope_not_found' };

  const kinds = String(args.kind || 'all').split(/[,|]/).map((k) => k.trim()).filter(Boolean);
  const maxResults = Math.max(1, Math.min(Number(args.maxResults || limits.maxSearchMatches || 40), limits.maxSearchMatches || 40));
  const maxFiles = Math.max(1, Math.min(Number(args.maxFiles || limits.maxSearchFiles || 120), limits.maxSearchFiles || 120));
  const pattern = String(args.pattern || '').trim();

  const candidates = walkRepoFiles(fs.statSync(scopeRoot).isDirectory() ? scopeRoot : path.dirname(scopeRoot), {
    maxFiles: maxFiles * 2,
    pattern
  }).slice(0, maxFiles);

  const matches = [];
  for (const file of candidates) {
    if (matches.length >= maxResults) break;
    scanFileForSymbol(file, symbol, kinds, maxResults, matches);
  }

  const fromPath = String(args.fromPath || '').trim();
  const ranked = sortSymbolMatches(matches, fromPath);
  const grouped = {
    definition: ranked.filter((m) => m.kind === 'definition'),
    call: ranked.filter((m) => m.kind === 'call'),
    import: ranked.filter((m) => m.kind === 'import'),
    export: ranked.filter((m) => m.kind === 'export')
  };

  return {
    ok: true,
    tool: 'find_references',
    symbol,
    scope: relScope || '.',
    fromPath: fromPath || null,
    scannedFiles: candidates.length,
    count: ranked.length,
    grouped,
    matches: ranked
  };
}

export function traceCallers(projectRoot, args = {}, limits = {}) {
  const symbol = String(args.symbol || '').trim();
  if (!symbol) return { ok: false, error: 'empty_symbol' };

  const fromPath = String(args.fromPath || args.path || '').trim();
  const contextLines = Math.max(0, Math.min(Number(args.contextLines || 3), 8));
  const refResult = findSymbolReferences(projectRoot, {
    symbol,
    path: args.scope || fromPath || '',
    fromPath,
    kind: 'call,import',
    maxResults: Math.min(Number(args.maxResults || 30), limits.maxSearchMatches || 30),
    maxFiles: limits.maxSearchFiles || 120,
    pattern: args.pattern
  }, limits);

  if (!refResult.ok) return refResult;

  let callers = refResult.matches.filter((m) => m.kind === 'call' || m.kind === 'import');
  if (fromPath) {
    const normalizedFrom = fromPath.replace(/\\/g, '/');
    callers = callers.filter((m) => m.path !== normalizedFrom);
  }

  const enriched = [];
  for (const hit of callers.slice(0, Math.min(Number(args.maxResults || 20), 20))) {
    const abs = path.resolve(projectRoot, hit.path);
    let snippet = hit.content;
    try {
      const content = fs.readFileSync(abs, 'utf8');
      const lines = content.split('\n');
      const start = Math.max(0, hit.line - 1 - contextLines);
      const end = Math.min(lines.length, hit.line + contextLines);
      snippet = lines.slice(start, end).map((line, idx) => {
        const num = start + idx + 1;
        const marker = num === hit.line ? '>' : ' ';
        return `${marker} ${num}| ${line}`;
      }).join('\n');
    } catch (e) {
      // keep single-line snippet
    }
    enriched.push({ ...hit, context: snippet });
  }

  return {
    ok: true,
    tool: 'trace_callers',
    symbol,
    fromPath: fromPath || null,
    count: enriched.length,
    callers: enriched,
    hint: enriched.length === 0
      ? 'No callers found in scanned scope. Consider widening scope or using find_references with kind=all.'
      : 'Review caller contexts to verify authorization, input validation, and error handling.'
  };
}

export function readSymbolContext(projectRoot, args = {}, limits = {}) {
  const symbol = String(args.symbol || '').trim();
  const relPath = String(args.path || '').trim();
  if (!symbol) return { ok: false, error: 'empty_symbol' };

  const contextLines = Math.max(1, Math.min(Number(args.contextLines || 20), limits.maxReadLines || 80));
  let targetPath = relPath ? path.resolve(projectRoot, relPath) : null;

  if (!targetPath || !fs.existsSync(targetPath)) {
    const defs = findSymbolReferences(projectRoot, {
      symbol,
      kind: 'definition',
      maxResults: 5,
      maxFiles: limits.maxSearchFiles || 120
    }, limits);
    const firstDef = defs.matches?.find((m) => m.kind === 'definition');
    if (!firstDef) return { ok: false, error: 'definition_not_found', symbol };
    targetPath = path.resolve(projectRoot, firstDef.path);
  }

  if (!targetPath.startsWith(path.resolve(projectRoot))) {
    return { ok: false, error: 'invalid_path' };
  }

  const content = fs.readFileSync(targetPath, 'utf8');
  const lines = content.split('\n');
  const symRe = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  let anchorLine = Number(args.line || 0);
  if (!anchorLine) {
    for (let i = 0; i < lines.length; i++) {
      if (symRe.test(lines[i]) && /function|class|const|let|var|def|func|=>/.test(lines[i])) {
        anchorLine = i + 1;
        break;
      }
    }
  }
  if (!anchorLine) anchorLine = 1;

  const half = Math.floor(contextLines / 2);
  const startLine = Math.max(1, anchorLine - half);
  const endLine = Math.min(lines.length, startLine + contextLines - 1);
  const slice = lines.slice(startLine - 1, endLine);

  return {
    ok: true,
    tool: 'read_symbol_context',
    symbol,
    path: path.relative(projectRoot, targetPath).replace(/\\/g, '/'),
    anchorLine,
    startLine,
    endLine,
    content: slice.map((line, idx) => `${startLine + idx}| ${line}`).join('\n')
  };
}

export function readAround(projectRoot, args = {}, limits = {}) {
  const relPath = String(args.path || '').trim();
  if (!relPath) return { ok: false, error: 'empty_path' };
  const abs = path.resolve(projectRoot, relPath);
  const root = path.resolve(projectRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, error: 'invalid_path' };
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, error: 'file_not_found' };
  }
  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split('\n');
  const line = Math.max(1, Math.min(Number(args.line || 1), lines.length));
  const maxWindow = Math.max(8, Math.min(Number(limits.maxReadLines || 80), 120));
  const before = Math.max(0, Math.min(Number(args.before ?? 12), maxWindow));
  const after = Math.max(0, Math.min(Number(args.after ?? 12), maxWindow));
  const startLine = Math.max(1, line - before);
  const endLine = Math.min(lines.length, line + after);
  const slice = lines.slice(startLine - 1, endLine);
  return {
    ok: true,
    tool: 'read_around',
    path: path.relative(projectRoot, abs).replace(/\\/g, '/'),
    line,
    startLine,
    endLine,
    content: slice.map((text, idx) => {
      const num = startLine + idx;
      const marker = num === line ? '>' : ' ';
      return `${marker} ${num}| ${text}`;
    }).join('\n')
  };
}

export function resolveImport(projectRoot, args = {}, limits = {}) {
  const pathAliases = limits.pathAliases || args.pathAliases || {};
  const result = resolveImportSpec(projectRoot, { ...args, pathAliases });
  if (!result.ok) return result;

  const root = path.resolve(projectRoot);
  if ((result.resolved || []).length === 0) {
    return {
      ok: true,
      tool: 'resolve_import',
      specifier: result.specifier,
      fromPath: result.fromPath,
      language: result.language,
      kind: result.kind,
      resolved: [],
      hint: result.hint
    };
  }

  const previewLines = Math.max(8, Math.min(Number(args.previewLines || 24), limits.maxReadLines || 40));
  const previews = result.resolved.slice(0, 3).map((rel) => {
    try {
      const abs = path.resolve(root, rel);
      const lines = fs.readFileSync(abs, 'utf8').split('\n').slice(0, previewLines);
      return {
        path: rel,
        preview: lines.map((line, idx) => `${idx + 1}| ${line}`).join('\n')
      };
    } catch (e) {
      return { path: rel, preview: '' };
    }
  });

  return {
    ok: true,
    tool: 'resolve_import',
    specifier: result.specifier,
    fromPath: result.fromPath,
    language: result.language,
    kind: result.kind,
    resolved: result.resolved,
    files: previews,
    hint: result.hint
  };
}

export function executeTraceTool(tool, projectRoot, args, limits = {}) {
  if (tool === 'find_references') return findSymbolReferences(projectRoot, args, limits);
  if (tool === 'trace_callers') return traceCallers(projectRoot, args, limits);
  if (tool === 'read_symbol_context') return readSymbolContext(projectRoot, args, limits);
  if (tool === 'read_around') return readAround(projectRoot, args, limits);
  if (tool === 'resolve_import') return resolveImport(projectRoot, args, limits);
  return null;
}
