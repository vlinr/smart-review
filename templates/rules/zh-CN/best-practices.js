// 最佳实践规则
export default [
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
    id: 'BP003',
    name: '空的异常捕获块',
    pattern: 'catch\s*\([^)]*\)\s*\{\s*\}',
    risk: 'medium',
    message: '检测到空的catch块，可能隐藏错误并导致不可预期行为',
    suggestion: '记录日志或采取补救措施，避免吞掉异常',
    flags: 'gi'
  },
  {
    id: 'BP004',
    name: '忽略TypeScript类型检查',
    pattern: '\\/\\/\\s*@ts-ignore',
    risk: 'medium',
    message: '检测到@ts-ignore，可能掩盖类型错误',
    suggestion: '修复类型问题或使用更精确的类型定义',
    flags: 'gi'
  },
  {
    id: 'BP005',
    name: '使用any类型',
    pattern: ':\\s*any\\b',
    risk: 'medium',
    message: '检测到any类型，可能削弱类型系统保护',
    suggestion: '使用具体类型或泛型替代any，提高类型安全',
    flags: 'gi'
  },
  {
    id: 'BP006',
    name: '禁用ESLint规则',
    pattern: '\\/\\/\\s*eslint-disable',
    risk: 'medium',
    message: '检测到禁用ESLint，可能隐藏代码质量问题',
    suggestion: '只在必要范围局部禁用，并给出明确原因',
    flags: 'gi'
  },
  {
    id: 'BP007',
    name: '调试断点未移除',
    pattern: '\\bdebugger\\b',
    risk: 'medium',
    message: '检测到调试断点，可能影响线上行为',
    suggestion: '在提交前移除debugger并使用日志或断言',
    flags: 'gi'
  },
  {
    id: 'BP008',
    name: '过于宽泛的异常捕获',
    pattern: 'catch\\s*\\(\\s*(Exception|Throwable|Error|BaseException)\\s+\\w+\\s*\\)\\s*\\{[^}]*(?!.*(?:log|throw|rethrow))[^}]*\\}',
    risk: 'medium',
    message: '捕获过于宽泛的异常类型且未进行适当处理',
    suggestion: '捕获具体的异常类型，并确保进行适当的日志记录或重新抛出',
    flags: 'gi'
  },
  {
    id: 'BP009',
    name: '打印堆栈而非日志记录',
    pattern: '\\.printStackTrace\\s*\\(',
    risk: 'medium',
    message: '检测到直接打印堆栈跟踪，可能导致信息丢失与不可控输出',
    suggestion: '使用结构化日志记录错误，并附带上下文信息',
    flags: 'gi'
  },
  {
    id: 'BP010',
    name: '进程级退出调用',
    pattern: 'System\\.exit\\s*\\(',
    risk: 'high',
    message: '检测到System.exit，可能导致服务非预期中断',
    suggestion: '使用受控的停止流程（优雅关闭）、信号处理与资源回收',
    flags: 'gi'
  },
  {
    id: 'BP011',
    name: '使用root数据库用户',
    pattern: '(user|username)\\s*=\\s*root\\b',
    risk: 'medium',
    message: '检测到使用root作为数据库用户，存在安全与审计风险',
    suggestion: '使用最小权限的应用专用账户，分离权限与职责',
    flags: 'gi'
  },
  {
    id: 'BP012',
    name: '禁用CSRF（Spring Security）',
    pattern: 'csrf\\s*\\(\\)\\.disable\\s*\\(\\)',
    risk: 'high',
    message: '检测到全局禁用CSRF保护，可能导致跨站请求伪造风险',
    suggestion: '在必要的API上采用令牌/同源策略，避免全局关闭',
    flags: 'gi'
  }
];