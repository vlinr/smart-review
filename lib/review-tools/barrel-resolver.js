import fs from 'fs';
import path from 'path';
import { tryFileCandidates } from './import-candidates.js';

const BARREL_NAME = /^index\.(tsx?|jsx?|mjs|cjs)$/i;
const RE_EXPORT = /export\s+(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/g;

function isBarrelFile(filePath) {
  const base = path.basename(filePath);
  if (BARREL_NAME.test(base)) return true;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    RE_EXPORT.lastIndex = 0;
    return RE_EXPORT.test(content);
  } catch (e) {
    return false;
  }
}

function resolveReexport(fromFile, specifier) {
  const dir = path.dirname(fromFile);
  const base = path.resolve(dir, specifier);
  return tryFileCandidates(base);
}

/**
 * Follow barrel re-exports up to maxDepth hops (index.ts / export ... from).
 */
export function followBarrelExports(absPaths = [], projectRoot, maxDepth = 2) {
  const root = path.resolve(projectRoot);
  const out = new Set();
  let frontier = absPaths.filter((p) => p && (p === root || p.startsWith(root + path.sep)));

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next = [];
    for (const abs of frontier) {
      if (!isBarrelFile(abs)) {
        out.add(abs);
        continue;
      }
      let content = '';
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        out.add(abs);
        continue;
      }
      let found = false;
      RE_EXPORT.lastIndex = 0;
      for (const m of content.matchAll(RE_EXPORT)) {
        found = true;
        for (const target of resolveReexport(abs, m[1])) {
          next.push(target);
        }
      }
      if (!found) out.add(abs);
    }
    frontier = [...new Set(next)];
  }

  for (const abs of frontier) out.add(abs);
  return [...out];
}

export function expandResolvedWithBarrels(absCandidates, projectRoot, maxDepth = 2) {
  const expanded = followBarrelExports(absCandidates, projectRoot, maxDepth);
  return expanded.length > 0 ? expanded : absCandidates;
}
