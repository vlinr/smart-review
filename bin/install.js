#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { logger } from '../lib/utils/logger.js';
import { FILE_PERMISSIONS, BATCH_CONSTANTS } from '../lib/utils/constants.js';

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
    logger.debug(`查找Git根目录，从 ${currentDir} 开始...`);

    for (let i = 0; i < BATCH_CONSTANTS.MAX_DIRECTORY_SEARCH_DEPTH; i++) {
      const gitDir = path.join(currentDir, '.git');
      if (fs.existsSync(gitDir)) {
        logger.success(`找到Git根目录: ${currentDir}`);
        return currentDir;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // 到达根目录
      }
      currentDir = parentDir;
    }

    logger.info('ℹ️  未找到.git目录，使用当前目录作为项目根目录');
    return process.cwd();
  }

  install() {
    logger.info('🚀 开始安装智能代码审查系统...');

    try {
      this.createReviewDirectory();
      this.copyTemplateFiles();
      this.installGitHooks();
      this.showNextSteps();

      logger.success('\n🎉 智能代码审查系统安装完成！');
      logger.info('💡 系统已内置默认配置和规则，无需额外配置即可使用');
      logger.info('📝 如需自定义，请编辑 .smart-review/ 目录下的配置文件');
      
    } catch (error) {
      logger.error('安装失败:', error);
      process.exit(1);
    }
  }

  createReviewDirectory() {
    if (!fs.existsSync(this.reviewDir)) {
      fs.mkdirSync(this.reviewDir, { recursive: true });
      logger.success('创建 .smart-review 目录');
    }

    // 创建AI提示词子目录（用于AI自定义提示）
    const aiPromptsDir = path.join(this.reviewDir, 'ai-rules');
    if (!fs.existsSync(aiPromptsDir)) {
      fs.mkdirSync(aiPromptsDir, { recursive: true });
      logger.success('创建 ai-rules 子目录（AI提示词）');
    }

    // 创建本地静态规则目录
    const localRulesDir = path.join(this.reviewDir, 'local-rules');
    if (!fs.existsSync(localRulesDir)) {
      fs.mkdirSync(localRulesDir, { recursive: true });
      logger.success('创建 local-rules 子目录（静态规则）');
    }
  }

  copyTemplateFiles() {
    // 将模板源路径（templates 下）映射到目标路径（.smart-review 下）
    const templatesMap = [
      { src: 'smart-review.json', dest: 'smart-review.json', description: '主配置文件' },
      { src: 'rules/security.js', dest: 'local-rules/security.js', description: '安全规则' },
      { src: 'rules/performance.js', dest: 'local-rules/performance.js', description: '性能规则' },
      { src: 'rules/best-practices.js', dest: 'local-rules/best-practices.js', description: '最佳实践规则' }
    ];

    for (const { src, dest, description } of templatesMap) {
      const templatePath = path.join(this.templatesDir, src);
      const targetPath = path.join(this.reviewDir, dest);

      if (fs.existsSync(templatePath) && !fs.existsSync(targetPath)) {
        // 确保目标目录存在
        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        fs.copyFileSync(templatePath, targetPath);
        logger.success(`创建 ${description}`);
      }
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
      logger.error('未检测到 Git，请先安装后重试： https://git-scm.com/downloads');
      process.exit(1);
    }

    // 2) 若项目未初始化为 Git 仓库，执行 git init
    const gitDir = path.join(this.projectRoot, '.git');
    // review-disable-start
    if (!fs.existsSync(gitDir)) {
      logger.warn('未检测到 .git 目录，正在初始化 Git 仓库...');
      try {
        execSync('git init', { cwd: this.projectRoot, stdio: 'ignore' });
      } catch (e) {
        logger.error('Git 仓库初始化失败，请手动执行 `git init` 后重试');
        process.exit(1);
      }
    }
    // review-disable-end

    // 3) 确保 hooks 目录存在
    const gitHooksDir = path.join(gitDir, 'hooks');
    // review-disable-start
    if (!fs.existsSync(gitHooksDir)) {
      fs.mkdirSync(gitHooksDir, { recursive: true });
    }
    // review-disable-end

    const preCommitHook = path.join(gitHooksDir, 'pre-commit');
    
    const hookContent = `#!/bin/bash
# 智能代码审查 - pre-commit钩子（子项目兼容，基于暂存文件逐层定位）

echo "🔍 启动代码审查..."

# 获取暂存区文件
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
  echo "📭 没有暂存的文件需要审查"
  exit 0
fi

echo "📁 发现暂存文件:"
echo "$STAGED_FILES"

# 运行代码审查（定位到仓库根目录）
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT" || { echo "❌ 无法进入仓库根目录"; exit 1; }

# 优先使用仓库根目录安装的 CLI
ROOT_BIN="$REPO_ROOT/node_modules/.bin/smart-review"

FOUND_CMD=""
FOUND_IS_ENTRY=0

if [ -f "$ROOT_BIN" ]; then
  FOUND_CMD="$ROOT_BIN"
else
  # 基于暂存文件的路径，逐层向上查找其子项目的 node_modules
  # 限制最大向上层级，避免卡住
  MAX_ASCEND=6
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    dir=$(dirname "$file")
    depth=0
    while [ "$dir" != "." ] && [ $depth -lt $MAX_ASCEND ]; do
      candidate_bin="$REPO_ROOT/$dir/node_modules/.bin/smart-review"
      candidate_entry="$REPO_ROOT/$dir/node_modules/smart-review/bin/review.js"
      if [ -f "$candidate_bin" ]; then
        FOUND_CMD="$candidate_bin"; FOUND_IS_ENTRY=0; break 2
      elif [ -f "$candidate_entry" ]; then
        FOUND_CMD="$candidate_entry"; FOUND_IS_ENTRY=1; break 2
      fi
      dir=$(dirname "$dir")
      depth=$((depth + 1))
    done
  done <<< "$STAGED_FILES"
fi

# 额外兜底：PATH 中的全局 smart-review
if [ -z "$FOUND_CMD" ] && command -v smart-review >/dev/null 2>&1; then
  FOUND_CMD="smart-review"; FOUND_IS_ENTRY=0
fi

if [ -z "$FOUND_CMD" ]; then
  echo "❌ 未找到 smart-review。请在对应子项目安装：npm i -D smart-review"
  echo "   或在仓库根安装供统一使用：npm i -D smart-review"
  exit 1
fi

echo "⚙️  使用命令: $FOUND_CMD --staged"
if [ $FOUND_IS_ENTRY -eq 1 ]; then
  node "$FOUND_CMD" --staged
else
  "$FOUND_CMD" --staged
fi

EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo "❌ 代码审查未通过，请修复问题后重新提交"
  exit 1
else
  echo "✅ 代码审查通过，继续提交"
  exit 0
fi
`;

    fs.writeFileSync(preCommitHook, hookContent);
    
    // 设置执行权限
    try {
      fs.chmodSync(preCommitHook, FILE_PERMISSIONS.EXECUTABLE);
      logger.success('安装 pre-commit Git钩子');
    } catch (error) {
      logger.warn('无法设置执行权限，但钩子文件已创建');
    }
    
    // 测试钩子是否能正常执行
    this.testHook(preCommitHook);
  }

  testHook(hookPath) {
    logger.info('🧪 测试Git钩子...');
    
    // 检查文件是否存在且可执行
    if (!fs.existsSync(hookPath)) {
      logger.error('钩子文件不存在');
      return;
    }
    
    try {
      const stats = fs.statSync(hookPath);
      const isExecutable = !!(stats.mode & 0o111);
      logger.debug(`钩子文件权限: ${stats.mode.toString(8)}, 可执行: ${isExecutable}`);
      
      if (!isExecutable) {
        logger.warn('钩子文件不可执行，尝试重新设置权限...');
        fs.chmodSync(hookPath, FILE_PERMISSIONS.EXECUTABLE);
      }
    } catch (error) {
      logger.warn('无法检查钩子文件权限:', error.message);
    }
  }

  showNextSteps() {
    logger.info('\n📝 可选配置:');
    logger.info('   1. 编辑 .smart-review/smart-review.json 配置AI参数和风险等级');
    logger.info('   2. 在 .smart-review/local-rules/ 目录添加静态规则文件');
    logger.info('   3. 在 .smart-review/ai-rules/ 目录添加AI提示词文件');
    logger.info('   4. 设置 OPENAI_API_KEY 环境变量启用AI审查');
    logger.info('\n⚙️  配置文件位置:');
    logger.info(`   ${path.join(this.reviewDir, 'smart-review.json')}`);
    logger.info(`   静态规则: ${path.join(this.reviewDir, 'local-rules/')}`);
    logger.info(`   AI提示词: ${path.join(this.reviewDir, 'ai-rules/')}`);
    
    logger.info('\n🔧 测试命令:');
    logger.info('   git add . && git commit -m "test"  # 测试提交触发审查');
    logger.info('   npx smart-review --files test/src/test-file.js  # 手动测试审查（使用项目内CLI）');
  }
}

// 运行安装
const installer = new Installer();
installer.install();