import fs from 'fs';
import path from 'path';
import { matchRoute } from './path-utils.js';

function parseSimpleFrontmatter(raw) {
  const text = String(raw || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: text.trim() };
  }
  const meta = {};
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    meta[key] = value;
  }
  return { meta, body: String(match[2] || '').trim() };
}

function normalizeSkillId(id) {
  return String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildSummary(meta, body, name) {
  const explicit = String(meta.summary || meta.description || '').trim();
  if (explicit) return explicit.slice(0, 200);
  const firstLine = String(body || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  const cleaned = firstLine.replace(/^#+\s*/, '');
  return (cleaned || name || '').slice(0, 200);
}

export class DocumentSkillLoader {
  constructor({ reviewDir, packageRoot, config }) {
    this.reviewDir = reviewDir;
    this.packageRoot = packageRoot;
    this.config = config;
    this.cache = new Map();
  }

  scanDirectory(dir) {
    const skills = [];
    if (!dir || !fs.existsSync(dir)) return skills;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skillFile = path.join(fullPath, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          skills.push(this.loadFile(skillFile));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.example.md')) continue;
      if (lower === 'skill.md' || lower.endsWith('.skill.md') || (lower.endsWith('.md') && !lower.startsWith('readme'))) {
        skills.push(this.loadFile(fullPath));
      }
    }
    return skills.filter(Boolean);
  }

  loadFile(filePath) {
    const cacheKey = filePath;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      const stat = fs.statSync(filePath);
      if (cached.mtimeMs === stat.mtimeMs) return cached.skill;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const { meta, body } = parseSimpleFrontmatter(raw);
    const id = normalizeSkillId(meta.id || path.basename(filePath, path.extname(filePath)));
    if (!id || !body) return null;
    const modes = Array.isArray(meta.modes)
      ? meta.modes.map((m) => String(m).toLowerCase())
      : String(meta.modes || '').split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);
    const match = Array.isArray(meta.match)
      ? meta.match.map(String)
      : String(meta.match || '').split(',').map((m) => m.trim()).filter(Boolean);
    const name = String(meta.name || id);
    const skill = {
      id,
      name,
      summary: buildSummary(meta, body, name),
      type: 'document',
      body,
      modes,
      match,
      priority: Number(meta.priority || 0),
      source: filePath
    };
    const stat = fs.statSync(filePath);
    this.cache.set(cacheKey, { mtimeMs: stat.mtimeMs, skill });
    return skill;
  }

  listCatalogEntries({ path: externalDirName = 'skills', includeBuiltin = true } = {}) {
    const byId = new Map();
    if (includeBuiltin && this.packageRoot) {
      const builtinDir = path.join(this.packageRoot, 'templates', 'skills');
      for (const skill of this.scanDirectory(builtinDir)) {
        byId.set(skill.id, {
          id: skill.id,
          name: skill.name,
          summary: skill.summary,
          type: 'document',
          body: skill.body,
          modes: skill.modes,
          match: skill.match
        });
      }
    }
    if (this.reviewDir) {
      const externalDir = path.join(this.reviewDir, externalDirName);
      for (const skill of this.scanDirectory(externalDir)) {
        byId.set(skill.id, {
          id: skill.id,
          name: skill.name,
          summary: skill.summary,
          type: 'document',
          body: skill.body,
          modes: skill.modes,
          match: skill.match
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  skillMatches(skill, mode, filePaths = []) {
    if (!skill) return false;
    const normalizedMode = String(mode || '').toLowerCase();
    if (skill.modes?.length > 0 && !skill.modes.includes(normalizedMode)) return false;
    if (skill.match?.length > 0 && !matchRoute(mode, filePaths, { match: skill.match })) return false;
    return true;
  }
}

export { parseSimpleFrontmatter, normalizeSkillId };
