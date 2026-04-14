import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { prepareForAIWithLineMap } from './utils/strip.js';
import { logger } from './utils/logger.js';
import { AI_CONSTANTS, HTTP_STATUS } from './utils/constants.js';
import { buildPrompts, t, getLocale, FIELD_LABELS, displayRisk } from './utils/i18n.js';

export class AIClient {
  static nodeVersionWarned = false; // 静态变量，确保只警告一次
  
  constructor(config) {
    this.config = config;
    this.cancelToken = config.cancelToken;
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
    const provider = this.normalizeProvider(this.config.provider);
    const apiKey = this.resolveApiKey(provider);
    const baseURL = this.resolveBaseURL(provider, this.config.baseURL);
    this.provider = provider;
    this.apiKey = apiKey;
    this.providerBaseURL = baseURL;

    if (!apiKey) {
      throw new Error(t(this.config, 'no_api_key'));
    }

    // 环境检测：OpenAI SDK 推荐 Node >=18（内置 fetch）。
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if ((nodeMajor < 18 || typeof fetch === 'undefined') && !AIClient.nodeVersionWarned) {
      logger.warn(t(this.config, 'node_version_warn'));
      AIClient.nodeVersionWarned = true;
    }

    if (provider === 'openai') {
      const options = { apiKey, maxRetries: 3 };
      if (baseURL) options.baseURL = baseURL;
      this.client = new OpenAI(options);
    } else {
      this.client = null;
    }
  }

  // 智能批量文件分析：支持分段文件的合并分析
  async analyzeSmartBatch(batchData, originalBatch = null, requestMeta = null) {
    try {
      if (this.isCancelled()) {
        return {
          issues: [],
          metadata: {
            batchIndex: originalBatch?.batchIndex,
            fileCount: batchData?.files?.length || 0,
            isSegmented: !!originalBatch?.isLargeFileSegment,
            totalSegments: originalBatch?.totalSegments,
            filePath: originalBatch?.segmentedFile
          }
        };
      }
      // 如果是大文件分段批次，改走分段整体分析路径，确保行号为绝对源行号
      if (originalBatch?.isLargeFileSegment) {
        try {
          logger.debug(t(this.config, 'detected_segmented_batch_dbg', {
            path: originalBatch.segmentedFile,
            segments: originalBatch.totalSegments
          }));
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
      const loc = getLocale(this.config);
      const L = FIELD_LABELS[loc];
      const batchIntro = t(this.config, 'batch_intro');
      const messages = [
        { role: 'system', content: this.getSystemPrompt() },
        { role: 'user', content: batchIntro }
      ];

      if (customPrompts.length > 0) {
        messages.push({ role: 'user', content: `\n[${t(this.config, 'custom_prompts_label')}]\n${customPrompts.join('\n\n---\n')}` });
      }
      const smartSkillContext = this.buildSkillContext('batch', batchData.files.map(f => f.filePath));
      if (smartSkillContext.prompt) {
        messages.push({ role: 'user', content: smartSkillContext.prompt });
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
          content: `${L.file}${file.filePath}\n${L.content}\n\`\`\`\n${contentForAI}\n\`\`\``
        });
        requestPreviews.push({ filePath: file.filePath, contentForAI });
      }
      // 汇总静态提示（可选）
      if (includeStaticHints) {
        const hintsParts = [];
        for (const file of batchData.files) {
          const staticIssues = file.staticIssues || [];
          if (staticIssues.length === 0) continue;
          const lines = staticIssues.map((i, idx) => {
            const riskDisp = displayRisk(i.risk || 'suggestion', this.config);
            const suggestPart = i.suggestion ? t(this.config, 'inline_suggestion', { suggestion: i.suggestion }) : '';
            return t(this.config, 'local_rule_hint_line', {
              index: idx + 1,
              risk: riskDisp,
              message: i.message,
              suggest: suggestPart,
              snippet: i.snippet || ''
            });
          });
          const header = t(this.config, 'local_rule_findings_header', { file: file.filePath });
          hintsParts.push(`${header}\n${lines.join('\n')}`);
        }
      if (hintsParts.length > 0) {
          messages.push({ role: 'user', content: hintsParts.join('\n\n') });
        }
      }

      // 添加最终指令，确保包含片段并保留行号前缀
      const finalInstructionBatch = t(this.config, 'final_instruction_batch');
      messages.push({ role: 'user', content: finalInstructionBatch });
      // 追加严格忽略规则，避免模型输出“行号跳跃/预处理移除”的提示
      const finalIgnoreRule = t(this.config, 'ignore_rule');
      messages.push({ role: 'user', content: finalIgnoreRule });
      
      // 使用分段响应处理（携带可读的请求ID，便于日志关联）
      const smartReqId = `smart_batch_${(batchData.files?.length || 0)}_${path.basename(batchData.files?.[0]?.filePath || 'unknown')}`;
      // 输出请求预览，便于定位行号映射问题
      const responseContent = await this.handleChunkedResponse(messages, smartReqId, { ...(requestMeta || {}), skillContext: smartSkillContext });
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
      logger.error(t(this.config, 'ai_batch_failed', { error: error.message }));
      // 如果是AI请求失败，应该终止程序而不是继续处理
      if (error.message.includes('Connection error') || error.message.includes('API') || error.message.includes('请求失败')) {
        logger.error(t(this.config, 'ai_connection_failed'));
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
      if (this.isCancelled()) {
        return {
          issues: [],
          metadata: {
            totalSegments: file.totalChunks,
            filePath: file.filePath
          }
        };
      }
      const cfg = this.config?.ai || this.config || {};
      const includeStaticHints = cfg.includeStaticHints === true;
      const customPrompts = await this.readCustomPrompts();
      const loc = getLocale(this.config);
      const L = FIELD_LABELS[loc];
      const segmentSkillContext = this.buildSkillContext('segment', [file.filePath]);
      
      // 并发设置：从配置读取，<=1 则保持串行（兼容顶层/嵌套两种配置形态）
      const segConcurrency = Math.max(1, Number((this.config?.ai?.concurrency ?? this.config?.concurrency) || 1));
      const effectiveTotal = Array.isArray(file.chunks) ? file.chunks.length : (file.totalChunks || 1);
      const availableSlots = this.concurrencyLimiter ? this.concurrencyLimiter.getAvailable() : segConcurrency;
      const workersHead = Math.max(1, Math.min(availableSlots, effectiveTotal));
      const concurrencyNote = workersHead > 1 ? t(this.config, 'segment_concurrency_note', { workers: workersHead }) : '';
      const totalNoteText = (file.totalChunks && file.totalChunks !== effectiveTotal)
        ? t(this.config, 'segment_total_note', { totalChunks: file.totalChunks, effectiveTotal })
        : '';
      logger.progress(t(this.config, 'segment_overall_start', {
        file: file.filePath,
        total: effectiveTotal,
        concurrency: concurrencyNote,
        totalNote: totalNoteText
      }));

      const allIssues = [];

      // 单段分析函数（复用原有逻辑）
      const analyzeOne = async (i) => {
        if (this.isCancelled()) return;
        const chunk = file.chunks[i];

        // 提前让出事件循环，允许并发协程启动
        // 注意：真正的“开始分析第X/段”提示将在取得并发许可后输出
        logger.debug(t(this.config, 'segment_wait_start_dbg', { index: i + 1, total: effectiveTotal, start: chunk.startLine, end: chunk.endLine }));

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
            messages.push({ role: 'user', content: `\n[${t(this.config, 'custom_prompts_label')}]\n${customPrompts.join('\n\n---\n')}` });
          }
          if (segmentSkillContext.prompt) {
            messages.push({ role: 'user', content: segmentSkillContext.prompt });
          }

          // 构建分段分析提示
          const attachLineNumbers = (this.config?.ai?.attachLineNumbersInBatch ?? this.config?.attachLineNumbersInBatch) !== false;
          const contentForAI = attachLineNumbers ? this.addLineNumberPrefixes(clean, lineMapAbs) : clean;

          const segmentPrompt = t(this.config, 'segment_prompt_template', {
            index: i + 1,
            total: file.totalChunks,
            Lfile: L.file,
            Lcontent: L.content,
            Lsnippet: L.snippet,
            Lrisk: L.risk,
            Lreason: L.reason,
            Lsuggestion: L.suggestion,
            file: file.filePath,
            content: contentForAI
          });

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
              const lines = segmentStaticIssues.map((si, idx) => {
                const riskDisp = displayRisk(si.risk || 'suggestion', this.config);
                const suggestPart = si.suggestion ? t(this.config, 'inline_suggestion', { suggestion: si.suggestion }) : '';
                return t(this.config, 'segment_static_issue_line', {
                  index: idx + 1,
                  risk: riskDisp,
                  message: si.message,
                  suggest: suggestPart,
                  snippetLabel: L.snippet,
                  snippet: si.snippet || ''
                });
              });
              messages.push({ role: 'user', content: `${t(this.config, 'segment_static_issues_header', { index: i + 1 })}\n${lines.join('\n')}` });
            }
          }
          
          // 发送分段分析请求
          const segReqId = `segment_${path.basename(file.filePath)}_${i + 1}of${file.totalChunks}`;
          const startLabel = t(this.config, 'segment_start_label', { file: file.filePath, index: i + 1, total: effectiveTotal, start: chunk.startLine, end: chunk.endLine });
          const responseContent = await this.handleChunkedResponse(messages, segReqId, { onStart: () => logger.info(startLabel), skillContext: segmentSkillContext });
          
          // 解析分段响应
          const segmentResult = this.parseAIResponse(responseContent, file.filePath, {});
          
          const batchPrefix = (typeof file.batchIndex === 'number' && typeof file.batchTotal === 'number')
            ? t(this.config, 'segment_batch_prefix', { index: file.batchIndex + 1, total: file.batchTotal })
            : '';
          if (Array.isArray(segmentResult)) {
            allIssues.push(...segmentResult);
            logger.success(t(this.config, 'segment_analysis_done_n_issues', { batch: batchPrefix, file: file.filePath, index: i + 1, count: segmentResult.length }));
          } else if (segmentResult && segmentResult.issues) {
            allIssues.push(...segmentResult.issues);
            logger.success(t(this.config, 'segment_analysis_done_n_issues', { batch: batchPrefix, file: file.filePath, index: i + 1, count: segmentResult.issues.length }));
          } else {
            logger.success(t(this.config, 'segment_analysis_done_zero', { batch: batchPrefix, file: file.filePath, index: i + 1 }));
          }
        } catch (error) {
          if (this.isCancellationError(error)) return;
          logger.error(t(this.config, 'segment_analysis_failed', { index: i + 1, error: error.message }));
        }
      };

      // 按配置执行并发或串行
      const total = effectiveTotal;
      const workers = Math.max(1, Math.min((this.concurrencyLimiter ? this.concurrencyLimiter.getAvailable() : segConcurrency), total));

    // 调度细节降为调试级别，避免扰乱终端主要进度
    logger.debug(t(this.config, 'segment_schedule_dbg', {
      workers,
      total,
      note: (file.totalChunks && file.totalChunks !== total) ? t(this.config, 'segment_total_note', { totalChunks: file.totalChunks, effectiveTotal: total }) : ''
    }));
      if (workers <= 1) {
        for (let i = 0; i < total; i++) {
          if (this.isCancelled()) break;
          // eslint-disable-next-line no-await-in-loop
          await analyzeOne(i);
        }
      } else {
        let cursor = 0;
        const runWorker = async (workerId) => {
      // 并发协程启动提示降为调试级别
      logger.debug(t(this.config, 'segment_worker_start_dbg', { id: workerId }));
          while (true) {
            if (this.isCancelled()) break;
            const i = cursor++;
            if (i >= total) break;
            // eslint-disable-next-line no-await-in-loop
            await analyzeOne(i);
          }
        };
        await Promise.all(Array.from({ length: workers }, (_, idx) => runWorker(idx + 1)));
        logger.debug(t(this.config, 'segment_concurrency_done_dbg', { total, extra: (file.totalChunks && file.totalChunks !== total) ? `/${file.totalChunks}` : '' }));
      }

      return {
        issues: allIssues,
        metadata: {
          totalSegments: file.totalChunks,
          filePath: file.filePath
        }
      };
      
    } catch (error) {
      if (this.isCancellationError(error)) {
        return {
          issues: [],
          metadata: {
            totalSegments: file.totalChunks,
            filePath: file.filePath
          }
        };
      }
      logger.error(t(this.config, 'segment_file_failed', { error: error.message }));
      // 如果是AI请求失败，应该终止程序而不是继续处理
      if (error.message.includes('Connection error') || error.message.includes('API') || error.message.includes('请求失败')) {
        logger.error(t(this.config, 'ai_connection_failed'));
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
      if (this.isCancelled()) return [];
      const cfg = this.config?.ai || {};
      const includeStaticHints = cfg.includeStaticHints === true;
      const customPrompts = await this.readCustomPrompts();
      const staticIssues = options.staticIssues || [];
      const loc = getLocale(this.config);
      const L = FIELD_LABELS[loc];
      logger.debug(t(this.config, 'ai_diff_start_dbg', { file: fileData.filePath, added: fileData.totalAddedLines }));
      
      // 构建diff专用的系统提示词
      const diffSystemPrompt = this.getDiffSystemPrompt();
      
      const messages = [
        { role: 'system', content: diffSystemPrompt }
      ];

      // 添加自定义提示词
      if (customPrompts && customPrompts.length > 0) {
        messages.push({ role: 'user', content: `\n[${t(this.config, 'custom_prompts_label')}]\n${customPrompts.join('\n\n---\n')}` });
      }
      const diffSkillContext = this.buildSkillContext('diff', [fileData.filePath]);
      if (diffSkillContext.prompt) {
        messages.push({ role: 'user', content: diffSkillContext.prompt });
      }

      // 构建diff分析提示
      const intro = t(this.config, 'diff_intro');
      const diffPrompt = `${intro}\n\n${L.file}${fileData.filePath}\n${t(this.config, 'diff_added_lines_label')}${fileData.totalAddedLines}\n${t(this.config, 'diff_smart_segments_label')}${fileData.segments.length}\n\n${t(this.config, 'diff_changes_label')}`;

      messages.push({ role: 'user', content: diffPrompt });

      // 添加每个智能分段
      for (let i = 0; i < fileData.segments.length; i++) {
        const segment = fileData.segments[i];
        const segTitle = t(this.config, 'diff_segment_title', { index: i + 1, total: fileData.segments.length });
        const segMeta = t(this.config, 'diff_segment_meta', {
          start: segment.startLine,
          end: segment.endLine,
          added: segment.addedLinesCount,
          tokens: segment.estimatedTokens
        });
        const segmentPrompt = `\n[${segTitle}] (${segMeta})\n\`\`\`diff\n${segment.content}\n\`\`\``;
        
          messages.push({ role: 'user', content: segmentPrompt });
          // 追加严格忽略规则，避免模型输出“行号跳跃/预处理移除”的提示
          messages.push({ role: 'user', content: t(this.config, 'ignore_rule') });
      }

      // 添加静态分析提示（如果有）
      if (includeStaticHints && staticIssues.length > 0) {
        const hintLines = staticIssues.map((issue, idx) => {
          const riskDisp = displayRisk(issue.risk || 'suggestion', this.config);
          const suggestPart = issue.suggestion ? t(this.config, 'inline_suggestion', { suggestion: issue.suggestion }) : '';
          return t(this.config, 'local_rule_hint_line', {
            index: idx + 1,
            risk: riskDisp,
            message: issue.message,
            suggest: suggestPart,
            snippet: issue.snippet || ''
          });
        });
        const hintsPrompt = `\n[${t(this.config, 'local_rule_findings')}]\n${hintLines.join('\n')}`;
        messages.push({ role: 'user', content: hintsPrompt });
      }

      // 添加最终指令
      const finalInstruction = t(this.config, 'diff_final_instruction', { file: fileData.filePath });
      
      messages.push({ role: 'user', content: finalInstruction });
      // 追加严格忽略规则，避免模型输出“行号跳跃/预处理移除”的提示
      messages.push({ role: 'user', content: t(this.config, 'ignore_rule') });

      // 记录请求信息
      logger.debug(t(this.config, 'ai_diff_send_dbg', { model: this.config.model ?? 'gpt-3.5-turbo', messages: messages.length }));

      // 发送请求并处理响应
      const diffReqId = `diff_${path.basename(fileData.filePath)}`;
      const responseContent = await this.handleChunkedResponse(messages, diffReqId, { skillContext: diffSkillContext });
      const issues = this.parseAIResponse(responseContent, fileData.filePath);
      
      logger.debug(t(this.config, 'ai_diff_done_dbg', { file: fileData.filePath, issues: issues.length }));
      
      return issues || [];
      
    } catch (error) {
      if (this.isCancellationError(error)) return [];
      logger.error(t(this.config, 'ai_diff_failed', { path: fileData.filePath, error: error.message }));
      if (error.message.includes('Connection error') || error.message.includes('API') || error.message.includes('请求失败')) {
        logger.error(t(this.config, 'ai_connection_failed'));
        process.exit(1);
      }
      throw error;
    }
  }

  // 批量文件分析：一次请求发送多个文件的完整内容
  async analyzeFilesBatch(entries) {
    try {
      if (this.isCancelled()) return [];
      const cfg = this.config?.ai || {};
      const includeStaticHints = cfg.includeStaticHints === true;
      const customPrompts = await this.readCustomPrompts();
      const loc = getLocale(this.config);
      const L = FIELD_LABELS[loc];
      const { systemPrompt } = buildPrompts(this.config);

      const messages = [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: t(this.config, 'batch_files_intro')
        }
      ];

      if (customPrompts.length > 0) {
        messages.push({ role: 'user', content: `\n[${t(this.config, 'custom_prompts_label')}]\n${customPrompts.join('\n\n---\n')}` });
      }
      const batchSkillContext = this.buildSkillContext('batch', entries.map(e => e.filePath));
      if (batchSkillContext.prompt) {
        messages.push({ role: 'user', content: batchSkillContext.prompt });
      }

      // 逐文件添加内容
      const requestPreviews = [];
      for (let i = 0; i < entries.length; i++) {
        const { filePath, content, failedStatic } = entries[i];
        const { clean, lineMap } = await prepareForAIWithLineMap(content, filePath);
        const attachLineNumbers = this.config?.ai?.attachLineNumbersInBatch !== false;
        const contentForAI = attachLineNumbers ? this.addLineNumberPrefixes(clean, lineMap) : clean;
        const failedText = failedStatic ? t(this.config, 'file_failed_static_suffix') : '';
        messages.push({
          role: 'user',
          content: `${L.file}${filePath}${failedText}\n${L.content}\n\`\`\`\n${contentForAI}\n\`\`\``
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
          const lines = staticIssues.map((i, idx) => {
            const riskDisp = displayRisk(i.risk || 'suggestion', this.config);
            const suggestPart = i.suggestion ? t(this.config, 'inline_suggestion', { suggestion: i.suggestion }) : '';
            return t(this.config, 'local_rule_hint_line', {
              index: idx + 1,
              risk: riskDisp,
              message: i.message,
              suggest: suggestPart,
              snippet: i.snippet || ''
            });
          });
          const header = t(this.config, 'local_rule_findings_header', { file: e.filePath });
          hintsParts.push(`${header}\n${lines.join('\n')}`);
        }
      if (hintsParts.length > 0) {
          messages.push({ role: 'user', content: hintsParts.join('\n\n') });
        }
      }

      // 添加最终指令，确保包含片段并保留行号前缀
      const finalInstructionBatch = t(this.config, 'final_instruction_batch');
      messages.push({ role: 'user', content: finalInstructionBatch });
      // 追加严格忽略规则，避免模型输出“行号跳跃/预处理移除”的提示
      messages.push({ role: 'user', content: t(this.config, 'ignore_rule') });
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
      }, { skillContext: batchSkillContext });
      // 批量响应：不传单个 filePath，让解析函数从AI返回的“文件名称：”中读取
      return this.parseAIResponse(response.choices[0].message.content, undefined, {});
    } catch (error) {
      if (this.isCancellationError(error)) return [];
      logger.error(t(this.config, 'ai_batch_failed', { error: error.message }));
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
      let cancelOff = null;
      let controller = null;
      try {
        if (this.isCancelled()) {
          throw this.createCancelError();
        }
        if (this.concurrencyLimiter) {
          release = await this.concurrencyLimiter.acquire();
          // 获取到并发许可后再输出“开始分析”提示
          if (meta && typeof meta.onStart === 'function') {
            try { meta.onStart(); } catch (e) {}
          }
        }
        if (this.isCancelled()) {
          throw this.createCancelError();
        }
        if (typeof AbortController !== 'undefined') {
          controller = new AbortController();
          if (this.cancelToken && typeof this.cancelToken.onCancel === 'function') {
            cancelOff = this.cancelToken.onCancel(() => {
              try { controller.abort(); } catch (e) {}
            });
          }
          if (this.isCancelled()) {
            try { controller.abort(); } catch (e) {}
          }
        }
        const res = await this.createChatCompletion(
          params,
          controller ? controller.signal : null
        );
        if (meta && meta.skillContext && meta.skillContext.strict) {
          const content = res?.choices?.[0]?.message?.content || '';
          if (!this.validateSkillResponse(content, meta.skillContext)) {
            const correction = this.buildSkillCorrectionPrompt(meta.skillContext);
            const strictMessages = [...(params.messages || []), { role: 'assistant', content }, { role: 'user', content: correction }];
            const strictRes = await this.createChatCompletion(
              { ...params, messages: strictMessages },
              controller ? controller.signal : null
            );
            if (strictRes?.choices?.[0]?.message?.content) {
              return strictRes;
            }
          }
        }
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
        if (cancelOff) {
          try { cancelOff(); } catch (e) {}
          cancelOff = null;
        }
        attempt++;
        if (this.isCancellationError(error)) {
          throw error;
        }
        const status = error?.status ?? (error?.response?.status);
        const retriable = (
          status === undefined || status === HTTP_STATUS.TOO_MANY_REQUESTS || (typeof status === 'number' && status >= HTTP_STATUS.INTERNAL_SERVER_ERROR && status < HTTP_STATUS.SERVER_ERROR_UPPER_BOUND)
        );
        if (attempt > retries || !retriable) {
          throw error;
        }
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.warn(t(this.config, 'ai_retry_warn', { attempt, retries, delay, error: error?.message || String(error) }));
        await new Promise((r) => setTimeout(r, delay));
      } finally {
        if (release) {
          try { release(); } catch (e) {}
        }
        if (cancelOff) {
          try { cancelOff(); } catch (e) {}
        }
      }
    }
  }

  getReviewSkillCatalog() {
    return {
      DIFF_RISK_GUARD: '仅聚焦本次变更引入的风险，不重复陈述历史遗留问题。',
      EVIDENCE_ENFORCER: '每个问题必须给出证据片段、风险原因、可执行修改建议。',
      SECURITY_DEEP: '深度检查注入、鉴权、越权、敏感数据泄露、配置风险。',
      LOGIC_CORRECTNESS: '检查分支条件、边界处理、空值路径、错误传播是否正确。',
      API_CONTRACT: '检查接口输入输出契约、幂等性、状态码语义、兼容性。',
      PERFORMANCE_HOTPATH: '检查热路径复杂度、批处理机会、重复计算与缓存策略。',
      CONCURRENCY_RESOURCE: '检查并发竞态、取消传播、连接/句柄/定时器释放。',
      MAINTAINABILITY_TESTABILITY: '检查可维护性、可测试性、可观测性与模块边界。'
    };
  }

  normalizeSkillIds(skillIds = []) {
    const catalog = this.getReviewSkillCatalog();
    const known = Object.keys(catalog);
    const normalized = [];
    for (const id of skillIds) {
      const value = String(id || '').trim().toUpperCase();
      if (!value) continue;
      if (!known.includes(value)) continue;
      if (!normalized.includes(value)) normalized.push(value);
    }
    return normalized;
  }

  getSkillsConfig() {
    const skills = this.config?.skills || {};
    const modeDefaults = {
      diff: ['DIFF_RISK_GUARD', 'EVIDENCE_ENFORCER', 'SECURITY_DEEP', 'LOGIC_CORRECTNESS'],
      segment: ['EVIDENCE_ENFORCER', 'LOGIC_CORRECTNESS', 'PERFORMANCE_HOTPATH', 'CONCURRENCY_RESOURCE'],
      batch: ['EVIDENCE_ENFORCER', 'SECURITY_DEEP', 'LOGIC_CORRECTNESS', 'API_CONTRACT'],
      generic: ['EVIDENCE_ENFORCER', 'LOGIC_CORRECTNESS']
    };
    return {
      enabled: skills.enabled !== false,
      strict: skills.strict === true,
      maxSkillsPerRequest: Number(skills.maxSkillsPerRequest || 4),
      required: this.normalizeSkillIds(skills.required || ['DIFF_RISK_GUARD', 'EVIDENCE_ENFORCER']),
      optional: this.normalizeSkillIds(skills.optional || []),
      modeDefaults
    };
  }

  resolveSkillSet(mode, filePaths = []) {
    const cfg = this.getSkillsConfig();
    if (!cfg.enabled) return { ids: [], strict: false, prompt: '' };
    const defaults = cfg.modeDefaults[mode] || cfg.modeDefaults.generic;
    const merged = this.normalizeSkillIds([...cfg.required, ...defaults, ...cfg.optional]);
    const max = Number.isFinite(cfg.maxSkillsPerRequest) && cfg.maxSkillsPerRequest > 0 ? Math.floor(cfg.maxSkillsPerRequest) : 4;
    const ids = merged.slice(0, max);
    const prompt = this.buildSkillsPrompt(ids, mode, filePaths);
    return { ids, strict: cfg.strict, prompt };
  }

  buildSkillsPrompt(skillIds, mode, filePaths = []) {
    if (!Array.isArray(skillIds) || skillIds.length === 0) return '';
    const catalog = this.getReviewSkillCatalog();
    const fileHint = Array.isArray(filePaths) && filePaths.length > 0 ? filePaths.join('\n') : '';
    const lines = skillIds
      .map((id, idx) => `${idx + 1}. ${id}: ${catalog[id] || ''}`)
      .join('\n');
    return [
      '[Review Skills]',
      `Mode: ${mode}`,
      'You must execute all listed skills in the same response.',
      lines,
      '[Output Requirements]',
      'Every issue must include file path, concrete snippet, risk reason, and actionable suggestion.',
      'Do not output generic statements without direct code evidence.',
      fileHint ? `[Target Files]\n${fileHint}` : ''
    ].filter(Boolean).join('\n');
  }

  buildSkillContext(mode, filePaths = []) {
    const resolved = this.resolveSkillSet(mode, filePaths);
    return {
      mode,
      skillIds: resolved.ids,
      strict: resolved.strict,
      prompt: resolved.prompt
    };
  }

  validateSkillResponse(content, skillContext) {
    if (!skillContext || !skillContext.strict) return true;
    const text = String(content || '').trim();
    if (!text || text === '无' || text.toLowerCase() === 'none') return true;
    const hasPath = /(文件路径|File Path|Lfile)/i.test(text);
    const hasSnippet = /(代码片段|Snippet|Lsnippet|```)/i.test(text);
    const hasReason = /(风险原因|Reason|Lreason)/i.test(text);
    const hasSuggestion = /(修改建议|Suggestion|Lsuggestion)/i.test(text);
    return hasPath && hasSnippet && hasReason && hasSuggestion;
  }

  buildSkillCorrectionPrompt(skillContext) {
    const ids = Array.isArray(skillContext?.skillIds) ? skillContext.skillIds.join(', ') : '';
    return [
      'Your previous answer does not satisfy required review skill constraints.',
      `Re-run strictly with skills: ${ids}`,
      'Return only issues with: file path, concrete snippet, risk reason, actionable suggestion.'
    ].join('\n');
  }

  normalizeProvider(provider) {
    const value = String(provider || 'openai').trim().toLowerCase();
    if (value === 'anthropic') return 'anthropic';
    if (value === 'gemini') return 'gemini';
    return 'openai';
  }

  resolveApiKey(provider) {
    if (this.config.apiKey) return this.config.apiKey;
    const candidates = provider === 'anthropic'
      ? [process.env.ANTHROPIC_API_KEY, process.env.AI_API_KEY]
      : provider === 'gemini'
        ? [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY, process.env.AI_API_KEY]
        : [process.env.OPENAI_API_KEY, process.env.AI_API_KEY];
    return candidates.find(Boolean) || '';
  }

  resolveBaseURL(provider, baseURL) {
    if (baseURL) return String(baseURL).trim();
    if (provider === 'anthropic') return 'https://api.anthropic.com';
    if (provider === 'gemini') return 'https://generativelanguage.googleapis.com';
    return '';
  }

  async createChatCompletion(params, signal) {
    if (this.provider === 'anthropic') {
      return this.createAnthropicCompletion(params, signal);
    }
    if (this.provider === 'gemini') {
      return this.createGeminiCompletion(params, signal);
    }
    return this.client.chat.completions.create(
      params,
      signal ? { signal } : undefined
    );
  }

  splitMessages(messages = []) {
    const system = [];
    const chat = [];
    for (const message of messages) {
      if (!message) continue;
      const role = String(message.role || '').toLowerCase();
      const content = String(message.content || '');
      if (!content.trim()) continue;
      if (role === 'system') {
        system.push(content);
      } else {
        chat.push({ role, content });
      }
    }
    return {
      systemText: system.join('\n\n').trim(),
      chat
    };
  }

  async createAnthropicCompletion(params, signal) {
    const { systemText, chat } = this.splitMessages(params.messages || []);
    const model = params.model || this.config.model || 'claude-3-5-sonnet-latest';
    const body = {
      model,
      max_tokens: Number(params.max_tokens || this.getMaxTokens()),
      temperature: params.temperature ?? this.config.temperature ?? 0.1,
      messages: chat.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content
      }))
    };
    if (systemText) body.system = systemText;
    const version = this.config.anthropicVersion || '2023-06-01';
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': version
    };
    if (this.config.anthropicBeta) {
      headers['anthropic-beta'] = this.config.anthropicBeta;
    }
    const endpoint = `${this.providerBaseURL.replace(/\/$/, '')}/v1/messages`;
    const response = await this.requestJson(endpoint, {
      method: 'POST',
      headers,
      body,
      signal
    });
    const content = Array.isArray(response?.content)
      ? response.content.map((item) => item?.text || '').join('\n').trim()
      : '';
    return { choices: [{ message: { content } }] };
  }

  async createGeminiCompletion(params, signal) {
    const { systemText, chat } = this.splitMessages(params.messages || []);
    const model = params.model || this.config.model || 'gemini-1.5-flash';
    const version = this.config.geminiApiVersion || 'v1beta';
    const endpoint = `${this.providerBaseURL.replace(/\/$/, '')}/${version}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const body = {
      contents: chat.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
      })),
      generationConfig: {
        temperature: params.temperature ?? this.config.temperature ?? 0.1,
        maxOutputTokens: Number(params.max_tokens || this.getMaxTokens())
      }
    };
    if (systemText) {
      body.systemInstruction = {
        parts: [{ text: systemText }]
      };
    }
    const response = await this.requestJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal
    });
    const parts = response?.candidates?.[0]?.content?.parts || [];
    const content = parts.map((item) => item?.text || '').join('\n').trim();
    return { choices: [{ message: { content } }] };
  }

  requestJson(urlString, options = {}) {
    if (typeof fetch !== 'undefined') {
      return this.requestJsonByFetch(urlString, options);
    }
    return this.requestJsonByHttp(urlString, options);
  }

  async requestJsonByFetch(urlString, options = {}) {
    const response = await fetch(urlString, {
      method: options.method || 'POST',
      headers: options.headers || {},
      body: JSON.stringify(options.body || {}),
      signal: options.signal || undefined
    });
    const raw = await response.text();
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch (e) {
      parsed = { raw };
    }
    if (!response.ok) {
      const err = new Error(parsed?.error?.message || parsed?.message || `HTTP ${response.status}`);
      err.status = response.status;
      err.response = { status: response.status, data: parsed };
      throw err;
    }
    return parsed;
  }

  requestJsonByHttp(urlString, options = {}) {
    const payload = JSON.stringify(options.body || {});
    const url = new URL(urlString);
    const requester = url.protocol === 'http:' ? http : https;
    const requestOptions = {
      method: options.method || 'POST',
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(options.headers || {})
      }
    };
    return new Promise((resolve, reject) => {
      const req = requester.request(requestOptions, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (e) {
            parsed = { raw };
          }
          const status = Number(res.statusCode || 0);
          if (status >= 200 && status < 300) {
            resolve(parsed);
            return;
          }
          const err = new Error(parsed?.error?.message || parsed?.message || `HTTP ${status}`);
          err.status = status;
          err.response = { status, data: parsed };
          reject(err);
        });
      });
      req.on('error', reject);
      if (options.signal) {
        const onAbort = () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          req.destroy(err);
        };
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => {
          try { options.signal.removeEventListener('abort', onAbort); } catch (e) {}
        });
      }
      req.write(payload);
      req.end();
    });
  }

  isCancelled() {
    return this.cancelToken && typeof this.cancelToken.isCancelled === 'function' && this.cancelToken.isCancelled();
  }

  createCancelError() {
    const err = new Error(t(this.config, 'interrupt_cancelled'));
    err.isCancelled = true;
    return err;
  }

  isCancellationError(error) {
    const msg = String(error?.message || '').toLowerCase();
    return !!(error?.isCancelled || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || msg.includes('cancel'));
  }

  getSystemPrompt() {
    // 使用缓存避免重复构建系统提示词
    if (this.systemPromptCache) {
      this.cacheStats.hits++;
      return this.systemPromptCache;
    }
    this.cacheStats.misses++;
    const { systemPrompt } = buildPrompts(this.config);
    this.systemPromptCache = systemPrompt;
    return this.systemPromptCache;
  }

  /**
   * Git Diff专用系统提示词
   * @returns {string} diff专用系统提示词
   */
  getDiffSystemPrompt() {
    // 使用 i18n 生成并缓存 Diff 专用系统提示词
    if (this.diffSystemPromptCache) {
      this.cacheStats.hits++;
      return this.diffSystemPromptCache;
    }
    this.cacheStats.misses++;
    const { diffSystemPrompt } = buildPrompts(this.config);
    this.diffSystemPromptCache = diffSystemPrompt;
    return this.diffSystemPromptCache;
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
            logger.warn(t(this.config, 'read_ai_prompt_file_failed', { file: filePath, error: e?.message || String(e) }));
          }
        }
      }
      
      // 缓存结果
      this.promptCache.set(cacheKey, prompts);
      return prompts;
    } catch (error) {
      logger.warn(t(this.config, 'read_custom_prompts_failed', { error: error?.message || String(error) }));
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
      /\*\*-----Git Diff代码分析结果开始-----\*\*([\s\S]*?)\*\*-----Git Diff代码分析结果结束-----\*\*/g,
      /\*\*-----Code Analysis Result Start-----\*\*([\s\S]*?)\*\*-----Code Analysis Result End-----\*\*/g,
      /\*\*-----Git Diff Code Analysis Result Start-----\*\*([\s\S]*?)\*\*-----Git Diff Code Analysis Result End-----\*\*/g
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
        if (
          block.includes('**-----代码分析结果-----**') ||
          block.includes('**-----Git Diff代码分析结果-----**') ||
          block.includes('**-----Code Analysis Result-----**') ||
          block.includes('**-----Git Diff Code Analysis Result-----**')
        ) {
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
        risk: this.normalizeRiskLevel(i.risk || 'suggestion'),
        message: t(this.config, 'fallback_static_reason', { message: i.message }),
        suggestion: i.suggestion || t(this.config, 'fallback_static_suggestion'),
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
      if (/^问题\d+[:：]/.test(line.trim()) || /^Issue\s*\d+[:：]?/i.test(line.trim())) {
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

    const LCN = FIELD_LABELS['zh-CN'];
    const LEN = FIELD_LABELS['en-US'];
    const FILE_LABELS = [LCN.file, LEN.file];
    const RISK_LABELS = [LCN.risk, LEN.risk];
    const REASON_LABELS = [LCN.reason, LEN.reason];
    const SUGGEST_LABELS = [LCN.suggestion, LEN.suggestion];
    const SNIPPET_LABELS = [LCN.snippet, LEN.snippet];

    const startsWithAny = (text, labels) => {
      const tline = String(text || '').trim();
      return labels.some(l => tline.startsWith(l));
    };
    const extractAfterAny = (text, labels) => {
      const tline = String(text || '').trim();
      for (const l of labels) {
        if (tline.startsWith(l)) return tline.slice(l.length).trim();
      }
      return null;
    };

    if (!filePath && context.fileList && context.fileList.length > 0) {
      const filePathLine = lines.find(line => startsWithAny(line, FILE_LABELS));
      if (filePathLine) {
        const aiPath = extractAfterAny(filePathLine, FILE_LABELS) || '';
        const matchedPath = context.fileList.find(p => {
          const fileName = p.split(/[\\/]/).pop();
          const aiFileName = aiPath.split(/[\\/]/).pop();
          return fileName === aiFileName || p.includes(aiPath.replace(/^[A-Z]?:?\\?/, ''));
        });
        if (matchedPath) {
          issue.file = matchedPath;
        }
      }
    } else {
      issue.file = filePath;
    }

    let isInCodeBlock = false;
    let codeLines = [];
    let collectPlainSnippet = false;
    let collectSuggestion = false;
    let suggestionLines = [];

    const isFieldLine = (text) => {
      const tline = String(text || '').trim();
      if (!tline) return false;
      if (startsWithAny(tline, FILE_LABELS)) return true;
      if (startsWithAny(tline, RISK_LABELS)) return true;
      if (startsWithAny(tline, REASON_LABELS)) return true;
      if (startsWithAny(tline, SUGGEST_LABELS)) return true;
      if (startsWithAny(tline, SNIPPET_LABELS)) return true;
      if (/^\*\*-----/.test(tline)) return true;
      if (/^问题\d+[:：]/.test(tline) || /^Issue\s*\d+[:：]?/i.test(tline)) return true;
      return false;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (collectPlainSnippet) {
        if (isFieldLine(line)) {
          issue.snippet = (issue.snippet && issue.snippet.length > 0)
            ? issue.snippet
            : codeLines.join('\n').trim();
          collectPlainSnippet = false;
        } else {
          codeLines.push(line);
          continue;
        }
      }

      if (collectSuggestion) {
        if (isFieldLine(line)) {
          issue.suggestion = suggestionLines.join('\n').trim();
          collectSuggestion = false;
          suggestionLines = [];
        } else {
          suggestionLines.push(line);
          continue;
        }
      }

      if (startsWithAny(line, FILE_LABELS)) {
        // ignore; handled above
      } else if (startsWithAny(line, RISK_LABELS)) {
        const level = extractAfterAny(line, RISK_LABELS) || '';
        issue.risk = this.mapRiskLevel(level);
      } else if (startsWithAny(line, REASON_LABELS)) {
        issue.message = extractAfterAny(line, REASON_LABELS) || '';
      } else if (startsWithAny(line, SUGGEST_LABELS)) {
        const rest = extractAfterAny(line, SUGGEST_LABELS) || '';
        collectSuggestion = true;
        suggestionLines = rest ? [rest] : [];
      } else if (startsWithAny(line, SNIPPET_LABELS)) {
        const snippetContent = extractAfterAny(line, SNIPPET_LABELS) || '';
        if (snippetContent && !snippetContent.startsWith('```')) {
          collectPlainSnippet = true;
          codeLines = [snippetContent];
        } else {
          if (i + 1 < lines.length && lines[i + 1].trim().startsWith('```')) {
            isInCodeBlock = true;
            i++;
            codeLines = [];
          } else {
            collectPlainSnippet = true;
            codeLines = [];
          }
        }
      } else if (isInCodeBlock) {
        if (line.trim() === '```') {
          isInCodeBlock = false;
          issue.snippet = codeLines.join('\n').trim();
        } else {
          codeLines.push(line);
        }
      }
    }

    if (collectPlainSnippet && (!issue.snippet || issue.snippet.length === 0)) {
      issue.snippet = codeLines.join('\n').trim();
    }
    if (collectSuggestion && (!issue.suggestion || issue.suggestion.length === 0)) {
      issue.suggestion = suggestionLines.join('\n').trim();
    }

    if (!issue.snippet) {
      const fenceMatch = block.match(/```([\s\S]*?)```/);
      if (fenceMatch && fenceMatch[1]) {
        issue.snippet = fenceMatch[1].trim();
      }
    }

    if (issue.snippet && typeof issue.snippet === 'string') {
      issue.snippet = this.normalizeSnippet(issue.snippet);
    }

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

    if (issue.message) {
      if (!issue.file) issue.file = filePath;
      if (!issue.risk) issue.risk = 'suggestion';
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
    const raw = String(chineseLevel || '').trim().toLowerCase();
    const mapping = {
      '致命': 'critical',
      '高危': 'high',
      '中危': 'medium', 
      '低危': 'low',
      '建议': 'suggestion',
      'critical': 'critical',
      'high': 'high',
      'medium': 'medium',
      'low': 'low',
      'suggestion': 'suggestion',
      'fatal': 'critical',
      'blocker': 'critical',
      'severe': 'high',
      'major': 'high',
      'moderate': 'medium',
      'minor': 'low',
      'info': 'suggestion',
      'tip': 'suggestion',
      'advice': 'suggestion',
      'recommendation': 'suggestion'
    };
    return mapping[raw] || 'suggestion';
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
    if (this.isCancelled()) {
      throw this.createCancelError();
    }
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
      logger.debug(t(this.config, 'chunk_req_info_dbg', {
        model: this.config.model ?? 'gpt-3.5-turbo',
        count: collector.messages.length
      }));
      // 输出请求消息的预览（限制每条消息长度）
        try {
          const preview = collector.messages.map((m, idx) => {
            const text = String(m.content ?? '');
            const maxLen = 1500;
            const truncatedSuffix = t(this.config, 'preview_truncated_suffix', { count: text.length - maxLen });
            const cut = text.length > maxLen ? `${text.slice(0, maxLen)}\n${truncatedSuffix}` : text;
            return `#${idx + 1} [${m.role}]\n${cut}`;
          }).join('\n---\n');
          logger.debug(t(this.config, 'chunk_req_preview_dbg', { preview }));
        } catch (e) {
          logger.debug(t(this.config, 'chunk_req_preview_fail_dbg', { error: e.message }));
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
      logger.debug(t(this.config, 'ai_response_len_dbg', { len: content.length }));
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
            content: t(this.config, 'chunk_continue_prompt') 
          });
          logger.debug(t(this.config, 'chunk_continue_needed_dbg'));
          
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
