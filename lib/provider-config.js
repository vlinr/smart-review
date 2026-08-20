const PROVIDER_DEFAULTS = {
  openai: {
    model: 'gpt-4o-mini',
    baseURL: '',
    envKeys: ['AI_API_KEY', 'OPENAI_API_KEY']
  },
  anthropic: {
    model: 'claude-3-5-sonnet-latest',
    baseURL: 'https://api.anthropic.com',
    envKeys: ['AI_API_KEY', 'ANTHROPIC_API_KEY']
  },
  gemini: {
    model: 'gemini-1.5-flash',
    baseURL: 'https://generativelanguage.googleapis.com',
    envKeys: ['AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']
  }
};

const MODEL_HINTS = {
  openai: [/^(gpt-|o\d)/i, /^text-/i],
  anthropic: [/^claude/i],
  gemini: [/^gemini/i]
};

export function normalizeProviderName(provider) {
  const value = String(provider || 'openai').trim().toLowerCase();
  if (value === 'anthropic') return 'anthropic';
  if (value === 'gemini') return 'gemini';
  return 'openai';
}

export function getProviderDefaults(provider) {
  const key = normalizeProviderName(provider);
  return PROVIDER_DEFAULTS[key] || PROVIDER_DEFAULTS.openai;
}

export function resolveApiKeyCandidates(provider, configApiKey) {
  if (configApiKey) return [configApiKey];
  const defaults = getProviderDefaults(provider);
  return defaults.envKeys.map((name) => process.env[name]).filter(Boolean);
}

export function validateProviderSetup(config = {}) {
  const provider = normalizeProviderName(config.provider);
  const defaults = getProviderDefaults(provider);
  const apiKey = resolveApiKeyCandidates(provider, config.apiKey)[0] || '';
  const model = String(config.model || defaults.model);
  const warnings = [];
  const errors = [];

  if (!apiKey) {
    errors.push(`missing_api_key:${provider}`);
  }

  const hints = MODEL_HINTS[provider] || [];
  const isOpenAiCompatibleGateway = provider === 'openai' && !!String(config.baseURL || '').trim();
  if (!isOpenAiCompatibleGateway && model && hints.length > 0 && !hints.some((re) => re.test(model))) {
    warnings.push(`model_provider_mismatch:${provider}:${model}`);
  }

  if (provider !== 'openai' && config.baseURL) {
    warnings.push('custom_base_url_ignored_for_native_provider');
  }

  return {
    provider,
    model,
    apiKeyPresent: !!apiKey,
    ok: errors.length === 0,
    warnings,
    errors
  };
}

export function formatProviderValidationMessage(validation, t, config) {
  if (!validation) return '';
  const lines = [];
  if (!validation.ok) {
    lines.push(t(config, 'provider_missing_api_key', { provider: validation.provider }));
  }
  for (const warning of validation.warnings) {
    if (warning.startsWith('model_provider_mismatch:')) {
      const [, provider, model] = warning.split(':');
      lines.push(t(config, 'provider_model_mismatch_warn', { provider, model }));
    }
    if (warning === 'custom_base_url_ignored_for_native_provider') {
      lines.push(t(config, 'provider_base_url_ignored_warn'));
    }
  }
  return lines.join('\n');
}
