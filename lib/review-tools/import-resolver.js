import fs from 'fs';
import path from 'path';
import { loadPathAliases, resolveAliasTargets, findNearestConfigDir } from './path-alias-resolver.js';
import { resolveWorkspaceImport } from './workspace-resolver.js';
import { expandResolvedWithBarrels } from './barrel-resolver.js';
import { tryFileCandidates, IMPORT_EXTS } from './import-candidates.js';

const JS_LIKE = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte']);
const SRC_ROOT_NAMES = ['src', 'src/main/java', 'src/main/kotlin', 'app/src/main/java', 'lib', 'internal', 'pkg'];

function uniqueInsideRoot(absPaths, projectRoot) {
  const root = path.resolve(projectRoot);
  return [...new Set(absPaths)]
    .filter((abs) => abs === root || abs.startsWith(root + path.sep))
    .map((abs) => path.relative(root, abs).replace(/\\/g, '/'));
}

function detectLanguage(fromPath) {
  const ext = path.extname(String(fromPath || '')).toLowerCase();
  if (ext === '.py' || ext === '.pyi') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.java') return 'java';
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.php') return 'php';
  if (ext === '.rs') return 'rust';
  if (ext === '.rb') return 'ruby';
  if (ext === '.cs') return 'csharp';
  if (['.cpp', '.c', '.h', '.hpp', '.cc', '.cxx'].includes(ext)) return 'cpp';
  if (JS_LIKE.has(ext)) return 'javascript';
  return 'unknown';
}

function loadGoModule(projectRoot, fromPath) {
  const fromAbs = fromPath ? path.resolve(projectRoot, fromPath) : projectRoot;
  const nearest = findNearestConfigDir(fromAbs, projectRoot, ['go.mod']);
  if (!nearest) return null;
  try {
    const raw = fs.readFileSync(nearest.cfgPath, 'utf8');
    const match = raw.match(/^\s*module\s+(\S+)/m);
    if (!match) return null;
    return { modulePath: match[1], moduleRoot: nearest.dir };
  } catch (e) {
    return null;
  }
}

function loadComposerPsr4(projectRoot, fromPath) {
  const fromAbs = fromPath ? path.resolve(projectRoot, fromPath) : projectRoot;
  const nearest = findNearestConfigDir(fromAbs, projectRoot, ['composer.json']);
  if (!nearest) return [];
  try {
    const json = JSON.parse(fs.readFileSync(nearest.cfgPath, 'utf8'));
    const psr4 = json?.autoload?.['psr-4'] || {};
    const entries = [];
    for (const [ns, relDir] of Object.entries(psr4)) {
      entries.push({
        namespace: String(ns).replace(/\\+$/, ''),
        dir: path.resolve(nearest.dir, String(relDir).replace(/\\/g, '/'))
      });
    }
    return entries;
  } catch (e) {
    return [];
  }
}

function loadCargoCrateRoot(projectRoot, fromPath) {
  const fromAbs = fromPath ? path.resolve(projectRoot, fromPath) : projectRoot;
  const nearest = findNearestConfigDir(fromAbs, projectRoot, ['Cargo.toml']);
  if (!nearest) return null;
  return path.join(nearest.dir, 'src');
}

function collectSourceRoots(projectRoot, fromAbs) {
  const root = path.resolve(projectRoot);
  const roots = new Set();
  let dir = fs.existsSync(fromAbs) && fs.statSync(fromAbs).isFile()
    ? path.dirname(fromAbs)
    : fromAbs;
  for (let i = 0; i < 10 && dir.startsWith(root); i++) {
    for (const name of SRC_ROOT_NAMES) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) roots.add(candidate);
      } catch (e) {
        // ignore
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...roots];
}

function resolveRelativeSpec(specifier, fromDir) {
  return tryFileCandidates(path.resolve(fromDir, specifier));
}

function looksLikePackageSpecifier(specifier) {
  const s = String(specifier || '');
  if (!s || s.startsWith('.') || s.startsWith('/')) return false;
  return /^@[^/]+\/[^/]+/.test(s) || /^[a-zA-Z0-9_@-]+(\/[a-zA-Z0-9_./-]+)?$/.test(s);
}

function resolveJsLikeSpec(specifier, projectRoot, fromDir, fromPath, pathAliases) {
  if (specifier.startsWith('.')) {
    return { kind: 'relative', candidates: resolveRelativeSpec(specifier, fromDir) };
  }
  if (specifier.startsWith('/') && !specifier.startsWith('//')) {
    return {
      kind: 'absolute',
      candidates: tryFileCandidates(path.resolve(projectRoot, specifier.replace(/^\//, '')))
    };
  }

  const candidates = [];
  if (looksLikePackageSpecifier(specifier)) {
    candidates.push(...resolveWorkspaceImport(projectRoot, specifier));
  }

  const aliases = loadPathAliases(projectRoot, fromPath, pathAliases);
  for (const base of resolveAliasTargets(specifier, aliases)) {
    candidates.push(...tryFileCandidates(base));
  }

  return { kind: 'alias_or_package', candidates };
}

function resolvePythonSpec(specifier, projectRoot, fromDir) {
  const clean = String(specifier || '').trim();
  if (!clean) return { kind: 'python', candidates: [] };

  if (clean.startsWith('.')) {
    const match = clean.match(/^(\.+)(.*)$/);
    if (!match) return { kind: 'python', candidates: [] };
    const dots = match[1];
    const rest = match[2].replace(/^\./, '');
    let baseDir = fromDir;
    for (let i = 1; i < dots.length; i++) {
      baseDir = path.dirname(baseDir);
    }
    const modulePath = rest ? rest.replace(/\./g, path.sep) : '';
    const candidates = modulePath
      ? [...tryFileCandidates(path.join(baseDir, modulePath))]
      : tryFileCandidates(baseDir);
    return { kind: 'python_relative', candidates };
  }

  const modulePath = clean.replace(/\./g, path.sep);
  const candidates = [];
  for (const root of collectSourceRoots(projectRoot, fromDir)) {
    candidates.push(...tryFileCandidates(path.join(root, modulePath)));
  }
  candidates.push(...tryFileCandidates(path.join(projectRoot, modulePath)));
  return { kind: 'python_module', candidates };
}

function resolveGoSpec(specifier, projectRoot, fromPath) {
  const clean = String(specifier || '').trim().replace(/^["']|["']$/g, '');
  if (!clean || (!clean.includes('/') && !clean.includes('.'))) {
    return { kind: 'go_stdlib_or_local', candidates: [] };
  }
  const goMod = loadGoModule(projectRoot, fromPath);
  const candidates = [];
  const fromAbs = fromPath ? path.resolve(projectRoot, fromPath) : projectRoot;

  if (goMod && clean.startsWith(goMod.modulePath)) {
    const rel = clean.slice(goMod.modulePath.length).replace(/^\//, '');
    candidates.push(...tryFileCandidates(path.join(goMod.moduleRoot, rel)));
    const internalIdx = rel.indexOf('internal/');
    if (internalIdx >= 0) {
      const internalRel = rel.slice(internalIdx);
      candidates.push(...tryFileCandidates(path.join(goMod.moduleRoot, internalRel)));
      const pkgName = path.basename(internalRel);
      if (pkgName && pkgName !== 'internal') {
        candidates.push(...tryFileCandidates(path.join(goMod.moduleRoot, internalRel, pkgName)));
      }
    }
  } else if (clean.startsWith('.')) {
    const fromDir = path.dirname(fromAbs);
    candidates.push(...tryFileCandidates(path.resolve(fromDir, clean)));
  } else if (!clean.includes('://') && clean.includes('/')) {
    candidates.push(...tryFileCandidates(path.join(projectRoot, clean)));
    if (goMod) {
      const relFromModule = clean.startsWith(goMod.modulePath)
        ? clean.slice(goMod.modulePath.length).replace(/^\//, '')
        : clean;
      if (relFromModule.includes('internal/')) {
        const internalRel = relFromModule.slice(relFromModule.indexOf('internal/'));
        candidates.push(...tryFileCandidates(path.join(goMod.moduleRoot, internalRel)));
      }
    }
  }
  return { kind: 'go_module', candidates };
}

function resolveJavaLikeSpec(specifier, projectRoot, fromDir, language) {
  const clean = String(specifier || '').trim();
  if (!clean || clean.endsWith('.*')) return { kind: language, candidates: [] };
  const relPath = clean.replace(/\./g, path.sep);
  const candidates = [];
  for (const root of collectSourceRoots(projectRoot, fromDir)) {
    candidates.push(...tryFileCandidates(path.join(root, relPath)));
  }
  return { kind: language, candidates };
}

function resolvePhpSpec(specifier, projectRoot, fromPath) {
  const clean = String(specifier || '').trim().replace(/^\\+/, '');
  if (!clean) return { kind: 'php', candidates: [] };
  const psr4Entries = loadComposerPsr4(projectRoot, fromPath);
  const candidates = [];
  for (const entry of psr4Entries) {
    if (!clean.startsWith(entry.namespace)) continue;
    const rest = clean.slice(entry.namespace.length).replace(/^\\+/, '').replace(/\\/g, path.sep);
    candidates.push(...tryFileCandidates(path.join(entry.dir, rest)));
  }
  const rel = clean.replace(/\\/g, path.sep);
  for (const root of collectSourceRoots(projectRoot, fromPath ? path.resolve(projectRoot, fromPath) : projectRoot)) {
    candidates.push(...tryFileCandidates(path.join(root, rel)));
  }
  return { kind: 'php', candidates };
}

function resolveRustSpec(specifier, projectRoot, fromPath) {
  const clean = String(specifier || '').trim();
  const crateRoot = loadCargoCrateRoot(projectRoot, fromPath);
  if (!crateRoot) return { kind: 'rust', candidates: [] };
  if (clean.startsWith('crate::')) {
    const rel = clean.slice('crate::'.length).replace(/::/g, path.sep);
    return { kind: 'rust', candidates: tryFileCandidates(path.join(crateRoot, rel)) };
  }
  if (clean.startsWith('super::') || clean.startsWith('self::')) {
    return { kind: 'rust', candidates: [] };
  }
  return { kind: 'rust_external', candidates: [] };
}

function resolveRubySpec(specifier, fromDir) {
  const clean = String(specifier || '').trim();
  if (clean.startsWith('.')) {
    return { kind: 'ruby', candidates: resolveRelativeSpec(clean, fromDir) };
  }
  return { kind: 'ruby', candidates: [] };
}

function resolveCppSpec(specifier, fromDir, projectRoot) {
  const clean = String(specifier || '').trim().replace(/^["']|["']$/g, '');
  if (!clean || clean.startsWith('<')) return { kind: 'cpp_system', candidates: [] };
  const local = resolveRelativeSpec(clean, fromDir);
  if (local.length > 0) return { kind: 'cpp_local', candidates: local };
  for (const root of collectSourceRoots(projectRoot, fromDir)) {
    const hit = tryFileCandidates(path.join(root, clean));
    if (hit.length > 0) return { kind: 'cpp_local', candidates: hit };
  }
  return { kind: 'cpp_local', candidates: [] };
}

function buildUnresolvedHint(specifier, language) {
  const tail = String(specifier || '').split(/[./\\]/).filter(Boolean).pop() || specifier;
  return [
    'Could not resolve to a repo file.',
    `Language hint: ${language}.`,
    'Fallback: use search_in_repo with path fragments or symbol names.',
    tail ? `Suggested queries: "${tail}", "${String(specifier).replace(/^@\/|^\.+/g, '')}"` : '',
    'If this is an external package/module (npm, pip, stdlib, Maven artifact), do not review vendor code; judge from usage in the changed snippet only.',
    'For generated code (pb/grpc), trace the source .proto/.thrift when the change touches it — do not treat generated artifacts as the primary review target.'
  ].filter(Boolean).join(' ');
}

function finalizeCandidates(candidates, projectRoot) {
  const root = path.resolve(projectRoot);
  const unique = [...new Set(candidates || [])].filter(
    (abs) => abs === root || abs.startsWith(root + path.sep)
  );
  const expanded = expandResolvedWithBarrels(unique, root, 2);
  return uniqueInsideRoot(expanded, root);
}

/**
 * Resolve an import/include/use specifier to in-repo files (language-aware).
 */
export function resolveImportSpec(projectRoot, args = {}) {
  const specifier = String(args.specifier || args.module || '').trim().replace(/^['"]|['"]$/g, '');
  const fromPath = String(args.fromPath || args.path || '').trim();
  const pathAliases = args.pathAliases || {};
  if (!specifier) return { ok: false, error: 'empty_specifier' };

  const root = path.resolve(projectRoot);
  const fromAbs = fromPath ? path.resolve(root, fromPath) : root;
  const fromDir = fs.existsSync(fromAbs) && fs.statSync(fromAbs).isFile()
    ? path.dirname(fromAbs)
    : (fs.existsSync(fromAbs) ? fromAbs : root);

  const language = detectLanguage(fromPath);
  let result = { kind: 'unknown', candidates: [] };

  if (language === 'python') {
    result = resolvePythonSpec(specifier, root, fromDir);
  } else if (language === 'go') {
    result = resolveGoSpec(specifier, root, fromPath);
  } else if (language === 'java' || language === 'kotlin' || language === 'csharp') {
    result = resolveJavaLikeSpec(specifier, root, fromDir, language);
  } else if (language === 'php') {
    result = resolvePhpSpec(specifier, root, fromPath);
  } else if (language === 'rust') {
    result = resolveRustSpec(specifier, root, fromPath);
  } else if (language === 'ruby') {
    result = resolveRubySpec(specifier, fromDir);
  } else if (language === 'cpp') {
    result = resolveCppSpec(specifier, fromDir, root);
  } else if (specifier.startsWith('.')) {
    result = { kind: 'relative', candidates: resolveRelativeSpec(specifier, fromDir) };
  } else {
    result = resolveJsLikeSpec(specifier, root, fromDir, fromPath, pathAliases);
  }

  const resolved = finalizeCandidates(result.candidates || [], root);
  return {
    ok: true,
    specifier,
    fromPath: fromPath || null,
    language,
    kind: result.kind,
    resolved,
    hint: resolved.length > 0
      ? 'Use this file as context for the current change. Do not review pre-existing issues in it unless this change newly exposes them. For barrel/index files, prefer the resolved source files.'
      : buildUnresolvedHint(specifier, language)
  };
}

export { tryFileCandidates, detectLanguage, uniqueInsideRoot, IMPORT_EXTS };
