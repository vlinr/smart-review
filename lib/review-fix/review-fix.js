import { matchRoute } from '../review-skills/path-utils.js';
import { isRiskEligible } from './fix-applier.js';

export class ReviewFixEngine {
  constructor({ config, tForAI }) {
    this.config = config;
    this.tForAI = tForAI;
  }

  resolveConfig(mode, filePaths = []) {
    const fixLoop = this.config?.fixLoop || {};
    const normalizedMode = String(mode || '').toLowerCase();
    const globallyEnabled = fixLoop.enabled === true;
    const routes = Array.isArray(fixLoop.routes) ? fixLoop.routes : [];
    const routeHit = routes.length > 0 && routes.some((route) => matchRoute(normalizedMode, filePaths, route));
    const enabled = globallyEnabled || routeHit;
    return {
      enabled,
      requireFixSnippet: fixLoop.requireFixSnippet !== false,
      verifyRound: fixLoop.verifyRound === true,
      autoApply: fixLoop.autoApply === true && enabled,
      maxApplyRounds: Math.max(1, Number(fixLoop.maxApplyRounds || 1)),
      reReviewAfterApply: fixLoop.reReviewAfterApply !== false,
      dryRun: fixLoop.dryRun === true,
      autoStage: fixLoop.autoStage === true,
      autoApplyMaxRisk: String(fixLoop.autoApplyMaxRisk || 'medium').toLowerCase()
    };
  }

  resolveApplyConfig(mode = 'batch', filePaths = []) {
    const cfg = this.resolveConfig(mode, filePaths);
    return {
      autoApply: cfg.autoApply,
      maxApplyRounds: cfg.maxApplyRounds,
      reReviewAfterApply: cfg.reReviewAfterApply,
      dryRun: cfg.dryRun,
      autoStage: cfg.autoStage,
      autoApplyMaxRisk: cfg.autoApplyMaxRisk
    };
  }

  filterApplicableIssues(issues = [], applyCfg) {
    if (!applyCfg?.autoApply) return [];
    return issues.filter((issue) => {
      if (issue.source !== 'ai') return false;
      if (!issue.fixSnippet || !String(issue.fixSnippet).trim()) return false;
      if (!issue.file) return false;
      return isRiskEligible(issue.risk, applyCfg.autoApplyMaxRisk);
    });
  }

  buildOutputPrompt(fixCfg) {
    if (!fixCfg.enabled) return '';
    const lines = [this.tForAI('fix_loop_output_header')];
    if (fixCfg.requireFixSnippet) {
      lines.push(this.tForAI('fix_loop_output_require_snippet'));
    }
    if (fixCfg.autoApply) {
      lines.push(this.tForAI('fix_loop_output_auto_apply'));
    }
    lines.push(this.tForAI('fix_loop_output_format'));
    return lines.join('\n');
  }

  buildVerifyPrompt(issues = [], fixCfg) {
    if (!fixCfg.enabled || !fixCfg.verifyRound || issues.length === 0) return '';
    const summary = this.summarizeIssuesForFix(issues);
    return [
      this.tForAI('fix_loop_verify_header'),
      this.tForAI('fix_loop_verify_instruction'),
      `${this.tForAI('fix_loop_verify_issues')}\n${summary}`,
      this.tForAI('fix_loop_verify_output_format')
    ].join('\n\n');
  }

  summarizeIssuesForFix(issues = []) {
    return issues.slice(0, 15).map((issue, idx) => {
      const file = String(issue.file || '').trim();
      const message = String(issue.message || '').trim().slice(0, 160);
      const snippet = String(issue.snippet || '').trim().slice(0, 120);
      const snippetPart = snippet ? `\n   snippet: ${snippet}` : '';
      return `${idx + 1}. ${file}\n   ${message}${snippetPart}`;
    }).join('\n\n');
  }
}

export function mergeFixCodes(existing = [], refined = []) {
  const keyOf = (issue) => {
    const file = String(issue.file || '').trim();
    const message = String(issue.message || '').trim().slice(0, 120);
    const snippet = String(issue.snippet || '').trim().slice(0, 200);
    return `${file}::${message || snippet}`;
  };
  const refinedMap = new Map();
  for (const issue of refined) {
    const code = issue.fixSnippet;
    if (!code) continue;
    refinedMap.set(keyOf(issue), code);
  }
  return existing.map((issue) => {
    const code = refinedMap.get(keyOf(issue));
    if (!code) return issue;
    return { ...issue, fixSnippet: code };
  });
}
