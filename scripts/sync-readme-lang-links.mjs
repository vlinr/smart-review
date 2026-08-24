/**
 * Sync bilingual README language-switcher links.
 *
 * - GitHub (relative): works in the repo UI
 * - npm (absolute): relative links 404 on npmjs.com; use GitHub blob or jsDelivr
 *
 * Usage:
 *   node scripts/sync-readme-lang-links.mjs           # prefer GitHub absolute if repository set, else relative
 *   node scripts/sync-readme-lang-links.mjs --for-npm  # absolute links for publish (GitHub or jsDelivr)
 *   node scripts/sync-readme-lang-links.mjs --restore  # relative links (after publish)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const pkgName = pkg.name || 'smart-review';

const mode = process.argv.includes('--restore')
  ? 'restore'
  : process.argv.includes('--for-npm')
    ? 'npm'
    : 'auto';

function resolveGithubBlobBase() {
  const repo = pkg.repository;
  const raw = typeof repo === 'string' ? repo : (repo?.url || '');
  const match = String(raw).match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/i);
  if (!match) return null;
  const branch = pkg.repository?.branch || process.env.SMART_REVIEW_DOC_BRANCH || 'main';
  return `https://github.com/${match[1]}/blob/${branch}`;
}

function buildLinks(target) {
  if (target === 'relative') {
    return { zh: 'README.md', en: 'README.en-US.md' };
  }
  const github = resolveGithubBlobBase();
  if (target === 'github' || (target === 'absolute' && github)) {
    if (!github) {
      throw new Error('package.json 缺少 repository（GitHub）。请先填写后再用 GitHub 绝对链接。');
    }
    return {
      zh: `${github}/README.md`,
      en: `${github}/README.en-US.md`
    };
  }
  // npm fallback without GitHub: published package files on jsDelivr
  return {
    zh: `https://cdn.jsdelivr.net/npm/${pkgName}/README.md`,
    en: `https://cdn.jsdelivr.net/npm/${pkgName}/README.en-US.md`
  };
}

function pickTarget() {
  if (mode === 'restore') return 'relative';
  if (mode === 'npm') return resolveGithubBlobBase() ? 'github' : 'absolute';
  // auto: GitHub absolute when repository exists, otherwise relative for local/GitHub UX
  return resolveGithubBlobBase() ? 'github' : 'relative';
}

const links = buildLinks(pickTarget());
const zhLine = `> 语言 / Language: [中文](${links.zh}) | [English](${links.en})`;
const enLine = `> Language: [English](${links.en}) | [中文](${links.zh})`;

function patchFile(fileName, nextLine, patterns) {
  const filePath = path.join(root, fileName);
  let text = fs.readFileSync(filePath, 'utf8');
  let replaced = false;
  for (const re of patterns) {
    if (re.test(text)) {
      text = text.replace(re, nextLine);
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    throw new Error(`未找到语言切换行: ${fileName}`);
  }
  fs.writeFileSync(filePath, text, 'utf8');
}

patchFile('README.md', zhLine, [
  /^> 语言 \/ Language:.*$/m
]);
patchFile('README.en-US.md', enLine, [
  /^> Language:.*$/m
]);

const target = pickTarget();
console.log(`[sync-readme-lang-links] mode=${mode} target=${target}`);
console.log(`  中文 -> ${links.zh}`);
console.log(`  English -> ${links.en}`);
