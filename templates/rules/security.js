// 安全规则
export default [
  {
    id: 'SEC001',
    name: '硬编码密码检测',
    pattern: '(password|pwd|pass)\\s*[=:]\\s*[\'"][^\'\"]{6,}[\'"]',
    risk: 'high',
    message: '发现硬编码的密码或密钥',
    suggestion: '使用环境变量或安全的密钥管理服务',
    flags: 'gi',
    excludePatterns: ['//.*', '/\\*[\\s\\S]*?\\*/', '(example|test|demo|placeholder|xxx|123|abc|password|secret)']
  },
  {
    id: 'SEC002',
    name: 'SQL注入风险',
    pattern: '(execute|query)\\s*\\(\\s*[fF]?[\'"][^\']*\\+.*[\'"]',
    risk: 'critical',
    message: '发现字符串拼接SQL查询，存在SQL注入风险',
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
  },
  {
    id: 'SEC004',
    name: '命令注入风险',
    pattern: '(exec|spawn|execSync)\\s*\\([^\\)]*(req\\.|request\\.|params\\.|query\\.|input|user|\\+.*(?:req|input|user|params)|\\$\\{.*(?:req|input|user|params))',
    risk: 'critical',
    message: '发现命令执行函数调用，且可能包含用户输入',
    suggestion: '避免使用用户输入构造命令，或进行严格的输入验证',
    flags: 'gi'
  }
,
  {
    id: 'SEC005',
    name: '路径遍历风险',
    pattern: '(fs\\.(readFile|writeFile|appendFile|mkdir|rmdir|unlink)|open|fopen|FileInputStream|Files\\.newInputStream)\\s*\\([^\\)]*(\\.\\.\/|\\+|\\$\\{)',
    risk: 'high',
    message: '可能存在路径遍历或未校验的文件路径使用',
    suggestion: '对路径进行规范化、白名单校验，并避免直接拼接用户输入',
    flags: 'gi'
  },
  {
    id: 'SEC006',
    name: '禁用SSL证书校验',
    pattern: 'requests\\.(get|post|put|delete)\\s*\\([^\\)]*verify\\s*=\\s*False',
    risk: 'high',
    message: '发现禁用SSL证书校验的HTTP请求',
    suggestion: '启用证书校验或使用可信证书，避免中间人攻击',
    flags: 'gi'
  },
  {
    id: 'SEC007',
    name: '弱加密算法使用',
    pattern: 'crypto\\.(createHash|createCipheriv)\\s*\\(\\s*[\'\"](md5|sha1)[\'\"\\)]|MessageDigest\\.getInstance\\(\\s*[\'\"](MD5|SHA-1)[\'\"\\)]',
    risk: 'high',
    message: '检测到MD5/SHA1等弱加密算法的使用',
    suggestion: '使用更安全的算法，如SHA-256/512、Argon2、bcrypt、scrypt',
    flags: 'gi'
  },
  {
    id: 'SEC008',
    name: '硬编码密钥/Token',
    pattern: '\\b(api[_-]?key|secret|token)\\b\\s*[:=]\\s*[\'\"][A-Za-z0-9_\\-\\/\\+=]{16,}[\'\"]',
    risk: 'high',
    message: '检测到硬编码的密钥或访问令牌',
    suggestion: '将敏感信息存放在安全的密钥管理或环境变量中',
    flags: 'gi'
  },
  {
    id: 'SEC009',
    name: '不安全反序列化',
    pattern: 'pickle\\.loads\\s*\\(|yaml\\.load\\s*\\(|ObjectInputStream\\.readObject\\s*\\(|unserialize\\s*\\(',
    risk: 'critical',
    message: '检测到潜在的不安全反序列化操作',
    suggestion: '使用安全的反序列化方式，例如 yaml.safe_load，避免反序列化不可信数据',
    flags: 'gi'
  },
  {
    id: 'SEC010',
    name: 'SSRF风险',
    pattern: '(requests\\.(get|post|put|delete)|http\\.get|fetch|urlopen)\\s*\\([^\\)]*(req\\.|request\\.|params\\.|query\\.|input|user|\\+.*req|\\+.*input|\\$\\{.*req|\\$\\{.*input)',
    risk: 'high',
    message: '检测到可能由用户输入构成的URL请求，存在SSRF风险',
    suggestion: '对外部URL进行白名单限制并校验，禁止访问内部地址',
    flags: 'gi'
  },
  {
    id: 'SEC011',
    name: 'NoSQL注入风险',
    pattern: '(db|collection)\\.[a-zA-Z]+\\s*\\([^\\)]*\\+[^\\)]*\\)',
    risk: 'high',
    message: '检测到可能的NoSQL注入（动态拼接查询条件）',
    suggestion: '使用参数化查询或安全的查询构建器，避免直接拼接',
    flags: 'gi'
  },
  {
    id: 'SEC012',
    name: '开放重定向',
    pattern: '(res\\.redirect|response\\.sendRedirect)\\s*\\([^\\)]*(\\+|\\$\\{)',
    risk: 'high',
    message: '检测到基于用户输入的重定向，可能导致开放重定向',
    suggestion: '对目标URL进行白名单校验或固定化处理',
    flags: 'gi'
  },
  {
    id: 'SEC013',
    name: '系统命令执行（Python）',
    pattern: '(os\\.system|subprocess\\.(Popen|call|run))\\s*\\(',
    risk: 'critical',
    message: '检测到系统命令执行调用，若包含用户输入可能导致命令注入',
    suggestion: '避免直接调用系统命令，改用安全库或严格白名单参数',
    flags: 'gi'
  },
  {
    id: 'SEC014',
    name: '不安全随机数',
    pattern: '(Math\\.random\\(|random\\.random\\(|new\\s+Random\\s*\\().*(?:token|key|secret|password|salt|nonce|session|auth|uuid)',
    risk: 'medium',
    message: '检测到在安全相关场景中使用非加密安全的随机数生成方法',
    suggestion: '使用加密安全的随机数生成器，如 crypto.randomBytes、secrets.SystemRandom',
    flags: 'gi'
  },
  {
    id: 'SEC015',
    name: '危险的eval/Function使用',
    pattern: '\\beval\\s*\\(|new\\s+Function\\s*\\(',
    risk: 'high',
    message: '检测到可能导致代码注入的动态执行',
    suggestion: '避免使用eval/Function，改用安全的解析与映射逻辑',
    flags: 'gi'
  },
  {
    id: 'SEC016',
    name: '原型污染',
    pattern: '(?:__proto__|constructor|prototype)\\s*[:=]',
    risk: 'high',
    message: '检测到对对象原型的直接赋值，可能导致原型污染',
    suggestion: '避免从不可信数据合并到对象原型，使用安全的合并策略',
    flags: 'gi'
  },
  {
    id: 'SEC017',
    name: 'Java字符串拼接SQL执行',
    pattern: 'Statement\\s*\\.\\s*(execute|executeQuery|executeUpdate)\\s*\\([^\\)]*(\\+|%s)',
    risk: 'critical',
    message: '检测到通过字符串拼接构造SQL语句的执行',
    suggestion: '使用PreparedStatement与占位符进行参数化查询',
    flags: 'gi'
  },
  {
    id: 'SEC018',
    name: 'jQuery.html导致XSS风险',
    pattern: '\\$\\([^\\)]*\\)\\.html\\s*\\(',
    risk: 'high',
    message: '检测到直接注入HTML内容，可能导致XSS',
    suggestion: '使用text()或可信模板引擎进行转义输出',
    flags: 'gi'
  },
  {
    id: 'SEC019',
    name: '过大文件权限（777）',
    pattern: 'chmod\\s*\\([^\\)]*777',
    risk: 'high',
    message: '检测到设置过大的文件权限，存在安全风险',
    suggestion: '使用最小权限原则，避免设置777等过宽权限',
    flags: 'gi'
  },
  {
    id: 'SEC020',
    name: '系统命令执行（多语言）',
    pattern: '(system\\s*\\(|passthru\\s*\\(|shell_exec\\s*\\(|Process\\.Start\\s*\\()',
    risk: 'critical',
    message: '检测到系统命令执行调用，若包含用户输入可能导致命令注入',
    suggestion: '避免直接调用系统命令，改用安全库或严格白名单参数',
    flags: 'gi'
  },
  {
    id: 'SEC021',
    name: '禁用TLS校验（Node）',
    pattern: '(rejectUnauthorized\s*:\s*false|process\.env\.NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*[\'\"]0[\'\"])',
    risk: 'high',
    message: '检测到禁用TLS证书校验的配置',
    suggestion: '启用证书校验并使用可信CA，避免中间人攻击',
    flags: 'gi'
  },
  {
    id: 'SEC022',
    name: 'CORS任意来源',
    pattern: '(Access-Control-Allow-Origin\\s*:\\s*\\*|cors\\s*\\(\\s*\\{[^}]*origin\\s*:\\s*[\'\"\\*\'\"])',
    risk: 'medium',
    message: '检测到CORS允许任意来源，可能导致跨域数据泄露',
    suggestion: '仅对可信来源开放，或使用令牌校验与细粒度策略',
    flags: 'gi'
  },
  {
    id: 'SEC023',
    name: 'LDAP注入风险',
    pattern: '((DirContext|InitialDirContext|LdapContext)\\.[a-zA-Z]+\\s*\\([^)]*(\\+|\\$\\{))|(ldap3\\.Connection\\.search\\s*\\([^)]*(\\+|\\$\\{))',
    risk: 'high',
    message: '检测到基于字符串拼接的LDAP查询过滤器',
    suggestion: '使用安全的过滤器构造与参数绑定，避免直接拼接',
    flags: 'gi'
  },
  {
    id: 'SEC024',
    name: 'XXE（XML外部实体）风险',
    pattern: '(xml\\.etree\\.ElementTree\\.(parse|fromstring)|xml\\.dom\\.minidom\\.(parse|parseString)|DocumentBuilderFactory\\.newInstance\\s*\\(|SAXParserFactory\\.newInstance\\s*\\(|simplexml_load_string\\s*\\(|DOMDocument::loadXML\\s*\\()',
    risk: 'high',
    message: '检测到可能的XML解析，未禁用外部实体可能导致XXE',
    suggestion: '禁用外部实体解析，或使用安全解析库（如defusedxml）',
    flags: 'gi'
  },
  {
    id: 'SEC025',
    name: 'Java HostnameVerifier始终返回true',
    pattern: 'new\s+HostnameVerifier\s*\(\)\s*\{[\s\S]*?return\s+true;[\s\S]*?\}',
    risk: 'high',
    message: '检测到跳过主机名校验的HTTPS验证',
    suggestion: '实现严格的主机名校验逻辑，避免任意通过',
    flags: 'gi'
  },
  {
    id: 'SEC026',
    name: 'Node禁用证书错误忽略',
    pattern: 'process\.env\.NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*[\'\"]0[\'\"]',
    risk: 'critical',
    message: '检测到全局禁用证书错误的环境变量设置',
    suggestion: '移除该设置并使用合法证书，或在测试环境隔离',
    flags: 'gi'
  },
  {
    id: 'SEC027',
    name: '连接字符串包含凭据',
    pattern: '(mongodb|mysql|postgres|redis)://[^@]+:[^@]+@',
    risk: 'high',
    message: '检测到在连接字符串中硬编码了账号密码',
    suggestion: '使用环境变量或安全凭据存储，避免明文出现在代码中',
    flags: 'gi'
  },
  {
    id: 'SEC028',
    name: '日志输出敏感信息',
    pattern: '(logger\\.(info|debug|warn|error)|console\\.log|print\\()\\s*[^\\)]*(\\b(password|secret|token|api[_\\-]?key)\\s*[=:,]|\\$\\{.*\\b(password|secret|token|api[_\\-]?key)\\b)',
    risk: 'medium',
    message: '检测到将敏感信息输出到日志',
    suggestion: '对敏感字段进行脱敏或完全避免记录',
    flags: 'gi'
  },
  {
    id: 'SEC029',
    name: 'Mass Assignment（Rails/Laravel）',
    pattern: '(permit!\\s*\\(|update\\s*\\(\\s*params\\[|::create\\s*\\(\\s*\\$request->all\\s*\\)|->fill\\s*\\(\\s*\\$request->all\\s*\\))',
    risk: 'high',
    message: '检测到可能的批量赋值风险，未进行字段白名单校验',
    suggestion: '启用强参数/属性白名单，仅允许安全字段写入',
    flags: 'gi'
  },
  {
    id: 'SEC030',
    name: '禁用TLS校验（Go）',
    pattern: 'InsecureSkipVerify\s*:\s*true',
    risk: 'high',
    message: '检测到在Go中禁用了TLS证书校验',
    suggestion: '启用证书校验并使用可信CA，避免中间人攻击',
    flags: 'gi'
  },
  {
    id: 'SEC031',
    name: '禁用证书校验（C#）',
    pattern: 'ServicePointManager\.ServerCertificateValidationCallback',
    risk: 'high',
    message: '检测到覆盖全局证书校验回调，可能接受任意证书',
    suggestion: '移除该回调并使用正确的证书验证机制',
    flags: 'gi'
  },
  {
    id: 'SEC032',
    name: 'Entity Framework原生SQL拼接',
    pattern: 'FromSqlRaw\\s*\\([^\\)]*(\\+|\\$\\{)',
    risk: 'critical',
    message: '检测到EF Core使用FromSqlRaw并进行字符串拼接',
    suggestion: '使用FromSqlInterpolated或参数化查询，避免注入风险',
    flags: 'gi'
  },
  {
    id: 'SEC033',
    name: 'Go系统命令执行',
    pattern: 'exec\\.Command\\s*\\(',
    risk: 'high',
    message: '检测到Go中执行系统命令，若包含用户输入可能导致命令注入',
    suggestion: '避免使用shell -c与拼接命令，采用白名单参数与直接可执行路径',
    flags: 'gi'
  },
  {
    id: 'SEC034',
    name: '不安全随机数（Go）',
    pattern: 'math\/rand|\brand\.(Int|Intn|Float|Read)\b',
    risk: 'medium',
    message: '检测到使用math/rand生成随机数，非加密安全',
    suggestion: '使用crypto/rand或安全随机数库生成敏感令牌与密钥',
    flags: 'gi'
  }
];