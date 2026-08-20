export function wildcardToRegex(pattern) {
  const text = String(pattern || '').trim();
  if (!text) return null;
  const escaped = text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/\\\\]*');
  try {
    return new RegExp(`^${regex}$`, 'i');
  } catch (e) {
    return null;
  }
}

export function normalizePaths(filePaths = []) {
  return (Array.isArray(filePaths) ? filePaths : []).map((p) => String(p || '').replace(/\\/g, '/'));
}

export function matchRoute(mode, filePaths, route) {
  if (!route || typeof route !== 'object') return false;
  const normalizedMode = String(mode || '').toLowerCase();
  const modes = Array.isArray(route.modes) ? route.modes.map((m) => String(m).toLowerCase()) : [];
  if (modes.length > 0 && !modes.includes(normalizedMode)) return false;
  const patterns = Array.isArray(route.match) ? route.match : [];
  if (patterns.length === 0) return false;
  const paths = normalizePaths(filePaths);
  for (const p of patterns) {
    const re = wildcardToRegex(p);
    if (!re) continue;
    if (paths.some((fp) => re.test(fp))) return true;
  }
  return false;
}
