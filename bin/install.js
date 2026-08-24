#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { logger } from '../lib/utils/logger.js';
import { FILE_PERMISSIONS, BATCH_CONSTANTS } from '../lib/utils/constants.js';
import { t } from '../lib/utils/i18n.js';
import { resolveGitHooksDir, writeGitHookFiles } from '../lib/install/git-hooks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Installer {
  constructor() {
    this.projectRoot = this.findGitRoot();
    this.reviewDir = path.join(this.projectRoot, '.smart-review');
    this.templatesDir = path.join(__dirname, '../templates');
  }

  findGitRoot() {
    let currentDir = process.cwd();
    logger.debug(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_search_git_root_dbg', { dir: currentDir }));

    for (let i = 0; i < BATCH_CONSTANTS.MAX_DIRECTORY_SEARCH_DEPTH; i++) {
      const gitDir = path.join(currentDir, '.git');
      if (fs.existsSync(gitDir)) {
        logger.success(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_found_git_root_success', { dir: currentDir }));
        return currentDir;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // 到达根目录
      }
      currentDir = parentDir;
    }

    logger.info(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_no_git_use_current'));
    return process.cwd();
  }

  async install() {
    logger.info(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_start'));

    try {
      this.createReviewDirectory();
      await this.copyTemplateFiles();
      this.ensureLogsGitignoreEntry();
      this.installGitHooks();
      this.showNextSteps();

      logger.success('\n' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_done_success'));
      logger.info(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_bundled_info'));
      logger.info(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_customize_tip'));
      
    } catch (error) {
      logger.error(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_failed', { error: error.message }));
      process.exit(1);
    }
  }

  createReviewDirectory() {
    if (!fs.existsSync(this.reviewDir)) {
      fs.mkdirSync(this.reviewDir, { recursive: true });
      logger.success(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_create_review_dir'));
    }

    // 创建AI提示词子目录（用于AI自定义提示）
    const aiPromptsDir = path.join(this.reviewDir, 'ai-rules');
    if (!fs.existsSync(aiPromptsDir)) {
      fs.mkdirSync(aiPromptsDir, { recursive: true });
      logger.success(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_create_ai_rules_dir'));
    }

    // 创建本地静态规则目录
    const localRulesDir = path.join(this.reviewDir, 'local-rules');
    if (!fs.existsSync(localRulesDir)) {
      fs.mkdirSync(localRulesDir, { recursive: true });
      logger.success(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_create_local_rules_dir'));
    }

    const skillsDir = path.join(this.reviewDir, 'skills');
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
      logger.success('创建文档型 Skills 目录: .smart-review/skills/');
    }
  }

  async copyTemplateFiles() {
    // 将模板源路径（templates 下）映射到目标路径（.smart-review 下）
    const templatesMap = [
      { src: 'smart-review.json', dest: 'smart-review.json', description: '主配置文件' },
      { src: 'rules/security.js', dest: 'local-rules/security.js', description: '安全规则' },
      { src: 'rules/performance.js', dest: 'local-rules/performance.js', description: '性能规则' },
      { src: 'rules/best-practices.js', dest: 'local-rules/best-practices.js', description: '最佳实践规则' }
    ];
    
    // 根据 locale 选择模板目录（优先 rules/<locale>/，否则回退到 rules/zh-CN/）
    const loc = await this.resolveLocale();

    for (const { src, dest, description } of templatesMap) {
      let effectiveSrc = src;
      if (src.startsWith('rules/')) {
        const fileName = path.basename(src);
        const candidateRel = path.join('rules', loc, fileName);
        const candidateAbs = path.join(this.templatesDir, candidateRel);
        const fallbackRel = path.join('rules', 'zh-CN', fileName);
        const fallbackAbs = path.join(this.templatesDir, fallbackRel);
        if (fs.existsSync(candidateAbs)) {
          effectiveSrc = candidateRel;
        } else if (fs.existsSync(fallbackAbs)) {
          effectiveSrc = fallbackRel;
        }
      }
      const templatePath = path.join(this.templatesDir, effectiveSrc);
      const targetPath = path.join(this.reviewDir, dest);

      if (fs.existsSync(templatePath) && !fs.existsSync(targetPath)) {
        // 确保目标目录存在
        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        // smart-review.json 原样复制；规则文件按 locale 生成本地化版本
        if (src === 'smart-review.json') {
          fs.copyFileSync(templatePath, targetPath);
        } else {
          try {
            const content = await this.buildLocalizedRuleModule(templatePath);
            fs.writeFileSync(targetPath, content, 'utf8');
          } catch (e) {
            // 失败时退回直接复制原模板
            fs.copyFileSync(templatePath, targetPath);
          }
        }
        logger.success(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_create_template_success', { desc: description }));
      }
    }

    this.seedDocumentSkillExamples();
  }

  seedDocumentSkillExamples() {
    const exampleSrc = path.join(this.templatesDir, 'skills', 'project-conventions.example.md');
    const skillsDir = path.join(this.reviewDir, 'skills');
    const exampleDest = path.join(skillsDir, 'project-conventions.example.md');
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
    if (fs.existsSync(exampleSrc) && !fs.existsSync(exampleDest)) {
      fs.copyFileSync(exampleSrc, exampleDest);
      logger.success('已复制文档型 Skill 示例: .smart-review/skills/project-conventions.example.md');
    }
  }

  async resolveLocale() {
    // 解析语言优先级：环境变量 > 已复制的项目配置 > 模板默认配置 > zh-CN
    let loc = process.env.SMART_REVIEW_LOCALE || '';
    if (!loc) {
      try {
        const projectCfg = path.join(this.reviewDir, 'smart-review.json');
        if (fs.existsSync(projectCfg)) {
          const cfg = JSON.parse(fs.readFileSync(projectCfg, 'utf8'));
          if (cfg && typeof cfg.locale === 'string' && cfg.locale.trim()) {
            loc = cfg.locale.trim();
          }
        }
      } catch (e) {
        // 忽略读取失败，继续尝试模板配置
      }
    }
    if (!loc) {
      try {
        const templateCfg = path.join(this.templatesDir, 'smart-review.json');
        if (fs.existsSync(templateCfg)) {
          const cfg = JSON.parse(fs.readFileSync(templateCfg, 'utf8'));
          if (cfg && typeof cfg.locale === 'string' && cfg.locale.trim()) {
            loc = cfg.locale.trim();
          }
        }
      } catch (e) {
        // 忽略读取失败
      }
    }
    if (!loc) loc = 'zh-CN';
    return loc;
  }

  async buildLocalizedRuleModule(templatePath) {
    // 解析语言优先级：环境变量 > 已复制的项目配置 > 模板默认配置 > zh-CN
    let loc = process.env.SMART_REVIEW_LOCALE || '';
    if (!loc) {
      try {
        const projectCfg = path.join(this.reviewDir, 'smart-review.json');
        if (fs.existsSync(projectCfg)) {
          const cfg = JSON.parse(fs.readFileSync(projectCfg, 'utf8'));
          if (cfg && typeof cfg.locale === 'string' && cfg.locale.trim()) {
            loc = cfg.locale.trim();
          }
        }
      } catch (e) {
        // 忽略读取失败，继续尝试模板配置
      }
    }
    if (!loc) {
      try {
        const templateCfg = path.join(this.templatesDir, 'smart-review.json');
        if (fs.existsSync(templateCfg)) {
          const cfg = JSON.parse(fs.readFileSync(templateCfg, 'utf8'));
          if (cfg && typeof cfg.locale === 'string' && cfg.locale.trim()) {
            loc = cfg.locale.trim();
          }
        }
      } catch (e) {
        // 忽略读取失败
      }
    }
    if (!loc) loc = 'zh-CN';
    const fileUrl = `file://${templatePath.replace(/\\/g, '/')}`;
    const mod = await import(fileUrl);
    const rules = Array.isArray(mod?.default) ? mod.default : (Array.isArray(mod?.rules) ? mod.rules : []);
    const localized = rules.map((r) => {
      const id = r?.id;
      if (!id) return r;
      const nameKey = `rule_${id}_name`;
      const msgKey = `rule_${id}_message`;
      const sugKey = `rule_${id}_suggestion`;
      const name = t(loc, nameKey);
      const message = t(loc, msgKey);
      const suggestion = t(loc, sugKey);
      return {
        ...r,
        name: (typeof name === 'string' && name !== nameKey) ? name : r.name,
        message: (typeof message === 'string' && message !== msgKey) ? message : r.message,
        suggestion: (typeof suggestion === 'string' && suggestion !== sugKey) ? suggestion : r.suggestion,
      };
    });
    // 生成ESM模块内容
    const json = JSON.stringify(localized, null, 2);
    return `// Generated by smart-review install (locale: ${loc})\nexport default ${json};\n`;
  }

  ensureLogsGitignoreEntry() {
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    const entry = '.smart-review/logs/';
    try {
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, `${entry}\n`, 'utf8');
        logger.success(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_gitignore_logs_added'));
        return;
      }
      const content = fs.readFileSync(gitignorePath, 'utf8');
      const lines = content.split(/\r?\n/);
      const hasEntry = lines.some((line) => {
        const trimmed = line.trim();
        return trimmed === entry || trimmed === '.smart-review/logs' || trimmed === '.smart-review/logs/**';
      });
      if (hasEntry) return;
      const suffix = content.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(gitignorePath, `${suffix}${entry}\n`, 'utf8');
      logger.success(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_gitignore_logs_added'));
    } catch (error) {
      logger.warn(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_gitignore_logs_warn', { error: error.message }));
    }
  }

  installGitHooks() {
    // 1) 检测是否存在 git 命令
    let gitAvailable = false;
    try {
      execSync('git --version', { stdio: 'ignore' });
      gitAvailable = true;
    } catch (e) {
      gitAvailable = false;
    }

    if (!gitAvailable) {
      logger.error(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_git_missing', { url: 'https://git-scm.com/downloads' }));
      process.exit(1);
    }

    // 2) 若项目未初始化为 Git 仓库，执行 git init
    const gitDir = path.join(this.projectRoot, '.git');
    // review-disable-start
    if (!fs.existsSync(gitDir)) {
      logger.warn(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_init_git_warn'));
      try {
        execSync('git init', { cwd: this.projectRoot, stdio: 'ignore' });
      } catch (e) {
        logger.error(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_init_git_failed'));
        process.exit(1);
      }
    }
    // review-disable-end

    // 3) 解析真实 hooks 目录（core.hooksPath / worktree）
    const loc = process.env.SMART_REVIEW_LOCALE || 'zh-CN';
    const gitHooksDir = resolveGitHooksDir(this.projectRoot);
    logger.debug(t(loc, 'install_hooks_dir_dbg', { path: gitHooksDir }));

    let written;
    try {
      written = writeGitHookFiles({ gitHooksDir, loc });
    } catch (error) {
      logger.error(t(loc, 'install_precommit_write_failed', { error: error.message }));
      process.exit(1);
    }

    const actionKey = {
      created: 'install_precommit_created_success',
      replaced: 'install_precommit_replaced_success',
      appended: 'install_precommit_appended_success'
    }[written.action] || 'install_precommit_installed_success';

    // 设置执行权限
    try {
      fs.chmodSync(written.preCommitHook, FILE_PERMISSIONS.EXECUTABLE);
      logger.success(t(loc, actionKey));
      logger.success(t(loc, 'install_precommit_win_helper_success'));
    } catch (error) {
      logger.warn(t(loc, 'install_precommit_perm_warn'));
      logger.success(t(loc, actionKey));
    }

    // 测试钩子是否能正常执行
    this.testHook(written.preCommitHook);
  }

  testHook(hookPath) {
    logger.info(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_test_hook'));
    
    // 检查文件是否存在且可执行
    if (!fs.existsSync(hookPath)) {
      logger.error(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_hook_missing'));
      return;
    }
    
    try {
      // 在 Windows 上无需检查可执行位，直接提示成功
      if (process.platform === 'win32') {
        logger.success(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_test_hook_success'));
        return;
      }
      const stats = fs.statSync(hookPath);
      const isExecutable = !!(stats.mode & 0o111);
      logger.debug(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_hook_perm_dbg', { mode: stats.mode.toString(8), exec: isExecutable }));
      if (!isExecutable) {
        logger.warn(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_hook_perm_fix_warn'));
        fs.chmodSync(hookPath, FILE_PERMISSIONS.EXECUTABLE);
      }
      // POSIX 环境下权限检查完成，提示成功
      logger.success(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_test_hook_success'));
    } catch (error) {
      logger.warn(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_hook_perm_check_failed', { error: error.message }));
    }
  }

  showNextSteps() {
    logger.info('\n' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_optional_header'));
    logger.info('   ' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_optional_item1'));
    logger.info('   ' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_optional_item2'));
    logger.info('   ' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_optional_item3'));
    logger.info('   ' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_optional_item4'));

    logger.info('\n' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_paths_header'));
    logger.info(`   ${path.join(this.reviewDir, 'smart-review.json')}`);
    logger.info('   ' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_local_rules_path', { path: path.join(this.reviewDir, 'local-rules/') }));
    logger.info('   ' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_ai_rules_path', { path: path.join(this.reviewDir, 'ai-rules/') }));
    
    logger.info('\n' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_test_header'));
    logger.info('   ' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_test_git_commit'));
    logger.info('   ' + t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_test_cli'));
  }
}

// 运行安装
const installer = new Installer();
(async () => { await installer.install(); })();
