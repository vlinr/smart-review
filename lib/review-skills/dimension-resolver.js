import { matchRoute, wildcardToRegex, normalizePaths } from './path-utils.js';

const DIMENSION_CATALOG = [
  { id: 'evidence-enforcer', key: 'skill_evidence_enforcer', always: true },
  { id: 'diff-risk-guard', key: 'skill_diff_risk_guard', always: true },
  { id: 'logic-correctness', key: 'skill_logic_correctness', always: true },
  { id: 'api-contract', key: 'skill_api_contract', always: true },
  { id: 'performance-hotpath', key: 'skill_performance_hotpath', always: true },
  { id: 'runtime-compat', key: 'skill_runtime_compat', always: true },
  { id: 'concurrency-resource', key: 'skill_concurrency_resource' },
  { id: 'maintainability-testability', key: 'skill_maintainability_testability' }
];

export class DimensionSkillResolver {
  constructor({ config, tForAI }) {
    this.config = config;
    this.tForAI = tForAI;
  }

  isEnabled() {
    const skills = this.config?.skills || {};
    return skills.enabled !== false;
  }

  matchesEntry(item, mode, filePaths = []) {
    if (item.always) return true;
    const normalizedMode = String(mode || '').toLowerCase();
    if (Array.isArray(item.modes) && item.modes.length > 0) {
      if (!item.modes.map((m) => String(m).toLowerCase()).includes(normalizedMode)) {
        return false;
      }
    }
    if (Array.isArray(item.match) && item.match.length > 0) {
      return matchRoute(mode, filePaths, { match: item.match });
    }
    return true;
  }

  listCatalogEntries(mode = null, filePaths = []) {
    if (!this.isEnabled()) return [];
    return DIMENSION_CATALOG
      .filter((item) => mode == null || this.matchesEntry(item, mode, filePaths))
      .map((item) => {
        const summary = this.tForAI(item.key);
        const extra = [];
        if (item.id === 'evidence-enforcer') extra.push(this.tForAI('skill_evidence_trace_hint'));
        if (item.id === 'diff-risk-guard') extra.push(this.tForAI('skill_diff_risk_trace_hint'));
        if (item.id === 'api-contract') extra.push(this.tForAI('skill_api_boundary_hint'));
        const body = extra.length > 0 ? `${summary}\n${extra.join('\n')}` : summary;
        return {
          id: item.id,
          name: item.id,
          summary,
          type: 'dimension',
          body,
          always: item.always === true,
          modes: item.modes || [],
          match: item.match || []
        };
      });
  }

  buildCorrectionPrompt(skillIds = []) {
    const ids = Array.isArray(skillIds) ? skillIds.join(', ') : '';
    return [
      this.tForAI('skills_correction_line1'),
      this.tForAI('skills_correction_line2', { skills: ids }),
      this.tForAI('skills_correction_line3'),
      this.tForAI('skills_correction_line4'),
      this.tForAI('skills_correction_line5')
    ].join('\n');
  }
}

export { wildcardToRegex, normalizePaths, matchRoute };
