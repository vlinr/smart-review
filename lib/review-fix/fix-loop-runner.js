import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { applyFixes, issueKey } from './fix-applier.js';
import { ReviewFixEngine } from './review-fix.js';
import { logger } from '../utils/logger.js';
import { t } from '../utils/i18n.js';

const execAsync = promisify(exec);

export class FixLoopRunner {
  constructor({ reviewer, config }) {
    this.reviewer = reviewer;
    this.config = config;
    this.fixEngine = new ReviewFixEngine({
      config: config?.ai || config,
      tForAI: (key, params) => t({ locale: 'en-US' }, key, params)
    });
    this.stats = { applied: 0, failed: 0, rounds: 0, reReviewed: false };
  }

  async run() {
    const filePaths = [...new Set(
      this.reviewer.issues
        .filter((issue) => issue.source === 'ai' && issue.file)
        .map((issue) => issue.file)
    )];
    const applyCfg = this.fixEngine.resolveApplyConfig('batch', filePaths);
    if (!applyCfg.autoApply) return this.stats;

    const applicable = this.fixEngine.filterApplicableIssues(this.reviewer.issues, applyCfg);
    if (applicable.length === 0) return this.stats;

    logger.info(t(this.config, 'fix_apply_start', { count: applicable.length }));

    for (let round = 1; round <= applyCfg.maxApplyRounds; round++) {
      if (this.reviewer.isCancelled()) break;
      this.stats.rounds = round;

      const pending = this.fixEngine.filterApplicableIssues(this.reviewer.issues, applyCfg);
      if (pending.length === 0) break;

      const result = await applyFixes(pending, this.config.projectRoot, {
        dryRun: applyCfg.dryRun,
        fs,
        path
      });

      for (const item of result.applied) {
        logger.success(t(this.config, 'fix_apply_ok', {
          file: path.relative(this.config.projectRoot, item.issue.file),
          method: item.method
        }));
        this.stats.applied += 1;
      }
      for (const item of result.failed) {
        logger.warn(t(this.config, 'fix_apply_failed', {
          file: path.relative(this.config.projectRoot, item.issue.file || ''),
          reason: item.reason
        }));
        this.stats.failed += 1;
      }

      if (result.applied.length === 0) break;

      const appliedKeys = new Set(result.applied.map((item) => issueKey(item.issue)));
      this.reviewer.issues = this.reviewer.issues.filter((issue) => !appliedKeys.has(issueKey(issue)));

      if (applyCfg.dryRun) {
        logger.info(t(this.config, 'fix_apply_dry_run'));
        break;
      }

      if (applyCfg.autoStage && result.files.length > 0) {
        await this.stageFiles(result.files);
      }

      if (!applyCfg.reReviewAfterApply) break;

      logger.info(t(this.config, 'fix_re_review_start', { count: result.files.length }));
      await this.reviewer.reReviewFilesAfterFix(result.files);
      this.stats.reReviewed = true;
    }

    if (this.stats.applied > 0) {
      logger.info(t(this.config, 'fix_apply_done', {
        applied: this.stats.applied,
        failed: this.stats.failed,
        rounds: this.stats.rounds
      }));
    }

    return this.stats;
  }

  async stageFiles(files) {
    for (const file of files) {
      const rel = path.relative(this.config.projectRoot, file).replace(/\\/g, '/');
      try {
        await execAsync(`git add -- "${rel}"`, { cwd: this.config.projectRoot });
        logger.debug(t(this.config, 'fix_auto_staged', { file: rel }));
      } catch (error) {
        logger.warn(t(this.config, 'fix_auto_stage_failed', { file: rel, error: error?.message || String(error) }));
      }
    }
  }
}
