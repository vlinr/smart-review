import { SkillCatalog, extractSkillSelection, selectedIncludesDocumentSkill } from './skill-catalog.js';
import { shouldRejectForSelfCheck } from '../review-tools/output-self-check.js';
import { isNoIssueText } from '../review-tools/output-continue.js';

export class ReviewSkillResolver {
  constructor({ config, reviewDir, packageRoot, tForAI, extractFinalReviewContent }) {
    this.config = config;
    this.extractFinalReviewContent = extractFinalReviewContent;
    this.catalog = new SkillCatalog({ config, reviewDir, packageRoot, tForAI });
  }

  buildSkillContext(mode, filePaths = []) {
    const cfg = this.catalog.getConfig();
    if (!cfg.enabled) {
      return {
        enabled: false,
        mode,
        catalogIds: [],
        preSelectedIds: [],
        selectedIds: [],
        outlinePrompt: '',
        selectedBodiesPrompt: '',
        prompt: '',
        strict: false,
        enableTraceTools: false,
        skipSelectionRound: false
      };
    }

    const normalizedPaths = (filePaths || []).map((p) => String(p || '').replace(/\\/g, '/'));
    const preSelectedIds = this.catalog.resolvePreSelectedIds(mode, normalizedPaths);
    const catalogIds = this.catalog.listRelevantEntries(mode, normalizedPaths).map((entry) => entry.id);
    const outlinePrompt = this.catalog.buildOutlinePrompt(mode, normalizedPaths, preSelectedIds);
    const selectedBodiesPrompt = this.catalog.buildSelectedBodiesPrompt(preSelectedIds);
    const strict = preSelectedIds.includes('evidence-enforcer') || preSelectedIds.includes('evidence-trace');
    const enableTraceTools = strict && this.config?.tools?.enabled !== false;
    const skipSelectionRound = preSelectedIds.length > 0;

    const promptParts = [outlinePrompt, selectedBodiesPrompt].filter(Boolean);
    return {
      enabled: true,
      mode,
      filePaths: normalizedPaths,
      catalogIds,
      preSelectedIds,
      selectedIds: [...preSelectedIds],
      outlinePrompt,
      selectedBodiesPrompt,
      prompt: promptParts.join('\n\n'),
      strict,
      enableTraceTools,
      skipSelectionRound
    };
  }

  extractSkillSelection(content) {
    return extractSkillSelection(content);
  }

  buildSelectedSkillsPrompt(selectedIds = []) {
    return this.catalog.buildSelectedBodiesPrompt(selectedIds);
  }

  needsDocumentBodies(selectedIds = []) {
    return selectedIncludesDocumentSkill(selectedIds, this.catalog);
  }

  validateSkillResponse(content, skillContext) {
    if (!skillContext || !skillContext.strict) return true;
    const text = this.extractFinalReviewContent(content);
    if (!text) return true;
    // Programmatic structure gate (no AI self-review of findings).
    if (shouldRejectForSelfCheck(content, {
      extractFinalReviewContent: (c) => this.extractFinalReviewContent(c),
      isNoIssueText
    })) {
      return false;
    }
    if (isNoIssueText(text)) return true;
    const markerRegexes = [
      /\*\*-----代码分析结果开始-----\*\*([\s\S]*?)\*\*-----代码分析结果结束-----\*\*/g,
      /\*\*-----Git Diff代码分析结果开始-----\*\*([\s\S]*?)\*\*-----Git Diff代码分析结果结束-----\*\*/g,
      /\*\*-----Code Analysis Result Start-----\*\*([\s\S]*?)\*\*-----Code Analysis Result End-----\*\*/g,
      /\*\*-----Git Diff Code Analysis Result Start-----\*\*([\s\S]*?)\*\*-----Git Diff Code Analysis Result End-----\*\*/g
    ];
    let blocks = [];
    for (const re of markerRegexes) {
      const matches = Array.from(text.matchAll(re));
      if (matches.length > 0) {
        blocks.push(...matches.map((m) => String(m[1] || '').trim()).filter(Boolean));
      }
    }
    if (blocks.length === 0) {
      // Prefer 问题N / Issue N slices; do not treat every blank-line paragraph as an issue.
      const byProblem = text.split(/\n(?=问题\d+[:：]|Issue\s*\d+[:：]?)/i).map((b) => b.trim()).filter(Boolean);
      blocks = byProblem.length > 1 || /^问题\d+[:：]|^Issue\s*\d+/im.test(text)
        ? byProblem
        : text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    }
    const hasRequiredFields = (blockText) => {
      const hasSnippet = /(代码片段|Snippet|Lsnippet|```)/i.test(blockText);
      const hasReason = /(风险原因|Reason|Lreason)/i.test(blockText);
      const hasSuggestion = /(修改建议|Suggestion|Lsuggestion)/i.test(blockText);
      return hasSnippet && hasReason && hasSuggestion;
    };
    const issueBlocks = blocks.filter((blockText) => (
      /^问题\d+[:：]|^Issue\s*\d+/im.test(blockText)
      || /\*\*-----/.test(blockText)
      || /(代码片段|Snippet|风险原因|Reason|修改建议|Suggestion)/i.test(blockText)
    ));
    // Pass when at least one complete issue exists. Requiring EVERY paragraph to be
    // complete caused false rejects (and AI rewrites that dropped findings).
    if (issueBlocks.some(hasRequiredFields)) return true;
    if (issueBlocks.length > 0) return false;
    return true;
  }

  buildSkillCorrectionPrompt(skillContext) {
    const ids = skillContext?.selectedIds?.length
      ? skillContext.selectedIds
      : (skillContext?.preSelectedIds?.length ? skillContext.preSelectedIds : (skillContext?.catalogIds || []));
    return this.catalog.dimensions.buildCorrectionPrompt(ids);
  }
}

export { extractSkillSelection };
