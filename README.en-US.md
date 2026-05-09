# Smart Review

> Language: [English](README.en-US.md) | [中文](README.md)

🚀 AI-powered code review tool combining static rules and AI analysis.

## ✨ Features

- Static rule checks for Security, Performance, Best Practices
- AI analysis with unified OpenAI / Anthropic / Gemini integration
- Skill-driven review orchestration to enforce detailed risk and fix outputs
- Smart batching and chunked processing for large files
- Git Hook integration (pre-commit)
- Highly configurable and multilingual output

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
├── smart-review.json   # Main config file
├── ai-rules/           # AI prompt directory
└── local-rules/        # Local static rules directory
    ├── security.js     # Security rules
    ├── performance.js  # Performance rules
    └── best-practices.js # Best practices rules
```

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
For very large files, the tool automatically segments the file:
```bash
smart-review --files test/src/large-test-file.js
```

Sample output:
```
Review in progress, please wait...
🔍 Start analyzing file in segments: test/src/large-test-file.js, total 2 segments
🔍 Analyzing segment 1/2 (lines 1-150), estimated 2400 tokens, 150 lines of code
   ✅ Segment 1 completed, found 8 issues
🔍 Analyzing segment 2/2 (lines 130-302), estimated 2800 tokens, 172 lines of code
   ✅ Segment 2 completed, found 12 issues
🎯 Segmented analysis completed, 20 issues found in total
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
- Works in Git Bash, CMD, and PowerShell
- Press `q` or `Esc` during review to interrupt and print completed results
- Interruptions do not fail the review; only blocking risks stop the commit

## ⚙️ Config

Main config `.smart-review/smart-review.json` example:

```json
{
  "ai": {
    "enabled": true,
    "provider": "openai",
    "model": "deepseek-chat",
    "baseURL": "https://api.deepseek.com/v1",
    "reviewOnlyChanges": true,
    "maxResponseTokens": 8192,
    "maxFileSizeKB": 500,
    "enabledFor": [".js", ".ts", ".jsx", ".tsx", ".py", ".java"],
    "useStaticHints": true,
    "maxRequestTokens": 8000,
    "temperature": 0,
    "skills": {
      "enabled": true,
      "strict": false,
      "maxSkillsPerRequest": 4,
      "required": ["DIFF_RISK_GUARD", "EVIDENCE_ENFORCER"],
      "optional": ["SECURITY_DEEP", "LOGIC_CORRECTNESS", "API_CONTRACT"],
      "routes": [
        {
          "match": ["**/auth/**", "**/security/**"],
          "modes": ["diff", "batch", "segment"],
          "add": ["SECURITY_DEEP", "API_CONTRACT"]
        }
      ]
    },
    "tools": {
      "enabled": false,
      "maxCalls": 2,
      "maxReadLines": 400,
      "maxSearchMatches": 50,
      "maxSearchFiles": 120,
      "maxListFiles": 200,
      "allow": [
        "read_file",
        "get_staged_diff",
        "list_files",
        "search_in_file",
        "get_file_outline",
        "search_in_repo",
        "list_changed_files"
      ]
    },
    "concurrency": 3
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

### Config Options

#### AI (`ai`)
- `enabled`: Enable AI analysis
- `provider`: Model provider, supports `openai`, `anthropic`, `gemini`
- `model`: Model name for the selected provider
- `apiKey`: Unified API key field (or use environment variables)
- `baseURL`: API base URL
- `reviewOnlyChanges`: Enable Git Diff incremental review; true analyzes only changed lines
- `maxResponseTokens`: Max tokens in AI response
- `maxFileSizeKB`: Max size per file
- `enabledFor`: File extensions supported by AI analysis
- `useStaticHints`: Include static rules as AI context
- `maxRequestTokens`: Max tokens per request
- `minFilesPerBatch` / `maxFilesPerBatch`: Batch sizing
- `tokenRatio`: Token estimation ratio
- `chunkOverlapLines`: Overlap between segments to keep context
- `includeStaticHints`: Include rule hints in AI analysis
- `temperature`: Model creativity; 0 favors deterministic outputs
- `concurrency`: Number of concurrent AI requests
- `skills.enabled`: Enable review skill orchestration
- `skills.strict`: Enforce output constraints (path/snippet/reason/suggestion)
- `skills.maxSkillsPerRequest`: Max skills applied in one request
- `skills.required`: Required skill list
- `skills.optional`: Optional skill list (mode-based supplement)
- `skills.routes`: Dynamically append skills by file path and mode (`match/modes/add`)
- `tools.enabled`: Enable local read-only tool calling (see tool list below)
- `tools.maxCalls`: Max tool-call rounds per request
- `tools.maxReadLines`: Max lines for single `read_file` call
- `tools.maxSearchMatches`: Max returned matches for `search_in_file` / `search_in_repo`
- `tools.maxSearchFiles`: Max scanned files for one `search_in_repo` call
- `tools.maxListFiles`: Max returned files for one `list_files` call
- `tools.allow`: Tool allowlist (only listed tools can be called by the model)

#### AI Read-Only Tool List (`ai.tools.allow`)
- `read_file`: Read specific line ranges from one file
- `get_staged_diff`: Get staged Git diff (optionally filtered by path)
- `list_files`: Recursively list repository files (supports subdir and keyword/wildcard filtering)
- `search_in_file`: Search text or regex in a single file
- `get_file_outline`: Extract lightweight file outline (class/function/method signatures)
- `search_in_repo`: Search text or regex across repository files (with scan and result caps)
- `list_changed_files`: List changed Git files (supports staged/unstaged and status filtering)
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
- In-file ignore affects static rules only, not AI analysis

## 📋 Built-in Rules

### Security
- **SEC001**: Hardcoded passwords/keys
- **SEC002**: SQL injection risk — string-concatenated queries
- **SEC003**: XSS risk — direct manipulation of HTML content
- **SEC004**: Command injection risk — dangerous command execution APIs

### Performance
- **PERF001**: DB queries inside loops — possible N+1 query issues
- **PERF002**: Memory leak risk — timers created but not cleared

### Best Practices
- **BP001**: Debugging code — console.log, print, alert, etc.
- **BP002**: Magic numbers — suggest using named constants

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

**`.smart-review/ai-rules/custom-prompts.txt`**
```text
Please pay special attention to:
1. Unhandled Promise rejections
2. Proper error handling for API calls
3. Ensure sensitive data is not accidentally logged
```

**`.smart-review/ai-rules/security-focus.txt`**
```text
Security review focus:
- Validate user input
- Verify access control logic
- Ensure data encryption and masking
```

## 🚀 Performance Optimization

### Git Diff incremental review
Core optimization: review only changed content.

#### Benefits
- Review speed up 70–90%
- Token usage down 60–80%
- Memory optimized — load only relevant code segments
- Reduced network payload — smaller API requests

#### Best for
- Daily development commits
- Feature iterations
- Bug fixes
- Refactoring focus areas

#### Context preservation
```json
{
  "ai": {
    "reviewOnlyChanges": true,
    "contextMergeLines": 10,
    "chunkOverlapLines": 5
  }
}
```

### Large file strategy

Smart batching efficiently handles huge files.

#### Segmentation
- Auto-detect files exceeding token limits
- Split into overlapping segments
- Preserve context via overlap
- Parallel analysis supported

#### Token management
```json
{
  "ai": {
    "maxRequestTokens": 8000,
    "chunkOverlapLines": 5,
    "minFilesPerBatch": 1,
    "maxFilesPerBatch": 10
  }
}
```

#### Tips
1. Tune batch parameters
```json
{
  "ai": {
    "maxRequestTokens": 6000,
    "chunkOverlapLines": 10,
    "minFilesPerBatch": 1,
    "maxFilesPerBatch": 5
  }
}
```
2. Enable concurrency
```json
{
  "ai": {
    "concurrency": 3,
    "maxFilesPerBatch": 5
  }
}
```
3. Smart batching parameters
```json
{
  "ai": {
    "minFilesPerBatch": 1,
    "maxFilesPerBatch": 5
  }
}
```
4. File filtering
```json
{
  "ignoreFiles": [
    "**/*.min.js",
    "**/dist/**",
    "**/*.generated.*"
  ]
}
```

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

- Config `locale`: set at the top level in `.smart-review/smart-review.json`. Supported values: `zh-CN`, `en-US`. Example: `{ "locale": "en-US" }`.
- Env var `SMART_REVIEW_LOCALE`: highest priority; the installer selects rule templates based on this value.
- Selection priority: Env var > Project config `.smart-review/smart-review.json` > Template default `templates/smart-review.json` > fallback `zh-CN`.
- Template directories: `templates/rules/<locale>/security.js | performance.js | best-practices.js`. Missing files for a locale fall back to `zh-CN`.
- CLI/Git hook messages switch language automatically according to `locale`.

Switch examples:

```bash
# Windows PowerShell (current session)
$env:SMART_REVIEW_LOCALE='en-US'; node bin/install.js

# macOS/Linux bash
export SMART_REVIEW_LOCALE=en-US && node bin/install.js
```

To add a new language (e.g., `ja-JP`), create `templates/rules/ja-JP/` with the three rule files and set `"locale": "ja-JP"` or use the env var.

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
  --files <files>     Review specific files (comma separated)
  --ai                Force enable AI analysis
  --no-ai             Disable AI analysis
  --diff-only         Only review changed lines (Git Diff mode)
  --debug             Print debug logs
```

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
