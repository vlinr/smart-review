import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { prepareForAIWithLineMap } from './utils/strip.js';
import { logger } from './utils/logger.js';
import { AI_CONSTANTS, HTTP_STATUS } from './utils/constants.js';

export class AIClient {
  static nodeVersionWarned = false; // 静态变量，确保只警告一次
  
  constructor(config) {
    this.config = config;
    this.client = null;
    this.segmentCollector = new Map(); // 分段收集器：filePath -> {segments: [], totalSegments: number}
    this.chunkedResponseCollector = new Map(); // 分段响应收集器：requestId -> {chunks: [], isComplete: boolean}
    this.reviewDir = config.reviewDir; // 用于读取自定义AI提示词目录
    
    // 性能优化缓存
    this.promptCache = new Map(); // 缓存自定义提示词
    this.systemPromptCache = null; // 缓存系统提示词
    this.contentCache = new Map(); // 缓存处理后的内容
    this.cacheStats = { hits: 0, misses: 0 };
    
    this.initializeClient();
  }

  initializeClient() {
    const { apiKey, baseURL } = this.config;

    if (!apiKey) {
      throw new Error('未配置AI API密钥');
    }

    // 环境检测：OpenAI SDK 推荐 Node >=18（内置 fetch）。
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if ((nodeMajor < 18 || typeof fetch === 'undefined') && !AIClient.nodeVersionWarned) {
      logger.warn('检测到 Node 版本 < 18 或缺少全局 fetch，可能导致连接异常。建议升级到 Node >=18。');
      AIClient.nodeVersionWarned = true;
    }

    const options = { apiKey, maxRetries: 3 };
    if (baseURL) options.baseURL = baseURL;

    // 当前实现仅支持 OpenAI 客户端
    this.client = new OpenAI(options);
  }

  // 智能批量文件分析：支持分段文件的合并分析
  async analyzeSmartBatch(batchData, originalBatch = null, requestMeta = null) {
    try {
      // 如果是大文件分段批次，改走分段整体分析路径，确保行号为绝对源行号
      if (originalBatch?.isLargeFileSegment) {
        try {
          logger.debug(`检测到分段批次，改用分段整体分析：${originalBatch.segmentedFile}（${originalBatch.totalSegments}段）`);
        } catch (e) {}
        const result = await this.handleSegmentBatch(originalBatch);
        return {
          issues: result.issues || [],
          metadata: {
            batchIndex: originalBatch?.batchIndex,
            fileCount: 1,
            isSegmented: true,
            totalSegments: originalBatch?.totalSegments,
            filePath: originalBatch?.segmentedFile
          }
        };
      }
      // 对于所有批次，执行常规的批量分析逻辑
      const cfg = this.config?.ai || {};
      const includeStaticHints = cfg.includeStaticHints === true;
      const customPrompts = await this.readCustomPrompts();
      const messages = [
        { role: 'system', content: this.getSystemPrompt() },
        {
          role: 'user',
          content: `我会发送一个批次的文件进行代码审查。其中可能包含分段文件（大文件被分成多段）。对于分段文件，请在收到所有段后进行整体分析。每个问题用空行分隔，务必包含"文件路径：绝对路径"与代码片段，且禁止任何"第X行/第X-Y行"等行号或行范围描述。`
        }
      ];

      if (customPrompts.length > 0) {
        messages.push({ role: 'user', content: `\n[自定义提示词]\n${customPrompts.join('\n\n---\n')}` });
      }
      // 处理每个文件
      const requestPreviews = [];
      for (const file of batchData.files) {
        // 完整文件
        const { clean, lineMap } = await prepareForAIWithLineMap(file.content, file.filePath);
        const attachLineNumbers = this.config?.ai?.attachLineNumbersInBatch !== false;
        const contentForAI = attachLineNumbers ? this.addLineNumberPrefixes(clean, lineMap) : clean;
        messages.push({
          role: 'user',
          content: `文件路径：${file.filePath}\n代码内容：\n\`\`\`\n${contentForAI}\n\`\`\``
        });
        requestPreviews.push({ filePath: file.filePath, contentForAI });
      }
      // 汇总静态提示（可选）
      if (includeStaticHints) {
        const hintsParts = [];
        for (const file of batchData.files) {
          const staticIssues = file.staticIssues || [];
          if (staticIssues.length === 0) continue;
          const lines = staticIssues.map((i, idx) => `${idx + 1}. 片段（${i.risk}）：${i.message}${i.suggestion ? `；建议：${i.suggestion}` : ''}；代码片段：${i.snippet || ''}`);
          hintsParts.push(`[本地规则发现的问题 - ${file.filePath}]\n${lines.join('\n')}`);
        }
      if (hintsParts.length > 0) {
          messages.push({ role: 'user', content: hintsParts.join('\n\n') });
        }
      }

      // 添加最终指令，确保包含片段并保留行号前缀
      const finalInstructionBatch = `请逐文件进行审查，每个问题用空行分隔，必须包含"文件路径：绝对路径"与具体的代码片段。禁止使用文字行号或行范围描述（如“第X行/第X-Y行”）；如片段中存在每行的[n]前缀请原样保留。`;
      messages.push({ role: 'user', content: finalInstructionBatch });
      // 追加严格忽略规则，避免模型输出“行号跳跃/预处理移除”的提示
      const finalIgnoreRule = `注意：代码可能经过预处理（剥离注释、跳过无需审查片段），因此行号前缀可能不连续。这是正常的，请严格忽略“行号跳跃/行号不连续/被预处理移除”等现象，不要将其视为问题或风险，也不要提出“检查代码完整性/补全缺失代码”类建议。仅针对给定片段中的有效代码提出问题与修改建议。`;
      messages.push({ role: 'user', content: finalIgnoreRule });
      
      // 使用分段响应处理（携带可读的请求ID，便于日志关联）
      const smartReqId = `smart_batch_${(batchData.files?.length || 0)}_${path.basename(batchData.files?.[0]?.filePath || 'unknown')}`;
      // 输出请求预览，便于定位行号映射问题
      const responseContent = await this.handleChunkedResponse(messages, smartReqId, requestMeta);
      // 批量响应：传递文件列表用于路径匹配
      const fileList = batchData.files.map(f => f.filePath);
      const issues = this.parseAIResponse(responseContent, undefined, { fileList });
      
      // 返回与其他方法一致的格式
      return {
        issues: issues || [],
        metadata: {
          batchIndex: originalBatch?.batchIndex,
          fileCount: batchData.files.length
        }
      };
    } catch (error) {
      logger.error(`AI批量文件分析失败: ${error.message}`);
      // 如果是AI请求失败，应该终止程序而不是继续处理
      if (error.message.includes('Connection error') || error.message.includes('API') || error.message.includes('请求失败')) {
        logger.error('AI服务连接失败，终止分析过程');
        process.exit(1);
      }
      throw error; // 重新抛出错误，让上层调用者处理
    }
  }

  // 处理分段批次：现在所有分段都在一个批次中
  async handleSegmentBatch(batch) {
    const filePath = batch.segmentedFile;
    const totalSegments = batch.totalSegments;
    
    // 现在所有分段都在同一个批次中，直接处理
    const segments = batch.items.map(item => ({
      index: item.chunkIndex,
      content: item.content,
      startLine: item.startLine || 1,
      endLine: item.endLine || 1,
      tokens: item.tokens || 0
    }));
    
    // 按索引排序分段
    segments.sort((a, b) => a.index - b.index);
    
    // 合并分段内容
    const fullContent = segments.map(seg => seg.content).join('\n');
    
    // 构造完整文件对象进行分析
    const fullFile = {
      filePath: filePath,
      content: fullContent,
      isChunked: true,
      totalChunks: totalSegments,
      chunks: segments,
      staticIssues: batch.staticIssues || [],
      // 承载批次上下文，便于分段日志添加“批次 i/x”前缀
      batchIndex: typeof batch.batchIndex === 'number' ? batch.batchIndex : null,
      batchTotal: typeof batch.totalRequests === 'number' ? batch.totalRequests : null
    };
    
    // 进行整体分析 - 这里会显示分段进度
    const result = await this.analyzeCompleteSegmentedFile(fullFile);
    
    // 返回与analyzeSmartBatch一致的格式
    return {
      issues: result.issues || [],
      metadata: result.metadata || {}
    };
  }

  // 分析完整的分段文件
  async analyzeCompleteSegmentedFile(file) {
    try {
      const cfg = this.config?.ai || this.config || {};
      const includeStaticHints = cfg.includeStaticHints === true;
      const customPrompts = await this.readCustomPrompts();
      
      // 并发设置：从配置读取，<=1 则保持串行（兼容顶层/嵌套两种配置形态）
      const segConcurrency = Math.max(1, Number((this.config?.ai?.concurrency ?? this.config?.concurrency) || 1));
      const effectiveTotal = Array.isArray(file.chunks) ? file.chunks.length : (file.totalChunks || 1);
      const availableSlots = this.concurrencyLimiter ? this.concurrencyLimiter.getAvailable() : segConcurrency;
      const workersHead = Math.max(1, Math.min(availableSlots, effectiveTotal));
      const totalNote = (file.totalChunks && file.totalChunks !== effectiveTotal)
        ? `（总段数 ${file.totalChunks}，当前批次 ${effectiveTotal}）`
        : '';
      logger.progress(`开始逐段分析文件: ${file.filePath}，共 ${effectiveTotal} 段${workersHead > 1 ? `（并发 ${workersHead}）` : ''}${totalNote}`);

      const allIssues = [];

      // 单段分析函数（复用原有逻辑）
      const analyzeOne = async (i) => {
        const chunk = file.chunks[i];

        // 提前让出事件循环，允许并发协程启动
        // 注意：真正的“开始分析第X/段”提示将在取得并发许可后输出
        logger.debug(`分段待启动：第 ${i + 1}/${effectiveTotal} 段 (行 ${chunk.startLine}-${chunk.endLine})`) ;

        // 立即让出事件循环，让其他并发协程尽快启动打印日志
        await Promise.resolve();

        // 使用缓存避免重复处理相同内容
        const contentKey = `${file.filePath}:${chunk.startLine}-${chunk.endLine}:${chunk.content.length}`;
        let clean;
        let lineMapAbs = null;

        if (this.contentCache.has(contentKey)) {
          this.cacheStats.hits++;
          const cached = this.contentCache.get(contentKey);
          clean = cached.clean;
          lineMapAbs = cached.lineMapAbs || null;
        } else {
          this.cacheStats.misses++;
          const prepared = await prepareForAIWithLineMap(chunk.content, file.filePath);
          clean = prepared.clean || prepared.cleaned || prepared;
          const lm = prepared.lineMap || [];
          lineMapAbs = Array.isArray(lm) ? lm.map(n => (Number(n) || 0) + (chunk.startLine - 1)) : null;
          this.contentCache.set(contentKey, { clean, lineMapAbs });
        }

        // 预处理完成后将继续派发AI请求

        try {
          // 构建分段分析消息
          let messages = [
            { role: 'system', content: this.getSystemPrompt() }
          ];

          // 添加自定义提示词
          if (customPrompts && customPrompts.length > 0) {
            messages.push({ role: 'user', content: `\n[自定义提示词]\n${customPrompts.join('\n\n---\n')}` });
          }

          // 构建分段分析提示
          const attachLineNumbers = (this.config?.ai?.attachLineNumbersInBatch ?? this.config?.attachLineNumbersInBatch) !== false;
          const contentForAI = attachLineNumbers ? this.addLineNumberPrefixes(clean, lineMapAbs) : clean;

          const segmentPrompt = `请对以下代码段进行完整的代码审查分析。这是一个大文件的第 ${i + 1}/${file.totalChunks} 段：

文件路径：${file.filePath}
代码内容：
\`\`\`
${contentForAI}
\`\`\`

请仔细审查这段代码，查找以下类型的问题：
- 类型安全问题（如使用any类型）
- 安全漏洞
- 性能问题
- 代码质量问题
- 最佳实践违反

重要：请立即开始分析，不要只是确认收到。必须按以下格式输出每个发现的问题：

**-----代码分析结果-----**
文件路径：${file.filePath}
代码片段：[具体的问题代码]
风险等级：[高/中/低]
风险原因：[问题描述]
修改建议：[具体的修改建议]

如果发现多个问题，每个问题都要用 **-----代码分析结果-----** 开头。
如果没有发现问题，请回复：

**-----代码分析结果-----**
本段代码无明显问题

注意：如片段中每行包含形如 [n] 的源行号前缀，请在你的输出的代码片段中原样保留这些前缀，以便后续定位。`;

          messages.push({
            role: 'user',
            content: segmentPrompt
          });

          // 添加静态提示（如果有且属于当前分段）
          if (includeStaticHints && file.staticIssues && file.staticIssues.length > 0) {
            const segmentStaticIssues = file.staticIssues.filter(issue => 
              issue.line >= chunk.startLine && issue.line <= chunk.endLine
            );
            if (segmentStaticIssues.length > 0) {
              const lines = segmentStaticIssues.map((si, idx) => `${idx + 1}. 片段（${si.risk}）：${si.message}${si.suggestion ? `；建议：${si.suggestion}` : ''}；代码片段：${si.snippet || ''}`);
              messages.push({ role: 'user', content: `[本地规则发现的问题 - 第${i + 1}段]\n${lines.join('\n')}` });
            }
          }
          
          // 发送分段分析请求
          const segReqId = `segment_${path.basename(file.filePath)}_${i + 1}of${file.totalChunks}`;
          const startLabel = `开始分析 ${file.filePath} 第 ${i + 1}/${effectiveTotal} 段（行 ${chunk.startLine}-${chunk.endLine}）`;
          const responseContent = await this.handleChunkedResponse(messages, segReqId, { onStart: () => logger.info(startLabel) });
          
          // 解析分段响应
          const segmentResult = this.parseAIResponse(responseContent, file.filePath, {});
          
          const batchPrefix = (typeof file.batchIndex === 'number' && typeof file.batchTotal === 'number')
            ? `批次 ${file.batchIndex + 1}/${file.batchTotal} `
            : '';
          if (Array.isArray(segmentResult)) {
            allIssues.push(...segmentResult);
            logger.success(`${batchPrefix}（${file.filePath}）第 ${i + 1} 段分析完成，发现 ${segmentResult.length} 个问题`);
          } else if (segmentResult && segmentResult.issues) {
            allIssues.push(...segmentResult.issues);
            logger.success(`${batchPrefix}（${file.filePath}）第 ${i + 1} 段分析完成，发现 ${segmentResult.issues.length} 个问题`);
          } else {
            logger.success(`${batchPrefix}（${file.filePath}）第 ${i + 1} 段分析完成，发现 0 个问题`);
          }
        } catch (error) {
          logger.error(`第 ${i + 1} 段分析失败: ${error.message}`);
        }
      };

      // 按配置执行并发或串行
      const total = effectiveTotal;
      const workers = Math.max(1, Math.min((this.concurrencyLimiter ? this.concurrencyLimiter.getAvailable() : segConcurrency), total));
      const schedNote = (file.totalChunks && file.totalChunks !== total)
        ? `（总段数 ${file.totalChunks}，本批次处理 ${total} 段）`
        : '';
    // 调度细节降为调试级别，避免扰乱终端主要进度
    logger.debug(`分段并发调度：workers=${workers}, total=${total}${schedNote}`);
      if (workers <= 1) {
        for (let i = 0; i < total; i++) {
          // eslint-disable-next-line no-await-in-loop
          await analyzeOne(i);
        }
      } else {
        let cursor = 0;
        const runWorker = async (workerId) => {
      // 并发协程启动提示降为调试级别
      logger.debug(`启动分段并发协程 #${workerId}`);
          while (true) {
            const i = cursor++;
            if (i >= total) break;
            // eslint-disable-next-line no-await-in-loop
            await analyzeOne(i);
          }
        };
        await Promise.all(Array.from({ length: workers }, (_, idx) => runWorker(idx + 1)));
        logger.debug(`分段并发完成：已处理 ${total}${file.totalChunks && file.totalChunks !== total ? `/${file.totalChunks}` : ''} 段`);
      }

      return {
        issues: allIssues,
        metadata: {
          totalSegments: file.totalChunks,
          filePath: file.filePath
        }
      };
      
    } catch (error) {
      logger.error(`分段文件分析失败: ${error.message}`);
      // 如果是AI请求失败，应该终止程序而不是继续处理
      if (error.message.includes('Connection error') || error.message.includes('API') || error.message.includes('请求失败')) {
        logger.error('AI服务连接失败，终止分析过程');
        process.exit(1);
      }
      throw error; // 重新抛出错误，让上层调用者处理
    }
  }

  /**
   * Git Diff文件分析 - 专门审查变动内容
   * @param {Object} fileData diff审查数据
   * @param {Object} options 选项
   * @returns {Array} 问题列表
   */
  async analyzeDiffFile(fileData, options = {}) {
    try {
      const cfg = this.config?.ai || {};
      const includeStaticHints = cfg.includeStaticHints === true;
      const customPrompts = await this.readCustomPrompts();
      const staticIssues = options.staticIssues || [];
      
      logger.debug(`开始Git Diff分析: ${fileData.filePath} (${fileData.totalAddedLines} 行新增代码)`);
      
      // 构建diff专用的系统提示词
      const diffSystemPrompt = this.getDiffSystemPrompt();
      
      const messages = [
        { role: 'system', content: diffSystemPrompt }
      ];

      // 添加自定义提示词
      if (customPrompts && customPrompts.length > 0) {
        messages.push({ role: 'user', content: `\n[自定义提示词]\n${customPrompts.join('\n\n---\n')}` });
      }

      // 构建diff分析提示
      const diffPrompt = `请对以下Git变更进行代码审查。重点关注新增的代码行（+号标记），上下文代码仅供理解，无需审查。

文件路径：${fileData.filePath}
新增代码行数：${fileData.totalAddedLines}
智能分段数：${fileData.segments.length}

变更内容：`;

      messages.push({ role: 'user', content: diffPrompt });

      // 添加每个智能分段
      for (let i = 0; i < fileData.segments.length; i++) {
        const segment = fileData.segments[i];
        const segmentPrompt = `
[智能分段 ${i + 1}/${fileData.segments.length}] (行范围: ${segment.startLine}-${segment.endLine}, 新增${segment.addedLinesCount}行, 约${segment.estimatedTokens} tokens)
\`\`\`diff
${segment.content}
\`\`\``;
        
          messages.push({ role: 'user', content: segmentPrompt });
          // 追加严格忽略规则，避免模型输出“行号跳跃/预处理移除”的提示
          messages.push({ role: 'user', content: `重要：该分段可能经过预处理，行号可能不连续。请严格忽略“行号跳跃/行号不连续/被预处理移除”等现象，不要将其视为问题或风险，也不要提出“检查代码完整性/补全缺失代码”类建议。` });
      }

      // 添加静态分析提示（如果有）
      if (includeStaticHints && staticIssues.length > 0) {
        const hintLines = staticIssues.map((issue, idx) => 
          `${idx + 1}. 风险等级：${issue.risk}，问题：${issue.message}${issue.suggestion ? `，建议：${issue.suggestion}` : ''}，代码片段：${issue.snippet || ''}`
        );
        const hintsPrompt = `\n[本地规则发现的问题]\n${hintLines.join('\n')}`;
        messages.push({ role: 'user', content: hintsPrompt });
      }

      // 添加最终指令
      const finalInstruction = `
请仅对标记为"+"的新增代码行进行审查，忽略删除行（-）和上下文行。每个问题用空行分隔，必须包含"文件路径：${fileData.filePath}"和具体的代码片段。禁止使用文字行号或行范围描述（如“第X行/第X-Y行”）；如片段中存在每行的[行号]前缀请原样保留。`;
      
      messages.push({ role: 'user', content: finalInstruction });
      // 追加严格忽略规则，避免模型输出“行号跳跃/预处理移除”的提示
      messages.push({ role: 'user', content: `注意：变更内容可能经过预处理（剥离注释、跳过无需审查片段），新增片段中的源行号可能不连续。这是正常的，请严格忽略“行号跳跃/行号不连续/被预处理移除”等现象，不要将其视为问题或风险，也不要提出“检查代码完整性/补全缺失代码”类建议。仅针对给定片段中的有效新增代码提出问题与修改建议。` });

      // 记录请求信息
      logger.debug(`发送Git Diff AI请求 - 模型: ${this.config.model ?? 'gpt-3.5-turbo'}, 消息数: ${messages.length}`);

      // 发送请求并处理响应
      const diffReqId = `diff_${path.basename(fileData.filePath)}`;
      const responseContent = await this.handleChunkedResponse(messages, diffReqId);
      const issues = this.parseAIResponse(responseContent, fileData.filePath);
      
      logger.debug(`Git Diff分析完成: ${fileData.filePath}，发现 ${issues.length} 个问题`);
      
      return issues || [];
      
    } catch (error) {
      logger.error(`Git Diff文件分析失败: ${error.message}`);
      if (error.message.includes('Connection error') || error.message.includes('API') || error.message.includes('请求失败')) {
        logger.error('AI服务连接失败，终止分析过程');
        process.exit(1);
      }
      throw error;
    }
  }

  // 批量文件分析：一次请求发送多个文件的完整内容
  async analyzeFilesBatch(entries) {
    try {
      const cfg = this.config?.ai || {};
      const includeStaticHints = cfg.includeStaticHints === true;
      const customPrompts = await this.readCustomPrompts();

      const messages = [
        { role: 'system', content: this.getSystemPrompt() },
        {
          role: 'user',
          content: `我会一次性发送多个文件的完整代码，请逐文件进行审查并返回结果。每个问题用空行分隔，务必包含"文件路径：绝对路径"与代码片段，且禁止任何"第X行/第X-Y行"等行号或行范围描述。`
        }
      ];

      if (customPrompts.length > 0) {
        messages.push({ role: 'user', content: `\n[自定义提示词]\n${customPrompts.join('\n\n---\n')}` });
      }

      // 逐文件添加内容
      const requestPreviews = [];
      for (let i = 0; i < entries.length; i++) {
        const { filePath, content, failedStatic } = entries[i];
        const { clean, lineMap } = await prepareForAIWithLineMap(content, filePath);
        const attachLineNumbers = this.config?.ai?.attachLineNumbersInBatch !== false;
        const contentForAI = attachLineNumbers ? this.addLineNumberPrefixes(clean, lineMap) : clean;
        messages.push({
          role: 'user',
          content: `文件路径：${filePath}${failedStatic ? '（本地审查未通过）' : ''}\n代码内容：\n\`\`\`\n${contentForAI}\n\`\`\``
        });
        requestPreviews.push({ filePath, contentForAI });
      }

      // 汇总静态提示（可选）
      if (includeStaticHints) {
        const hintsParts = [];
        for (const e of entries) {
          if (e.failedStatic !== true) continue; // 仅针对本地未通过的文件汇总静态提示
          const staticIssues = e.staticIssues || [];
          if (staticIssues.length === 0) continue;
          const lines = staticIssues.map((i, idx) => `${idx + 1}. 片段（${i.risk}）：${i.message}${i.suggestion ? `；建议：${i.suggestion}` : ''}；代码片段：${i.snippet || ''}`);
          hintsParts.push(`[本地规则发现的问题 - ${e.filePath}]\n${lines.join('\n')}`);
        }
      if (hintsParts.length > 0) {
          messages.push({ role: 'user', content: hintsParts.join('\n\n') });
        }
      }

      // 添加最终指令，确保包含片段并保留行号前缀
      const finalInstructionBatch = `请逐文件进行审查，每个问题用空行分隔，必须包含"文件路径：绝对路径"与具体的代码片段。禁止使用文字行号或行范围描述（如“第X行/第X-Y行”）；如片段中存在每行的[n]前缀请原样保留。`;
      messages.push({ role: 'user', content: finalInstructionBatch });
      const useDynamic = (this.config?.ai?.dynamicMaxTokens !== false);
      const contextWindow = (() => {
        const cw = Number(this.config.contextWindow ?? AI_CONSTANTS.DEFAULT_CONTEXT_WINDOW);
        return Number.isFinite(cw) ? cw : AI_CONSTANTS.DEFAULT_CONTEXT_WINDOW;
      })();
      const reserve = (() => {
        const rv = Number(this.config.outputReserveTokens ?? AI_CONSTANTS.DEFAULT_OUTPUT_RESERVE_TOKENS);
        return Number.isFinite(rv) ? rv : AI_CONSTANTS.DEFAULT_OUTPUT_RESERVE_TOKENS;
      })();
      const totalChars = messages.reduce((acc, m) => acc + String(m.content || '').length, 0);
      const inputTokensEst = Math.ceil(totalChars / AI_CONSTANTS.CHARS_PER_TOKEN);
      const dynamicBudget = Math.max(AI_CONSTANTS.MIN_DYNAMIC_BUDGET, Math.min(AI_CONSTANTS.MAX_DYNAMIC_BUDGET, contextWindow - inputTokensEst - reserve));
      const response = await this.chatWithRetry({
        model: this.config.model ?? 'gpt-3.5-turbo',
        messages,
        temperature: this.config.temperature !== undefined ? this.config.temperature : 0.1,
        max_tokens: (() => {
          if (useDynamic) {
            const upper = Number(this.config.maxResponseTokens ?? dynamicBudget);
            const safeUpper = Number.isFinite(upper) ? upper : dynamicBudget;
            return Math.max(1, Math.floor(Math.min(dynamicBudget, safeUpper)));
          }
          const raw = this.config.maxResponseTokens ?? AI_CONSTANTS.DEFAULT_MAX_RESPONSE_TOKENS;
          const num = typeof raw === 'number' ? raw : Number(raw);
          if (!Number.isFinite(num) || Number.isNaN(num)) return AI_CONSTANTS.DEFAULT_MAX_RESPONSE_TOKENS;
          const min = 1;
          const max = AI_CONSTANTS.MAX_RESPONSE_TOKENS_LIMIT;
          return Math.min(max, Math.max(min, Math.floor(num)));
        })()
      });
      // 批量响应：不传单个 filePath，让解析函数从AI返回的“文件名称：”中读取
      return this.parseAIResponse(response.choices[0].message.content, undefined, {});
    } catch (error) {
      logger.error(`AI批量文件分析失败: ${error.message}`);
      return [];
    }
  }

  // 通用重试封装：对 AI 请求进行重试与指数退避，处理临时失败/限流/服务器错误
  // 通用重试封装：支持在获取并发许可后触发 onStart 钩子
  async chatWithRetry(params, meta = null) {
    const retries = Number(this.config.requestRetries ?? AI_CONSTANTS.DEFAULT_REQUEST_RETRIES);
    const baseDelay = Number(this.config.requestBackoffMs ?? AI_CONSTANTS.DEFAULT_REQUEST_BACKOFF_MS);
    let attempt = 0;
    while (true) {
      let release = null;
      try {
        if (this.concurrencyLimiter) {
          release = await this.concurrencyLimiter.acquire();
          // 获取到并发许可后再输出“开始分析”提示
          if (meta && typeof meta.onStart === 'function') {
            try { meta.onStart(); } catch (e) {}
          }
        }
        const res = await this.client.chat.completions.create(params);
        // 在释放并发许可之前触发成功钩子，以确保进度日志和批次完成日志先于后续开始日志
        if (meta && typeof meta.onSuccess === 'function') {
          try { meta.onSuccess(res); } catch (e) {}
        }
        return res;
      } catch (error) {
        if (release) {
          try { release(); } catch (e) {}
          release = null;
        }
        attempt++;
        const status = error?.status ?? (error?.response?.status);
        const retriable = (
          status === undefined || status === HTTP_STATUS.TOO_MANY_REQUESTS || (typeof status === 'number' && status >= HTTP_STATUS.INTERNAL_SERVER_ERROR && status < HTTP_STATUS.SERVER_ERROR_UPPER_BOUND)
        );
        if (attempt > retries || !retriable) {
          throw error;
        }
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.warn(`AI请求失败，重试(${attempt}/${retries})，等待 ${delay}ms: ${error.message}`);
        await new Promise((r) => setTimeout(r, delay));
      } finally {
        if (release) {
          try { release(); } catch (e) {}
        }
      }
    }
  }

  getSystemPrompt() {
    // 使用缓存避免重复构建系统提示词
    if (this.systemPromptCache) {
      this.cacheStats.hits++;
      return this.systemPromptCache;
    }
    
    this.cacheStats.misses++;
    this.systemPromptCache = `你是一个专业的代码审查与优化专家。请以通用的方式对收到的代码进行全面审查，识别不合理实现与潜在问题，并提出切实可行的修复或优化建议。

**分段响应协议：**
如果你的回答内容过长，可能超出单次响应的token限制，请按以下格式进行分段：

1. 在每段结尾添加分段标记：
   - 未完成：[CHUNK_CONTINUE]
   - 已完成：[CHUNK_END]
   - 分段索引：[CHUNK_X/Y]（X为当前段，Y为总段数）

2. 示例格式：
   \`\`\`
   这是第一段分析内容...
   [CHUNK_1/3]
   [CHUNK_CONTINUE]
   \`\`\`

3. 当收到"继续"时，请继续输出下一段内容。

4. 最后一段必须以 [CHUNK_END] 结尾。

**代码分析输出格式**
请严格按照以下格式返回分析结果，每个问题必须使用开始/结束标记包裹，并以空行分隔：

**-----代码分析结果开始-----**
文件路径：{文件路径}
代码片段：{具体的给定审查代码的原始片段内容，不允许丢失任何字符，仅当问题属于全局性或架构性问题时才可留空}
风险等级：{致命/高危/中危/低危/建议}
风险原因：{详细原因（必须包含证据：代码片段）}
修改建议：{具体建议（允许多行）}
**-----代码分析结果结束-----**

若输入中包含"[本地规则发现的问题]"，请顺便判断本地规则是否是误报，如是误报返回对应规则,并在"风险原因"中说明误报理由；若不是误报可忽略该对应本地规则。

风险等级及范围定义：

**致命级别**：可能导致系统崩溃、数据丢失、严重安全漏洞
- 前端：未捕获的异常导致页面崩溃、XSS攻击漏洞、敏感信息泄露到控制台、无限递归导致浏览器卡死、计时器未清理等
- 后端：空指针异常、数据库连接泄露、SQL注入、未授权的数据访问、死循环导致服务器宕机等
- 引擎/核心：内存泄漏、缓冲区溢出、竞态条件、资源未释放、关键算法错误等

**高危级别**：可能导致安全漏洞、数据泄露、业务逻辑错误
- 前端：CSRF攻击风险、本地存储敏感数据、不安全的API调用、用户输入未验证等
- 后端：密码硬编码、权限验证缺失、敏感数据未加密、API接口未鉴权、文件上传漏洞等
- 引擎/核心：加密算法使用错误、随机数生成不安全、配置文件暴露、日志记录敏感信息等

**中危级别**：可能影响系统稳定性、性能问题、用户体验
- 前端：组件重复渲染、大量DOM操作、未优化的网络请求、内存占用过高、响应式设计问题等
- 后端：数据库查询未优化、缓存策略不当、线程池配置不合理、API响应时间过长等
- 引擎/核心：算法复杂度过高、资源使用效率低、并发处理能力不足、错误处理机制不完善等

**低危级别**：代码质量问题、不符合最佳实践、可维护性问题
- 前端：组件职责不清、状态管理混乱、样式代码重复、TypeScript类型定义不准确等
- 后端：代码重复、函数过长、类设计不合理、异常处理不规范、日志记录不完整等
- 引擎/核心：模块耦合度高、接口设计不清晰、命名规范不统一、注释缺失等

**建议级别**：改进建议，不影响功能，提升代码质量
- 前端：组件拆分优化、Hook使用优化、CSS样式优化、代码格式化、变量命名改进、未使用变量清理等
- 后端：方法重构、参数验证完善、返回值优化、代码注释补充、单元测试覆盖等
- 引擎/核心：性能监控添加、配置参数调优、文档完善、代码结构优化、版本兼容性等

**代码片段格式要求：**
1. 必须提供具体的原始代码片段内容，直接返回纯文本代码，不要使用markdown代码块格式（如\`\`\`typescript等）
2. 仅在以下全局性或架构性问题时才可留空：
   - 整体项目架构设计问题
   - 跨多个文件的设计模式问题
   - 全局配置或依赖管理问题
   - 整体代码组织结构问题
3. 对于具体的代码问题（如函数、变量、语句等），必须提供相关的代码片段作为证据
4. 提供的原始内容，不允许以任何形式导致字符丢失，必须保证提供的内容准确性
5. 若输入中包含每行的\`[n]\`行号前缀（例如\`[123]\`），请原样保留这些前缀作为片段的一部分，不要自行生成、修改或移除行号

禁止使用文字描述的行号或行范围（如“第X行/第X-Y行”）；允许片段中的\`[n]\`前缀，它是输入的一部分

**行号说明与误报避免：**
1. 我可能会对代码进行预处理（剥离注释、跳过标记为“无需审查”的片段等），因此片段中的\`[n]\`源行号可能出现不连续（例如从278直接跳到294）。这是正常现象，不代表代码缺失或结构问题。
2. 严禁将“行号不连续/行号跳跃/注释行号不连续”等现象判定为问题或风险原因；遇到此类情况请直接忽略，不要输出相应的风险或建议。

**不在审查范围（必须忽略）：**
1. 预处理造成的元信息差异：行号不连续/跳跃、注释移除、被标记为“无需审查”的片段剥离。
2. 展示层的占位或截断标记（如“中间省略”）。
3. 请不要在任何输出字段（风险原因、建议或片段）中提及“行号跳跃”、“行号不连续”、“被预处理移除”等措辞；若遇到此类情况，直接忽略，不要生成问题。

**重点分析领域：**

1. **安全问题**：
   - 输入验证缺失、SQL注入、XSS攻击、CSRF漏洞等
   - 敏感信息硬编码（密码、API密钥、令牌等）
   - 权限验证缺失、未授权访问、数据泄露风险等
   - 不安全的加密算法、随机数生成、文件操作等

2. **性能问题**：
   - 算法复杂度过高、嵌套循环、递归深度等
   - 内存泄漏、资源未释放、缓存策略不当等
   - 数据库查询未优化、N+1查询问题等
   - 前端组件重复渲染、大量DOM操作、网络请求优化等

3. **代码质量问题**：
   - 函数过长、类职责不清、代码重复等
   - 复杂的条件判断、深层嵌套、魔法数字等
   - 变量命名不规范、类型定义不准确等
   - 异常处理不完善、错误信息不明确等

4. **架构与设计问题**：
   - 模块耦合度过高、依赖关系混乱等
   - 设计模式使用不当、接口设计不合理等
   - 配置管理问题、环境变量使用等
   - 单元测试覆盖率、可测试性设计等

**代码片段与行号约束**：
- 如输入片段存在每行的\`[行号]\`前缀，请原样保留，它是输入的一部分
- 禁止使用文字描述的行号或行范围（如“第X行/第X-Y行”）；必须以片段呈现问题

**行号说明与误报避免（必须遵守）**：
- 由于预处理（剥离注释、跳过无需审查片段等），片段中的\`[n]\`源行号可能不连续。这是正常的，务必严格忽略“行号不连续/行号跳跃/被预处理移除”等现象，不得将其视为问题或风险原因，不得提出“检查代码完整性/补全缺失代码”等建议。
- 输出中禁止出现相关措辞（如“行号跳跃”、“行号不连续”、“被预处理移除”）。如遇此类情形请直接忽略，不要生成任何问题。
`;
     
     return this.systemPromptCache;
  }

  /**
   * Git Diff专用系统提示词
   * @returns {string} diff专用系统提示词
   */
  getDiffSystemPrompt() {
    return `你是一个专业的代码审查与优化专家，专门负责Git变更的增量代码审查。

**Git Diff增量审查说明：**
1. 你将收到Git diff格式的代码变更，包含新增行（+）、删除行（-）和上下文行
2. **重要：仅对新增行（+号标记）进行审查，删除行（-）和上下文行仅供理解代码逻辑，无需审查**
3. 上下文行的作用是帮助你理解新增代码的执行环境和逻辑关系
4. 专注于新增代码可能引入的问题，而不是整个文件的问题

**代码分析输出格式**
请严格按照以下格式返回分析结果，每个问题必须使用开始/结束标记包裹，并以空行分隔：

**-----Git Diff代码分析结果开始-----**
文件路径：{文件路径}
代码片段：{具体的新增代码片段（+号标记的内容），不包含+号前缀；如片段中存在每行的[行号]前缀，请原样保留}
风险等级：{致命/高危/中危/低危/建议}
风险原因：{详细原因，重点说明新增代码可能引入的问题}
修改建议：{针对新增代码的具体修改建议（允许多行）}
**-----Git Diff代码分析结果结束-----**

**风险等级定义（专注于新增代码）：**

**致命级别**：新增代码可能导致系统崩溃、数据丢失、严重安全漏洞
- 新增的未捕获异常、空指针引用、无限循环
- 新增的SQL注入、XSS攻击漏洞、敏感信息泄露
- 新增的内存泄漏、资源未释放、死锁风险

**高危级别**：新增代码可能导致安全漏洞、数据泄露、业务逻辑错误
- 新增的权限验证缺失、未授权访问
- 新增的密码硬编码、敏感数据未加密
- 新增的不安全API调用、输入验证缺失

**中危级别**：新增代码可能影响系统稳定性、性能问题
- 新增的性能瓶颈、算法复杂度过高
- 新增的数据库查询未优化、缓存策略不当
- 新增的组件重复渲染、内存占用过高

**低危级别**：新增代码的质量问题、不符合最佳实践
- 新增的代码重复、函数过长、命名不规范
- 新增的异常处理不规范、日志记录不完整
- 新增的类型定义不准确、注释缺失

**建议级别**：新增代码的改进建议，提升代码质量
- 新增代码的格式化、变量命名改进
- 新增代码的重构建议、性能优化
- 新增代码的单元测试覆盖、文档完善

**重点关注新增代码的问题：**
1. **安全风险**：新增代码是否引入安全漏洞
2. **性能影响**：新增代码是否影响系统性能
3. **逻辑错误**：新增代码是否存在业务逻辑错误
4. **兼容性**：新增代码是否与现有代码兼容
5. **可维护性**：新增代码是否易于维护和扩展

**代码片段要求：**
- 只提供新增的代码片段（去除+号前缀，同时保留每行的\`[行号]\`前缀）
- 不要包含上下文行或删除行
- 确保代码片段的准确性，不允许字符丢失
- 禁止使用文字描述的行号或行范围；允许片段中的\`[n]\`前缀，它是输入的一部分

**行号说明与误报避免：**
- 由于仅审查新增行以及上游可能进行的预处理（如剥离注释、跳过无需审查片段），片段中的\`[n]\`源行号可能出现不连续。这是正常的，请不要将“行号不连续/行号跳跃”等现象视为问题或风险原因，务必忽略。

**不在审查范围（必须忽略）：**
- 预处理引起的行号不连续/跳跃、注释或无需审查内容的移除。
- 展示预览的占位或截断标记（如“中间省略”）。
- 输出中禁止出现“行号跳跃”、“行号不连续”、“被预处理移除”等措辞；如遇此类情形请忽略，不要生成任何问题。

记住：你的任务是审查新增的代码变更，帮助开发者在代码合并前发现和修复潜在问题。`;
  }
 
  getCacheStats() {
    return {
      hits: this.cacheStats.hits,
      misses: this.cacheStats.misses,
      hitRate: this.cacheStats.hits / (this.cacheStats.hits + this.cacheStats.misses) || 0,
      systemPromptCached: !!this.systemPromptCache,
      promptCacheSize: this.promptCache.size,
      contentCacheSize: this.contentCache.size
    };
  }

  async readCustomPrompts() {
    try {
      if (!this.reviewDir) return [];
      
      const rulesDir = path.join(this.reviewDir, 'ai-rules');
      const cacheKey = rulesDir;
      
      // 检查缓存
      if (this.promptCache.has(cacheKey)) {
        this.cacheStats.hits++;
        return this.promptCache.get(cacheKey);
      }
      
      this.cacheStats.misses++;
      
      if (!fs.existsSync(rulesDir)) {
        this.promptCache.set(cacheKey, []);
        return [];
      }
      
      const files = fs.readdirSync(rulesDir);
      const prompts = [];
      
      for (const file of files) {
        const filePath = path.join(rulesDir, file);
        if (fs.statSync(filePath).isFile()) {
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            if (content && content.trim()) {
              prompts.push(content.trim());
            }
          } catch (e) {
            logger.warn(`读取AI提示文件失败 ${filePath}:`, e.message);
          }
        }
      }
      
      // 缓存结果
      this.promptCache.set(cacheKey, prompts);
      return prompts;
    } catch (error) {
      logger.warn('读取自定义AI提示词失败:', error.message);
      return [];
    }
  }

  parseAIResponse(response, filePath, context = {}) {
    if (!response || response.trim() === '无') {
      // 仅误报判定模式下，允许返回"无"，不再生成占位建议
      return [];
    }

    const issues = [];

    // 优先：按开始/结束标记提取块
    const markerRegexes = [
      /\*\*-----代码分析结果开始-----\*\*([\s\S]*?)\*\*-----代码分析结果结束-----\*\*/g,
      /\*\*-----Git Diff代码分析结果开始-----\*\*([\s\S]*?)\*\*-----Git Diff代码分析结果结束-----\*\*/g
    ];
    let hasStandardFormat = false;
    for (const re of markerRegexes) {
      const matches = Array.from(response.matchAll(re));
      if (matches.length > 0) {
        hasStandardFormat = true;
        for (const m of matches) {
          const block = m[1].trim();
          const issue = this.parseIssueBlock(block, filePath, context);
          if (issue) issues.push(issue);
        }
      }
    }

    // 兼容旧格式：单头标记（无结束标记），按空行分块
    if (!hasStandardFormat) {
      let blocks = response.split('\n\n');
      for (const block of blocks) {
        if (block.includes('**-----代码分析结果-----**') || block.includes('**-----Git Diff代码分析结果-----**')) {
          hasStandardFormat = true;
          const issue = this.parseIssueBlock(block, filePath, context);
          if (issue) issues.push(issue);
        }
      }
    }
    
    // 如果没有找到标准格式，尝试解析实际的AI响应格式（问题1:, 问题2: 等）
    if (!hasStandardFormat) {
      // 按问题编号分割
      const problemBlocks = this.splitByProblemNumbers(response);
      for (const block of problemBlocks) {
        const issue = this.parseIssueBlock(block, filePath, context);
        if (issue) {
          issues.push(issue);
        }
      }
    }

    // 若解析不到任何块，但存在本地问题，输出占位建议
    if (issues.length === 0 && Array.isArray(context.staticIssues) && context.staticIssues.length > 0) {
      return context.staticIssues.map((i) => ({
        file: filePath,
        source: 'ai',
        risk: i.risk || 'suggestion',
        message: `基于本地规则：${i.message}`,
        suggestion: i.suggestion || '请根据本地规则进行复核与修复，并补充测试与监控以验证风险。',
        snippet: i.snippet || ''
      }));
    }

    return issues;
  }

  // 新增方法：按问题编号分割响应内容
  splitByProblemNumbers(response) {
    const blocks = [];
    const lines = response.split('\n');
    let currentBlock = [];
    
    for (const line of lines) {
      // 检查是否是新问题的开始（问题1:, 问题2: 等）
      if (/^问题\d+[:：]/.test(line.trim())) {
        // 如果当前块有内容，保存它
        if (currentBlock.length > 0) {
          blocks.push(currentBlock.join('\n'));
          currentBlock = [];
        }
      }
      currentBlock.push(line);
    }
    
    // 添加最后一个块
    if (currentBlock.length > 0) {
      blocks.push(currentBlock.join('\n'));
    }
    
    return blocks;
  }

  parseIssueBlock(block, filePath, context = {}) {
    const lines = block.split('\n');
    const issue = { source: 'ai' };
    
    // 在批量模式下，需要从AI返回的内容中匹配文件路径
    if (!filePath && context.fileList && context.fileList.length > 0) {
      // 从block中查找文件路径信息
      const filePathLine = lines.find(line => line.startsWith('文件路径：'));
      if (filePathLine) {
        const aiPath = filePathLine.replace('文件路径：', '').trim();
        // 查找匹配的文件路径
        const matchedPath = context.fileList.find(path => {
          const fileName = path.split(/[/\\]/).pop();
          const aiFileName = aiPath.split(/[/\\]/).pop();
          return fileName === aiFileName || path.includes(aiPath.replace(/^[A-Z]?:?\\?/, ''));
        });
        if (matchedPath) {
          issue.file = matchedPath;
        }
      }
    } else {
      // 单文件模式，直接使用传入的filePath
      issue.file = filePath;
    }
    
    let isInCodeBlock = false;
    let codeLines = [];
    let collectPlainSnippet = false; // 处理“代码片段：”后紧随的非围栏代码
    let collectSuggestion = false;   // 处理“修改建议：”的多行文本
    let suggestionLines = [];

    const isFieldLine = (text) => {
      const t = String(text || '').trim();
      if (!t) return false;
      if (t.startsWith('文件路径：')) return true;
      if (t.startsWith('风险等级：')) return true;
      if (t.startsWith('风险原因：')) return true;
      if (t.startsWith('修改建议：')) return true;
      if (t.startsWith('代码片段：')) return true; // 新片段开始也视为字段边界
      if (/^\*\*-----/.test(t)) return true; // 块分隔符
      if (/^问题\d+[:：]/.test(t)) return true; // 问题编号
      return false;
    };
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // 若正在收集非围栏代码片段，优先处理
      if (collectPlainSnippet) {
        if (isFieldLine(line)) {
          // 到达下一个字段，结束收集
          issue.snippet = (issue.snippet && issue.snippet.length > 0)
            ? issue.snippet
            : codeLines.join('\n').trim();
          collectPlainSnippet = false;
          // 继续让本行按字段规则处理
        } else {
          codeLines.push(line);
          continue;
        }
      }

      // 若正在收集修改建议的多行文本
      if (collectSuggestion) {
        if (isFieldLine(line)) {
          issue.suggestion = suggestionLines.join('\n').trim();
          collectSuggestion = false;
          suggestionLines = [];
          // 继续处理当前字段
        } else {
          suggestionLines.push(line);
          continue;
        }
      }

      // 处理标准格式的字段
      if (line.startsWith('文件路径：')) {
        // 跳过AI返回的文件路径，我们直接使用本地已知的完整路径
      } else if (line.startsWith('风险等级：')) {
        const level = line.replace('风险等级：', '').trim();
        issue.risk = this.mapRiskLevel(level);
      } else if (line.startsWith('风险原因：')) {
        issue.message = line.replace('风险原因：', '').trim();
      } else if (line.startsWith('修改建议：')) {
        const rest = line.replace('修改建议：', '').trim();
        collectSuggestion = true;
        suggestionLines = rest ? [rest] : [];
      } else if (line.startsWith('代码片段：')) {
        const snippetContent = line.replace('代码片段：', '').trim();
        // 如果代码片段行后面直接有内容，使用该内容
        if (snippetContent && !snippetContent.startsWith('```')) {
          // 改为启动“非围栏片段”模式，收集后续多行直到下一个字段
          collectPlainSnippet = true;
          codeLines = [snippetContent];
        } else {
          // 检查下一行是否是代码块开始
          if (i + 1 < lines.length && lines[i + 1].trim().startsWith('```')) {
            isInCodeBlock = true;
            i++; // 跳过 ``` 行
            codeLines = [];
          } else {
            // 启动非围栏代码片段收集，直到遇到下一个字段
            collectPlainSnippet = true;
            codeLines = [];
          }
        }
      } 
      // 处理实际AI响应格式的字段（没有冒号前缀）
      else if (line.trim().startsWith('代码片段：')) {
        const snippetContent = line.replace(/^.*代码片段：/, '').trim();
        if (snippetContent && !snippetContent.startsWith('```')) {
          // 改为启动“非围栏片段”模式，收集后续多行直到下一个字段
          collectPlainSnippet = true;
          codeLines = [snippetContent];
        } else {
          // 检查下一行是否是代码块开始
          if (i + 1 < lines.length && lines[i + 1].trim().startsWith('```')) {
            isInCodeBlock = true;
            i++; // 跳过 ``` 行
            codeLines = [];
          } else {
            // 启动非围栏代码片段收集，直到遇到下一个字段
            collectPlainSnippet = true;
            codeLines = [];
          }
        }
      } else if (line.trim().startsWith('风险等级：')) {
        const level = line.replace(/^.*风险等级：/, '').trim();
        issue.risk = this.mapRiskLevel(level);
      } else if (line.trim().startsWith('风险原因：')) {
        issue.message = line.replace(/^.*风险原因：/, '').trim();
      } else if (line.trim().startsWith('修改建议：')) {
        const rest = line.replace(/^.*修改建议：/, '').trim();
        collectSuggestion = true;
        suggestionLines = rest ? [rest] : [];
      } else if (isInCodeBlock) {
        // 处理代码块内容
        if (line.trim() === '```') {
          // 代码块结束
          isInCodeBlock = false;
          issue.snippet = codeLines.join('\n').trim();
        } else {
          // 收集代码行
          codeLines.push(line);
        }
      }
    }

    // 若到末尾仍在收集非围栏片段，收尾
    if (collectPlainSnippet && (!issue.snippet || issue.snippet.length === 0)) {
      issue.snippet = codeLines.join('\n').trim();
    }

    // 若到末尾仍在收集多行修改建议，收尾
    if (collectSuggestion && (!issue.suggestion || issue.suggestion.length === 0)) {
      issue.suggestion = suggestionLines.join('\n').trim();
    }

    // 回退：如果未找到“代码片段：”字段但块内存在代码块，则提取第一个代码块内容作为片段
    if (!issue.snippet) {
      const fenceMatch = block.match(/```([\s\S]*?)```/);
      if (fenceMatch && fenceMatch[1]) {
        issue.snippet = fenceMatch[1].trim();
      }
    }

    // 片段规范化：移除“中间省略”占位行，裁剪到合理长度，并避免跨越不相邻的行号簇
    if (issue.snippet && typeof issue.snippet === 'string') {
      issue.snippet = this.normalizeSnippet(issue.snippet);
    }

    // 从代码片段中提取行号范围（支持每行的`[n]`前缀；兼容可选的'+'或空格前缀）
    if (issue.snippet && typeof issue.snippet === 'string') {
      let startNum = null;
      let endNum = null;
      const snippetLines = issue.snippet.split('\n');
      for (const sLine of snippetLines) {
        const m = sLine.match(/^\s*[+ ]?\[(\d+)\]\s/);
        if (m) {
          const n = Number(m[1]);
          if (Number.isFinite(n)) {
            if (startNum === null || n < startNum) startNum = n;
            if (endNum === null || n > endNum) endNum = n;
          }
        }
      }
      if (startNum !== null) {
        issue.lineStart = startNum;
        issue.lineEnd = endNum !== null ? endNum : startNum;
        issue.line = issue.lineStart; // 兼容旧字段
      }
    }
    
    // 必须有原因才认为是有效问题
    if (issue.message) {
      // 确保文件路径不为空，如果AI没有返回文件名称，使用传入的filePath
      if (!issue.file) {
        issue.file = filePath;
      }
      
      // 确保所有问题都有风险等级，如果没有则设为默认值
      if (!issue.risk) {
        issue.risk = 'suggestion'; // 默认为建议等级
      }
      
      // 规范化风险等级：确保在有效范围内
      issue.risk = this.normalizeRiskLevel(issue.risk);
      
      return issue;
    }

    return null;
  }

  // 规范化AI返回的代码片段：
  // - 移除日志/模型生成的“中间省略 … 字符”占位行
  // - 按行号聚类，避免跨越相距过大的行号簇（保留首个簇）
  // - 限制输出的最大行数，保证片段简洁可读
  normalizeSnippet(snippet) {
    try {
      const MAX_LINES = Number(this.config?.displayMaxSnippetLines ?? 12);
      const GAP_THRESHOLD = Number(this.config?.snippetGapThreshold ?? 5); // 行号差距超过阈值则分簇
      const lines = String(snippet).split('\n');
      // 1) 移除“中间省略”占位行
      const cleaned = lines.filter(l => !(/\u2026|\.\.\./.test(l) && /中间省略\s+\d+\s+字符/.test(l)) && !/^\s*\.\.\.\s*$/.test(l));

      // 2) 按行号聚类，仅保留第一个包含行号的簇
      const clusters = [];
      let current = [];
      let prevN = null;
      const lineNumRegex = /^\s*[+ ]?\[(\d+)\]\s/;
      for (const l of cleaned) {
        const m = l.match(lineNumRegex);
        if (m) {
          const n = Number(m[1]);
          if (prevN !== null && ((n - prevN > GAP_THRESHOLD) || (n < prevN)) && current.length > 0) {
            clusters.push(current);
            current = [];
          }
          current.push(l);
          prevN = n;
        } else {
          // 非行号行：跟随当前簇
          current.push(l);
        }
      }
      if (current.length > 0) clusters.push(current);
      const selected = clusters.find(c => c.some(l => lineNumRegex.test(l))) || cleaned;

      // 3) 限制最大行数
      const result = selected.slice(0, Math.max(1, MAX_LINES));
      return result.join('\n').trim();
    } catch {
      return snippet;
    }
  }

  // 将文本按行添加 [n] 前缀
  addLineNumberPrefixes(text, lineMap = null) {
    try {
      const lines = String(text).split('\n');
      return lines.map((l, i) => {
        const n = Array.isArray(lineMap) && Number.isFinite(Number(lineMap[i])) ? Number(lineMap[i]) : (i + 1);
        return `[${n}] ${l}`;
      }).join('\n');
    } catch {
      return text;
    }
  }

  mapRiskLevel(chineseLevel) {
    const mapping = {
      '致命': 'critical',
      '高危': 'high',
      '中危': 'medium', 
      '低危': 'low',
      '建议': 'suggestion'
    };
    
    return mapping[chineseLevel] || 'suggestion';
  }

  normalizeRiskLevel(riskLevel) {
    // 定义有效的风险等级顺序（从低到高）
    const validLevels = ['suggestion', 'low', 'medium', 'high', 'critical'];
    
    // 如果是有效等级，直接返回
    if (validLevels.includes(riskLevel)) {
      return riskLevel;
    }
    
    return 'suggestion';
  }

  // 检查响应是否包含分段标记
  isChunkedResponse(content) {
    return content.includes('[CHUNK_CONTINUE]') || content.includes('[CHUNK_END]');
  }

  // 解析分段响应信息
  parseChunkInfo(content) {
    const isContinue = content.includes('[CHUNK_CONTINUE]');
    const isEnd = content.includes('[CHUNK_END]');
    
    // 提取分段索引信息
    const indexRegex = /\[CHUNK_(\d+)\/(\d+)\]/;
    const indexMatch = content.match(indexRegex);
    
    let currentChunk = 1;
    let totalChunks = 1;
    
    if (indexMatch) {
      currentChunk = parseInt(indexMatch[1]) || 1;
      totalChunks = parseInt(indexMatch[2]) || 1;
    }
    
    // 清理内容，移除分段标记
    let cleanContent = content
      .replace(/\[CHUNK_CONTINUE\]/g, '')
      .replace(/\[CHUNK_END\]/g, '')
      .replace(indexRegex, '')
      .trim();
    
    return {
      content: cleanContent,
      currentChunk,
      totalChunks,
      isContinue,
      isEnd,
      isComplete: isEnd || (!isContinue && !isEnd) // 如果没有标记，认为是完整响应
    };
  }

  // 处理分段响应的主方法
  async handleChunkedResponse(messages, requestId = null, meta = null) {
    // 生成请求ID
    if (!requestId) {
      requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // 初始化收集器
    if (!this.chunkedResponseCollector.has(requestId)) {
      this.chunkedResponseCollector.set(requestId, {
        chunks: [],
        isComplete: false,
        messages: [...messages] // 保存原始消息
      });
    }

    const collector = this.chunkedResponseCollector.get(requestId);

    try {
      // 记录请求信息
      logger.debug(`发送分段AI请求 - 模型: ${this.config.model ?? 'gpt-3.5-turbo'}, 消息数: ${collector.messages.length}`);
      // 输出请求消息的预览（限制每条消息长度）
      try {
        const preview = collector.messages.map((m, idx) => {
          const text = String(m.content ?? '');
          const maxLen = 1500;
          const cut = text.length > maxLen ? `${text.slice(0, maxLen)}\n...省略 ${text.length - maxLen} 字符` : text;
          return `#${idx + 1} [${m.role}]\n${cut}`;
        }).join('\n---\n');
        logger.debug(`AI请求消息预览:\n${preview}`);
      } catch (e) {
        logger.debug(`AI请求消息预览失败: ${e.message}`);
      }
      
      // 发送请求
      const isFirstCall = this.chunkedResponseCollector.get(requestId).chunks.length === 0;
      const response = await this.chatWithRetry({
        model: this.config.model ?? 'gpt-3.5-turbo',
        messages: collector.messages,
        temperature: this.config.temperature !== undefined ? this.config.temperature : 0.1,
        max_tokens: this.getMaxTokens()
      }, isFirstCall ? meta : null);

      const content = response.choices[0].message.content;
      logger.debug(`AI响应: ${content.length} 字符`);
      // 检查是否是分段响应
      if (this.isChunkedResponse(content)) {
        const chunkInfo = this.parseChunkInfo(content);
        
        // 添加到收集器
        collector.chunks.push({
          index: chunkInfo.currentChunk,
          content: chunkInfo.content,
          timestamp: Date.now()
        });

        // 检查是否完成
        if (chunkInfo.isComplete) {
          collector.isComplete = true;
          const fullContent = this.assembleChunks(collector.chunks);
          this.chunkedResponseCollector.delete(requestId);
          return fullContent;
        } else {
          // 需要继续获取下一段
          collector.messages.push({ role: 'assistant', content: content });
          collector.messages.push({ 
            role: 'user', 
            content: '继续' 
          });
          logger.debug('分段响应未完成，发送"继续"请求下一段');
          
          // 递归获取下一段
          return await this.handleChunkedResponse(null, requestId, null);
        }
      } else {
        // 不是分段响应，直接返回
        collector.chunks.push({
          index: 1,
          content: content,
          timestamp: Date.now()
        });
        collector.isComplete = true;
        this.chunkedResponseCollector.delete(requestId);
        // 最终内容预览（非分段）
        // 信息级别输出最终原始响应预览（非分段）
        return content;
      }
    } catch (error) {
      // 清理收集器
      this.chunkedResponseCollector.delete(requestId);
      throw error;
    }
  }

  // 组装分段内容
  assembleChunks(chunks) {
    // 按索引排序
    chunks.sort((a, b) => a.index - b.index);
    
    // 合并内容
    const fullContent = chunks.map(chunk => chunk.content).join('\n\n');
    
    return fullContent;
  }

  // 获取最大token数
  getMaxTokens() {
    const useDynamic = (this.config?.ai?.dynamicMaxTokens !== false);
    const contextWindow = Number(this.config.contextWindow ?? AI_CONSTANTS.DEFAULT_CONTEXT_WINDOW);
    const reserve = Number(this.config.outputReserveTokens ?? AI_CONSTANTS.DEFAULT_OUTPUT_RESERVE_TOKENS);
    
    if (useDynamic) {
      // 这里简化处理，实际应该根据输入消息长度计算
      const dynamicBudget = Math.max(AI_CONSTANTS.MIN_DYNAMIC_BUDGET, Math.min(AI_CONSTANTS.MAX_DYNAMIC_BUDGET, contextWindow - reserve));
      const upper = Number(this.config.maxResponseTokens ?? dynamicBudget);
      const safeUpper = Number.isFinite(upper) ? upper : dynamicBudget;
      return Math.max(1, Math.floor(Math.min(dynamicBudget, safeUpper)));
    }
    
    const raw = this.config.maxResponseTokens ?? AI_CONSTANTS.DEFAULT_MAX_RESPONSE_TOKENS;
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(num) || Number.isNaN(num)) return AI_CONSTANTS.DEFAULT_MAX_RESPONSE_TOKENS;
    const min = 1;
    const max = AI_CONSTANTS.MAX_RESPONSE_TOKENS_LIMIT;
    return Math.min(max, Math.max(min, Math.floor(num)));
  }

  
}