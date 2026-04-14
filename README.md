# Smart Review

> 语言 / Language: [中文](README.md) | [English](README.en-US.md)

🚀 **AI智能代码审查工具** - 结合静态规则检测和AI智能分析，为你的代码提供全方位的安全和质量审查。

## ✨ 特性

- 🔍 **静态规则检测** - 内置安全、性能、最佳实践规则
- 🧠 **AI智能分析** - 支持 OpenAI / Anthropic / Gemini 的统一对接
- 🧩 **审查技能编排** - 支持 Skills 约束输出，强制细化风险分析与修复建议
- ⚡ **Git Diff增量审查** - 智能识别变更内容，只审查修改的代码行，大幅提升审查效率
- 🚀 **智能分批处理** - 自动优化大文件处理，支持分段分析
- 📊 **大文件支持** - 智能分段处理超大文件，突破token限制
- 🎯 **Git Hook集成** - 支持暂存区文件审查和指定文件审查
- 📁 **多语言支持** - JavaScript、TypeScript、Python、Java、Go、C++、PHP等
- ⚙️ **高度可配置** - 自定义规则、风险等级、AI参数
- 🔧 **自动安装** - 一键安装配置文件和Git Hook

## 📦 安装

在项目中安装 smart-review，安装后会自动初始化配置并集成到 git pre-commit 钩子：

### 使用 npm
```bash
npm install --save-dev smart-review
```

### 使用 yarn
```bash
yarn add --dev smart-review
```

> 💡 安装完成后，工具会自动：
> - 创建 `.smart-review` 配置目录和配置文件
> - 设置 git pre-commit 钩子，在每次提交时自动进行代码审查

## 🚀 快速开始

### 1. 自动初始化
安装完成后，工具会自动创建配置目录和文件。如需手动重新初始化：
```bash
node bin/install.js
```

初始化后的目录结构：

```
.smart-review/
├── smart-review.json   # 主配置文件
├── ai-rules/           # AI规则目录
└── local-rules/        # 本地静态规则目录
    ├── security.js     # 安全规则
    ├── performance.js  # 性能规则
    └── best-practices.js # 最佳实践规则
```

### 2. 基本使用

#### 审查暂存区文件（Git Hook）
```bash
node bin/review.js --staged
```

#### 审查指定文件
```bash
node bin/review.js --files test/src/test-file.js
node bin/review.js --files test/src/index.tsx,test/src/large-test-file.js
```

#### Git Diff 增量审查模式
启用增量审查模式后，工具会智能识别文件的变更内容，只审查修改的代码行，大幅提升审查效率：

```bash
# 审查暂存区的变更内容（推荐）
node bin/review.js --staged

# 审查指定文件的变更内容
node bin/review.js --files src/modified-file.js
```

**增量审查模式的优势：**
- ⚡ **高效审查** - 只分析变更的代码行，跳过未修改的内容
- 🎯 **精准定位** - 问题报告直接关联到具体的变更行
- 💰 **成本优化** - 减少AI API调用的token消耗
- 🚀 **快速反馈** - 大幅缩短审查时间，特别适合大型项目

**工作原理：**
1. 自动检测Git变更（通过`git diff`）
2. 提取变更的代码行和上下文
3. 只对变更内容进行静态规则检测和AI分析
4. 保持完整的上下文信息，确保分析准确性

#### 大文件分段分析
对于超大文件，工具会自动进行智能分段处理：
```bash
node bin/review.js --files test/src/large-test-file.js
```

输出示例：
```
代码审查审查中，请等待...
🔍 开始逐段分析文件: test/src/large-test-file.js，共 2 段
🔍 开始分析第 1/2 段 (行 1-150)，预估2400 tokens, 共150 行代码
   ✅ 第 1 段分析完成，发现 8 个问题
🔍 开始分析第 2/2 段 (行 130-302)，预估2800 tokens, 共172 行代码
   ✅ 第 2 段分析完成，发现 12 个问题
🎯 分段分析完成，共发现 20 个问题
```

#### 批次处理示例
对于多个文件的批次处理：
```
代码审查审查中，请等待...
🔍 开始分析批次文件: src/utils.js, src/config.js, src/helper.js，预估3200 tokens, 共3 个文件
   ✅ 批次分析完成: src/utils.js, src/config.js, src/helper.js，发现 5 个问题，耗时: 2.3s
当前已完成进度: 1/3，总耗时: 2.3s
🔍 开始分析批次文件: src/api.js, src/database.js，预估2800 tokens, 共2 个文件
   ✅ 批次分析完成: src/api.js, src/database.js，发现 3 个问题，耗时: 1.8s
当前已完成进度: 2/3，总耗时: 4.1s
```

### 3. Git Hook 集成
在 `package.json` 中添加：
```json
{
  "husky": {
    "hooks": {
      "pre-commit": "smart-review --staged"
    }
  }
}
```

#### 中断与终端兼容
- 支持在 Git Bash、CMD、PowerShell 中进行交互中断
- 审查过程中输入 `q` 或按 `Esc` 可中断审查并输出已完成结果
- 中断不会被视为审查失败，只有存在阻断风险才会阻止提交

## ⚙️ 配置文件

### 主配置文件 `.smart-review/smart-review.json`

```json
{
  "ai": {
    "enabled": true,
    "provider": "openai",
    "model": "deepseek-chat",
    "apiKey": "your-api-key",
    "baseURL": "https://api.deepseek.com/v1",
    "reviewOnlyChanges": true,
    "maxResponseTokens": 8192,
    "maxFileSizeKB": 500,
    "enabledFor": [".js", ".ts", ".jsx", ".less", ".css", ".tsx", ".vue", ".py", ".java", ".go", ".rs", ".cpp", ".c", ".cs", ".php"],
    "useStaticHints": true,
    "maxRequestTokens": 8000,
    "minFilesPerBatch": 1,
    "maxFilesPerBatch": 20,
    "tokenRatio": 4,
    "chunkOverlapLines": 5,
    "includeStaticHints": true,
    "skills": {
      "enabled": true,
      "strict": false,
      "maxSkillsPerRequest": 4,
      "required": ["DIFF_RISK_GUARD", "EVIDENCE_ENFORCER"],
      "optional": ["SECURITY_DEEP", "LOGIC_CORRECTNESS", "API_CONTRACT"]
    },
    "temperature": 0,
    "concurrency": 3
  },
  "riskLevels": {
    "critical": { "block": true },
    "high": { "block": true },
    "medium": { "block": true },
    "low": { "block": false },
    "suggestion": { "block": false }
  },
  "suppressLowLevelOutput": false,
  "useExternalRulesOnly": false,
  "fileExtensions": [".js", ".jsx", ".less", ".css", ".ts", ".tsx", ".vue", ".svelte", ".py", ".java", ".go", ".rs", ".cpp", ".c", ".h", ".php", ".rb", ".html", ".css", ".scss", ".less"],
  "ignoreFiles": [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/*.min.js",
    "**/*.bundle.js",
    "test/src/risky-code.js",
    "large.*\\.js$"
  ]
}
```

### 配置项说明

#### AI 配置 (`ai`)
- `enabled`: 是否启用AI分析
- `provider`: 模型提供方，支持 `openai`、`anthropic`、`gemini`
- `model`: 对应提供方的模型名称
- `apiKey`: 统一 API 密钥字段（也可通过环境变量注入）
- `baseURL`: API基础URL
- `reviewOnlyChanges`: 是否启用Git Diff增量审查模式。`true`时只审查变更的代码行，`false`时审查整个文件内容。默认为`true`，大幅提升审查效率
- `maxResponseTokens`: AI响应最大token数
- `maxFileSizeKB`: 单文件最大大小限制
- `enabledFor`: AI分析支持的文件扩展名
- `useStaticHints`: 是否将静态规则作为AI分析的上下文
- `maxRequestTokens`: 请求最大token数
- `minFilesPerBatch`: 批处理最小文件数
- `maxFilesPerBatch`: 批处理最大文件数
- `tokenRatio`: Token估算比例
- `chunkOverlapLines`: 分段重叠行数，保持上下文连续性
- `includeStaticHints`: 是否在AI分析中包含静态规则提示
- `temperature`: AI模型的创造性参数，0表示最确定性的输出
- `concurrency`: 并发AI请求数量，默认3个。设置为1或更小时使用串行处理，大于1时启用并发处理以提升性能
- `skills.enabled`: 是否启用审查技能编排
- `skills.strict`: 是否强制检查输出是否满足“路径/片段/原因/建议”约束
- `skills.maxSkillsPerRequest`: 单次请求最多启用的技能数量
- `skills.required`: 必选技能列表
- `skills.optional`: 可选技能列表（按模式补充）

#### 风险等级配置 (`riskLevels`)
- `critical`: 致命风险
- `high`: 高危风险
- `medium`: 中危风险
- `low`: 低危风险
- `suggestion`: 建议性问题

每个等级可配置 `block` 属性，决定是否阻断提交。

#### 输出控制配置 (`suppressLowLevelOutput`)
- `true`: 仅输出阻断等级的问题（即 `block: true` 的风险等级）
- `false`: 输出所有检测到的问题（默认行为）

此配置允许您在保持现有阻断逻辑的同时，控制是否显示低等级的问题。当启用时，只有会阻断提交的问题才会在输出中显示，有助于聚焦于关键问题。

#### 规则加载策略配置 (`useExternalRulesOnly`)
- `true`: 仅使用外部规则模式 - 只加载 `.smart-review/local-rules` 目录中的规则，完全忽略内置规则
- `false`: 合并模式（默认） - 内置规则与外部规则合并，同名规则外部覆盖内置，不同名规则为新增

此配置控制规则的加载策略：
- **仅外部规则模式**：适用于需要完全自定义规则集的场景，不受内置规则影响
- **合并模式**：适用于在内置规则基础上进行扩展或覆盖的场景

#### 忽略审查配置

Smart Reviewer 提供两种层级的忽略配置：文件级别和代码行级别。

##### 1. 文件级别忽略 (`ignoreFiles`)

在配置文件中设置 `ignoreFiles` 数组，支持三种匹配模式：

**精确匹配**
```json
{
  "ignoreFiles": [
    "src/config/secrets.js", 
    "test/fixtures/data.json"
  ]
}
```

**Glob 模式**
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

**正则表达式**
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

##### 2. 文件内忽略注释

在代码中使用特殊注释来忽略特定行或代码块的审查：

**单行忽略**
```javascript
// review-disable-next-line
const password = "hardcoded-password"; // 下一行会被忽略

/* review-disable-next-line */
const apiKey = "sk-1234567890"; // 下一行会被忽略
```

**多行忽略**
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
  eval(userInput); // 这段代码块会被忽略
  document.innerHTML = data;
}
/* review-disable-end */
```

**支持的注释格式**
- **JavaScript/TypeScript**: `//` 和 `/* */`
- **Python/Ruby**: `#`
- **HTML/Svelte**: `<!-- -->`
- **CSS/SCSS/Less**: `/* */`
- **Java/Go/C/C++/Rust/PHP**: `//` 和 `/* */`

**注意事项**
- 忽略注释必须在独立的注释行中，不能与代码混写
- `review-disable-next-line` 只影响紧接着的下一行代码
- `review-disable-start/end` 必须成对出现，影响两个注释之间的所有代码
- 文件内忽略只影响静态规则检测，不影响AI分析

## 🔧 自定义规则

### 创建自定义规则文件
在 `.smart-review/local-rules/` 目录下创建 JavaScript 文件：

```javascript
// .smart-review/local-rules/custom-security.js
export const rules = {
  security: [
    {
      id: 'CUSTOM001',
      name: '敏感信息泄露',
      pattern: '(token|secret|password)\\s*=\\s*[\'"][^\'"]+[\'"]',
      risk: 'high',
      message: '发现可能的敏感信息硬编码',
      suggestion: '使用环境变量或安全配置管理',
      flags: 'gi'
    }
  ]
};
```

### 函数式规则
支持更复杂的检测逻辑：

```javascript
export const rules = {
  performance: [
    {
      id: 'PERF001',
      name: '复杂度检测',
      pattern: function(content) {
        // 自定义检测逻辑
        const lines = content.split('\n');
        const issues = [];
        
        lines.forEach((line, index) => {
          if (line.includes('for') && line.includes('for')) {
            issues.push(`第${index + 1}行：嵌套循环可能影响性能`);
          }
        });
        
        return issues;
      },
      risk: 'medium',
      message: '发现性能问题',
      suggestion: '优化算法复杂度'
    }
  ]
};
```

### AI 提示词

在 `.smart-review/ai-rules/` 目录下创建自定义AI提示词文件：

**`.smart-review/ai-rules/custom-prompts.txt`**
```text
请特别关注以下代码模式：
1. 检查是否存在未处理的Promise rejection
2. 验证API调用是否有适当的错误处理
3. 确保敏感数据不会被意外记录到日志中
```

**`.smart-review/ai-rules/security-focus.txt`**
```text
安全审查重点：
- 检查用户输入验证
- 确认权限控制逻辑
- 验证数据加密和脱敏处理
```

> 💡 **提示**: AI提示词文件可以是 `.txt`、`.md` 或任何文本文件，内容会被添加到AI分析的上下文中。

## 📋 内置规则

### 安全规则 (Security)
- **SEC001**: 硬编码密码检测 - 检测硬编码的密码或密钥
- **SEC002**: SQL注入风险 - 检测字符串拼接SQL查询
- **SEC003**: XSS风险 - 检测直接操作HTML内容的风险
- **SEC004**: 命令注入风险 - 检测命令执行函数调用

### 性能规则 (Performance)
- **PERF001**: 循环内数据库查询 - 检测可能导致N+1查询问题的代码
- **PERF002**: 内存泄漏风险 - 检测定时器使用但未清理的情况

### 最佳实践 (Best Practices)
- **BP001**: 调试代码 - 检测console.log、print、alert等调试代码
- **BP002**: 魔法数字 - 检测常见的魔法数字，建议使用常量

## 🚀 性能优化

### Git Diff 增量审查优化

Smart Reviewer 的核心性能优化特性，通过智能识别变更内容，实现高效的增量审查：

#### 性能提升效果
- **审查速度提升 70-90%** - 只分析变更的代码行，跳过未修改内容
- **Token消耗减少 60-80%** - 大幅降低AI API调用成本
- **内存占用优化** - 只加载和处理变更相关的代码段
- **网络传输优化** - 减少API请求的数据量

#### 适用场景
- ✅ **日常开发提交** - 小范围代码修改，审查速度极快
- ✅ **功能迭代** - 针对性审查新增和修改的功能代码
- ✅ **Bug修复** - 快速验证修复代码的安全性和质量
- ✅ **代码重构** - 专注于重构部分的影响分析

#### 智能上下文保持
```json
{
  "ai": {
    "reviewOnlyChanges": true,
    "contextMergeLines": 10,     // 保持变更行周围的上下文
    "chunkOverlapLines": 5       // 确保分析的连续性
  }
}
```

### 大文件处理策略

Smart Reviewer 采用智能分批处理技术，能够高效处理超大文件：

#### 自动分段机制
- **智能检测**: 自动识别超过token限制的大文件
- **分段处理**: 将大文件分割为多个重叠段落
- **上下文保持**: 通过重叠行数保持代码上下文连续性
- **并行分析**: 支持多段并行处理，提升分析速度

#### Token 管理
```json
{
  "ai": {
    "maxRequestTokens": 8000,      // 单次请求最大 token 数
    "chunkOverlapLines": 5,        // 分段重叠行数
    "minFilesPerBatch": 1,         // 每批次最少文件数
    "maxFilesPerBatch": 10         // 每批次最多文件数
  }
}
```

#### 性能优化建议

1. **合理设置批处理参数**
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

2. **启用并发处理**
   ```json
   {
     "ai": {
       "concurrency": 3,        // 并发 AI 请求数量
       "maxFilesPerBatch": 5    // 控制批次文件数
     }
   }
   ```

3. **调整智能分批参数**
   ```json
   {
     "ai": {
       "minFilesPerBatch": 1,
       "maxFilesPerBatch": 5
     }
   }
   ```

4. **文件过滤优化**
   ```json
   {
     "ignoreFiles": [
       "**/*.min.js",         // 跳过压缩文件
       "**/dist/**",          // 跳过构建产物
       "**/*.generated.*"     // 跳过生成文件
     ]
   }
   ```

### 内存和网络优化

- **流式处理**: 大文件采用流式读取，减少内存占用
- **请求重试**: 内置智能重试机制，处理网络波动
- **缓存机制**: 静态规则结果缓存，避免重复计算
- **增量分析**: 只分析变更的文件部分

## 🔌 API 使用

### 编程式使用

```javascript
import { CodeReviewer } from './lib/reviewer.js';
import { ConfigLoader } from './lib/config-loader.js';

// 加载配置
const configLoader = new ConfigLoader('/path/to/project');
const config = await configLoader.loadConfig();
const rules = await configLoader.loadRules(config);

// 创建审查器
const reviewer = new CodeReviewer(config, rules);

// 审查暂存区文件
const result = await reviewer.reviewStagedFiles();

// 审查指定文件
const result = await reviewer.reviewSpecificFiles(['test/src/test-file.js']);

// 处理结果
if (result.blockSubmission) {
  console.log('发现阻断性问题，请修复后再提交');
  result.issues.forEach(issue => {
    console.log(`${issue.file}:${issue.line} - ${issue.message}`);
  });
}
```

### 自定义配置

```javascript
import { CodeReviewer } from './lib/reviewer.js';
import { defaultConfig, defaultRules } from './lib/default-config.js';

const customConfig = {
  ...defaultConfig,
  ai: {
    ...defaultConfig.ai,
    enabled: false  // 禁用AI分析
  },
  riskLevels: {
    ...defaultConfig.riskLevels,
    low: { block: true }  // 低危也阻断
  }
};

const reviewer = new CodeReviewer(customConfig, defaultRules);
```

## 🌍 环境变量

可通过环境变量配置：

```bash
# 统一 API 配置（最高优先级）
export AI_API_KEY="your-api-key"

# 按 Provider 配置
export OPENAI_API_KEY="your-api-key"
export ANTHROPIC_API_KEY="your-api-key"
export GEMINI_API_KEY="your-api-key"
# 或 Google 生态变量
export GOOGLE_API_KEY="your-api-key"

# 调试模式
export DEBUG_SMART_REVIEW=true

# 国际化（i18n）
# Windows PowerShell（当前会话）
$env:SMART_REVIEW_LOCALE='zh-CN'  # 或 'en-US'

# macOS/Linux bash
export SMART_REVIEW_LOCALE=zh-CN  # 或 en-US
```

如果需要使用自定义的 OpenAI 兼容服务，请在项目的配置文件中设置 `ai.baseURL`：

```json
{
  "ai": { "provider": "openai", "baseURL": "https://api.openai.com/v1" }
}
```

## 🌍 国际化 (i18n)

- 配置项 `locale`：在 `.smart-review/smart-review.json` 顶层设置输出与模板语言，支持 `zh-CN`、`en-US`。示例：`{"locale": "en-US"}`。
- 环境变量 `SMART_REVIEW_LOCALE`：优先级最高，安装和复制模板时将按该值选择语言目录。
- 选择优先级：环境变量 > 项目配置 `.smart-review/smart-review.json` > 模板默认配置 `templates/smart-review.json` > `zh-CN`。
- 模板目录结构：`templates/rules/<locale>/security.js|performance.js|best-practices.js`；当指定语言缺失某文件时自动回退到 `zh-CN`。
- 控制台与 Git 钩子提示会随 `locale` 切换语言，无需额外配置。
- 切换示例：
  - PowerShell：`$env:SMART_REVIEW_LOCALE='en-US'; node bin/install.js`
  - Bash：`export SMART_REVIEW_LOCALE=en-US && node bin/install.js`

如需新增语言（例如 `ja-JP`），在 `templates/rules/ja-JP/` 下添加三类规则模板文件，并在配置中设置 `"locale": "ja-JP"` 或通过环境变量切换即可。

## 🔧 命令行参数

```bash
smart-review [options]

选项:
  --staged              审查 Git 暂存区文件
  --files <files>       审查指定文件（逗号分隔）
  --ai                  强制启用 AI 分析
  --no-ai               禁用 AI 分析
  --diff-only           仅审查变更行（Git Diff 模式）
  --debug               输出调试日志
```

**增量审查相关说明：**
- `--diff-only`：仅审查变更行（Git Diff 模式），覆盖配置项 `ai.reviewOnlyChanges`
- 禁用增量审查：在 `.smart-review/smart-review.json` 将 `ai.reviewOnlyChanges` 设为 `false`，适用于需要全面审查的场景

**使用示例：**
```bash
# 强制使用增量审查模式
smart-review --staged --diff-only

# 审查完整文件内容（在配置中关闭增量）
# .smart-review/smart-review.json
{
  "ai": { "reviewOnlyChanges": false }
}
smart-review --files src/important.js

# 结合其他参数使用
smart-review --staged --diff-only --debug
```

## 🚀 CI/CD 集成

### GitHub Actions

```yaml
name: Code Review
on: [push, pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npx smart-review --files $(git diff --name-only HEAD~1)
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### GitLab CI

```yaml
code_review:
  stage: test
  script:
    - npm install
    - npx smart-review --files $(git diff --name-only $CI_MERGE_REQUEST_TARGET_BRANCH_SHA)
  variables:
    OPENAI_API_KEY: $OPENAI_API_KEY
```

## 🛠️ 故障排除

### 常见问题

1. **AI分析失败**
   ```
   ⚠️ 检测到 Node 版本 < 18 或缺少全局 fetch
   ```
   **解决方案**: 升级到 Node.js 18+ 或安装 fetch polyfill

2. **配置文件未找到**
   ```
   ❌ 配置文件加载失败
   ```
   **解决方案**: 确保 `.smart-review/smart-review.json` 存在且格式正确

3. **API密钥错误**
   ```
   ❌ OpenAI API调用失败
   ```
   **解决方案**: 检查 `OPENAI_API_KEY` 环境变量或配置文件中的密钥

4. **大文件处理超时**
  ```
  ❌ 文件分析超时
  ```
  **解决方案**: 
  - 降低 `ai.maxRequestTokens` 或减少批次文件数（`maxFilesPerBatch`），并适当降低 `chunkOverlapLines`
  - 增加 `chunkOverlapLines` 以减少分段数量
  - 检查网络连接稳定性

5. **分段分析结果不完整**
   ```
   ⚠️ 部分分段分析失败
   ```
   **解决方案**:
   - 检查文件编码是否为 UTF-8
   - 确保文件没有语法错误
   - 调整 `maxRequestTokens` 配置

6. **内存占用过高**
  ```
  ❌ 内存不足错误
  ```
  **解决方案**:
  - 减少 `maxFilesPerBatch` 配置值
  - 调整 `minFilesPerBatch`/`maxFilesPerBatch` 控制每批文件数量
  - 添加更多文件到 `ignoreFiles` 列表

7. **Token 限制错误**
  ```
  ❌ Request too large
  ```
  **解决方案**:
  - 降低 `maxRequestTokens` 配置值
  - 减少每批文件数量或启用增量审查 `--diff-only`
  - 检查是否有超大的单行代码

### 调试模式

启用调试日志：
```bash
DEBUG_SMART_REVIEW=true smart-review --staged
# 或
smart-review --staged --debug
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 开启 Pull Request

⭐ 如果这个项目对你有帮助，请给个 Star！
