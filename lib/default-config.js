export const defaultConfig = {
  // AI配置
  ai: {
    enabled: true,
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY || '',
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
      name: '硬编码密码',
      pattern: '(password|pwd|pass)\\s*=\\s*[\'"][^\'"]+[\'"]',
      risk: 'high',
      message: '发现硬编码的密码，建议使用环境变量或安全的配置管理',
      suggestion: '使用环境变量或加密的配置存储',
      flags: 'gi'
    },
    {
      id: 'SEC002',
      name: 'SQL注入风险',
      pattern: '(execute|query)\\s*\\(\\s*[fF]?[\'"][^\']*\\+.*[\'"]',
      risk: 'critical',
      message: '发现可能的SQL注入风险，字符串拼接SQL查询',
      suggestion: '使用参数化查询或ORM的安全方法',
      flags: 'gi'
    },
    {
      id: 'SEC003',
      name: 'XSS风险',
      pattern: 'innerHTML\\s*=|document\\.write\\s*\\(',
      risk: 'high',
      message: '发现直接操作HTML内容，可能存在XSS风险',
      suggestion: '使用textContent或安全的DOM操作方法',
      flags: 'gi'
    }
  ],
  
  performance: [
    {
      id: 'PERF001',
      name: '循环内数据库查询',
      pattern: 'for\\s*\\([^)]*\\)\\s*\\{[^}]*\\.(find|query|select)[^}]*\\}',
      risk: 'medium',
      message: '在循环内执行数据库查询，可能导致N+1查询问题',
      suggestion: '使用批量查询或预加载数据',
      flags: 'gi'
    },
    {
      id: 'PERF002',
      name: '内存泄漏风险',
      pattern: 'setInterval\\s*\\([^)]*\\)|setTimeout\\s*\\([^)]*\\)',
      risk: 'medium',
      message: '发现定时器使用，可能存在内存泄漏风险',
      suggestion: '确保在组件卸载时清理定时器',
      flags: 'gi'
    }
  ],
  
  'best-practices': [
    {
      id: 'BP001',
      name: '调试代码',
      pattern: 'console\\.log|print\\(|alert\\(',
      risk: 'low',
      message: '发现调试代码，建议在提交前移除',
      suggestion: '使用日志系统替代console.log',
      flags: 'gi'
    },
    {
      id: 'BP002',
      name: '魔法数字',
      pattern: '\\b(?<!\\.)(?!(?:0|1|10|12|24|30|60|100|200|201|300|400|401|403|404|500|503|1000|3000|5000|8080|9000)\\b)\\d{3,}(?!\\.\\d)\\b',
      risk: 'low',
      message: '检测到魔法数字，建议使用常量定义',
      suggestion: '将数字定义为有意义的常量',
      flags: 'g'
    },
    {
      id: 'BP013',
      name: '使用var声明',
      pattern: '\\bvar\\s+\\w+',
      risk: 'medium',
      message: '检测到使用var声明变量，可能导致作用域问题',
      suggestion: '使用let或const替代var，提高代码安全性',
      flags: 'gi'
    }
  ]
};