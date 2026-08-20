import fs from 'fs';
import path from 'path';

const CONFIG_NAMES = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.build.json', 'jsconfig.json'];
const BUNDLER_CONFIG_NAMES = [
  'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs',
  'webpack.config.js', 'webpack.config.ts',
  'nuxt.config.ts', 'nuxt.config.js',
  'vue.config.js'
];

function stripJsonComments(raw) {
  return String(raw || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function findNearestConfigDir(fromAbs, projectRoot, names = CONFIG_NAMES) {
  const root = path.resolve(projectRoot);
  let dir = fromAbs;
  if (fs.existsSync(fromAbs) && fs.statSync(fromAbs).isFile()) {
    dir = path.dirname(fromAbs);
  }
  while (dir.startsWith(root)) {
    for (const name of names) {
      const cfgPath = path.join(dir, name);
      if (fs.existsSync(cfgPath)) return { dir, cfgPath, name };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadJsonConfig(cfgPath) {
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return JSON.parse(stripJsonComments(raw));
  } catch (e) {
    return null;
  }
}

function mergeCompilerOptions(base = {}, overlay = {}) {
  const merged = { ...base, ...overlay };
  if (base.paths || overlay.paths) {
    merged.paths = { ...(base.paths || {}), ...(overlay.paths || {}) };
  }
  return merged;
}

function loadCompilerOptionsFromConfig(cfgPath, visited = new Set(), depth = 0) {
  if (!cfgPath || visited.has(cfgPath) || depth > 6) return {};
  visited.add(cfgPath);
  const json = loadJsonConfig(cfgPath);
  if (!json) return {};

  let opts = { ...(json.compilerOptions || {}) };
  const extendsTarget = String(json.extends || '').trim();
  if (extendsTarget) {
    const cfgDir = path.dirname(cfgPath);
    const parentPath = extendsTarget.startsWith('.')
      ? path.resolve(cfgDir, extendsTarget)
      : path.resolve(cfgDir, extendsTarget);
    const candidates = [parentPath, `${parentPath}.json`];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        opts = mergeCompilerOptions(loadCompilerOptionsFromConfig(candidate, visited, depth + 1), opts);
        break;
      }
    }
  }
  return opts;
}

function normalizeAliasPrefix(key) {
  return String(key || '').replace(/\*+$/, '').replace(/\/+$/, '');
}

function normalizeAliasDest(value) {
  return String(value || '').replace(/\*+$/, '').replace(/\/+$/, '');
}

function pushAlias(aliases, prefix, destAbs) {
  if (!prefix || !destAbs) return;
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const existing = aliases.find((item) => item.prefix === normalizedPrefix);
  if (existing) {
    if (!existing.dests.includes(destAbs)) existing.dests.push(destAbs);
    return;
  }
  aliases.push({ prefix: normalizedPrefix, dests: [destAbs] });
}

function parseUserPathAliases(projectRoot, userAliases = {}) {
  const aliases = [];
  if (!userAliases || typeof userAliases !== 'object') return aliases;
  for (const [prefix, target] of Object.entries(userAliases)) {
    const targets = Array.isArray(target) ? target : [target];
    for (const item of targets) {
      const dest = path.resolve(projectRoot, String(item || '').trim());
      pushAlias(aliases, normalizeAliasPrefix(prefix), dest);
    }
  }
  return aliases;
}

function parseTsConfigAliases(projectRoot, configDir, compilerOptions = {}) {
  const aliases = [];
  const baseUrl = compilerOptions.baseUrl
    ? path.resolve(configDir, compilerOptions.baseUrl)
    : configDir;
  for (const [key, targets] of Object.entries(compilerOptions.paths || {})) {
    const prefix = normalizeAliasPrefix(key);
    const dests = (Array.isArray(targets) ? targets : [targets]).map((t) =>
      path.resolve(baseUrl, normalizeAliasDest(t))
    );
    for (const dest of dests) {
      pushAlias(aliases, prefix, dest);
    }
  }
  return aliases;
}

function resolveBundlerPath(raw, configDir) {
  const s = String(raw || '').trim().replace(/,$/, '');
  if (!s) return null;
  const resolveMatch = s.match(/path\.resolve\s*\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)/);
  if (resolveMatch) return path.resolve(configDir, resolveMatch[1]);
  const urlMatch = s.match(/new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/);
  if (urlMatch) return path.resolve(configDir, urlMatch[1]);
  const relQuoted = s.match(/^['"](\.[^'"]*)['"]$/);
  if (relQuoted) return path.resolve(configDir, relQuoted[1]);
  return null;
}

function parseBundlerAliasFile(cfgPath) {
  const aliases = [];
  let content = '';
  try {
    content = fs.readFileSync(cfgPath, 'utf8');
  } catch (e) {
    return aliases;
  }
  const configDir = path.dirname(cfgPath);
  const patterns = [
    /['"](@[^'"]*)['"]\s*:\s*(path\.resolve\([^)]+\)|new\s+URL\([^)]+\)|['"][^'"]+['"])/g,
    /['"](~[^'"]*)['"]\s*:\s*(path\.resolve\([^)]+\)|new\s+URL\([^)]+\)|['"][^'"]+['"])/g,
    /['"](#[^'"]*)['"]\s*:\s*(path\.resolve\([^)]+\)|new\s+URL\([^)]+\)|['"][^'"]+['"])/g,
    /['"](@[^'"]*)['"]\s*:\s*(fileURLToPath\([^)]+\))/g
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(content)) !== null) {
      const dest = resolveBundlerPath(match[2], configDir);
      if (dest) pushAlias(aliases, normalizeAliasPrefix(match[1]), dest);
    }
  }
  return aliases;
}

function loadBundlerAliases(fromAbs, projectRoot) {
  const root = path.resolve(projectRoot);
  let dir = fromAbs;
  if (fs.existsSync(fromAbs) && fs.statSync(fromAbs).isFile()) {
    dir = path.dirname(fromAbs);
  }
  const aliases = [];
  while (dir.startsWith(root)) {
    for (const name of BUNDLER_CONFIG_NAMES) {
      const cfgPath = path.join(dir, name);
      if (!fs.existsSync(cfgPath)) continue;
      for (const item of parseBundlerAliasFile(cfgPath)) {
        for (const dest of item.dests) pushAlias(aliases, item.prefix, dest);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return aliases;
}

function guessLocalSrcRoots(fromAbs, projectRoot) {
  const root = path.resolve(projectRoot);
  const roots = [];
  let dir = fs.existsSync(fromAbs) && fs.statSync(fromAbs).isFile()
    ? path.dirname(fromAbs)
    : fromAbs;
  for (let i = 0; i < 8 && dir.startsWith(root); i++) {
    for (const name of ['src', 'lib', 'app', 'internal', 'pkg']) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          roots.push(candidate);
        }
      } catch (e) {
        // ignore
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set(roots)];
}

/**
 * Load import path aliases automatically (no user config required).
 * Priority: nearest tsconfig/jsconfig (with extends) → Vite/Webpack/Nuxt alias → local src guess for @/
 * Optional userAliases is an internal override only; normal projects need nothing in smart-review.json.
 */
export function loadPathAliases(projectRoot, fromPath = '', userAliases = {}) {
  const root = path.resolve(projectRoot);
  const fromAbs = fromPath ? path.resolve(root, fromPath) : root;
  const aliases = [];

  const nearest = findNearestConfigDir(fromAbs, root);
  if (nearest) {
    const compilerOptions = loadCompilerOptionsFromConfig(nearest.cfgPath);
    for (const item of parseTsConfigAliases(root, nearest.dir, compilerOptions)) {
      for (const dest of item.dests) pushAlias(aliases, item.prefix, dest);
    }
  }

  for (const item of loadBundlerAliases(fromAbs, root)) {
    for (const dest of item.dests) pushAlias(aliases, item.prefix, dest);
  }

  const hasAtAlias = aliases.some((item) => item.prefix === '@/' || item.prefix === '@');
  if (!hasAtAlias) {
    for (const srcRoot of guessLocalSrcRoots(fromAbs, root)) {
      pushAlias(aliases, '@/', srcRoot);
    }
  }

  const hasTildeAlias = aliases.some((item) => item.prefix === '~/' || item.prefix === '~');
  if (!hasTildeAlias) {
    for (const srcRoot of guessLocalSrcRoots(fromAbs, root)) {
      pushAlias(aliases, '~/', srcRoot);
    }
  }

  const hasHashAlias = aliases.some((item) => item.prefix === '#/' || item.prefix === '#');
  if (!hasHashAlias) {
    for (const srcRoot of guessLocalSrcRoots(fromAbs, root)) {
      pushAlias(aliases, '#/', srcRoot);
    }
  }

  if (userAliases && typeof userAliases === 'object' && Object.keys(userAliases).length > 0) {
    for (const item of parseUserPathAliases(root, userAliases)) {
      for (const dest of item.dests) pushAlias(aliases, item.prefix, dest);
    }
  }

  return aliases;
}

export function matchAlias(specifier, alias) {
  const barePrefix = alias.prefix.replace(/\/$/, '');
  if (specifier === barePrefix || specifier === alias.prefix) return '';
  if (specifier.startsWith(alias.prefix)) {
    return specifier.slice(alias.prefix.length);
  }
  if (specifier.startsWith(`${barePrefix}/`)) {
    return specifier.slice(barePrefix.length + 1);
  }
  return null;
}

export function resolveAliasTargets(specifier, aliases = []) {
  const hits = [];
  for (const alias of aliases) {
    const rest = matchAlias(specifier, alias);
    if (rest == null) continue;
    for (const dest of alias.dests) {
      hits.push(path.join(dest, rest));
    }
  }
  return hits;
}

export {
  findNearestConfigDir,
  loadCompilerOptionsFromConfig,
  guessLocalSrcRoots
};
