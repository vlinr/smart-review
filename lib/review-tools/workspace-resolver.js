import fs from 'fs';
import path from 'path';
import { tryFileCandidates } from './import-candidates.js';

const cache = new Map();

function loadPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

function parsePnpmWorkspace(content) {
  const patterns = [];
  for (const line of String(content || '').split('\n')) {
    const m = line.match(/^\s*-\s*['"]?([^'"\n#]+)/);
    if (m) patterns.push(m[1].trim());
  }
  return patterns;
}

function expandWorkspacePatterns(projectRoot, patterns) {
  const root = path.resolve(projectRoot);
  const dirs = new Set();
  for (const pattern of patterns) {
    const normalized = String(pattern || '').replace(/\\/g, '/').trim();
    if (!normalized) continue;
    if (normalized.includes('*')) {
      const idx = normalized.indexOf('*');
      const base = normalized.slice(0, idx).replace(/\/$/, '');
      const baseDir = path.join(root, base);
      if (!fs.existsSync(baseDir)) continue;
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgDir = path.join(baseDir, entry.name);
        if (fs.existsSync(path.join(pkgDir, 'package.json'))) dirs.add(pkgDir);
      }
      continue;
    }
    const pkgDir = path.join(root, normalized);
    if (fs.existsSync(path.join(pkgDir, 'package.json'))) dirs.add(pkgDir);
  }
  return dirs;
}

function resolveExportEntry(pkgDir, subpath = '.') {
  const pkg = loadPackageJson(pkgDir);
  const cleanSub = subpath === '.' ? '.' : `./${String(subpath).replace(/^\.\//, '')}`;
  const subRel = subpath === '.' ? '' : String(subpath).replace(/^\.\//, '');

  if (pkg?.exports && typeof pkg.exports === 'object') {
    const target = pkg.exports[cleanSub] ?? (subpath === '.' ? pkg.exports['.'] : undefined);
    if (typeof target === 'string') {
      const hits = tryFileCandidates(path.resolve(pkgDir, target.replace(/^\.\//, '')));
      if (hits.length > 0) return hits;
    }
    if (target && typeof target === 'object') {
      const pick = target.import || target.require || target.default || target.types;
      if (typeof pick === 'string') {
        const hits = tryFileCandidates(path.resolve(pkgDir, pick.replace(/^\.\//, '')));
        if (hits.length > 0) return hits;
      }
    }
  }

  const subCandidates = subpath === '.'
    ? []
    : [
      subRel,
      path.join('src', subRel),
      path.join('lib', subRel),
      path.join('dist', subRel)
    ];
  for (const rel of subCandidates) {
    const hits = tryFileCandidates(path.join(pkgDir, rel));
    if (hits.length > 0) return hits;
  }

  if (!pkg) return tryFileCandidates(path.join(pkgDir, subpath === '.' ? 'index' : subRel));

  const fallbacks = subpath === '.'
    ? [pkg.module, pkg.main, pkg.types].filter(Boolean)
    : [];
  for (const item of fallbacks) {
    const hits = tryFileCandidates(path.resolve(pkgDir, String(item).replace(/^\.\//, '')));
    if (hits.length > 0) return hits;
  }
  return tryFileCandidates(path.join(pkgDir, subpath === '.' ? 'index' : subRel));
}

/**
 * Discover workspace packages from pnpm-workspace.yaml or package.json workspaces.
 */
export function loadWorkspacePackages(projectRoot) {
  const root = path.resolve(projectRoot);
  if (cache.has(root)) return cache.get(root);

  const packages = [];
  const patterns = [];
  const pnpmPath = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmPath)) {
    patterns.push(...parsePnpmWorkspace(fs.readFileSync(pnpmPath, 'utf8')));
  }
  const rootPkg = loadPackageJson(root);
  if (rootPkg?.workspaces) {
    const ws = rootPkg.workspaces;
    if (Array.isArray(ws)) patterns.push(...ws);
    else if (Array.isArray(ws.packages)) patterns.push(...ws.packages);
  }

  const dirs = expandWorkspacePatterns(root, patterns.length > 0 ? patterns : ['packages/*', 'apps/*']);
  for (const dir of dirs) {
    const pkg = loadPackageJson(dir);
    if (!pkg?.name) continue;
    packages.push({ name: pkg.name, dir });
  }

  cache.set(root, packages);
  return packages;
}

/**
 * Resolve workspace package import (e.g. @scope/ui, shared-utils/foo) to files.
 */
export function resolveWorkspaceImport(projectRoot, specifier) {
  const clean = String(specifier || '').trim().replace(/^['"]|['"]$/g, '');
  if (!clean || clean.startsWith('.') || clean.startsWith('/')) return [];

  for (const pkg of loadWorkspacePackages(projectRoot)) {
    if (clean === pkg.name) {
      return resolveExportEntry(pkg.dir, '.');
    }
    if (clean.startsWith(`${pkg.name}/`)) {
      const sub = clean.slice(pkg.name.length + 1);
      return resolveExportEntry(pkg.dir, sub);
    }
  }
  return [];
}

export function clearWorkspaceCache(projectRoot) {
  cache.delete(path.resolve(projectRoot));
}
