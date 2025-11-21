#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import { CodeReviewer } from '../lib/reviewer.js';
import { ConfigLoader } from '../lib/config-loader.js';
import { logger } from '../lib/utils/logger.js';
import { BATCH_CONSTANTS } from '../lib/utils/constants.js';

class ReviewCLI {
  constructor() {
    this.projectRoot = this.findProjectRoot();
  }

  findProjectRoot() {
    let currentDir = process.cwd();
    // 静默查找项目根目录，优先 .smart-review 其次 .git
    for (let i = 0; i < BATCH_CONSTANTS.MAX_DIRECTORY_SEARCH_DEPTH; i++) {
      if (fs.existsSync(path.join(currentDir, '.smart-review'))) {
        return currentDir;
      }
      if (fs.existsSync(path.join(currentDir, '.git'))) {
        return currentDir;
      }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
    return process.cwd();
  }

  async run() {
    const args = process.argv.slice(2);
    
    try {
      logger.progress('代码审查启动中，请等待...');
      // 加载配置
      const configLoader = new ConfigLoader(this.projectRoot);
      const config = await configLoader.loadConfig();
      
      // 调试日志开关（命令行）
      if (args.includes('--debug')) {
        logger.debugMode = true;
        logger.info('通过命令行参数启用调试日志模式');
      }

      // 处理AI相关的命令行参数
      if (args.includes('--no-ai')) {
        config.ai = { ...config.ai, enabled: false };
        logger.info('通过命令行参数禁用AI分析');
      } else if (args.includes('--ai')) {
        config.ai = { ...config.ai, enabled: true };
        logger.info('通过命令行参数启用AI分析');
      }
      
      // 处理Git Diff审查相关参数
      if (args.includes('--diff-only')) {
        config.ai = { ...config.ai, reviewOnlyChanges: true };
        logger.info('通过命令行参数启用Git Diff增量审查模式');
      }
      
      const rules = await configLoader.loadRules(config);
      // 创建审查器
      const reviewer = new CodeReviewer(config, rules);
      
      let result;
      if (args.includes('--staged')) {
        result = await reviewer.reviewStagedFiles();
      } else if (args.includes('--files')) {
        const filesIndex = args.indexOf('--files');
        const fileList = args[filesIndex + 1]?.split(',').map(f => f.trim()) || [];
        result = await reviewer.reviewSpecificFiles(fileList);
      } else {
        logger.info('使用方法:');
        logger.info('  npx smart-code-reviewer --staged    # 审查暂存区文件');
        logger.info('  npx smart-code-reviewer --staged --diff-only  # 仅审查暂存区变动内容(git diff)');
        logger.info('  npx smart-code-reviewer --files file1,file2  # 审查指定文件');
        process.exit(1);
      }
      
      this.printResults(result);
      process.exit(result.blockSubmission ? 1 : 0);
      
    } catch (error) {
      logger.error('审查执行失败:', error);
      process.exit(1);
    }
  }

  printResults(result) {
    const staticIssues = result.issues.filter(i => i.source === 'static');
    const aiIssues = result.issues.filter(i => i.source === 'ai');
    // 本地规则审查结果
    logger.info('\n本地规则审查结果');
    const staticByFile = this.groupIssuesByFile(staticIssues);
      if (staticIssues.length === 0) {
        logger.info('无');
      } else {
        Object.entries(staticByFile).forEach(([file, issues]) => {
          logger.info(`\n文件: ${file}`);
          // 根据行号排序，保证位置从上到下
          const getLineKey = (i) => {
            const s = Number(i.lineStart);
            const single = Number(i.line);
            const e = Number(i.lineEnd);
            if (Number.isFinite(s) && s > 0) return s;
            if (Number.isFinite(single) && single > 0) return single;
            if (Number.isFinite(e) && e > 0) return e;
            return Number.POSITIVE_INFINITY;
          };
          const sorted = [...issues].sort((a, b) => getLineKey(a) - getLineKey(b));
          sorted.forEach((issue, index) => {
            logger.info(`\n问题${index + 1}:`);
            const locationLabel = this.formatLocationLabel(issue);
            if (locationLabel) logger.info(locationLabel);
            // 美化代码片段输出：去除行号前缀并统一缩进
            if (issue.snippet && issue.snippet.trim().length > 0) {
              logger.info('代码片段：');
              logger.info(this.formatSnippet(issue.snippet));
            } else {
              logger.info('代码片段：(全局性问题)');
            }
            logger.info(`风险等级：${this.getRiskLevelText(issue.risk)}`);
            logger.info(`风险原因：${issue.message}`);
            if (issue.suggestion) logger.info(`修改建议：${issue.suggestion}`);
          });
        });
      }

    // AI代码分析结果（若有）
    if (result.aiRan) {
      logger.info('\nAI代码分析结果');
      // 说明：行号可能不连续是预处理所致（剥离注释/无需审查片段），请忽略行号跳跃
      logger.info('提示：片段行号为源文件绝对行号，因清洗注释/无需审查片段可能出现跳跃，请忽略行号不连续。');
      // 去重：按 file+line+message 进行去重，避免重复输出
      // 打印时不再对 AI 结果做粗略去重（聚合逻辑已在 reviewer.generateResult 中完成），仅分文件展示
      const aiByFile = this.groupIssuesByFile(aiIssues);
      if (aiIssues.length === 0) {
        logger.info('无');
      } else {
        Object.entries(aiByFile).forEach(([file, issues]) => {
          logger.info(`\n文件: ${file}`);
          // 根据行号排序：起始行号优先，其次单行号；无行号的排后
          const getLineKey = (i) => {
            const s = Number(i.lineStart);
            const single = Number(i.line);
            const e = Number(i.lineEnd);
            if (Number.isFinite(s) && s > 0) return s;
            if (Number.isFinite(single) && single > 0) return single;
            if (Number.isFinite(e) && e > 0) return e;
            return Number.POSITIVE_INFINITY;
          };
          const sorted = [...issues].sort((a, b) => getLineKey(a) - getLineKey(b));
          sorted.forEach((issue, index) => {
            logger.info(`\n问题${index + 1}:`);
            const locationLabel = this.formatLocationLabel(issue);
            if (locationLabel) logger.info(locationLabel);
            // 美化代码片段输出：去除行号前缀并统一缩进
            if (issue.snippet && issue.snippet.trim().length > 0) {
              logger.info('代码片段：');
              logger.info(this.formatSnippet(issue.snippet));
            } else {
              logger.info('代码片段：(全局性问题)');
            }
            logger.info(`风险等级：${this.getRiskLevelText(issue.risk)}`);
            logger.info(`风险原因：${issue.message}`);
            if (issue.suggestion) logger.info(`修改建议：${issue.suggestion}`);
          });
        });
      }
    }
  }

  groupIssuesByFile(issues) {
    return issues.reduce((groups, issue) => {
      // 确保 issue.file 存在且为字符串
      if (!issue.file || typeof issue.file !== 'string') {
        logger.warn('发现无效的问题对象，缺少有效的文件路径:', issue);
        return groups;
      }
      
      const relativePath = path.relative(this.projectRoot, issue.file);
      if (!groups[relativePath]) {
        groups[relativePath] = [];
      }
      groups[relativePath].push(issue);
      return groups;
    }, {});
  }

  getRiskLevelText(risk) {
    const levels = {
      'critical': '致命',
      'high': '高危', 
      'medium': '中危',
      'low': '低危',
      'suggestion': '建议'
    };
    return levels[risk] || risk;
  }

  // 位置标签：范围为“行号范围：start-end”，单行为“行号：n”
  formatLocationLabel(issue) {
    const start = Number(issue.lineStart);
    const end = Number(issue.lineEnd);
    const single = Number(issue.line);
    if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) {
      if (start === end) return `行号：${start}`;
      return `行号范围：${start}-${end}`;
    }
    if (Number.isFinite(single) && single > 0) {
      return `行号：${single}`;
    }
    return '';
  }

  // 美化代码片段：
  // - 去除开头的 [n] 行号标记
  // - 去除片段前后的空行并合并连续空行
  // - 按第一行的缩进等比例裁剪，保持代码梯度
  // - 统一前置两空格缩进以便阅读
  formatSnippet(snippet) {
    if (!snippet || typeof snippet !== 'string') return '';
    const lines = snippet.split('\n').map(line => line.replace(/^\s*[+ ]?\[(\d+)\]\s?/, ''));
    // 去除片段前后的空行
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    // 合并连续空行
    const compact = [];
    let prevBlank = false;
    for (const line of lines) {
      const isBlank = line.trim() === '';
      if (isBlank) {
        if (!prevBlank) compact.push('');
        prevBlank = true;
      } else {
        compact.push(line);
        prevBlank = false;
      }
    }
    // 以第一行非空的缩进作为基准，等比例裁剪
    const firstNonEmpty = compact.find(l => l.trim() !== '') || '';
    const baseIndent = (firstNonEmpty.match(/^[\t ]*/)?.[0]?.length) || 0;
    const normalized = compact.map(l => {
      const thisIndent = (l.match(/^[\t ]*/)?.[0]?.length) || 0;
      const removeLen = Math.min(baseIndent, thisIndent);
      return l.slice(removeLen);
    });
    // 统一两空格缩进
    return normalized.map(l => `  ${l}`).join('\n');
  }
}

// 运行审查
const cli = new ReviewCLI();
cli.run().catch(error => logger.error('CLI运行失败:', error));
