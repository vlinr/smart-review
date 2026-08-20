# Smart Review

> Language: [English](README.en-US.md) | [中文](README.md)

🚀 **AI-powered code review** — static rules for instant catches, model-driven evidence tracing across defs and call chains; use via CLI anytime or Git Hook automatically, for security, logic, and contract risks.

## ✨ Features

- Static rules for security / performance / best practices (full templates after install)
- AI analysis via OpenAI / Anthropic / Gemini — security, logic bugs, API contracts, compatibility, performance
- Skills + evidence tracing — pre-enabled evidence trace, security-deep, logic/contract/perf; tools for defs, refs, callers
- Monorepo API contract tracing — frontend calls traced to backend routes/handlers/DTOs for method/path/required params
- Deep security review — injection, authz, IDOR, SSRF, deserialization checklist (not limited to auth dirs)
- Git Diff incremental review by default; `--files` falls back to full file when there is no change; `--full` forces full file
- Batching/segmentation only when `maxRequestTokens` / `maxFilesPerBatch` are set
- Git Hook integration (pre-commit)
- Multilingual file types (JS/TS/Vue/Python/Java/Go, …)
- Highly configurable rules, risk levels, tool budgets, external skills / ai-rules
- Localized CLI and final AI answers; **internal model prompts stay English**
## 📦 Installation

```bash
npm install --save-dev smart-review
# or
yarn add --dev smart-review
```

After installation, configuration files are created under `.smart-review/` and a `pre-commit` Git hook is set up.

## 🚀 Quick Start

```bash
# Re-initialize if needed
node bin/install.js

# Review staged files (recommended)
smart-review --staged

# Review specific files
smart-review --files src/example.js
```

Initialized directory structure:

```
.smart-review/
├── smart-review.json   # Main config
├── ai-rules/           # Custom AI prompts (injected verbatim)
├── skills/             # Optional external document skills
└── local-rules/        # Static rules (copied from templates on install)
    ├── security.js
    ├── performance.js
    └── best-practices.js
```

### Default review profile

| Item | Default |
|------|---------|
| Scope | Diff incremental (`reviewOnlyChanges: true`); only `+` lines |
| Skills | Evidence trace, API boundary, security-deep, logic, contract, performance, runtime-compat (see [Advanced capabilities](#-advanced-review-capabilities-enabled-by-default)) |
| Tools | `tools.strategy: conservative` (~6) + `evidenceMaxCalls: 12` |
| Segmentation | None unless `maxRequestTokens` is set |
| Loop / fix loop | Off |
| Blocking static hits | May skip AI when `runWhenBlocked: false` |

### 🎯 Advanced review capabilities (enabled by default)

Beyond static rules and “snippet-only” diff review, Smart Review pre-enables **dimension skills** and **document skills**, and turns on **evidence-trace tools** in diff mode (`tools.strategy: conservative`). The model can read definitions and references in the repo for **correlated analysis**, not just guess from the hunk.

> Built-in skill/tool prompts to the model are English; this section summarizes behavior. CLI and final issue text follow `locale`.

#### 1. Evidence tracing & correlated analysis (`evidence-trace`)

**Problem**: A changed call, config key, or HTTP request cannot be judged from the `+` lines alone.

**Behavior**:

- Start from the **changed snippet**, trace symbol definitions, contracts, error handling, config meaning
- **Correlated analysis**: `find_references` for defs/refs; `trace_callers` for “who calls this and what this change affects”
- Traced legacy code is **evidence only** — pre-existing callee issues unrelated to this change are not reported as new findings

**Typical cases**: new/changed calls; new imports/types/config; `import type` contracts; monorepo workspace package imports; generated pb/grpc usage; missing error handling; newly reachable old paths.

**Tool chain**: `resolve_import` → `read_symbol_context` / `read_around` → `find_references` (pass `fromPath` to rank same-file/same-dir matches above homonyms) → `trace_callers`; if still unresolved, `search_in_repo`.

**Import resolution (zero config)**: `resolve_import` auto-reads tsconfig/jsconfig (with `extends`), Vite/Webpack/Nuxt aliases (`@/`, `~/`, `#/`), pnpm/npm **workspace packages**, barrel `export … from` (up to 2 hops), and Python / Go (incl. `internal/`) / Java / PHP imports. **No** `pathAliases` entry in `smart-review.json` is required.

#### 2. Monorepo API contract tracing (`api-boundary-trace`)

**Problem**: In a monorepo, FE API changes or BE route/DTO/validation changes can break the other side without showing up in one file.

**Behavior**:

1. Extract method, path, query/body/header names from the change
2. `search_in_repo` for `@Get` / `router.post` / handlers / OpenAPI fragments
3. `read_around` / `read_symbol_context` for DTOs, required fields, validation
4. For **backend signature changes**: `find_references` / `trace_callers` to verify in-repo callers still match

**Checks**: HTTP method, path, required params, types/enums, visible auth headers.

**Reporting**: Issues stay on the **changed file/snippet**; definitions are cited as evidence. Missing in-repo definition → Medium “needs human confirmation”, not silent pass.

#### 3. Deep security review (`security-deep`)

**Problem**: Generic diff review can miss OWASP-class, auth boundary, and outbound-request risks.

**Extra checklist** (any new input surface, auth, outbound network, sensitive data):

| Area | Focus |
|------|--------|
| Injection | SQL/NoSQL/command/LDAP/template |
| Auth & authz | Identity/permission, privilege escalation, IDOR |
| Sensitive data | Hardcoded secrets, logging secrets; test values that look real stay High |
| Session | Cookie flags, fixation/invalidation |
| Input validation | Length, type, allowlists, upload paths |
| SSRF | User-controlled URLs to internal/metadata endpoints |
| Deserialization | Untrusted data into deserialize/merge |
| CORS / redirects | Overly open CORS, open redirects |

Each issue needs path, snippet, reason, actionable fix; no auto-downgrade to Suggestion for “needs confirmation” or test paths.

#### 4. Other pre-enabled skills

| Skill | Role |
|------|------|
| `logic-correctness` | Branches, boundaries, nulls, races, error paths |
| `api-contract` | Method/path/payload, idempotency, status codes, breaking changes |
| `performance-hotpath` | N+1, blocking, extra allocations on hot paths |
| `runtime-compat` | Node/browser/API version differences |
| `diff-risk-guard` | Review `+` lines only; callee legacy ≠ new finding |
| `evidence-enforcer` | Every issue needs evidence snippet, risk, reason, suggestion |

Document skills (`evidence-trace`, `api-boundary-trace`, `security-deep`) inject **full checklists** when pre-enabled; `[SKILL_SELECT]` is usually unnecessary. Add team rules via `.smart-review/skills/*.md` with optional `match`.

#### 5. Tuning

| Need | Config |
|------|--------|
| More monorepo API trace steps | Raise `tools.evidenceMaxCalls` (default 12) or `tools.strategy: balanced` |
| Disable tools (save tokens) | `tools.strategy: off` or `ai.tools.enabled: false` |
| Feed static hits to AI | `includeStaticHints: true` |
| Extra review round | `loop.enabled: true` |

### Basic Usage

#### Review staged files (Git Hook)
```bash
smart-review --staged
```

#### Review specific files
```bash
smart-review --files test/src/test-file.js
smart-review --files test/src/index.tsx,test/src/large-test-file.js
```

#### Git Diff Incremental Mode
When enabled, the tool only analyzes changed lines, drastically improving efficiency:

```bash
# Review changes in the staging area (recommended)
smart-review --staged

# Review changes in specified files
smart-review --files src/modified-file.js
```

Benefits of incremental review:
- Efficient — analyze only changed lines, skip untouched content
- Precise — issues linked to exact changed lines
- Cost-optimized — reduce AI token usage
- Fast feedback — ideal for large projects

How it works:
1. Detect Git changes via `git diff`
2. Extract changed lines and context
3. Run static rule checks and AI analysis on the changes
4. Keep sufficient context to ensure accuracy

#### Large File Chunked Analysis
Files are segmented only when `ai.maxRequestTokens` is set. If it is omitted, the full file is sent.
```bash
smart-review --files test/src/large-test-file.js
```

#### Batch Processing Example
For multiple files in batches:
```
Review in progress, please wait...
🔍 Analyzing batch: src/utils.js, src/config.js, src/helper.js, estimated 3200 tokens, 3 files
   ✅ Batch completed: src/utils.js, src/config.js, src/helper.js, found 5 issues, time: 2.3s
Progress: 1/3, total time: 2.3s
🔍 Analyzing batch: src/api.js, src/database.js, estimated 2800 tokens, 2 files
   ✅ Batch completed: src/api.js, src/database.js, found 3 issues, time: 1.8s
Progress: 2/3, total time: 4.1s
```

### Git Hook Integration
Add to `package.json` if you use Husky:
```json
{
  "husky": {
    "hooks": {
      "pre-commit": "smart-review --staged"
    }
  }
}
```

#### Interrupt & Terminal Compatibility
- Works in Git Bash, CMD, PowerShell, and common IDE terminals
- Press `q` / `Esc` (or Ctrl+C) to interrupt and print completed results
- User interrupt exit code is typically **130** (SIGTERM **143**); interrupt is not a retryable failure
- Fail the check only for blocking findings, or when AI review is incomplete (empty/invalid conclusion)

## ⚙️ Config

Main config `.smart-review/smart-review.json` example:

```json
{
  "ai": {
    "enabled": true,
    "provider": "openai",
    "model": "deepseek-chat",
    "baseURL": "https://api.deepseek.com/v1"
  },
  "riskLevels": {
    "critical": { "block": true },
    "high": { "block": true },
    "medium": { "block": true },
    "low": { "block": false },
    "suggestion": { "block": false }
  },
  "locale": "en-US"
}
```

Sampling and limit fields are optional: if omitted they are not sent and do not cap the model. Set them only when you want a limit, for example:

```json
{
  "ai": {
    "temperature": 0,
    "maxResponseTokens": 8192,
    "maxRequestTokens": 8000,
    "maxFilesPerBatch": 10,
    "concurrency": 3,
    "tools": { "strategy": "conservative", "evidenceMaxCalls": 12 }
  }
}
```

### Config Options

#### AI (`ai`)
- `enabled`: Enable AI analysis
- `provider`: Model provider, supports `openai`, `anthropic`, `gemini`
- `model`: Model name for the selected provider
- `apiKey`: Unified API key field (or use environment variables)
- `baseURL`: API base URL
- `reviewOnlyChanges`: Enable Git Diff incremental review. Changed files are reviewed as diffs; files with no reviewable git change fall back to the full file. Use `--full` to force full-file review
- `maxResponseTokens`: Optional max tokens in AI response; omitted means the field is not sent
- `maxFileSizeKB`: Optional max size per file for AI; omitted means no size skip
- `enabledFor`: File extensions supported by AI analysis
- `includeStaticHints` (alias: `useStaticHints`): Include static findings as AI context
- `maxRequestTokens`: Optional request token budget; omitted means no token-based splitting
- `minFilesPerBatch` / `maxFilesPerBatch`: Optional batch sizing; omit `maxFilesPerBatch` for no file-count cap
- `tokenRatio`: Token estimation ratio
- `chunkOverlapLines`: Overlap between segments (only used when `maxRequestTokens` causes segmentation)
- `temperature`: Optional sampling parameter; omitted means it is not sent
- `concurrency`: Number of concurrent AI requests (default 3). Parallelism runs when there is more than one batch
- `skills.enabled`: Enable skill catalog
- `skills.path`: External skill docs directory under `.smart-review/` (default `skills`)
- `tools.strategy`: `off` / `conservative` (default, ~6 calls) / `balanced` (~12) / `aggressive` (~20)
- `tools.evidenceMaxCalls`: Evidence-trace call cap (default **12**)
- `loop.enabled`: Multi-round review loop
- `fixLoop.enabled`: Review-fix loop (structured fix snippets)
- `fixLoop.autoApply`: Auto-apply fixes and re-review (requires `fixLoop.enabled`)

#### Skills

See **[Advanced review capabilities](#-advanced-review-capabilities-enabled-by-default)** for the full picture. Config notes:

- A skill outline is always sent; listed skills are **pre-enabled** by default — `[SKILL_SELECT]` is usually unnecessary.
- External `.smart-review/skills/*.md`: no `match` → always inject; with `match` → path hit only.
- Findings always land on the **changed snippet**; traced definitions are evidence only.

#### AI read-only tools (including evidence)

Base: `read_file`, `get_staged_diff`, `list_files`, `search_in_file`, `get_file_outline`, `search_in_repo`, `list_changed_files`, `get_file_diff`.

Evidence extras: `resolve_import` (**auto-reads** tsconfig/Vite/Webpack/Nuxt, `@/`/`~/`/`#/` aliases, pnpm/npm workspaces, barrel re-exports, go.mod/composer, etc.; Python/Go/Java/PHP imports), `read_around`, `find_references` (pass `fromPath` to de-prioritize homonyms), `trace_callers`, `read_symbol_context`. Built-in prompts cover `import type` and generated pb/grpc artifacts. On failure, AI is hinted to use `search_in_repo` — **no alias config in smart-review.json required**.

Narrow with `ai.tools.allow` if needed.

#### Risk Levels (`riskLevels`)
- `critical` / `high` / `medium` / `low` / `suggestion`
- Each level supports `block` to decide whether to block commits

#### Output Control (`suppressLowLevelOutput`)
- `true`: Output only blocking levels (`block: true`)
- `false`: Output all detected issues (default)

#### Rule Loading Strategy (`useExternalRulesOnly`)
- `true`: Use only external rules from `.smart-review/local-rules`, ignore bundled rules
- `false`: Merge mode (default) — external override bundled by id; unique ids become additions

#### Ignore Review Configuration

Smart Review supports file-level and in-file ignore.

##### 1. File-level ignore (`ignoreFiles`)

Exact match:
```json
{
  "ignoreFiles": [
    "src/config/secrets.js",
    "test/fixtures/data.json"
  ]
}
```

Glob patterns:
```json
{
  "ignoreFiles": [
    "**/node_modules/**",
    "dist/*",
    "**/*.min.js",
    "**/build/**",
    "**/*.bundle.js"
  ]
}
```

Regular expressions:
```json
{
  "ignoreFiles": [
    ".*\\.generated\\.",
    "large.*\\.js$",
    "/test.*\\.spec\\./",
    ".*\\.temp\\."
  ]
}
```

##### 2. In-file ignore comments

Single line:
```javascript
// review-disable-next-line
const password = "hardcoded-password"; // The next line will be ignored

/* review-disable-next-line */
const apiKey = "sk-1234567890"; // The next line will be ignored
```

Block ignore:
```javascript
// review-disable-start
const config = {
  password: "admin123",
  apiKey: "secret-key",
  token: "hardcoded-token"
};
// review-disable-end

/* review-disable-start */
function unsafeFunction() {
  eval(userInput); // This block will be ignored
  document.innerHTML = data;
}
/* review-disable-end */
```

Supported comment styles
- JavaScript/TypeScript: `//` and `/* */`
- Python/Ruby: `#`
- HTML/Svelte: `<!-- -->`
- CSS/SCSS/Less: `/* */`
- Java/Go/C/C++/Rust/PHP: `//` and `/* */`

Notes
- Ignore comments must be on separate lines, not mixed with code
- `review-disable-next-line` affects the immediately following line only
- `review-disable-start/end` must be paired and affect the range between them
- In-file ignore applies to **both static rules and AI** (disabled regions are stripped before review)

## 📋 Static rules

### Two layers

| Source | Contents |
|--------|----------|
| Bundled `defaultRules` | Small core set (e.g. SEC001–003, PERF001–002, some BP) when templates are not installed |
| Install templates → `.smart-review/local-rules/` | Full set: security ~SEC001–034, performance PERF001–013, best-practices BP, … |

Default is **merge** mode (external overrides same id). `useExternalRulesOnly: true` uses `local-rules` only.

See `templates/rules/<locale>/` for the full installed lists. Highlights:

### Security (excerpt)
- **SEC001** hardcoded secrets · **SEC002** SQL injection · **SEC003** XSS · plus command injection, path traversal, SSRF, weak crypto, sensitive logs, …

### Performance (excerpt)
- **PERF001** N+1 / queries in loops · **PERF002** timer leaks · plus blocking IO, regex/JSON in hot loops, …

### Best Practices (excerpt)
- **BP001** debug leftovers · **BP002** magic numbers · empty catch / overly broad catch, …

## 🔧 Custom Rules

Example: custom security rule
```javascript
// .smart-review/local-rules/custom-security.js
export const rules = {
  security: [
    {
      id: 'CUSTOM001',
      name: 'Sensitive information leakage',
      pattern: '(token|secret|password)\\s*=\\s*['"]^["']+['"]',
      risk: 'high',
      message: 'Possible hardcoded sensitive information found',
      suggestion: 'Use environment variables or secure configuration management',
      flags: 'gi'
    }
  ]
};
```

Example: performance rule
```javascript
export const rules = {
  performance: [
    {
      id: 'PERF001',
      name: 'Complexity check',
      pattern: function(content) {
        const lines = content.split('\n');
        const issues = [];
        lines.forEach((line, index) => {
          if (line.includes('for') && line.includes('for')) {
            issues.push(`Line ${index + 1}: nested loops may impact performance`);
          }
        });
        return issues;
      },
      risk: 'medium',
      message: 'Performance issue detected',
      suggestion: 'Optimize algorithmic complexity'
    }
  ]
};
```

### AI prompt customization

Put text files under `.smart-review/ai-rules/`. Content is injected **verbatim** (any language is fine for team rules).

Built-in system prompts and skill bodies sent to the model are **English**; final answer language follows `locale`.

> Tip: `.txt`, `.md`, or any text file works.

## 🚀 Performance Optimization

### Git Diff incremental review
Default: review only changed content (Diff).

#### Benefits
- Smaller payloads and faster feedback on typical commits
- Lower AI token usage and cost
- Better fit for large repos

#### Best for
- Daily commits, feature work, bug fixes
- Use `--full` or `reviewOnlyChanges: false` when full-file context is required

#### Context preservation
```json
{
  "ai": {
    "reviewOnlyChanges": true,
    "contextMergeLines": 10
  }
}
```

### Large file strategy

Segmentation is **opt-in**.

#### Segmentation
- Without `maxRequestTokens`: prefer full file (or split by `maxFilesPerBatch` only)
- With a budget: oversized files are split with overlap; combine with `concurrency` as needed

#### Example
```json
{
  "ai": {
    "maxRequestTokens": 8000,
    "chunkOverlapLines": 5,
    "maxFilesPerBatch": 10,
    "concurrency": 3,
    "tools": { "strategy": "balanced", "evidenceMaxCalls": 12 }
  }
}
```

#### Tips
1. Prefer Diff incremental before enabling segmentation
2. Raise `evidenceMaxCalls` / `tools.strategy` for deeper monorepo API tracing
3. Ignore `dist`, minified, and generated files
4. Enable `loop.enabled` on sensitive paths when you want a second pass

### Memory and network optimization

- Streaming: large files are read in streaming mode
- Request retries: built-in retry logic handles network flaps
- Caching: static rule results cache to avoid recomputation
- Incremental analysis: only changed parts are analyzed

## 🔌 API Usage

Minimal Node.js integration example:
```javascript
import { ConfigLoader, CodeReviewer } from './index.js';

async function main() {
  const loader = new ConfigLoader(process.cwd());
  const config = await loader.loadConfig();
  const rules = await loader.loadRules(config);
  const reviewer = new CodeReviewer(config, rules);

  const result = await reviewer.reviewStagedFiles();
  if (result.blockSubmission) {
    console.log('Blocking issues found; please fix before committing');
    process.exit(1);
  }
  console.log('Review completed successfully');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## 🚀 CI/CD Integration

### GitHub Actions
```yaml
name: smart-review
on: [push, pull_request]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - run: npm ci
      - name: Run Smart Review
        run: smart-review --staged
```

### GitLab CI
```yaml
stages:
  - review

smart_review:
  stage: review
  image: node:18
  script:
    - npm ci
    - smart-review --staged
  only:
    - merge_requests
    - branches
```

## 🌍 Internationalization (i18n)

- `locale` (`zh-CN` / `en-US`) controls: CLI text, install templates, and the language of the model's **final answer**.
- **Internal prompts and built-in skill bodies sent to the model are always English**, regardless of `locale`.
- Env `SMART_REVIEW_LOCALE` overrides config.
- Priority: env > `.smart-review/smart-review.json` > template default > `zh-CN`.
- Rule templates: `templates/rules/<locale>/`; missing files fall back to `zh-CN`.

```bash
# Windows PowerShell
$env:SMART_REVIEW_LOCALE='en-US'; node bin/install.js

# macOS/Linux
export SMART_REVIEW_LOCALE=en-US && node bin/install.js
```

## 🌍 Environment Variables

```bash
export AI_API_KEY="your-api-key"
export OPENAI_API_KEY="your-api-key"
export ANTHROPIC_API_KEY="your-api-key"
export GEMINI_API_KEY="your-api-key"
export GOOGLE_API_KEY="your-api-key"
export DEBUG_SMART_REVIEW=true
export SMART_REVIEW_LOCALE=en-US
```

To use a custom OpenAI-compatible endpoint, set `ai.baseURL` in `.smart-review/smart-review.json`:

```json
{
  "ai": { "provider": "openai", "baseURL": "https://api.openai.com/v1" }
}
```

## 🔧 CLI Options

```bash
smart-review [options]
  --staged            Review Git staged files
  --files <files>     Review specific files (comma separated; per-file: diff if present, else full file)
  --full              Force full-file review
  --ai                Force enable AI analysis
  --no-ai             Disable AI analysis
  --diff-only         Only review changed lines (Git Diff mode)
  --debug             Print debug logs
```

- `--files`: files with reviewable added lines use Diff; untouched files fall back to full file; delete-only diffs do not full-file-fallback
- `--full`: force full file for the listed paths
- Interrupt with `q`/`Esc` → exit **130** typically

## 🛠️ Troubleshooting

- Ensure Git for Windows is installed if using Windows; hooks rely on `bash`.
- If the hook test warns about executability on Windows, it will still work; the installer handles Windows gracefully.

### Debug Mode

Enable debug logs:
```bash
DEBUG_SMART_REVIEW=true smart-review --staged
# or
smart-review --staged --debug
```

## 🤝 Contributing

1. Fork the project
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

⭐ If this project helps you, please star the repo!
