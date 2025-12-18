// 性能规则
export default [
  {
    id: 'PERF001',
    name: '循环内数据库查询',
    pattern: '(for|while)\\s*\\([^)]*\\)\\s*\\{[^}]*\\b(find|query|select|findOne|findMany|findFirst|findUnique|create|update|delete|save)\\s*\\([^}]*\\}',
    risk: 'medium',
    message: '在循环内执行数据库查询，可能导致N+1查询问题',
    suggestion: '使用批量查询或预加载数据',
    flags: 'gi'
  },
  {
    id: 'PERF002',
    name: '内存泄漏风险（定时器使用）',
    pattern: 'setInterval\\s*\\([^)]*\\)|setTimeout\\s*\\([^)]*\\)',
    risk: 'medium',
    message: '发现定时器使用，若未清理可能导致内存泄漏或残留任务',
    suggestion: '确保在适当生命周期调用 clearInterval/clearTimeout 进行清理',
    flags: 'gi',
    // 为了覆盖内置 PERF002，外部规则增加清理检测，若文件中存在任一清理则跳过此规则
    requiresAbsent: ['clearInterval\\s*\\(', 'clearTimeout\\s*\\(']
  },
  {
    id: 'PERF003',
    name: '同步文件IO阻塞',
    pattern: 'fs\\.(readFileSync|writeFileSync|appendFileSync|existsSync|statSync|readdirSync)\\s*\\(',
    risk: 'high',
    message: '检测到同步文件IO，可能阻塞事件循环并影响吞吐',
    suggestion: '优先使用异步IO或队列化处理，避免阻塞主线程',
    flags: 'gi'
  },
  {
    id: 'PERF004',
    name: '循环内网络请求',
    pattern: 'for\s*\([^)]*\)\s*\{[^}]*\b(fetch|axios\.(get|post|put|delete)|requests\.(get|post|put|delete)|http\.get)\b[^}]*\}',
    risk: 'high',
    message: '检测到循环内执行网络请求，可能导致级联延迟与拥塞',
    suggestion: '合并请求、并发控制或批量处理，减少往返次数',
    flags: 'gi'
  },
  {
    id: 'PERF005',
    name: '循环内JSON序列化',
    pattern: 'for\s*\([^)]*\)\s*\{[^}]*JSON\.stringify[^}]*\}',
    risk: 'medium',
    message: '循环内频繁序列化可能导致CPU开销过大',
    suggestion: '将序列化移到循环外或进行缓存/批量处理',
    flags: 'gi'
  },
  {
    id: 'PERF006',
    name: '循环内正则编译',
    pattern: 'for\\s*\\([^)]*\\)\\s*\\{[^}]*new\\s+RegExp\\s*\\([^}]*\\}',
    risk: 'medium',
    message: '循环内重复编译正则会增加不必要的开销',
    suggestion: '将正则常量化或预编译，避免在循环中创建',
    flags: 'gi'
  },
  {
    id: 'PERF007',
    name: '忙等待循环',
    pattern: '(while\\s*\\(\\s*true\\s*\\)|for\\s*\\(\\s*;\\s*;\\s*\\))\\s*\\{[^}]*(?!.*(?:sleep|wait|await|setTimeout|setInterval|yield|break|return))[^}]*\\}',
    risk: 'high',
    message: '检测到可能的忙等待循环，可能导致CPU飙升与资源浪费',
    suggestion: '使用事件驱动或阻塞等待机制，避免空循环',
    flags: 'gi'
  },
  {
    id: 'PERF008',
    name: '循环内DOM布局抖动',
    pattern: 'for\s*\([^)]*\)\s*\{[^}]*(offsetWidth|offsetHeight|getBoundingClientRect)[^}]*\}',
    risk: 'high',
    message: '循环内读取布局信息会触发频繁回流/重绘',
    suggestion: '合并DOM读写、使用批处理、减少同步布局查询',
    flags: 'gi'
  },
  {
    id: 'PERF009',
    name: '阻塞等待（sleep）',
    pattern: '(Thread\\.sleep\\s*\\(|time\\.sleep\\s*\\()',
    risk: 'medium',
    message: '检测到阻塞等待调用，可能降低服务吞吐和响应',
    suggestion: '改用异步等待或限流/队列机制，避免阻塞主线程',
    flags: 'gi'
  },
  {
    id: 'PERF010',
    name: '无界线程池',
    pattern: 'Executors\\.newCachedThreadPool\\s*\\(',
    risk: 'high',
    message: '检测到无界线程池，可能导致线程爆炸与资源枯竭',
    suggestion: '使用有界线程池并设置合理最大值与队列长度',
    flags: 'gi'
  },
  {
    id: 'PERF011',
    name: '循环内字符串拼接',
    pattern: '(for|while)\\s*\\([^)]*\\)\\s*\\{[^}]*\\b\\w+\\s*\\+=\\s*[\'"`]',
    risk: 'medium',
    message: '循环内频繁字符串拼接会造成较大CPU与内存开销',
    suggestion: '使用StringBuilder/列表收集再join，或其他批量化策略',
    flags: 'gi'
  },
  {
    id: 'PERF012',
    name: '循环内创建数据库连接',
    pattern: 'for\\s*\\([^)]*\\)\\s*\\{[^}]*\\b(getConnection|openConnection|new\\s+SqlConnection|mysql_connect|pg_connect|MongoClient\\s*\\()\\b',
    risk: 'high',
    message: '循环内反复创建数据库连接会导致严重性能问题',
    suggestion: '使用连接池与复用策略，在循环外预先获取连接',
    flags: 'gi'
  },
  {
    id: 'PERF013',
    name: 'HTTP请求缺少超时（Python）',
    pattern: 'requests\\.(get|post|put|delete)\\s*\\(',
    risk: 'medium',
    message: '网络请求未设置超时会造成资源悬挂与吞吐下降',
    suggestion: '设置合理的timeout参数，并对重试与熔断进行控制',
    flags: 'gi',
    requiresAbsent: ['timeout\\s*=']
  }
];