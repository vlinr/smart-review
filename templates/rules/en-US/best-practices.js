// Best practices rules (en-US)
export default [
  {
    id: 'BP001',
    name: 'Debug code',
    pattern: 'console\\.log|print\\(|alert\\(',
    risk: 'low',
    message: 'Debug code found; remove before committing',
    suggestion: 'Use a logging system instead of console.log',
    flags: 'gi',
    extensions: ['.js', '.ts', '.py', '.php', '.rb']
  },
  {
    id: 'BP002',
    name: 'Magic numbers',
    pattern: '\\b(?<!\\.) (?!(?:0|1|10|12|24|30|60|100|200|201|300|400|401|403|404|500|503|1000|3000|5000|8080|9000)\\b) \\d{3,}(?!\\.\\d)\\b'.replace(/\s+/g, ''),
    risk: 'low',
    message: 'Magic numbers detected; define them as constants',
    suggestion: 'Define numbers as meaningful constants',
    flags: 'g',
    extensions: ['.js', '.ts', '.java', '.cs', '.php', '.py', '.rb', '.go']
  },
  {
    id: 'BP003',
    name: 'Empty catch block',
    pattern: 'catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}',
    risk: 'medium',
    message: 'Empty catch may hide errors and cause unpredictable behavior',
    suggestion: 'Log or take remedial actions instead of swallowing exceptions',
    flags: 'gi',
    extensions: ['.js', '.ts', '.java', '.cs', '.php']
  },
  {
    id: 'BP004',
    name: 'Ignore TypeScript type checking',
    pattern: '\\/\\/\\s*@ts-ignore',
    risk: 'medium',
    message: 'Detected @ts-ignore; may conceal type errors',
    suggestion: 'Fix type issues or use precise type definitions',
    flags: 'gi',
    extensions: ['.ts']
  },
  {
    id: 'BP005',
    name: 'Use of any type',
    pattern: ':\\s*any\\b',
    risk: 'medium',
    message: 'Using any weakens type safety guarantees',
    suggestion: 'Use concrete types or generics to improve safety',
    flags: 'gi',
    extensions: ['.ts']
  },
  {
    id: 'BP006',
    name: 'ESLint rule disabled',
    pattern: '\\/\\/\\s*eslint-disable',
    risk: 'medium',
    message: 'Disabling ESLint may hide code quality issues',
    suggestion: 'Disable locally only when necessary, and explain the reason',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'BP007',
    name: 'Debugger statement left',
    pattern: '\\bdebugger\\b',
    risk: 'medium',
    message: 'Debugger statement found; may affect production behavior',
    suggestion: 'Remove debugger before commit; use logs or assertions',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'BP008',
    name: 'Overly broad exception catch',
    pattern: 'catch\\s*\\(\\s*(Exception|Throwable|Error|BaseException)\\s+\\w+\\s*\\)\\s*\\{[^}]*(?!.*(?:log|throw|rethrow))[^}]*\\}',
    risk: 'medium',
    message: 'Catching broad exception types without proper handling',
    suggestion: 'Catch specific types and ensure logging or rethrowing as needed',
    flags: 'gi',
    extensions: ['.js', '.ts', '.java', '.cs', '.php']
  },
  {
    id: 'BP009',
    name: 'Print stack instead of logging',
    pattern: '\\.printStackTrace\\s*\\(',
    risk: 'medium',
    message: 'Direct stack printing may lose context and produce uncontrolled output',
    suggestion: 'Use structured logging with context information',
    flags: 'gi',
    extensions: ['.java']
  },
  {
    id: 'BP010',
    name: 'Process-level exit call',
    pattern: 'System\\.exit\\s*\\(',
    risk: 'high',
    message: 'System.exit detected; may cause unexpected service termination',
    suggestion: 'Use graceful shutdown, signal handling, and resource cleanup',
    flags: 'gi',
    extensions: ['.java']
  },
  {
    id: 'BP011',
    name: 'Use root database user',
    pattern: '(user|username)\\s*=\\s*root\\b',
    risk: 'medium',
    message: 'Using root as DB user introduces security and audit risks',
    suggestion: 'Use a least-privileged application account and separate duties',
    flags: 'gi',
    extensions: ['.js', '.ts', '.java', '.cs', '.php', '.py', '.rb', '.go']
  },
  {
    id: 'BP012',
    name: 'Disable CSRF (Spring Security)',
    pattern: 'csrf\\s*\\(\\)\\.disable\\s*\\(\\)',
    risk: 'high',
    message: 'Globally disabling CSRF may cause CSRF vulnerabilities',
    suggestion: 'Use token/same-origin policies where needed; avoid global disable',
    flags: 'gi',
    extensions: ['.java']
  }
];