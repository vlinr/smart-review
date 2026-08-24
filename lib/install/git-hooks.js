/**
 * Git pre-commit 钩子安装：路径解析、文案转义、内容合并、脚本生成
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { t } from '../utils/i18n.js';

export const HOOK_MARKER_START = '# >>> smart-review-pre-commit-start';
export const HOOK_MARKER_END = '# <<< smart-review-pre-commit-end';

/** bash 双引号字符串转义（用于 echo "..."） */
export function escapeBashDoubleQuoted(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}

/**
 * 解析真实 hooks 目录（尊重 core.hooksPath / worktree）
 */
export function resolveGitHooksDir(projectRoot, exec = execSync) {
  try {
    const raw = exec('git rev-parse --git-path hooks', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (!raw) {
      return path.join(projectRoot, '.git', 'hooks');
    }
    return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
  } catch {
    return path.join(projectRoot, '.git', 'hooks');
  }
}

/** 是否已包含 smart-review 钩子片段（标记或旧版特征） */
export function hasSmartReviewHook(content) {
  if (!content || typeof content !== 'string') return false;
  if (content.includes(HOOK_MARKER_START) || content.includes(HOOK_MARKER_END)) {
    return true;
  }
  return isLegacySmartReviewSignature(content);
}

function isLegacySmartReviewSignature(content) {
  const hasHeader =
    /智能代码审查\s*-\s*pre-commit/i.test(content) ||
    /Smart Code Review\s*-\s*pre-commit/i.test(content);
  const hasRuntime =
    /FOUND_ENTRY_CMD/.test(content) ||
    /smart-review-err/.test(content) ||
    /ROOT_BIN=.*smart-review/.test(content) ||
    /node_modules\/\.bin\/smart-review/.test(content);
  return hasHeader || (hasRuntime && /--staged/.test(content));
}

function findLegacyBlockStart(content) {
  const patterns = [
    /^#\s*智能代码审查\s*-\s*pre-commit.*$/m,
    /^#\s*Smart Code Review\s*-\s*pre-commit.*$/m,
    /^echo\s+".*启动代码审查/m,
    /^echo\s+".*Starting code review/m,
    /FOUND_ENTRY_CMD=/m,
    /ROOT_BIN=.*smart-review/m
  ];
  let best = -1;
  for (const re of patterns) {
    const m = content.match(re);
    if (m && typeof m.index === 'number') {
      if (best < 0 || m.index < best) best = m.index;
    }
  }
  return best;
}

/**
 * 合并 pre-commit：已有 smart-review 则替换对应块；否则追加。
 * @returns {{ content: string, action: 'created' | 'replaced' | 'appended' }}
 */
export function mergePreCommitContent(existingRaw, smartReviewBody) {
  const block = `${HOOK_MARKER_START}\n${smartReviewBody.trimEnd()}\n${HOOK_MARKER_END}`;
  const existing = existingRaw == null ? '' : String(existingRaw);

  if (!existing.trim()) {
    return {
      content: `#!/usr/bin/env bash\n${block}\n`,
      action: 'created'
    };
  }

  const startIdx = existing.indexOf(HOOK_MARKER_START);
  const endIdx = existing.indexOf(HOOK_MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + HOOK_MARKER_END.length).replace(/^\r?\n/, '');
    const joined = `${before}${block}\n${after}`.replace(/\n{3,}/g, '\n\n');
    return { content: ensureTrailingNewline(joined), action: 'replaced' };
  }

  if (hasSmartReviewHook(existing)) {
    const legacyStart = findLegacyBlockStart(existing);
    if (legacyStart > 0) {
      let prefix = existing.slice(0, legacyStart).replace(/\s+$/, '');
      if (!/^#!/.test(prefix) && /^#!/.test(existing)) {
        const shebang = existing.match(/^#![^\r\n]*/);
        prefix = shebang ? shebang[0] : '#!/usr/bin/env bash';
      } else if (!prefix) {
        prefix = '#!/usr/bin/env bash';
      }
      return {
        content: ensureTrailingNewline(`${prefix}\n\n${block}`),
        action: 'replaced'
      };
    }
    // 整文件基本是旧版 smart-review 钩子
    const shebang = existing.match(/^#![^\r\n]*/);
    const head = shebang ? shebang[0] : '#!/usr/bin/env bash';
    return {
      content: ensureTrailingNewline(`${head}\n${block}`),
      action: 'replaced'
    };
  }

  const trimmed = existing.replace(/\s+$/, '');
  return {
    content: ensureTrailingNewline(`${trimmed}\n\n${block}`),
    action: 'appended'
  };
}

function ensureTrailingNewline(s) {
  return s.endsWith('\n') ? s : `${s}\n`;
}

/**
 * 生成标记块内的 bash 主体（不含 shebang / 标记）
 */
export function buildBashHookBody(loc, translate = t) {
  const e = (key) => escapeBashDoubleQuoted(translate(loc, key));
  const header = String(translate(loc, 'hook_header_comment')).replace(/\r?\n/g, ' ');
  return `# ${header}

echo "${e('hook_start_review')}"

trap "echo \\"${e('interrupt_cancelled')}\\"; exit 0" INT TERM

# 获取暂存区文件
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
  echo "${e('hook_no_staged')}"
  exit 0
fi

echo "${e('hook_found_staged_header')}"
echo "$STAGED_FILES"

# 运行代码审查（定位到仓库根目录）
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT" || { echo "${e('hook_cd_repo_fail')}"; exit 1; }

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
  echo "${e('hook_cmd_not_found1')}"
  echo "${e('hook_cmd_not_found2')}"
  echo "${e('hook_cmd_missing_continue')}"
  # 未安装 smart-review，跳过自动审查但不阻断提交
  exit 0
fi

echo "${e('hook_use_command_prefix')} $FOUND_CMD --staged"
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
  echo "${e('interrupt_cancelled')}"
  exit 0
fi
if [ $EXIT_CODE -ne 0 ]; then
  echo "${e('hook_review_fail')}"
  exit 1
else
  echo "${e('hook_review_pass')}"
  exit 0
fi
`;
}

/**
 * Windows 独立脚本内容（避免 .cmd 内嵌 node -e + 中文）
 */
export function buildWindowsHookScript(loc, translate = t) {
  const msg = {
    start: translate(loc, 'hook_start_review'),
    noStaged: translate(loc, 'hook_no_staged'),
    foundHeader: translate(loc, 'hook_found_staged_header'),
    cdFail: translate(loc, 'hook_cd_repo_fail'),
    cmdNotFound1: translate(loc, 'hook_cmd_not_found1'),
    cmdNotFound2: translate(loc, 'hook_cmd_not_found2'),
    cmdMissingContinue: translate(loc, 'hook_cmd_missing_continue'),
    useCmdPrefix: translate(loc, 'hook_use_command_prefix'),
    reviewFail: translate(loc, 'hook_review_fail'),
    reviewPass: translate(loc, 'hook_review_pass'),
    interruptCancelled: translate(loc, 'interrupt_cancelled')
  };
  return `#!/usr/bin/env node
/**
 * smart-review Windows pre-commit helper
 * Generated by smart-review install — do not edit by hand.
 */
'use strict';
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const MSG = ${JSON.stringify(msg, null, 2)};
const log = (value) => { if (value) console.log(value); };
log(MSG.start);
let staged = '';
try { staged = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' }); } catch (e) {}
const stagedFiles = staged.split(/\\r?\\n/).filter(Boolean);
if (!stagedFiles.length) { log(MSG.noStaged); process.exit(0); }
log(MSG.foundHeader);
log(stagedFiles.join('\\n'));
let repoRoot = '';
try { repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim(); } catch (e) {}
if (!repoRoot) { log(MSG.cdFail); process.exit(1); }
const rootBin = path.join(repoRoot, 'node_modules', '.bin', 'smart-review');
const rootEntry = path.join(repoRoot, 'node_modules', 'smart-review', 'bin', 'review.js');
let foundCmd = '';
let foundEntry = '';
if (fs.existsSync(rootBin)) { foundCmd = rootBin; if (fs.existsSync(rootEntry)) { foundEntry = rootEntry; } }
if (!foundCmd) {
  const maxAscend = 6;
  outer: for (const file of stagedFiles) {
    let dir = path.dirname(file);
    let depth = 0;
    while (dir && dir !== '.' && depth < maxAscend) {
      const candidateBin = path.join(repoRoot, dir, 'node_modules', '.bin', 'smart-review');
      const candidateEntry = path.join(repoRoot, dir, 'node_modules', 'smart-review', 'bin', 'review.js');
      if (fs.existsSync(candidateBin)) { foundCmd = candidateBin; if (fs.existsSync(candidateEntry)) { foundEntry = candidateEntry; } break outer; }
      if (fs.existsSync(candidateEntry)) { foundCmd = candidateEntry; foundEntry = candidateEntry; break outer; }
      dir = path.dirname(dir);
      depth++;
    }
  }
}
if (!foundCmd) {
  try { execSync('where smart-review', { stdio: 'ignore' }); foundCmd = 'smart-review'; } catch (e) {}
}
if (!foundCmd) { log(MSG.cmdNotFound1); log(MSG.cmdNotFound2); log(MSG.cmdMissingContinue); process.exit(0); }
log(MSG.useCmdPrefix + ' ' + foundCmd + ' --staged');
const hasTty = !!(process.stdin && process.stdin.isTTY) || !!(process.stdout && process.stdout.isTTY);
const tryTty = (p) => { try { const fd = fs.openSync(p, 'r'); fs.closeSync(fd); return p; } catch (e) { return ''; } };
const ensureTty = () => {
  if (process.env.SMART_REVIEW_TTY) return;
  let tty = '';
  if (hasTty) { tty = tryTty('\\\\\\\\.\\\\CONIN$') || tryTty('CONIN$'); }
  if (!tty) { tty = tryTty('\\\\\\\\.\\\\CONIN$') || tryTty('CONIN$'); }
  if (tty) { process.env.SMART_REVIEW_TTY = tty; process.env.SMART_REVIEW_FORCE_TTY = '1'; }
};
const args = ['--staged'];
const runOnce = (capture) => {
  if (foundEntry) {
    return spawnSync(process.execPath, [foundEntry, ...args], { stdio: capture ? 'pipe' : 'inherit' });
  }
  return spawnSync(foundCmd, args, { stdio: capture ? 'pipe' : 'inherit', shell: true });
};
let result = runOnce(true);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
let code = Number.isInteger(result.status) ? result.status : (Number.isInteger(result.code) ? result.code : 0);
const errText = result.stderr ? String(result.stderr) : '';
if (code !== 0 && /stdin is not a tty/i.test(errText)) {
  ensureTty();
  result = runOnce(false);
  code = Number.isInteger(result.status) ? result.status : (Number.isInteger(result.code) ? result.code : 0);
}
if (code === 130 || code === 143) { log(MSG.interruptCancelled); process.exit(0); }
if (code !== 0) { log(MSG.reviewFail); process.exit(1); }
log(MSG.reviewPass); process.exit(0);
`;
}

export function buildWindowsCmdWrapper() {
  return [
    '@echo off',
    'SETLOCAL',
    'node "%~dp0pre-commit-smart-review.js"',
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n');
}

/**
 * 写入 hooks 目录下的 pre-commit / Windows 辅助文件
 */
export function writeGitHookFiles({
  gitHooksDir,
  loc,
  translate = t,
  writeFileSync = fs.writeFileSync,
  readFileSync = fs.readFileSync,
  existsSync = fs.existsSync,
  mkdirSync = fs.mkdirSync
}) {
  if (!existsSync(gitHooksDir)) {
    mkdirSync(gitHooksDir, { recursive: true });
  }

  const preCommitHook = path.join(gitHooksDir, 'pre-commit');
  const body = buildBashHookBody(loc, translate);
  let existing = '';
  if (existsSync(preCommitHook)) {
    existing = readFileSync(preCommitHook, 'utf8');
  }
  const { content, action } = mergePreCommitContent(existing, body);
  writeFileSync(preCommitHook, content, 'utf8');

  const winJs = path.join(gitHooksDir, 'pre-commit-smart-review.js');
  const winCmd = path.join(gitHooksDir, 'pre-commit.cmd');
  writeFileSync(winJs, buildWindowsHookScript(loc, translate), 'utf8');
  writeFileSync(winCmd, buildWindowsCmdWrapper(), 'utf8');

  return {
    preCommitHook,
    winJs,
    winCmd,
    action
  };
}
