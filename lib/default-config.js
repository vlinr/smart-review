import { t } from './utils/i18n.js';

export const defaultConfig = {
  // AI配置
  ai: {
    enabled: true,
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    baseURL: '',
    temperature: 0.1,
    maxResponseTokens: 4096,
    maxFileSizeKB: 100,
    enabledFor: ['.js', '.ts', '.jsx', '.tsx', '.vue', '.py', '.java', '.cpp', '.c', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt'],
    // 当本地规则存在时，是否将本地规则提示作为上下文提供给AI
    useStaticHints: true,
    // 在存在阻断级别本地问题时是否仍运行AI
    runWhenBlocked: false,
    maxRequestTokens: 8000,
    minFilesPerBatch: 1,
    maxFilesPerBatch: 10,
    tokenRatio: 4,
    chunkOverlapLines: 5,
    includeStaticHints: true,
    skills: {
      enabled: true,
      strict: false,
      maxSkillsPerRequest: 4,
      required: ['DIFF_RISK_GUARD', 'EVIDENCE_ENFORCER'],
      optional: ['SECURITY_DEEP', 'LOGIC_CORRECTNESS', 'API_CONTRACT']
    },
    // 并发处理配置
    concurrency: 3, // 并发AI请求数量，默认3个，<=1时串行，>1时并发
    // Git Diff 增量审查配置
    reviewOnlyChanges: true, // 是否仅审查暂存区变动内容（git diff），而非全文件
    contextMergeLines: 10 // 上下文合并行长度（大概值），用于在diff审查时提供足够的上下文
  },

  // 风险等级配置
  riskLevels: {
    critical: { block: true },
    high: { block: false },
    medium: { block: false },
    low: { block: false },
    suggestion: { block: false }
  },

  // 是否抑制低等级问题的输出（仅输出阻断等级的问题）
  suppressLowLevelOutput: false,

  // 规则加载策略：true=仅使用外部规则，false=内部和外部规则合并（默认）
  useExternalRulesOnly: false,

  // 文件处理配置
  fileExtensions: [
    '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
    '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h',
    '.php', '.rb', '.html', '.css', '.scss', '.less'
  ],
  
  // 统一的忽略文件配置：支持相对路径、绝对路径、glob模式和正则表达式
  // 示例：["./test/src/test-file.js", "test/*", "**/node_modules/**", "/.*\\.generated\\./"]
  ignoreFiles: [
    // 依赖目录
    '**/node_modules/**',
    '**/vendor/**',
    '**/.pnpm/**',
    '**/bower_components/**',
    
    // 测试覆盖率和报告
    '**/coverage/**',
    '**/test-results/**',
    '**/reports/**',
    
    // 压缩和打包文件
    '**/*.min.js',
    '**/*.min.css',
    '**/*.bundle.js',
    '**/*.chunk.js',
    '**/*.umd.js',
    
    // 生成的文件
    '**/*.generated.*',
    '**/*.auto.*',
    '**/generated/**',
    
    // 版本控制和临时文件
    '**/.git/**',
    '**/.svn/**',
    '**/.hg/**',
    '**/tmp/**',
    '**/temp/**',
    '**/*.tmp',
    '**/*.temp',
    '**/*.swp',
    '**/*.swo',
    '**/*~',
    
    // IDE和编辑器文件
    '**/.vscode/**',
    '**/.idea/**',
    '**/*.iml',
    '**/.project',
    '**/.classpath',
    '**/.settings/**',
    
    // 日志文件
    '**/*.log',
    '**/logs/**',
    
    // 缓存目录
    '**/.cache/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.vuepress/**',
    
    // 包管理器锁文件
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/composer.lock',
    '**/Pipfile.lock',
    
    // 环境和配置文件（可能包含敏感信息）
    '**/.env',
    '**/.env.*',
    '**/config/secrets.*'
  ],
  
};

export const defaultRules = {
  security: [
    {
      id: 'SEC001',
      name: t(undefined, 'rule_SEC001_name'),
      pattern: '(password|pwd|pass)\\s*=\\s*[\'"][^\'"]+[\'"]',
      risk: 'high',
      message: t(undefined, 'rule_SEC001_message'),
      suggestion: t(undefined, 'rule_SEC001_suggestion'),
      flags: 'gi',
      extensions: ['.js', '.ts', '.py', '.java', '.rb', '.php', '.cs', '.go']
    },
    {
      id: 'SEC002',
      name: t(undefined, 'rule_SEC002_name'),
      pattern: '(execute|query)\\s*\\(\\s*[fF]?[\'"][^\']*\\+.*[\'"]',
      risk: 'critical',
      message: t(undefined, 'rule_SEC002_message'),
      suggestion: t(undefined, 'rule_SEC002_suggestion'),
      flags: 'gi',
      extensions: ['.js', '.ts', '.java', '.cs', '.php', '.py', '.rb', '.go']
    },
    {
      id: 'SEC003',
      name: t(undefined, 'rule_SEC003_name'),
      pattern: 'innerHTML\\s*=|document\\.write\\s*\\(',
      risk: 'high',
      message: t(undefined, 'rule_SEC003_message'),
      suggestion: t(undefined, 'rule_SEC003_suggestion'),
      flags: 'gi',
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte']
    }
  ],
  
  performance: [
    {
      id: 'PERF001',
      name: t(undefined, 'rule_PERF001_name'),
      pattern: 'for\\s*\\([^)]*\\)\\s*\\{[^}]*\\.(find|query|select)[^}]*\\}',
      risk: 'medium',
      message: t(undefined, 'rule_PERF001_message'),
      suggestion: t(undefined, 'rule_PERF001_suggestion'),
      flags: 'gi',
      extensions: ['.js', '.ts', '.java', '.py', '.rb', '.php', '.cs', '.go']
    },
    {
      id: 'PERF002',
      name: t(undefined, 'rule_PERF002_name'),
      pattern: 'setInterval\\s*\\([^)]*\\)|setTimeout\\s*\\([^)]*\\)',
      risk: 'medium',
      message: t(undefined, 'rule_PERF002_message'),
      suggestion: t(undefined, 'rule_PERF002_suggestion'),
      flags: 'gi',
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte']
    }
  ],
  
  'best-practices': [
    {
      id: 'BP001',
      name: t(undefined, 'rule_BP001_name'),
      pattern: 'console\\.log|print\\(|alert\\(',
      risk: 'low',
      message: t(undefined, 'rule_BP001_message'),
      suggestion: t(undefined, 'rule_BP001_suggestion'),
      flags: 'gi',
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.py', '.php', '.rb']
    },
    {
      id: 'BP002',
      name: t(undefined, 'rule_BP002_name'),
      pattern: '\\b(?<!\\.)(?!(?:0|1|10|12|24|30|60|100|200|201|300|400|401|403|404|500|503|1000|3000|5000|8080|9000)\\b)\\d{3,}(?!\\.\\d)\\b',
      risk: 'low',
      message: t(undefined, 'rule_BP002_message'),
      suggestion: t(undefined, 'rule_BP002_suggestion'),
      flags: 'g',
      extensions: ['.js', '.ts', '.java', '.cs', '.php', '.py', '.rb', '.go']
    },
    {
      id: 'BP013',
      name: t(undefined, 'rule_BP013_name'),
      pattern: '\\bvar\\s+\\w+',
      risk: 'medium',
      message: t(undefined, 'rule_BP013_message'),
      suggestion: t(undefined, 'rule_BP013_suggestion'),
      flags: 'gi',
      extensions: ['.js', '.jsx', '.ts', '.tsx']
    }
  ]
};
