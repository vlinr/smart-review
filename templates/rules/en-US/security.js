// Security rules (en-US)
export default [
  {
    id: 'SEC001',
    name: 'Hard-coded password detection',
    pattern: '(password|pwd|pass)\\s*[=:]\\s*[\'\"][^\'\\\"]{6,}[\'\\\"]',
    risk: 'high',
    message: 'Hard-coded password or secret detected',
    suggestion: 'Use environment variables or a secure secret manager',
    flags: 'gi',
    extensions: ['.js', '.ts', '.py', '.java', '.php', '.rb', '.cs'],
    excludePatterns: ['//.*', '/\\*[\\s\\S]*?\\*/', '(example|test|demo|placeholder|xxx|123|abc|password|secret)']
  },
  {
    id: 'SEC002',
    name: 'SQL injection risk',
    pattern: '(execute|query)\\s*\\(\\s*[fF]?[\'\"][^\']*\\+.*[\'\"]',
    risk: 'critical',
    message: 'String-concatenated SQL detected; injection risk',
    suggestion: 'Use parameterized queries or the ORM’s safe APIs',
    flags: 'gi',
    extensions: ['.js', '.ts', '.py', '.java', '.php', '.rb', '.cs']
  },
  {
    id: 'SEC003',
    name: 'XSS risk',
    pattern: 'innerHTML\\s*=|document\\.write\\s*\\(',
    risk: 'high',
    message: 'Direct HTML manipulation detected; possible XSS',
    suggestion: 'Use textContent or safe DOM APIs',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'SEC004',
    name: 'Command injection risk',
    pattern: '(exec|spawn|execSync)\\s*\\([^\\)]*(req\\.|request\\.|params\\.|query\\.|input|user|\\+.*(?:req|input|user|params)|\\$\\{.*(?:req|input|user|params))',
    risk: 'critical',
    message: 'Command execution with possible user input detected',
    suggestion: 'Avoid constructing commands from user input; validate strictly',
    flags: 'gi',
    extensions: ['.js', '.ts']
  }
,
  {
    id: 'SEC005',
    name: 'Path traversal risk',
    pattern: '(fs\\.(readFile|writeFile|appendFile|mkdir|rmdir|unlink)|open|fopen|FileInputStream|Files\\.newInputStream)\\s*\\([^\\)]*(\\.\\.\/|\\+|\\$\\{)',
    risk: 'high',
    message: 'Potential path traversal or unvalidated file path usage',
    suggestion: 'Normalize and whitelist paths; never concatenate untrusted input',
    flags: 'gi',
    extensions: ['.js', '.ts', '.java', '.php', '.py']
  },
  {
    id: 'SEC006',
    name: 'Disable SSL certificate verification',
    pattern: 'requests\\.(get|post|put|delete)\\s*\\([^\\)]*verify\\s*=\\s*False',
    risk: 'high',
    message: 'HTTP request with certificate verification disabled detected',
    suggestion: 'Enable verification and use trusted CAs; avoid MITM attacks',
    flags: 'gi',
    extensions: ['.py']
  },
  {
    id: 'SEC007',
    name: 'Weak cryptographic algorithm',
    pattern: 'crypto\\.(createHash|createCipheriv)\\s*\\(\\s*[\'\"](md5|sha1)[\'\"\\)]|MessageDigest\\.getInstance\\(\\s*[\'\"](MD5|SHA-1)[\'\"\\)]',
    risk: 'high',
    message: 'Detected use of weak algorithms such as MD5/SHA-1',
    suggestion: 'Use stronger algorithms: SHA-256/512, Argon2, bcrypt, scrypt',
    flags: 'gi',
    extensions: ['.js', '.ts', '.java']
  },
  {
    id: 'SEC008',
    name: 'Hard-coded secret/Token',
    pattern: '\\b(api[_-]?key|secret|token)\\b\\s*[:=]\\s*[\'\"][A-Za-z0-9_\\-\\/\\+=]{16,}[\'\"]',
    risk: 'high',
    message: 'Hard-coded secret or access token detected',
    suggestion: 'Store secrets in a manager or environment variables',
    flags: 'gi',
    extensions: ['.js', '.ts', '.py', '.java', '.php', '.rb', '.cs']
  },
  {
    id: 'SEC009',
    name: 'Unsafe deserialization',
    pattern: 'pickle\\.loads\\s*\\(|yaml\\.load\\s*\\(|ObjectInputStream\\.readObject\\s*\\(|unserialize\\s*\\(',
    risk: 'critical',
    message: 'Potentially unsafe deserialization detected',
    suggestion: 'Use safe methods (e.g., yaml.safe_load); never deserialize untrusted data',
    flags: 'gi',
    extensions: ['.py', '.java', '.php']
  },
  {
    id: 'SEC010',
    name: 'SSRF risk',
    pattern: '(requests\\.(get|post|put|delete)|http\\.get|fetch|urlopen)\\s*\\([^\\)]*(req\\.|request\\.|params\\.|query\\.|input|user|\\+.*req|\\+.*input|\\$\\{.*req|\\$\\{.*input)',
    risk: 'high',
    message: 'User-controlled URL request detected; SSRF risk',
    suggestion: 'Whitelist external URLs; prohibit access to internal addresses',
    flags: 'gi',
    extensions: ['.js', '.ts', '.py']
  },
  {
    id: 'SEC011',
    name: 'NoSQL injection risk',
    pattern: '(db|collection)\\.[a-zA-Z]+\\s*\\([^\\)]*\\+[^\\)]*\\)',
    risk: 'high',
    message: 'Possible NoSQL injection (dynamically concatenated conditions)',
    suggestion: 'Use parameterized queries or safe builders; avoid concatenation',
    flags: 'gi',
    extensions: ['.js', '.ts', '.py', '.rb', '.php']
  },
  {
    id: 'SEC012',
    name: 'Open redirect',
    pattern: '(res\\.redirect|response\\.sendRedirect)\\s*\\([^\\)]*(\\+|\\$\\{)',
    risk: 'high',
    message: 'User-controlled redirection detected; open-redirect risk',
    suggestion: 'Whitelist target URLs or fix them to safe destinations',
    flags: 'gi',
    extensions: ['.js', '.ts', '.java']
  },
  {
    id: 'SEC013',
    name: 'System command execution (Python)',
    pattern: '(os\\.system|subprocess\\.(Popen|call|run))\\s*\\(',
    risk: 'critical',
    message: 'System command execution detected; injection risk if user input involved',
    suggestion: 'Avoid direct system calls; use safe libraries or strict whitelists',
    flags: 'gi',
    extensions: ['.py']
  },
  {
    id: 'SEC014',
    name: 'Insecure randomness',
    pattern: '(Math\\.random\\(|random\\.random\\(|new\\s+Random\\s*\\().*(?:token|key|secret|password|salt|nonce|session|auth|uuid)',
    risk: 'medium',
    message: 'Non-cryptographic RNG used in security-sensitive contexts',
    suggestion: 'Use cryptographically secure RNGs (crypto.randomBytes, secrets.SystemRandom)',
    flags: 'gi',
    extensions: ['.js', '.ts', '.py', '.java']
  },
  {
    id: 'SEC015',
    name: 'Dangerous eval/Function usage',
    pattern: '\\beval\\s*\\(|new\\s+Function\\s*\\(',
    risk: 'high',
    message: 'Dynamic execution that may lead to code injection',
    suggestion: 'Avoid eval/Function; use safe parsing/mapping logic',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'SEC016',
    name: 'Prototype pollution',
    pattern: '(?:__proto__|constructor|prototype)\\s*[:=]',
    risk: 'high',
    message: 'Direct assignment to object prototypes; may cause pollution',
    suggestion: 'Avoid merging untrusted data into prototypes; use safe merging',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'SEC017',
    name: 'Java string-concatenated SQL execution',
    pattern: 'Statement\\s*\\.\\s*(execute|executeQuery|executeUpdate)\\s*\\([^\\)]*(\\+|%s)',
    risk: 'critical',
    message: 'SQL execution built via string concatenation detected',
    suggestion: 'Use PreparedStatement with placeholders',
    flags: 'gi',
    extensions: ['.java']
  },
  {
    id: 'SEC018',
    name: 'jQuery.html causing XSS risk',
    pattern: '\\$\\([^\\)]*\\)\\.html\\s*\\(',
    risk: 'high',
    message: 'Direct HTML injection detected; possible XSS',
    suggestion: 'Use text() or trusted templating with escaping',
    flags: 'gi',
    extensions: ['.js']
  },
  {
    id: 'SEC019',
    name: 'Overly permissive file mode (777)',
    pattern: 'chmod\\s*\\([^\\)]*777',
    risk: 'high',
    message: 'Setting wide-open file permissions detected',
    suggestion: 'Apply least privilege; avoid 777 and similar modes',
    flags: 'gi',
    extensions: ['.php']
  },
  {
    id: 'SEC020',
    name: 'System command execution (multi-language)',
    pattern: '(system\\s*\\(|passthru\\s*\\(|shell_exec\\s*\\(|Process\\.Start\\s*\\()',
    risk: 'critical',
    message: 'System command execution detected; injection risk with user input',
    suggestion: 'Avoid shell commands; use safe libraries and whitelist parameters',
    flags: 'gi',
    extensions: ['.php', '.cs']
  },
  {
    id: 'SEC021',
    name: 'Disable TLS verification (Node)',
    pattern: '(rejectUnauthorized\\s*:\\s*false|process\\.env\\.NODE_TLS_REJECT_UNAUTHORIZED\\s*=\\s*[\'\"]0[\'\"])',
    risk: 'high',
    message: 'TLS certificate verification disabled detected',
    suggestion: 'Enable verification and use trusted CA to avoid MITM',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'SEC022',
    name: 'CORS allows any origin',
    pattern: '(Access-Control-Allow-Origin\\s*:\\s*\\*|cors\\s*\\(\\s*\\{[^}]*origin\\s*:\\s*[\'\"\\*\'\"])',
    risk: 'medium',
    message: 'CORS allows "*"; may lead to cross-origin data leaks',
    suggestion: 'Only allow trusted origins; use tokens and fine-grained policy',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'SEC023',
    name: 'LDAP injection risk',
    pattern: '((DirContext|InitialDirContext|LdapContext)\\.[a-zA-Z]+\\s*\\([^)]*(\\+|\\$\\{))|(ldap3\\.Connection\\.search\\s*\\([^)]*(\\+|\\$\\{))',
    risk: 'high',
    message: 'String-concatenated LDAP filters detected',
    suggestion: 'Build filters safely and bind parameters; avoid concatenation',
    flags: 'gi',
    extensions: ['.java', '.py']
  },
  {
    id: 'SEC024',
    name: 'XXE (XML External Entity) risk',
    pattern: '(xml\\.etree\\.ElementTree\\.(parse|fromstring)|xml\\.dom\\.minidom\\.(parse|parseString)|DocumentBuilderFactory\\.newInstance\\s*\\(|SAXParserFactory\\.newInstance\\s*\\(|simplexml_load_string\\s*\\(|DOMDocument::loadXML\\s*\\()',
    risk: 'high',
    message: 'XML parsing with external entities not disabled',
    suggestion: 'Disable external entities or use safe libraries (e.g., defusedxml)',
    flags: 'gi',
    extensions: ['.py', '.java', '.php']
  },
  {
    id: 'SEC025',
    name: 'Java HostnameVerifier always returns true',
    pattern: 'new\\s+HostnameVerifier\\s*\\(\\)\\s*\\{[\\s\\S]*?return\\s+true;[\\s\\S]*?\\}',
    risk: 'high',
    message: 'Hostname verification bypass detected for HTTPS',
    suggestion: 'Implement strict hostname verification to avoid permissive behavior',
    flags: 'gi',
    extensions: ['.java']
  },
  {
    id: 'SEC026',
    name: 'Node ignore certificate errors',
    pattern: 'process\\.env\\.NODE_TLS_REJECT_UNAUTHORIZED\\s*=\\s*[\'\"]0[\'\"]',
    risk: 'critical',
    message: 'Global env disables certificate errors detected',
    suggestion: 'Remove the setting and use valid certs or isolate in test env',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'SEC027',
    name: 'Credentials in connection string',
    pattern: '(mongodb|mysql|postgres|redis)://[^@]+:[^@]+@',
    risk: 'high',
    message: 'Username/password hard-coded in connection string detected',
    suggestion: 'Use env variables or secure credential storage; avoid plaintext in code',
    flags: 'gi',
    extensions: ['.js', '.ts', '.py', '.java', '.php', '.rb', '.cs']
  },
  {
    id: 'SEC028',
    name: 'Sensitive data in logs',
    pattern: '(logger\\.(info|debug|warn|error)|console\\.log|print\\()\\s*[^\\)]*(\\b(password|secret|token|api[_\\-]?key)\\s*[=:,]|\\$\\{.*\\b(password|secret|token|api[_\\-]?key)\\b)',
    risk: 'medium',
    message: 'Sensitive information logged',
    suggestion: 'Mask sensitive fields or avoid logging them altogether',
    flags: 'gi',
    extensions: ['.js', '.ts', '.py', '.java', '.php', '.rb']
  },
  {
    id: 'SEC029',
    name: 'Mass Assignment (Rails/Laravel)',
    pattern: '(permit!\\s*\\(|update\\s*\\(\\s*params\\[|::create\\s*\\(\\s*\\$request->all\\s*\\)|->fill\\s*\\(\\s*\\$request->all\\s*\\))',
    risk: 'high',
    message: 'Possible mass assignment risk; no whitelist validation',
    suggestion: 'Enable strong parameters/whitelist; only allow safe fields',
    flags: 'gi',
    extensions: ['.rb', '.php']
  },
  {
    id: 'SEC030',
    name: 'Disable TLS verification (Go)',
    pattern: 'InsecureSkipVerify\\s*:\\s*true',
    risk: 'high',
    message: 'TLS certificate verification disabled in Go detected',
    suggestion: 'Enable verification and use trusted CA; avoid MITM attacks',
    flags: 'gi',
    extensions: ['.go']
  },
  {
    id: 'SEC031',
    name: 'Disable certificate validation (C#)',
    pattern: 'ServicePointManager\\.ServerCertificateValidationCallback',
    risk: 'high',
    message: 'Overriding global certificate validation; may accept any certificate',
    suggestion: 'Remove the override and use proper validation mechanisms',
    flags: 'gi',
    extensions: ['.cs']
  },
  {
    id: 'SEC032',
    name: 'EF Core raw SQL concatenation',
    pattern: 'FromSqlRaw\\s*\\([^\\)]*(\\+|\\$\\{)',
    risk: 'critical',
    message: 'Using FromSqlRaw with string concatenation detected',
    suggestion: 'Use FromSqlInterpolated or parameterized queries to avoid injection',
    flags: 'gi',
    extensions: ['.cs']
  },
  {
    id: 'SEC033',
    name: 'Go system command execution',
    pattern: 'exec\\.Command\\s*\\(',
    risk: 'high',
    message: 'System command execution in Go; injection risk if user input involved',
    suggestion: 'Avoid shell -c and concatenation; whitelist parameters and exec paths',
    flags: 'gi',
    extensions: ['.go']
  },
  {
    id: 'SEC034',
    name: 'Insecure randomness (Go)',
    pattern: 'math\/rand|\\brand\\.(Int|Intn|Float|Read)\\b',
    risk: 'medium',
    message: 'Using math/rand for randomness; not cryptographically secure',
    suggestion: 'Use crypto/rand or secure RNG libraries for tokens and keys',
    flags: 'gi',
    extensions: ['.go']
  }
];