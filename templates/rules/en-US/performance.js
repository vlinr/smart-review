// Performance rules (en-US)
export default [
  {
    id: 'PERF001',
    name: 'Database queries inside loops',
    pattern: '(for|while)\\s*\\([^)]*\\)\\s*\\{[^}]*\\b(find|query|select|findOne|findMany|findFirst|findUnique|create|update|delete|save)\\s*\\([^}]*\\}',
    risk: 'medium',
    message: 'Executing DB queries in loops may cause N+1 problems',
    suggestion: 'Use batch queries or preload data',
    flags: 'gi',
    extensions: ['.js', '.ts', '.java', '.py', '.php', '.rb', '.cs', '.go']
  },
  {
    id: 'PERF002',
    name: 'Memory leak risk (timers)',
    pattern: 'setInterval\\s*\\([^)]*\\)|setTimeout\\s*\\([^)]*\\)',
    risk: 'medium',
    message: 'Timers without cleanup may cause leaks or lingering tasks',
    suggestion: 'Call clearInterval/clearTimeout at the proper lifecycle point',
    flags: 'gi',
    extensions: ['.js', '.ts'],
    // To override built-in PERF002, external rule adds cleanup detection; skip if any cleanup exists in file
    requiresAbsent: ['clearInterval\\s*\\(', 'clearTimeout\\s*\\(']
  },
  {
    id: 'PERF003',
    name: 'Synchronous file I/O blocking',
    pattern: 'fs\\.(readFileSync|writeFileSync|appendFileSync|existsSync|statSync|readdirSync)\\s*\\(',
    risk: 'high',
    message: 'Sync file I/O may block the event loop and hurt throughput',
    suggestion: 'Prefer async I/O or queued processing; avoid blocking the main thread',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'PERF004',
    name: 'Network requests inside loops',
    pattern: 'for\\s*\\([^)]*\\)\\s*\\{[^}]*\\b(fetch|axios\\.(get|post|put|delete)|requests\\.(get|post|put|delete)|http\\.get)\\b[^}]*\\}',
    risk: 'high',
    message: 'Requests inside loops can cause cascading latency and congestion',
    suggestion: 'Merge requests, control concurrency, or batch to reduce round-trips',
    flags: 'gi',
    extensions: ['.js', '.ts', '.py']
  },
  {
    id: 'PERF005',
    name: 'JSON serialization inside loops',
    pattern: 'for\\s*\\([^)]*\\)\\s*\\{[^}]*JSON\\.stringify[^}]*\\}',
    risk: 'medium',
    message: 'Frequent serialization in loops causes excessive CPU overhead',
    suggestion: 'Move serialization out of the loop or cache/batch it',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'PERF006',
    name: 'Regex compilation inside loops',
    pattern: 'for\\s*\\([^)]*\\)\\s*\\{[^}]*new\\s+RegExp\\s*\\([^}]*\\}',
    risk: 'medium',
    message: 'Repeated regex compilation adds unnecessary overhead',
    suggestion: 'Precompile or constantize regexes; avoid creating them in loops',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'PERF007',
    name: 'Busy-wait loops',
    pattern: '(while\\s*\\(\\s*true\\s*\\)|for\\s*\\(\\s*;\\s*;\\s*\\))\\s*\\{[^}]*(?!.*(?:sleep|wait|await|setTimeout|setInterval|yield|break|return))[^}]*\\}',
    risk: 'high',
    message: 'Possible busy-wait detected; can spike CPU and waste resources',
    suggestion: 'Use event-driven or blocking waits; avoid empty loops',
    flags: 'gi',
    extensions: ['.js', '.ts', '.java', '.cs', '.php', '.rb']
  },
  {
    id: 'PERF008',
    name: 'Layout thrashing in loops',
    pattern: 'for\\s*\\([^)]*\\)\\s*\\{[^}]*(offsetWidth|offsetHeight|getBoundingClientRect)[^}]*\\}',
    risk: 'high',
    message: 'Reading layout in loops triggers frequent reflow/repaint',
    suggestion: 'Batch DOM reads/writes; reduce synchronous layout queries',
    flags: 'gi',
    extensions: ['.js', '.ts']
  },
  {
    id: 'PERF009',
    name: 'Blocking sleep',
    pattern: '(Thread\\.sleep\\s*\\(|time\\.sleep\\s*\\()',
    risk: 'medium',
    message: 'Blocking waits reduce throughput and responsiveness',
    suggestion: 'Use async waits or rate-limiting/queues; avoid blocking',
    flags: 'gi',
    extensions: ['.java', '.py']
  },
  {
    id: 'PERF010',
    name: 'Unbounded thread pool',
    pattern: 'Executors\\.newCachedThreadPool\\s*\\(',
    risk: 'high',
    message: 'Unbounded pools can explode thread count and exhaust resources',
    suggestion: 'Use bounded pools with sane maximums and queue lengths',
    flags: 'gi',
    extensions: ['.java']
  },
  {
    id: 'PERF011',
    name: 'String concatenation inside loops',
    pattern: '(for|while)\\s*\\([^)]*\\)\\s*\\{[^}]*\\b\\w+\\s*\\+=\\s*[\'"`]',
    risk: 'medium',
    message: 'Frequent concatenation in loops consumes CPU and memory',
    suggestion: 'Use StringBuilder/collect in lists then join, or batch strategies',
    flags: 'gi',
    extensions: ['.js', '.ts', '.java', '.cs', '.py', '.rb']
  },
  {
    id: 'PERF012',
    name: 'Create DB connections in loops',
    pattern: 'for\\s*\\([^)]*\\)\\s*\\{[^}]*\\b(getConnection|openConnection|new\\s+SqlConnection|mysql_connect|pg_connect|MongoClient\\s*\\()\\b',
    risk: 'high',
    message: 'Repeatedly creating DB connections causes severe performance issues',
    suggestion: 'Use connection pools and reuse; acquire connections outside loops',
    flags: 'gi',
    extensions: ['.js', '.ts', '.java', '.cs', '.php']
  },
  {
    id: 'PERF013',
    name: 'HTTP requests without timeout (Python)',
    pattern: 'requests\\.(get|post|put|delete)\\s*\\(',
    risk: 'medium',
    message: 'Requests without timeout can hang resources and reduce throughput',
    suggestion: 'Set reasonable timeout; control retries and circuit breaking',
    flags: 'gi',
    extensions: ['.py'],
    requiresAbsent: ['timeout\\s*=']
  }
];