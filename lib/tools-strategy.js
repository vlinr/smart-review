const STRATEGIES = {
  off: {
    enabled: false,
    maxCalls: 0
  },
  conservative: {
    enabled: true,
    maxCalls: 6,
    maxReadLines: 300,
    maxSearchMatches: 30,
    maxSearchFiles: 80,
    maxListFiles: 100,
    modes: ['diff', 'batch', 'segment']
  },
  balanced: {
    enabled: true,
    maxCalls: 12,
    maxReadLines: 400,
    maxSearchMatches: 50,
    maxSearchFiles: 120,
    maxListFiles: 200,
    modes: ['diff', 'batch', 'segment']
  },
  aggressive: {
    enabled: true,
    maxCalls: 20,
    maxReadLines: 600,
    maxSearchMatches: 80,
    maxSearchFiles: 200,
    maxListFiles: 300,
    modes: ['diff', 'batch', 'segment']
  }
};

export function resolveToolsStrategy(tools = {}) {
  const strategyName = String(tools.strategy || 'off').trim().toLowerCase();
  const preset = STRATEGIES[strategyName] || STRATEGIES.off;
  const explicitEnabled = tools.enabled;
  const enabled = explicitEnabled === true
    ? true
    : explicitEnabled === false
      ? false
      : preset.enabled;

  return {
    strategy: strategyName,
    enabled,
    maxCalls: Number(tools.maxCalls ?? preset.maxCalls ?? 2),
    maxReadLines: Number(tools.maxReadLines ?? preset.maxReadLines ?? 400),
    maxSearchMatches: Number(tools.maxSearchMatches ?? preset.maxSearchMatches ?? 50),
    maxSearchFiles: Number(tools.maxSearchFiles ?? preset.maxSearchFiles ?? 120),
    maxListFiles: Number(tools.maxListFiles ?? preset.maxListFiles ?? 200),
    modes: Array.isArray(tools.modes) && tools.modes.length > 0 ? tools.modes : (preset.modes || []),
    routes: Array.isArray(tools.routes) && tools.routes.length > 0 ? tools.routes : (preset.routes || []),
    allow: Array.isArray(tools.allow) && tools.allow.length > 0
      ? tools.allow.map((x) => String(x).trim()).filter(Boolean)
      : [
        'read_file',
        'get_staged_diff',
        'list_files',
        'search_in_file',
        'get_file_outline',
        'search_in_repo',
        'list_changed_files',
        'get_file_diff',
        'find_references',
        'trace_callers',
        'read_symbol_context',
        'resolve_import',
        'read_around'
      ]
  };
}

const EVIDENCE_TRACE_TOOLS = [
  'read_file',
  'list_files',
  'find_references',
  'trace_callers',
  'read_symbol_context',
  'resolve_import',
  'read_around',
  'search_in_file',
  'search_in_repo',
  'get_file_outline',
  'get_staged_diff',
  'get_file_diff',
  'list_changed_files'
];

export function shouldEnableToolsForRequest(resolved, mode, filePaths = [], matchRoute) {
  if (!resolved.enabled) return false;
  const normalizedMode = String(mode || '').toLowerCase();
  if (Array.isArray(resolved.modes) && resolved.modes.length > 0) {
    if (resolved.modes.map((m) => String(m).toLowerCase()).includes(normalizedMode)) {
      return true;
    }
  }
  if (Array.isArray(resolved.routes) && resolved.routes.length > 0 && typeof matchRoute === 'function') {
    return resolved.routes.some((route) => matchRoute(normalizedMode, filePaths, route));
  }
  return resolved.enabled && (!resolved.modes || resolved.modes.length === 0);
}

export function resolveEvidenceTraceTools(tools = {}) {
  const base = resolveToolsStrategy({ ...tools, strategy: tools.strategy === 'off' ? 'conservative' : (tools.strategy || 'conservative'), enabled: true });
  return {
    ...base,
    enabled: true,
    maxCalls: Math.max(Number(tools.evidenceMaxCalls || base.maxCalls), base.maxCalls),
    allow: EVIDENCE_TRACE_TOOLS
  };
}
