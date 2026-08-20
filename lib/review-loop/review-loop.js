import { matchRoute } from '../review-skills/path-utils.js';

const HIGH_RISKS = new Set(['critical', 'high']);

export class ReviewLoopEngine {
  constructor({ config, tForAI }) {
    this.config = config;
    this.tForAI = tForAI;
  }

  resolveConfig(mode, filePaths = []) {
    const loop = this.config?.loop || {};
    const normalizedMode = String(mode || '').toLowerCase();
    const globallyEnabled = loop.enabled === true;
    const routes = Array.isArray(loop.routes) ? loop.routes : [];
    const routeHit = routes.length > 0 && routes.some((route) => matchRoute(normalizedMode, filePaths, route));
    const enabled = globallyEnabled || routeHit;
    return {
      enabled,
      maxRounds: Math.max(1, Number(loop.maxRounds || 2)),
      maxToolCallsPerReview: Math.max(1, Number(loop.maxToolCallsPerReview || 6)),
      continueOnHighRisk: loop.continueOnHighRisk !== false,
      stopOnNoNewIssues: loop.stopOnNoNewIssues !== false
    };
  }

  buildIntroPrompt(loopCfg) {
    if (!loopCfg.enabled || loopCfg.maxRounds <= 1) return '';
    return [
      this.tForAI('loop_intro_header'),
      this.tForAI('loop_intro_budget', { maxRounds: loopCfg.maxRounds }),
      this.tForAI('loop_intro_decision'),
      this.tForAI('loop_intro_stop_hint')
    ].join('\n');
  }

  buildContinuationPrompt(round, issues = [], loopCfg) {
    const summary = this.summarizeIssues(issues);
    return [
      this.tForAI('loop_continue_header', { round, maxRounds: loopCfg.maxRounds }),
      this.tForAI('loop_continue_instruction'),
      summary ? `${this.tForAI('loop_continue_prev_issues')}\n${summary}` : this.tForAI('loop_continue_no_prev'),
      this.tForAI('loop_continue_decision')
    ].join('\n\n');
  }

  summarizeIssues(issues = []) {
    if (!Array.isArray(issues) || issues.length === 0) return '';
    return issues.slice(0, 12).map((issue, idx) => {
      const risk = issue.risk || 'suggestion';
      const message = String(issue.message || '').trim().slice(0, 160);
      const file = String(issue.file || '').trim();
      return `${idx + 1}. [${risk}] ${file} - ${message}`;
    }).join('\n');
  }

  extractLoopDecision(content) {
    const text = String(content || '');
    const match = text.match(/\[LOOP_DECISION\](continue|stop)\[\/LOOP_DECISION\]/i);
    if (!match) return null;
    return String(match[1]).toLowerCase();
  }

  shouldContinue({ content, issues, round, addedCount, loopCfg }) {
    if (!loopCfg.enabled) return false;
    if (round >= loopCfg.maxRounds) return false;

    const decision = this.extractLoopDecision(content);
    if (decision === 'stop') return false;
    if (decision === 'continue') return true;

    if (round === 1 && loopCfg.continueOnHighRisk) {
      const hasHigh = (issues || []).some((issue) => HIGH_RISKS.has(String(issue.risk || '').toLowerCase()));
      if (hasHigh) return true;
    }

    if (round > 1 && loopCfg.stopOnNoNewIssues && addedCount <= 0) {
      return false;
    }

    return false;
  }
}

export function mergeLoopIssues(existing = [], incoming = []) {
  const merged = [...existing];
  const keyOf = (issue) => {
    const file = String(issue.file || '').trim();
    const snippet = String(issue.snippet || '').trim().slice(0, 200);
    const message = String(issue.message || '').trim().slice(0, 120);
    return `${file}::${snippet || message}`;
  };
  const seen = new Set(merged.map(keyOf));
  for (const issue of incoming) {
    const key = keyOf(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(issue);
  }
  return merged;
}
