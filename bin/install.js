#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { logger } from '../lib/utils/logger.js';
import { FILE_PERMISSIONS, BATCH_CONSTANTS } from '../lib/utils/constants.js';
import { t } from '../lib/utils/i18n.js';

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

    // 3) 确保 hooks 目录存在
    const gitHooksDir = path.join(gitDir, 'hooks');
    // review-disable-start
    if (!fs.existsSync(gitHooksDir)) {
      fs.mkdirSync(gitHooksDir, { recursive: true });
    }
    // review-disable-end

    const preCommitHook = path.join(gitHooksDir, 'pre-commit');
    
    const loc = process.env.SMART_REVIEW_LOCALE || 'zh-CN';
    const hookContent = `#!/usr/bin/env bash
# ${t(loc, 'hook_header_comment')}

echo "${t(loc, 'hook_start_review')}"

trap 'echo "${t(loc, 'interrupt_cancelled')}"; exit 0' INT TERM

# 获取暂存区文件
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
  echo "${t(loc, 'hook_no_staged')}"
  exit 0
fi

echo "${t(loc, 'hook_found_staged_header')}"
echo "$STAGED_FILES"

# 运行代码审查（定位到仓库根目录）
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT" || { echo "${t(loc, 'hook_cd_repo_fail')}"; exit 1; }

ROOT_BIN="$REPO_ROOT/node_modules/.bin/smart-review"

FOUND_CMD=""
FOUND_IS_ENTRY=0
FOUND_ENTRY_CMD=""

if [ -f "$ROOT_BIN" ]; then
  FOUND_CMD="$ROOT_BIN"
  ROOT_ENTRY="$REPO_ROOT/node_modules/smart-review/bin/review.js"
  if [ -f "$ROOT_ENTRY" ]; then
    FOUND_ENTRY_CMD="$ROOT_ENTRY"
  fi
else
  MAX_ASCEND=6
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    dir=$(dirname "$file")
    depth=0
    while [ "$dir" != "." ] && [ $depth -lt $MAX_ASCEND ]; do
      candidate_bin="$REPO_ROOT/$dir/node_modules/.bin/smart-review"
      candidate_entry="$REPO_ROOT/$dir/node_modules/smart-review/bin/review.js"
      if [ -f "$candidate_bin" ]; then
        FOUND_CMD="$candidate_bin"; FOUND_IS_ENTRY=0;
        if [ -f "$candidate_entry" ]; then
          FOUND_ENTRY_CMD="$candidate_entry"
        fi
        break 2
      elif [ -f "$candidate_entry" ]; then
        FOUND_CMD="$candidate_entry"; FOUND_IS_ENTRY=1; FOUND_ENTRY_CMD="$candidate_entry"; break 2
      fi
      dir=$(dirname "$dir")
      depth=$((depth + 1))
    done
  done <<< "$STAGED_FILES"
fi

if [ -z "$FOUND_CMD" ] && command -v smart-review >/dev/null 2>&1; then
  FOUND_CMD="smart-review"; FOUND_IS_ENTRY=0
fi

if [ -z "$FOUND_CMD" ]; then
  echo "${t(loc, 'hook_cmd_not_found1')}"
  echo "${t(loc, 'hook_cmd_not_found2')}"
  echo "${t(loc, 'hook_cmd_missing_continue')}"
  # 未安装 smart-review，跳过自动审查但不阻断提交
  exit 0
fi

echo "${t(loc, 'hook_use_command_prefix')} $FOUND_CMD --staged"
USE_WINPTY=0
if command -v uname >/dev/null 2>&1; then
  KERNEL=$(uname -s)
else
  KERNEL=""
fi
IS_MSYS=0
if [[ "$KERNEL" == MINGW* || "$KERNEL" == MSYS* || -n "$MSYSTEM" ]]; then
  IS_MSYS=1
fi
HAS_TTY=0
if [ -t 0 ] || [ -t 1 ]; then
  HAS_TTY=1
fi
TTY_DEVICE=""
if [ $HAS_TTY -eq 1 ] && [ -r /dev/tty ]; then
  TTY_DEVICE="/dev/tty"
elif [ $HAS_TTY -eq 1 ] && [ -r "CONIN$" ]; then
  TTY_DEVICE="CONIN$"
elif [ -r /dev/tty ]; then
  TTY_DEVICE="/dev/tty"
elif [ -r "CONIN$" ]; then
  TTY_DEVICE="CONIN$"
fi
if [ -n "$TTY_DEVICE" ]; then
  export SMART_REVIEW_TTY="$TTY_DEVICE"
fi
if [ $IS_MSYS -eq 1 ] && [ $HAS_TTY -eq 1 ]; then
  if command -v winpty >/dev/null 2>&1; then
    USE_WINPTY=1
  fi
fi
run_direct() {
  if [ $USE_WINPTY -eq 1 ]; then
    if [ -n "$FOUND_ENTRY_CMD" ]; then
      winpty node "$FOUND_ENTRY_CMD" --staged
    else
      winpty "$FOUND_CMD" --staged
    fi
  else
    if [ -n "$FOUND_ENTRY_CMD" ]; then
      node "$FOUND_ENTRY_CMD" --staged
    else
      "$FOUND_CMD" --staged
    fi
  fi
}
run_with_device() {
  if [ -n "$TTY_DEVICE" ]; then
    "$@" < "$TTY_DEVICE"
  else
    "$@"
  fi
}
TMP_ERR=""
if command -v mktemp >/dev/null 2>&1; then
  TMP_ERR=$(mktemp -t smart-review-err.XXXXXX)
else
  TMP_ERR="/tmp/smart-review-err-$$"
fi
run_direct 2> "$TMP_ERR"
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ] && [ -s "$TMP_ERR" ] && grep -qi "stdin is not a tty" "$TMP_ERR"; then
  if [ $USE_WINPTY -eq 1 ]; then
    if [ -n "$FOUND_ENTRY_CMD" ]; then
      run_with_device winpty node "$FOUND_ENTRY_CMD" --staged
    else
      run_with_device winpty "$FOUND_CMD" --staged
    fi
  else
    if [ -n "$FOUND_ENTRY_CMD" ]; then
      run_with_device node "$FOUND_ENTRY_CMD" --staged
    else
      run_with_device "$FOUND_CMD" --staged
    fi
  fi
  EXIT_CODE=$?
fi
rm -f "$TMP_ERR"
if [ $EXIT_CODE -eq 130 ] || [ $EXIT_CODE -eq 143 ]; then
  echo "${t(loc, 'interrupt_cancelled')}"
  exit 0
fi
if [ $EXIT_CODE -ne 0 ]; then
  echo "${t(loc, 'hook_review_fail')}"
  exit 1
else
  echo "${t(loc, 'hook_review_pass')}"
  exit 0
fi
`;

    fs.writeFileSync(preCommitHook, hookContent);
    const escapeCmdText = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const cmdMessages = {
      start: escapeCmdText(t(loc, 'hook_start_review')),
      noStaged: escapeCmdText(t(loc, 'hook_no_staged')),
      foundHeader: escapeCmdText(t(loc, 'hook_found_staged_header')),
      cdFail: escapeCmdText(t(loc, 'hook_cd_repo_fail')),
      cmdNotFound1: escapeCmdText(t(loc, 'hook_cmd_not_found1')),
      cmdNotFound2: escapeCmdText(t(loc, 'hook_cmd_not_found2')),
      cmdMissingContinue: escapeCmdText(t(loc, 'hook_cmd_missing_continue')),
      useCmdPrefix: escapeCmdText(t(loc, 'hook_use_command_prefix')),
      reviewFail: escapeCmdText(t(loc, 'hook_review_fail')),
      reviewPass: escapeCmdText(t(loc, 'hook_review_pass')),
      interruptCancelled: escapeCmdText(t(loc, 'interrupt_cancelled'))
    };
    const cmdNodeScript = [
      "const { execSync, spawnSync } = require('child_process');",
      "const fs = require('fs');",
      "const path = require('path');",
      `const MSG = { start: '${cmdMessages.start}', noStaged: '${cmdMessages.noStaged}', foundHeader: '${cmdMessages.foundHeader}', cdFail: '${cmdMessages.cdFail}', cmdNotFound1: '${cmdMessages.cmdNotFound1}', cmdNotFound2: '${cmdMessages.cmdNotFound2}', cmdMissingContinue: '${cmdMessages.cmdMissingContinue}', useCmdPrefix: '${cmdMessages.useCmdPrefix}', reviewFail: '${cmdMessages.reviewFail}', reviewPass: '${cmdMessages.reviewPass}', interruptCancelled: '${cmdMessages.interruptCancelled}' };`,
      "const log = (value) => { if (value) console.log(value); };",
      "log(MSG.start);",
      "let staged = '';",
      "try { staged = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' }); } catch (e) {}",
      "const stagedFiles = staged.split(/\\r?\\n/).filter(Boolean);",
      "if (!stagedFiles.length) { log(MSG.noStaged); process.exit(0); }",
      "log(MSG.foundHeader);",
      "log(stagedFiles.join('\\n'));",
      "let repoRoot = '';",
      "try { repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim(); } catch (e) {}",
      "if (!repoRoot) { log(MSG.cdFail); process.exit(1); }",
      "const rootBin = path.join(repoRoot, 'node_modules', '.bin', 'smart-review');",
      "const rootEntry = path.join(repoRoot, 'node_modules', 'smart-review', 'bin', 'review.js');",
      "let foundCmd = '';",
      "let foundEntry = '';",
      "if (fs.existsSync(rootBin)) { foundCmd = rootBin; if (fs.existsSync(rootEntry)) { foundEntry = rootEntry; } }",
      "if (!foundCmd) {",
      "  const maxAscend = 6;",
      "  outer: for (const file of stagedFiles) {",
      "    let dir = path.dirname(file);",
      "    let depth = 0;",
      "    while (dir && dir !== '.' && depth < maxAscend) {",
      "      const candidateBin = path.join(repoRoot, dir, 'node_modules', '.bin', 'smart-review');",
      "      const candidateEntry = path.join(repoRoot, dir, 'node_modules', 'smart-review', 'bin', 'review.js');",
      "      if (fs.existsSync(candidateBin)) { foundCmd = candidateBin; if (fs.existsSync(candidateEntry)) { foundEntry = candidateEntry; } break outer; }",
      "      if (fs.existsSync(candidateEntry)) { foundCmd = candidateEntry; foundEntry = candidateEntry; break outer; }",
      "      dir = path.dirname(dir);",
      "      depth++;",
      "    }",
      "  }",
      "}",
      "if (!foundCmd) {",
      "  try { execSync('where smart-review', { stdio: 'ignore' }); foundCmd = 'smart-review'; } catch (e) {}",
      "}",
      "if (!foundCmd) { log(MSG.cmdNotFound1); log(MSG.cmdNotFound2); log(MSG.cmdMissingContinue); process.exit(0); }",
      "log(MSG.useCmdPrefix + ' ' + foundCmd + ' --staged');",
      "const hasTty = !!(process.stdin && process.stdin.isTTY) || !!(process.stdout && process.stdout.isTTY);",
      "const tryTty = (p) => { try { const fd = fs.openSync(p, 'r'); fs.closeSync(fd); return p; } catch (e) { return ''; } };",
      "const ensureTty = () => {",
      "  if (process.env.SMART_REVIEW_TTY) return;",
      "  let tty = '';",
      "  if (hasTty) { tty = tryTty('\\\\\\\\.\\\\CONIN$') || tryTty('CONIN$'); }",
      "  if (!tty) { tty = tryTty('\\\\\\\\.\\\\CONIN$') || tryTty('CONIN$'); }",
      "  if (tty) { process.env.SMART_REVIEW_TTY = tty; process.env.SMART_REVIEW_FORCE_TTY = '1'; }",
      "};",
      "const args = ['--staged'];",
      "const runOnce = (capture) => {",
      "  if (foundEntry) {",
      "    return spawnSync(process.execPath, [foundEntry, ...args], { stdio: capture ? 'pipe' : 'inherit' });",
      "  }",
      "  return spawnSync(foundCmd, args, { stdio: capture ? 'pipe' : 'inherit', shell: true });",
      "};",
      "let result = runOnce(true);",
      "if (result.stdout) process.stdout.write(result.stdout);",
      "if (result.stderr) process.stderr.write(result.stderr);",
      "let code = Number.isInteger(result.status) ? result.status : (Number.isInteger(result.code) ? result.code : 0);",
      "const errText = result.stderr ? String(result.stderr) : '';",
      "if (code !== 0 && /stdin is not a tty/i.test(errText)) {",
      "  ensureTty();",
      "  result = runOnce(false);",
      "  code = Number.isInteger(result.status) ? result.status : (Number.isInteger(result.code) ? result.code : 0);",
      "}",
      "if (code === 130 || code === 143) { log(MSG.interruptCancelled); process.exit(0); }",
      "if (code !== 0) { log(MSG.reviewFail); process.exit(1); }",
      "log(MSG.reviewPass); process.exit(0);"
    ].join('');
    // Windows 兼容：提供 CMD 包装器，避免 bash 在 CMD 下的 TTY 问题
    try {
      const preCommitCmd = path.join(gitHooksDir, 'pre-commit.cmd');
      const cmdContent = [
        '@echo off',
        'SETLOCAL',
        `node -e "${cmdNodeScript}"`,
        'exit /b %ERRORLEVEL%\r\n'
      ].join('\r\n');
      fs.writeFileSync(preCommitCmd, cmdContent);
    } catch (e) {
      // 忽略 CMD 包装器写入失败
    }
    
    // 设置执行权限
    try {
      fs.chmodSync(preCommitHook, FILE_PERMISSIONS.EXECUTABLE);
      logger.success(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_precommit_installed_success'));
    } catch (error) {
      logger.warn(t(process.env.SMART_REVIEW_LOCALE || 'zh-CN', 'install_precommit_perm_warn'));
    }
    
    // 测试钩子是否能正常执行
    this.testHook(preCommitHook);
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
