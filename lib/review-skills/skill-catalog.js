import { DimensionSkillResolver } from './dimension-resolver.js';
import { DocumentSkillLoader, normalizeSkillId } from './document-skill-loader.js';

const DIMENSION_ID_ALIASES = {
  'diff-risk-guard': 'DIFF_RISK_GUARD',
  'evidence-enforcer': 'EVIDENCE_ENFORCER',
  'security-deep': 'SECURITY_DEEP',
  'api-boundary-trace': 'API_BOUNDARY_TRACE',
  'logic-correctness': 'LOGIC_CORRECTNESS',
  'api-contract': 'API_CONTRACT',
  'performance-hotpath': 'PERFORMANCE_HOTPATH',
  'runtime-compat': 'RUNTIME_COMPAT',
  'concurrency-resource': 'CONCURRENCY_RESOURCE',
  'maintainability-testability': 'MAINTAINABILITY_TESTABILITY'
};

export function toPublicSkillId(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase().replace(/-/g, '_');
  for (const [pub, internal] of Object.entries(DIMENSION_ID_ALIASES)) {
    if (internal === upper || pub === raw.toLowerCase()) return pub;
  }
  return normalizeSkillId(raw);
}

export class SkillCatalog {
  constructor({ config, reviewDir, packageRoot, tForAI }) {
    this.config = config;
    this.reviewDir = reviewDir;
    this.packageRoot = packageRoot;
    this.tForAI = tForAI;
    this.dimensions = new DimensionSkillResolver({ config, tForAI });
    this.documents = new DocumentSkillLoader({ reviewDir, packageRoot, config });
  }

  getConfig() {
    const skills = this.config?.skills || this.config?.ai?.skills || {};
    return {
      enabled: skills.enabled !== false,
      path: String(skills.path ?? 'skills').trim() || 'skills',
      includeBuiltin: skills.includeBuiltin !== false
    };
  }

  listDimensionEntries(mode = null, filePaths = []) {
    return this.dimensions.listCatalogEntries(mode, filePaths);
  }

  listDocumentEntries(mode = null, filePaths = []) {
    const cfg = this.getConfig();
    if (!cfg.enabled) return [];
    const all = this.documents.listCatalogEntries({
      path: cfg.path,
      includeBuiltin: cfg.includeBuiltin
    });
    if (mode == null) return all;
    return all.filter((entry) => this.documents.skillMatches(entry, mode, filePaths));
  }

  listAll(mode = null, filePaths = []) {
    const byId = new Map();
    for (const entry of this.listDimensionEntries(mode, filePaths)) {
      byId.set(entry.id, entry);
    }
    for (const entry of this.listDocumentEntries(mode, filePaths)) {
      byId.set(entry.id, entry);
    }
    return Array.from(byId.values());
  }

  listRelevantEntries(mode, filePaths = []) {
    return this.listAll(mode, filePaths);
  }

  resolvePreSelectedIds(mode, filePaths = []) {
    const ids = [
      'evidence-enforcer',
      'evidence-trace',
      'diff-risk-guard',
      'logic-correctness',
      'api-contract',
      'api-boundary-trace',
      'performance-hotpath',
      'runtime-compat'
    ];
    const entries = this.listRelevantEntries(mode, filePaths);
    for (const entry of entries) {
      if (entry.type !== 'document') continue;
      if (ids.includes(entry.id)) continue;
      // listRelevantEntries 已按 mode/path 过滤：
      // 无 match 的团队规范始终注入；有 match 的仅在路径命中时注入。
      ids.push(entry.id);
    }
    return [...new Set(ids.map(toPublicSkillId).filter(Boolean))];
  }

  getById(id) {
    const publicId = toPublicSkillId(id);
    const all = [
      ...this.listDimensionEntries(),
      ...this.documents.listCatalogEntries({
        path: this.getConfig().path,
        includeBuiltin: this.getConfig().includeBuiltin
      })
    ];
    return all.find((entry) => entry.id === publicId) || null;
  }

  buildOutlinePrompt(mode, filePaths = [], preSelectedIds = []) {
    const cfg = this.getConfig();
    if (!cfg.enabled) return '';
    const entries = this.listRelevantEntries(mode, filePaths);
    if (entries.length === 0) return '';

    const preSet = new Set((preSelectedIds || []).map(toPublicSkillId));
    const lines = entries.map((entry, idx) => {
      const kind = entry.type === 'document' ? '[document]' : '[dimension]';
      const required = preSet.has(entry.id) || entry.always ? ' [required]' : '';
      return `${idx + 1}. ${entry.id} ${kind}${required}: ${entry.summary}`;
    }).join('\n');

    const fileHint = Array.isArray(filePaths) && filePaths.length > 0
      ? `${this.tForAI('skills_prompt_target_files_header')}\n${filePaths.join('\n')}`
      : '';

    const preSelectedLine = preSelectedIds.length > 0
      ? this.tForAI('skills_preselected_line', { skills: preSelectedIds.join(', ') })
      : '';

    return [
      this.tForAI('skills_catalog_header'),
      this.tForAI('skills_catalog_mode', { mode }),
      this.tForAI('skills_catalog_instruction'),
      preSelectedLine,
      '[SKILL_CATALOG]',
      lines,
      '[/SKILL_CATALOG]',
      this.tForAI('skills_catalog_select_format'),
      this.tForAI('skills_prompt_output_header'),
      this.tForAI('skills_prompt_output_rule1'),
      this.tForAI('skills_prompt_output_rule2'),
      this.tForAI('skills_prompt_output_rule3'),
      fileHint
    ].filter(Boolean).join('\n');
  }

  buildSelectedBodiesPrompt(selectedIds = []) {
    const ids = [...new Set((selectedIds || []).map(toPublicSkillId).filter(Boolean))];
    if (ids.length === 0) return '';
    const blocks = [];
    for (const id of ids) {
      const entry = this.getById(id);
      if (!entry) continue;
      blocks.push([
        `### ${entry.name} (${entry.id})`,
        entry.body
      ].join('\n'));
    }
    if (blocks.length === 0) return '';
    return [
      this.tForAI('skills_selected_header'),
      blocks.join('\n\n')
    ].join('\n');
  }
}

export function extractSkillSelection(content) {
  const text = String(content || '');
  const tagged = text.match(/\[SKILL_SELECT\]([\s\S]*?)\[\/SKILL_SELECT\]/i);
  if (!tagged) return [];
  return tagged[1]
    .split(/[,，\n]/)
    .map((part) => toPublicSkillId(part))
    .filter(Boolean);
}

export function selectedIncludesDocumentSkill(selectedIds = [], catalog) {
  const ids = selectedIds.map(toPublicSkillId);
  return ids.some((id) => {
    const entry = catalog.getById(id);
    return entry?.type === 'document';
  });
}
