import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { prepareForAIWithLineMap } from './utils/strip.js';
import { logger } from './utils/logger.js';
import { AI_CONSTANTS, HTTP_STATUS } from './utils/constants.js';
import { buildPrompts, t, getLocale, FIELD_LABELS, displayRisk } from './utils/i18n.js';
import { ReviewSkillResolver } from './review-skills/skill-resolver.js';
import { ReviewLoopEngine, mergeLoopIssues } from './review-loop/review-loop.js';
import { ReviewFixEngine, mergeFixCodes } from './review-fix/review-fix.js';
import { resolveToolsStrategy, shouldEnableToolsForRequest, resolveEvidenceTraceTools } from './tools-strategy.js';
import { matchRoute } from './review-skills/path-utils.js';
import { executeTraceTool } from './review-tools/trace-tools.js';
import { filterIssuesToChangeScope } from './review-tools/change-scope-filter.js';
import {
  assembleReviewChunks,
  extractFinalReviewContent as extractReviewBody,
  isNoIssueText,
  isSubstantiveAnalysisResult as isSubstantiveReview,
  isSuccessfulReviewOutput,
  looksIncompleteReview as reviewLooksIncomplete,
  shouldContinueOutput as decideOutputContinue,
  stripChunkMarkers
} from './review-tools/output-continue.js';
import { hasDuplicatedIssueFields } from './review-tools/output-self-check.js';
import {
  normalizeProviderName,
  getProviderDefaults,
  resolveApiKeyCandidates,
  validateProviderSetup,
  formatProviderValidationMessage
} from './provider-config.js';
import {
  buildAnthropicRequest,
  buildGeminiRequest,
  normalizeAnthropicResponse,
  normalizeGeminiResponse,
  extractProviderError,
  normalizeChatRequest
} from './ai-providers/message-adapter.js';
import { resolveOptionalPositiveInt } from './utils/optional-config.js';
import { maskSensitiveText as maskSensitiveTextUtil } from './utils/log-sanitize.js';
import { shouldIncludeStaticHints } from './utils/static-hints.js';
import {
  normalizeIssueLabelLine,
  matchIssueFieldLine,
  isIssueFieldLine,
  stripIssueFieldLinesFromSnippet,
  parseIssueLineLocation,
  isFormatPlaceholderIssue
} from './utils/issue-field-normalize.js';
import { extractResponseParts, hydrateResponseContent } from './ai-providers/choice-text.js';
import {
  createAiConnectionError,
  createAiApiError,
  createIncompleteReviewError,
  isAiConnectionError,
  isIncompleteReviewError,
  isAiApiError,
  isAiProviderHttpFailure
} from './ai-errors.js';

const execFileAsync = promisify(execFile);

export function mapRiskLevel(levelText) {
  const raw = String(levelText || '').trim().toLowerCase();
  const compact = raw.replace(/\s+/g, '');
  if (!compact) return 'suggestion';
  if (/致命|critical|blocker|fatal/.test(compact)) return 'critical';
  if (/高危|severe|major/.test(compact) || compact === 'high' || compact === '高') return 'high';
  if (/中危|medium|moderate|中等/.test(compact) || compact === '中') return 'medium';
  if (/低危|minor/.test(compact) || compact === 'low' || compact === '低') return 'low';
  if (/建议|suggestion|info|tip|advice|recommendation/.test(compact)) return 'suggestion';
  if (/\bhigh\b/.test(raw)) return 'high';
  if (/\blow\b/.test(raw)) return 'low';
  return 'suggestion';
}

export class AIClient {
  static nodeVersionWarned = false; // 静态变量，确保只警告一次
  
  constructor(config) {
    this.config = config;
    this.userLocale = getLocale(config);
    this.aiLocale = 'en-US';
    this.aiLocaleConfig = { locale: this.aiLocale };
    this.cancelToken = config.cancelToken;
    this.client = null;
    this.segmentCollector = new Map(); // 分段收集器：filePath -> {segments: [], totalSegments: number}
    this.chunkedResponseCollector = new Map(); // 分段响应收集器：requestId -> {chunks: [], isComplete: boolean}
    this.reviewDir = config.reviewDir; // 用于读取自定义AI提示词目录
    this.projectRoot = config.projectRoot || process.cwd();
    
    // 性能优化缓存
    this.promptCache = new Map(); // 缓存自定义提示词
    this.systemPromptCache = null; // 缓存系统提示词
    this.contentCache = new Map(); // 缓存处理后的内容
    this.cacheStats = { hits: 0, misses: 0 };
    this.aiRequestLogSeq = 0;
    this.moduleDir = path.dirname(fileURLToPath(import.meta.url));
    this.packageRoot = path.resolve(this.moduleDir, '..');
    this.aiRequestLogEnabled = this.shouldEnableAIRequestLog();
    this.skillResolver = new ReviewSkillResolver({
      config: this.config,
      reviewDir: this.reviewDir,
      packageRoot: this.packageRoot,
      tForAI: (key, params) => this.tForAI(key, params),
      extractFinalReviewContent: (content) => this.extractFinalReviewContent(content)
    });
    this.reviewLoop = new ReviewLoopEngine({
      config: this.config,
      tForAI: (key, params) => this.tForAI(key, params)
    });
    this.reviewFix = new ReviewFixEngine({
      config: this.config,
      tForAI: (key, params) => this.tForAI(key, params)
    });
    this.loopContext = null;
    this.progressScope = '';
    
    this.initializeClient();
  }

  tForAI(key, params) {
    return t(this.aiLocaleConfig, key, params);
  }

  getAIFieldLabels() {
    return FIELD_LABELS[this.aiLocale] || FIELD_LABELS['en-US'];
  }

  getUserOutputLanguageInstruction() {
    const isZh = this.userLocale === 'zh-CN';
    if (isZh) {
      return 'Final answer language requirement: Use Simplified Chinese (zh-CN) for all descriptions, including risk reasons and suggestions. Use Chinese field labels in the final output when possible.';
    }
    return 'Final answer language requirement: Use English (en-US) for all descriptions, including risk reasons and suggestions. Use English field labels in the final output.';
  }

  shouldEnableAIRequestLog() {
    if (process.env.SMART_REVIEW_FORCE_AI_REQUEST_LOG === '1') return true;
    if (process.env.NODE_ENV === 'production') return false;
    // Published package usually does not include .git metadata.
    // Keep request logging enabled only for repository/development runtime by default.
    return fs.existsSync(path.join(this.packageRoot, '.git'));
  }

  getAIRequestLogFilePath(now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const dir = path.join(this.projectRoot, '.smart-review', 'logs', 'ai-requests');
    return path.join(dir, `${y}-${m}-${d}.md`);
  }

  maskSensitiveText(text = '') {
    return maskSensitiveTextUtil(text);
  }

  appendAIRequestLog(title, payload) {
    if (!this.aiRequestLogEnabled) return;
    try {
      const now = new Date();
      const filePath = this.getAIRequestLogFilePath(now);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.aiRequestLogSeq += 1;
      const ts = now.toISOString();
      const safePayload = this.maskSensitiveText(JSON.stringify(payload, null, 2));
      const section = [
        `## ${ts} #${this.aiRequestLogSeq} ${title}`,
        '',
        '```json',
        safePayload,
        '```',
        ''
      ].join('\n');
      fs.appendFileSync(filePath, section, 'utf8');
    } catch (e) {
      logger.debug(`Failed to write AI request log: ${e?.message || e}`);
    }
  }

  initializeClient() {
    const provider = normalizeProviderName(this.config.provider);
    const defaults = getProviderDefaults(provider);
    const validation = validateProviderSetup(this.config);
    const validationMessage = formatProviderValidationMessage(validation, t, this.config);
    if (validationMessage) {
      if (!validation.ok) {
        throw new Error(validationMessage);
      }
      logger.warn(validationMessage);
    }

    const apiKey = resolveApiKeyCandidates(provider, this.config.apiKey)[0] || '';
    const baseURL = this.resolveBaseURL(provider, this.config.baseURL);
    this.provider = provider;
    this.apiKey = apiKey;
    this.providerBaseURL = baseURL;
    if (!this.config.model) {
      this.config.model = defaults.model;
    }

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
      const timeout = resolveOptionalPositiveInt(this.config.timeout, this.config.timeoutMs);
      if (timeout) options.timeout = timeout;
      const maxRetries = resolveOptionalPositiveInt(this.config.maxRetries);
      if (maxRetries !== undefined) options.maxRetries = maxRetries;
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
      const L = this.getAIFieldLabels();
      const filePaths = batchData.files.map(f => f.filePath);
      const smartSkillContext = this.buildSkillContext('batch', filePaths);
      const messages = [
        { role: 'system', content: this.getSystemPrompt() },
        { role: 'user', content: this.tForAI('batch_intro') }
      ];
      const staticHint = (batchData.files || [])
        .map((file) => this.buildStaticAlreadyReportedBlock(file.staticIssues || [], file.filePath))
        .filter(Boolean)
        .join('\n\n');
      await this.appendReviewPreamble(messages, 'batch', filePaths, smartSkillContext, [staticHint]);
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

      messages.push({ role: 'user', content: this.tForAI('final_instruction_batch') });
      
      // 使用分段响应处理（携带可读的请求ID，便于日志关联）
      const smartReqId = this.createRequestId(
        'smart_batch',
        batchData.files?.[0]?.filePath || '',
        `${batchData.files?.length || 0}`
      );
      const { issues } = await this.runReviewWithLoop({
        baseMessages: messages,
        requestId: smartReqId,
        meta: { ...(requestMeta || {}), skillContext: smartSkillContext },
        mode: 'batch',
        filePaths,
        parseIssues: (content) => this.parseAIResponse(content, undefined, { fileList: filePaths })
      });
      
      // 返回与其他方法一致的格式
      return {
        issues: issues || [],
        metadata: {
          batchIndex: originalBatch?.batchIndex,
          fileCount: batchData.files.length
        }
      };
    } catch (error) {
      if (this.isCancelled() || this.isCancellationError(error)) {
        return {
          issues: [],
          metadata: {
            batchIndex: originalBatch?.batchIndex,
            fileCount: batchData?.files?.length || 0
          }
        };
      }
      logger.error(t(this.config, 'ai_batch_failed', { error: error.message }));
      this.propagateAiFailure(error);
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
      const L = this.getAIFieldLabels();
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
          const staticHint = this.buildStaticAlreadyReportedBlock(
            (file.staticIssues || []).filter((issue) => issue.line >= chunk.startLine && issue.line <= chunk.endLine),
            file.filePath
          );
          await this.appendReviewPreamble(messages, 'segment', [file.filePath], segmentSkillContext, [staticHint]);

          // 构建分段分析提示
          const attachLineNumbers = (this.config?.ai?.attachLineNumbersInBatch ?? this.config?.attachLineNumbersInBatch) !== false;
          const contentForAI = attachLineNumbers ? this.addLineNumberPrefixes(clean, lineMapAbs) : clean;

          const segmentPrompt = this.tForAI('segment_prompt_template', {
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
          
          // 发送分段分析请求
          const segReqId = this.createRequestId('segment', file.filePath, `${i + 1}of${file.totalChunks}`);
          const startLabel = t(this.config, 'segment_start_label', { file: file.filePath, index: i + 1, total: effectiveTotal, start: chunk.startLine, end: chunk.endLine });
          const { issues: segmentIssues } = await this.runReviewWithLoop({
            baseMessages: messages,
            requestId: segReqId,
            meta: { onStart: () => logger.info(startLabel), skillContext: segmentSkillContext },
            mode: 'segment',
            filePaths: [file.filePath],
            parseIssues: (content) => {
              const segmentResult = this.parseAIResponse(content, file.filePath, {});
              if (Array.isArray(segmentResult)) return segmentResult;
              if (segmentResult && segmentResult.issues) return segmentResult.issues;
              return [];
            }
          });
          
          const batchPrefix = (typeof file.batchIndex === 'number' && typeof file.batchTotal === 'number')
            ? t(this.config, 'segment_batch_prefix', { index: file.batchIndex + 1, total: file.batchTotal })
            : '';
          if (segmentIssues.length > 0) {
            allIssues.push(...segmentIssues);
            logger.success(t(this.config, 'segment_analysis_done_n_issues', { batch: batchPrefix, file: file.filePath, index: i + 1, count: segmentIssues.length }));
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
      this.propagateAiFailure(error);
    }
  }

  /**
   * Git Diff 分析。单文件与小文件合并共用此入口。
   */
  async analyzeDiffFile(fileData, options = {}) {
    return this.analyzeDiffFiles([{ fileData, staticIssues: options.staticIssues || [] }]);
  }

  async analyzeDiffFiles(entries = []) {
    const jobs = (entries || []).filter((entry) => entry?.fileData);
    if (jobs.length === 0) return [];
    try {
      if (this.isCancelled()) return [];
      const filePaths = jobs.map((entry) => entry.fileData.filePath);
      const diffSkillContext = this.buildSkillContext('diff', filePaths);
      const staticHint = jobs.length === 1
        ? this.buildStaticAlreadyReportedBlock(jobs[0].staticIssues || [], jobs[0].fileData.filePath)
        : jobs
          .map((entry) => this.buildStaticAlreadyReportedBlock(entry.staticIssues || [], entry.fileData.filePath))
          .filter(Boolean)
          .join('\n\n');

      const messages = [
        { role: 'system', content: this.getDiffSystemPrompt() }
      ];
      await this.appendReviewPreamble(messages, 'diff', filePaths, diffSkillContext, [staticHint]);

      if (jobs.length === 1) {
        messages.push({ role: 'user', content: this.tForAI('diff_intro') });
        this.appendDiffFilePayload(messages, jobs[0].fileData);
        messages.push({ role: 'user', content: this.tForAI('diff_final_instruction', { file: jobs[0].fileData.filePath }) });
      } else {
        messages.push({ role: 'user', content: this.tForAI('diff_pack_intro') });
        for (const job of jobs) {
          this.appendDiffFilePayload(messages, job.fileData);
        }
        messages.push({ role: 'user', content: this.tForAI('diff_final_instruction_pack') });
      }

      logger.debug(t(this.config, 'ai_diff_send_dbg', { model: this.config.model ?? 'gpt-3.5-turbo', messages: messages.length }));

      const diffReqId = this.createRequestId('diff', filePaths[0] || '', `${filePaths.length}`);
      const { issues } = await this.runReviewWithLoop({
        baseMessages: messages,
        requestId: diffReqId,
        meta: { skillContext: diffSkillContext },
        mode: 'diff',
        filePaths,
        parseIssues: (content) => {
          const parsed = this.parseAIResponse(
            content,
            jobs.length === 1 ? jobs[0].fileData.filePath : undefined,
            { fileList: filePaths }
          );
          const { kept, dropped } = filterIssuesToChangeScope(
            parsed,
            jobs.map((job) => job.fileData),
            filePaths
          );
          if (dropped.length > 0) {
            logger.debug(t(this.config, 'ai_dropped_out_of_scope_dbg', { count: dropped.length }));
          }
          return kept;
        }
      });

      logger.debug(t(this.config, 'ai_diff_done_dbg', { file: filePaths.join(', '), issues: (issues || []).length }));
      return issues || [];
    } catch (error) {
      if (this.isCancellationError(error) || this.isCancelled()) return [];
      logger.error(t(this.config, 'ai_diff_failed', { path: jobs[0]?.fileData?.filePath, error: error.message }));
      this.propagateAiFailure(error);
    }
  }

  // 批量文件分析：一次请求发送多个文件的完整内容
  async analyzeFilesBatch(entries) {
    try {
      if (this.isCancelled()) return [];
      const L = this.getAIFieldLabels();
      const filePaths = entries.map(e => e.filePath);
      const batchSkillContext = this.buildSkillContext('batch', filePaths);
      const messages = [
        { role: 'system', content: this.getSystemPrompt() },
        { role: 'user', content: this.tForAI('batch_files_intro') }
      ];
      const staticHint = entries
        .map((e) => this.buildStaticAlreadyReportedBlock(e.staticIssues || [], e.filePath))
        .filter(Boolean)
        .join('\n\n');
      await this.appendReviewPreamble(messages, 'batch', filePaths, batchSkillContext, [staticHint]);

      // 逐文件添加内容
      const requestPreviews = [];
      for (let i = 0; i < entries.length; i++) {
        const { filePath, content, failedStatic } = entries[i];
        const { clean, lineMap } = await prepareForAIWithLineMap(content, filePath);
        const attachLineNumbers = this.config?.ai?.attachLineNumbersInBatch !== false;
        const contentForAI = attachLineNumbers ? this.addLineNumberPrefixes(clean, lineMap) : clean;
        const failedText = failedStatic ? this.tForAI('file_failed_static_suffix') : '';
        messages.push({
          role: 'user',
          content: `${L.file}${filePath}${failedText}\n${L.content}\n\`\`\`\n${contentForAI}\n\`\`\``
        });
        requestPreviews.push({ filePath, contentForAI });
      }

      messages.push({ role: 'user', content: this.tForAI('final_instruction_batch') });

      const batchReqId = this.createRequestId('files_batch', filePaths[0] || '', `${filePaths.length}`);
      const { issues } = await this.runReviewWithLoop({
        baseMessages: messages,
        requestId: batchReqId,
        meta: { skillContext: batchSkillContext },
        mode: 'batch',
        filePaths,
        parseIssues: (content) => this.parseAIResponse(content, undefined, { fileList: filePaths })
      });
      return issues || [];
    } catch (error) {
      if (this.isCancellationError(error) || this.isCancelled()) return [];
      logger.error(t(this.config, 'ai_batch_failed', { error: error.message }));
      this.propagateAiFailure(error);
    }
  }

  appendReviewEnhancements(messages, mode, filePaths = []) {
    const loopCfg = this.reviewLoop.resolveConfig(mode, filePaths);
    const loopIntro = this.reviewLoop.buildIntroPrompt(loopCfg);
    if (loopIntro) {
      messages.push({ role: 'user', content: loopIntro });
    }
    const fixCfg = this.reviewFix.resolveConfig(mode, filePaths);
    const fixIntro = this.reviewFix.buildOutputPrompt(fixCfg);
    if (fixIntro) {
      messages.push({ role: 'user', content: fixIntro });
    }
  }

  async appendReviewPreamble(messages, mode, filePaths, skillContext, extraParts = []) {
    const customPrompts = await this.readCustomPrompts();
    if (customPrompts.length > 0) {
      messages.push({ role: 'user', content: `\n[${this.tForAI('custom_prompts_label')}]\n${customPrompts.join('\n\n---\n')}` });
    }
    const parts = [];
    if (skillContext?.prompt) parts.push(skillContext.prompt);
    const toolPrompt = this.buildToolsPrompt(mode, filePaths, { evidenceTrace: skillContext?.enableTraceTools });
    if (toolPrompt) parts.push(toolPrompt);
    parts.push(this.tForAI('ignore_rule'));
    for (const extra of extraParts) {
      if (extra) parts.push(extra);
    }
    if (parts.length > 0) {
      messages.push({ role: 'user', content: parts.join('\n\n') });
    }
    this.appendReviewEnhancements(messages, mode, filePaths);
  }

  buildStaticAlreadyReportedBlock(staticIssues = [], filePath = '') {
    const cfg = this.config?.ai || this.config || {};
    if (!shouldIncludeStaticHints(cfg) || !Array.isArray(staticIssues) || staticIssues.length === 0) {
      return '';
    }
    const lines = staticIssues.map((issue, idx) => {
      const riskDisp = displayRisk(issue.risk || 'suggestion', this.aiLocaleConfig);
      const suggestPart = issue.suggestion ? this.tForAI('inline_suggestion', { suggestion: issue.suggestion }) : '';
      return this.tForAI('local_rule_hint_line', {
        index: idx + 1,
        risk: riskDisp,
        message: issue.message,
        suggest: suggestPart,
        snippet: issue.snippet || ''
      });
    });
    const header = filePath
      ? this.tForAI('local_rule_findings_header', { file: filePath })
      : this.tForAI('local_rule_findings');
    return `${this.tForAI('static_already_reported')}\n${header}\n${lines.join('\n')}`;
  }

  appendDiffFilePayload(messages, fileData) {
    const L = this.getAIFieldLabels();
    const intro = `${L.file}${fileData.filePath}\n${this.tForAI('diff_added_lines_label')}${fileData.totalAddedLines}\n${this.tForAI('diff_smart_segments_label')}${(fileData.segments || []).length}\n${this.tForAI('diff_changes_label')}`;
    const chunks = (fileData.segments || []).map((segment, i) => {
      const segTitle = this.tForAI('diff_segment_title', { index: i + 1, total: fileData.segments.length });
      const segMeta = this.tForAI('diff_segment_meta', {
        start: segment.startLine,
        end: segment.endLine,
        added: segment.addedLinesCount,
        tokens: segment.estimatedTokens
      });
      return `[${segTitle}] (${segMeta})\n\`\`\`diff\n${segment.content}\n\`\`\``;
    });
    messages.push({ role: 'user', content: `${intro}\n\n${chunks.join('\n\n')}` });
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
        const paramsForCall = params && params.messages ? { ...params, messages: [...params.messages] } : params;
        const res = await this.createChatCompletion(
          paramsForCall,
          controller ? controller.signal : null
        );
        let finalRes = res;
        let finalMessages = [...(paramsForCall.messages || [])];
        const toolCfg = this.getToolsConfig({
          mode: meta?.skillContext?.mode,
          filePaths: meta?.skillContext?.filePaths,
          skillContext: meta?.skillContext
        });
        if (toolCfg.enabled) {
          const toolResult = await this.resolveToolCalls(paramsForCall, finalRes, controller ? controller.signal : null, toolCfg);
          finalRes = toolResult.response;
          finalMessages = toolResult.messages;
        }
        if (meta?.skillContext?.enabled) {
          const skillResult = await this.resolveSkillSelection(
            paramsForCall,
            finalRes,
            controller ? controller.signal : null,
            meta.skillContext
          );
          finalRes = skillResult.response;
          finalMessages = skillResult.messages;
          if (meta.skillContext) {
            meta.skillContext.selectedIds = skillResult.selectedIds;
          }
        }
        if (meta && meta.skillContext && meta.skillContext.strict) {
          const content = finalRes?.choices?.[0]?.message?.content || '';
          if (content.trim() && !this.validateSkillResponse(content, meta.skillContext)) {
            logger.progress(t(this.config, 'ai_progress_skill_strict', { file: this.getProgressFileLabel() }));
            const correction = this.buildSkillCorrectionPrompt(meta.skillContext);
            const strictMessages = [...finalMessages, { role: 'assistant', content }, { role: 'user', content: correction }];
            let strictRes = await this.createChatCompletion(
              { ...paramsForCall, messages: strictMessages },
              controller ? controller.signal : null
            );
            let strictFinalMessages = strictMessages;
            if (toolCfg.enabled) {
              const strictToolResult = await this.resolveToolCalls(
                { ...paramsForCall, messages: strictMessages },
                strictRes,
                controller ? controller.signal : null,
                this.getToolsConfig({
                  mode: meta?.skillContext?.mode,
                  filePaths: meta?.skillContext?.filePaths,
                  skillContext: meta?.skillContext
                })
              );
              strictRes = strictToolResult.response;
              strictFinalMessages = strictToolResult.messages;
            }
            if (strictRes?.choices?.[0]?.message?.content) {
              finalRes = strictRes;
              finalMessages = strictFinalMessages;
            }
          }
        }
        // 在释放并发许可之前触发成功钩子，以确保进度日志和批次完成日志先于后续开始日志
        if (meta && typeof meta.onSuccess === 'function') {
          try { meta.onSuccess(finalRes); } catch (e) {}
        }
        return finalRes;
      } catch (error) {
        if (release) {
          try { release(); } catch (e) {}
          release = null;
        }
        if (cancelOff) {
          try { cancelOff(); } catch (e) {}
          cancelOff = null;
        }
        if (this.isCancelled() || this.isCancellationError(error)) {
          throw this.createCancelError();
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
        logger.warn(t(this.config, 'ai_retry_warn', { attempt, retries, delay, error: error?.message || String(error) }));
        await new Promise((r) => setTimeout(r, delay));
        if (this.isCancelled()) {
          throw this.createCancelError();
        }
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

  buildSkillContext(mode, filePaths = []) {
    return this.skillResolver.buildSkillContext(mode, filePaths);
  }

  formatSkillLabels(ids = []) {
    const sep = getLocale(this.config) === 'en-US' ? ', ' : '、';
    return (ids || []).map((id) => {
      const key = `skill_label_${String(id || '').replace(/-/g, '_')}`;
      const label = t(this.config, key);
      if (label && label !== key) return label;
      return String(id || '').trim() || key;
    }).filter(Boolean).join(sep);
  }

  formatToolLabel(tool) {
    const key = `tool_label_${String(tool || '').trim()}`;
    const label = t(this.config, key);
    return (label && label !== key) ? label : String(tool || '').trim();
  }

  formatToolDetail(call = {}) {
    const args = call.args || {};
    const target = this.shortDisplayPath(String(args.path || args.fromPath || args.specifier || args.scope || '').trim());
    const symbol = String(args.symbol || args.query || args.pattern || '').trim();
    if (target && symbol) return `（${symbol} @ ${target}）`;
    if (target) return `（${target}）`;
    if (symbol) return `（${symbol}）`;
    return '';
  }

  shortDisplayPath(raw, max = 56) {
    const normalized = String(raw || '').replace(/\\/g, '/').trim();
    if (!normalized) return '';
    if (normalized.length <= max) return normalized;
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const tail = parts.slice(-2).join('/');
      if (tail.length + 2 <= max) return `…/${tail}`;
    }
    return `…${normalized.slice(-(max - 1))}`;
  }

  getToolProgressEmoji(tool) {
    const name = String(tool || '').trim();
    if (['search_in_repo', 'search_in_file', 'find_references'].includes(name)) return '🔍';
    if ([
      'read_file',
      'read_around',
      'read_symbol_context',
      'get_file_outline',
      'get_file_diff',
      'get_staged_diff'
    ].includes(name)) return '📖';
    if (['trace_callers', 'resolve_import'].includes(name)) return '🔗';
    if (['list_files', 'list_changed_files'].includes(name)) return '📂';
    return '🔧';
  }

  isTraceTool(tool) {
    return [
      'find_references',
      'trace_callers',
      'read_symbol_context',
      'resolve_import',
      'read_around'
    ].includes(String(tool || '').trim());
  }

  getProgressFileLabel() {
    return this.progressScope || t(this.config, 'ai_progress_file_fallback');
  }

  formatToolCallBrief(call) {
    const tool = this.formatToolLabel(String(call?.tool || '').trim());
    const detail = this.formatToolDetail(call);
    return detail ? `${tool}${detail}` : tool;
  }

  formatToolCallLine(call) {
    const emoji = this.getToolProgressEmoji(call?.tool);
    return `${emoji} ${this.formatToolCallBrief(call)}`;
  }

  logToolCallProgress(call) {
    const tool = String(call?.tool || '').trim();
    const isTrace = this.isTraceTool(tool);
    const detail = this.formatToolDetail(call);
    const text = t(this.config, isTrace ? 'ai_progress_tool_trace' : 'ai_progress_tool_call', {
      file: this.getProgressFileLabel(),
      tool: this.formatToolLabel(tool),
      detail
    });
    logger.line(this.getToolProgressEmoji(tool), text);
  }

  logToolBatchProgress(calls = []) {
    if (!Array.isArray(calls) || calls.length === 0) return;
    if (calls.length === 1) {
      this.logToolCallProgress(calls[0]);
      return;
    }
    const scope = this.getProgressFileLabel();
    logger.progress(t(this.config, 'ai_progress_tools_batch', {
      file: scope,
      count: calls.length
    }));
    const visible = calls.slice(0, 5);
    for (const call of visible) {
      logger.sub(this.formatToolCallLine(call));
    }
    if (calls.length > visible.length) {
      logger.sub(`… ${t(this.config, 'ai_progress_tools_more', { count: calls.length - visible.length }).trim()}`);
    }
  }

  validateSkillResponse(content, skillContext) {
    return this.skillResolver.validateSkillResponse(content, skillContext);
  }

  buildSkillCorrectionPrompt(skillContext) {
    return this.skillResolver.buildSkillCorrectionPrompt(skillContext);
  }

  async resolveSkillSelection(params, initialResponse, signal, skillContext) {
    let response = initialResponse;
    let messages = [...(params?.messages || [])];
    const preSelected = skillContext?.preSelectedIds || [];
    let selectedIds = this.skillResolver.extractSkillSelection(response?.choices?.[0]?.message?.content || '');
    if (selectedIds.length === 0 && preSelected.length > 0) {
      selectedIds = [...preSelected];
    }

    if (this.isSubstantiveAnalysisResult(response?.choices?.[0]?.message?.content || '')) {
      return { response, messages, selectedIds };
    }

    if (selectedIds.length > 0 && selectedIds.join(',') !== preSelected.join(',')) {
      logger.info(t(this.config, 'ai_progress_skill_selected', { skills: this.formatSkillLabels(selectedIds) }));
    }

    if (skillContext?.skipSelectionRound && preSelected.length > 0) {
      const content = response?.choices?.[0]?.message?.content || '';
      const onlySkillSelect = /\[SKILL_SELECT\]/i.test(content)
        && !this.isSubstantiveAnalysisResult(content)
        && !this.extractToolCall(content)
        && !/(风险原因|Reason|修改建议|Suggestion)/i.test(content);
      if (!onlySkillSelect) {
        return { response, messages, selectedIds };
      }
      logger.progress(t(this.config, 'ai_progress_waiting_model', { file: this.getProgressFileLabel() }));
      messages = [
        ...messages,
        { role: 'assistant', content },
        { role: 'user', content: `${this.tForAI('skills_preselected_continue', { skills: preSelected.join(', ') })}\n\n${this.tForAI('skills_perform_review')}` }
      ];
      response = await this.createChatCompletion({ ...params, messages }, signal);
      selectedIds = this.skillResolver.extractSkillSelection(response?.choices?.[0]?.message?.content || '') || selectedIds;
      return { response, messages, selectedIds };
    }

    const needsBodies = selectedIds.length > 0 && this.skillResolver.needsDocumentBodies(selectedIds);
    if (needsBodies) {
      const bodies = this.skillResolver.buildSelectedSkillsPrompt(selectedIds);
      const content = response?.choices?.[0]?.message?.content || '';
      messages = [
        ...messages,
        { role: 'assistant', content },
        { role: 'user', content: `${this.tForAI('skills_continue_after_select', { skills: selectedIds.join(',') })}\n\n${bodies}\n\n${this.tForAI('skills_perform_review')}` }
      ];
      response = await this.createChatCompletion({ ...params, messages }, signal);
      selectedIds = this.skillResolver.extractSkillSelection(response?.choices?.[0]?.message?.content || '') || selectedIds;
      return { response, messages, selectedIds };
    }

    if (selectedIds.length === 0) {
      const content = response?.choices?.[0]?.message?.content || '';
      messages = [
        ...messages,
        { role: 'assistant', content },
        { role: 'user', content: this.tForAI('skills_select_required') }
      ];
      response = await this.createChatCompletion({ ...params, messages }, signal);
      selectedIds = this.skillResolver.extractSkillSelection(response?.choices?.[0]?.message?.content || '');
      if (selectedIds.length > 0) {
        logger.info(t(this.config, 'ai_progress_skill_selected', { skills: this.formatSkillLabels(selectedIds) }));
      }
      if (selectedIds.length > 0 && this.skillResolver.needsDocumentBodies(selectedIds)) {
        const bodies = this.skillResolver.buildSelectedSkillsPrompt(selectedIds);
        messages = [
          ...messages,
          { role: 'assistant', content: response?.choices?.[0]?.message?.content || '' },
          { role: 'user', content: `${bodies}\n\n${this.tForAI('skills_perform_review')}` }
        ];
        response = await this.createChatCompletion({ ...params, messages }, signal);
      }
    }

    return { response, messages, selectedIds };
  }

  async runReviewWithLoop({ baseMessages, requestId, meta, mode, filePaths, parseIssues }) {
    const prevScope = this.progressScope;
    this.progressScope = (filePaths || [])
      .map((item) => path.basename(String(item || '')))
      .filter(Boolean)
      .join(', ') || prevScope;
    const loopCfg = this.reviewLoop.resolveConfig(mode, filePaths);
    const fixCfg = this.reviewFix.resolveConfig(mode, filePaths);
    const maxRounds = loopCfg.enabled ? loopCfg.maxRounds : 1;
    let allIssues = [];
    let lastContent = '';

    for (let round = 1; round <= maxRounds; round++) {
      if (this.isCancelled()) break;
      const roundMessages = round === 1
        ? [...baseMessages]
        : [
            ...baseMessages,
            { role: 'assistant', content: lastContent },
            { role: 'user', content: [
              this.reviewLoop.buildContinuationPrompt(round, allIssues, loopCfg),
              this.buildSkillContext(mode, filePaths).outlinePrompt
            ].filter(Boolean).join('\n\n') }
          ];

      this.loopContext = loopCfg.enabled
        ? { active: true, maxCalls: loopCfg.maxToolCallsPerReview }
        : null;

      if (round > 1) {
        logger.info(t(this.config, 'loop_round_start', { round, maxRounds: loopCfg.maxRounds }));
      } else {
        const skillIds = meta?.skillContext?.preSelectedIds?.length
          ? meta.skillContext.preSelectedIds
          : (meta?.skillContext?.selectedIds || []);
        if (skillIds.length > 0) {
          logger.info(`[${this.getProgressFileLabel()}] ${t(this.config, 'ai_progress_skills_active', { skills: this.formatSkillLabels(skillIds) })}`);
        }
        logger.progress(t(this.config, 'ai_progress_waiting_model', { file: this.getProgressFileLabel() }));
      }

      const roundRequestId = round === 1 ? requestId : `${requestId}_loop${round}`;
      const roundMeta = round === 1
        ? meta
        : (meta?.skillContext
          ? { ...meta, skillContext: { ...meta.skillContext, strict: meta.skillContext.strict !== false } }
          : meta);
      lastContent = await this.handleChunkedResponse(roundMessages, roundRequestId, roundMeta);
      if (this.isCancelled()) break;
      const roundIssues = parseIssues(lastContent) || [];
      if (!isSuccessfulReviewOutput(lastContent, roundIssues.length, roundIssues)) {
        throw createIncompleteReviewError(t(this.config, 'ai_review_incomplete'));
      }
      const selfCheckKey = hasDuplicatedIssueFields(lastContent)
        ? 'ai_progress_output_self_check_sanitized'
        : 'ai_progress_output_self_check_ok';
      logger.progress(t(this.config, selfCheckKey, {
        file: this.getProgressFileLabel(),
        count: roundIssues.length
      }));
      this.appendAIRequestLog('parsed_review', {
        issueCount: roundIssues.length,
        flags: this.summarizeReplyFlags(lastContent),
        issues: roundIssues.map((issue) => ({
          file: issue.file,
          risk: issue.risk,
          message: issue.message,
          snippet: String(issue.snippet || '').slice(0, 200)
        })),
        content: lastContent
      });
      const beforeCount = allIssues.length;
      allIssues = mergeLoopIssues(allIssues, roundIssues);
      const addedCount = allIssues.length - beforeCount;

      if (!this.reviewLoop.shouldContinue({
        content: lastContent,
        issues: allIssues,
        round,
        addedCount,
        loopCfg
      })) {
        break;
      }
    }

    if (fixCfg.enabled && fixCfg.verifyRound && allIssues.length > 0 && !this.isCancelled()) {
      const verifyPrompt = this.reviewFix.buildVerifyPrompt(allIssues, fixCfg);
      if (verifyPrompt) {
        logger.info(t(this.config, 'fix_verify_round_start'));
        const verifyMessages = [
          ...baseMessages,
          { role: 'assistant', content: lastContent },
          { role: 'user', content: verifyPrompt }
        ];
        this.loopContext = loopCfg.enabled
          ? { active: true, maxCalls: loopCfg.maxToolCallsPerReview }
          : null;
        const verifyContent = await this.handleChunkedResponse(verifyMessages, `${requestId}_fixverify`, meta);
        const verifyIssues = parseIssues(verifyContent) || [];
        allIssues = mergeFixCodes(allIssues, verifyIssues);
        lastContent = verifyContent;
      }
    }

    this.loopContext = null;
    this.progressScope = prevScope;
    return { content: lastContent, issues: allIssues };
  }

  getToolsConfig(context = {}) {
    const mode = context.mode || context.skillContext?.mode || null;
    const filePaths = context.filePaths || context.skillContext?.filePaths || [];
    const enableTrace = context.enableTraceTools === true || context.skillContext?.enableTraceTools === true;

    let resolved;
    let enabled;
    if (enableTrace) {
      resolved = resolveEvidenceTraceTools(this.config?.tools || {});
      enabled = this.config?.tools?.enabled !== false;
    } else {
      resolved = resolveToolsStrategy(this.config?.tools || {});
      const explicitEnabled = this.config?.tools?.enabled;
      enabled = explicitEnabled === true;
      if (explicitEnabled !== true && explicitEnabled !== false) {
        enabled = shouldEnableToolsForRequest(resolved, mode, filePaths, matchRoute);
      } else if (explicitEnabled === false) {
        enabled = false;
      }
    }

    const loopMaxCalls = this.loopContext?.active ? Number(this.loopContext.maxCalls) : null;
    return {
      strategy: resolved.strategy,
      enabled,
      maxCalls: Number(loopMaxCalls || resolved.maxCalls || 2),
      maxReadLines: Number(resolved.maxReadLines || 400),
      maxSearchMatches: Number(resolved.maxSearchMatches || 50),
      maxSearchFiles: Number(resolved.maxSearchFiles || 120),
      maxListFiles: Number(resolved.maxListFiles || 200),
      allow: resolved.allow,
      evidenceTrace: enableTrace,
      pathAliases: this.config?.pathAliases || this.config?.ai?.pathAliases || {}
    };
  }

  buildToolsPrompt(mode = null, filePaths = [], options = {}) {
    const cfg = this.getToolsConfig({ mode, filePaths, enableTraceTools: options.evidenceTrace });
    if (!cfg.enabled) return '';
    const lines = [
      this.tForAI('tools_prompt_header'),
      this.tForAI('tools_prompt_how_to_call'),
      '[TOOL_CALL]{"tool":"read_file","args":{"path":"relative/or/absolute/path","startLine":1,"endLine":200}}[/TOOL_CALL]',
      this.tForAI('tools_prompt_or'),
      '[TOOL_CALL]{"tool":"get_staged_diff","args":{"path":"optional/relative/path"}}[/TOOL_CALL]',
      this.tForAI('tools_prompt_or'),
      '[TOOL_CALL]{"tool":"list_files","args":{"path":"optional/subdir","pattern":"optional keyword or *.ext","maxResults":50}}[/TOOL_CALL]',
      this.tForAI('tools_prompt_or'),
      '[TOOL_CALL]{"tool":"search_in_file","args":{"path":"relative/path","query":"text or regex","regex":false,"caseSensitive":false,"maxMatches":20}}[/TOOL_CALL]',
      this.tForAI('tools_prompt_or'),
      '[TOOL_CALL]{"tool":"get_file_outline","args":{"path":"relative/path","maxItems":200}}[/TOOL_CALL]',
      this.tForAI('tools_prompt_or'),
      '[TOOL_CALL]{"tool":"search_in_repo","args":{"query":"text or regex","path":"optional/subdir","pattern":"optional *.ext","regex":false,"caseSensitive":false,"maxMatches":30,"maxFiles":50}}[/TOOL_CALL]',
      this.tForAI('tools_prompt_or'),
      '[TOOL_CALL]{"tool":"list_changed_files","args":{"staged":true,"path":"optional/subdir","statusFilter":"optional ACMRT"}}[/TOOL_CALL]',
      this.tForAI('tools_prompt_or'),
      '[TOOL_CALL]{"tool":"get_file_diff","args":{"path":"relative/path","staged":true}}[/TOOL_CALL]'
    ];
    if (cfg.evidenceTrace || cfg.allow.includes('find_references')) {
      lines.push(
        this.tForAI('tools_prompt_or'),
        '[TOOL_CALL]{"tool":"resolve_import","args":{"fromPath":"src/current/file.ts","specifier":"@/models/login"}}[/TOOL_CALL]',
        this.tForAI('tools_prompt_or'),
        '[TOOL_CALL]{"tool":"read_around","args":{"path":"src/file.ts","line":42,"before":12,"after":12}}[/TOOL_CALL]',
        this.tForAI('tools_prompt_or'),
        '[TOOL_CALL]{"tool":"find_references","args":{"symbol":"functionName","path":"optional/scope","kind":"all","maxResults":20}}[/TOOL_CALL]',
        this.tForAI('tools_prompt_or'),
        '[TOOL_CALL]{"tool":"trace_callers","args":{"symbol":"functionName","fromPath":"src/current/file.ts","contextLines":3}}[/TOOL_CALL]',
        this.tForAI('tools_prompt_or'),
        '[TOOL_CALL]{"tool":"read_symbol_context","args":{"symbol":"functionName","path":"optional/file.ts","contextLines":20}}[/TOOL_CALL]',
        this.tForAI('tools_evidence_trace_section')
      );
    }
    lines.push(
      this.tForAI('tools_prompt_budget'),
      this.tForAI('tools_prompt_strategy1'),
      this.tForAI('tools_prompt_strategy2'),
      cfg.evidenceTrace ? this.tForAI('tools_evidence_strategy') : '',
      this.tForAI('tools_prompt_final_format'),
      this.tForAI('tools_prompt_completion_rule'),
      this.tForAI('tools_prompt_no_tools_needed')
    );
    return lines.filter(Boolean).join('\n');
  }

  extractToolCall(content) {
    const calls = this.extractToolCalls(content);
    return calls[0] || null;
  }

  extractToolCalls(content) {
    const text = String(content || '');
    const matches = Array.from(text.matchAll(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/gi));
    const calls = [];
    for (const match of matches) {
      const candidate = String(match[1] || '').trim();
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        const tool = String(parsed?.tool || '').trim();
        if (!tool) continue;
        calls.push({ tool, args: parsed.args || {} });
      } catch (e) {
        continue;
      }
    }
    return calls;
  }

  extractFinalReviewContent(content) {
    return extractReviewBody(content);
  }

  looksIncompleteReview(content) {
    return reviewLooksIncomplete(content);
  }

  shouldContinueOutput(content, finishReason, continueCount, maxContinue) {
    return decideOutputContinue(content, finishReason, continueCount, maxContinue);
  }

  emitChunkSuccess(meta, fullContent) {
    if (meta && typeof meta.onSuccess === 'function') {
      try {
        meta.onSuccess({ choices: [{ message: { content: fullContent } }] });
      } catch (e) {}
    }
    return fullContent;
  }

  isNoIssueResponse(content) {
    return isNoIssueText(content);
  }

  isSubstantiveAnalysisResult(content) {
    return isSubstantiveReview(content);
  }

  createRequestId(prefix, filePath = '', extra = '') {
    const rel = String(filePath || '')
      .replace(/^[A-Za-z]:/, '')
      .replace(/[\\/]+/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(-120) || 'unknown';
    const ext = String(extra || '')
      .replace(/[\\/]+/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(-80);
    const rand = Math.random().toString(36).slice(2, 8);
    return [prefix, rel, ext, Date.now(), rand].filter(Boolean).join('_');
  }

  resolvePathInRepo(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return null;
    const abs = path.isAbsolute(raw) ? raw : path.resolve(this.projectRoot, raw);
    const normalizedRoot = path.resolve(this.projectRoot);
    const normalizedAbs = path.resolve(abs);
    if (normalizedAbs !== normalizedRoot && !normalizedAbs.startsWith(normalizedRoot + path.sep)) {
      return null;
    }
    return normalizedAbs;
  }

  walkFiles(root, limit) {
    const max = Math.max(1, Number(limit || 200));
    const files = [];
    const stack = [root];
    while (stack.length > 0 && files.length < max) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const entry of entries) {
        if (files.length >= max) break;
        const abs = path.join(current, entry.name);
        const rel = path.relative(this.projectRoot, abs).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          if (!/^(node_modules|\.git|dist|build|coverage|\.next|\.nuxt)(\/|$)/i.test(rel)) {
            stack.push(abs);
          }
          continue;
        }
        files.push({ abs, rel, name: entry.name });
      }
    }
    return files;
  }

  isPatternMatched(rel, name, pattern) {
    const normalized = String(pattern || '').trim().toLowerCase();
    if (!normalized) return true;
    const lowerRel = String(rel || '').toLowerCase();
    const lowerName = String(name || '').toLowerCase();
    const wildcard = normalized.includes('*')
      ? new RegExp(`^${normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')
      : null;
    if (wildcard) return wildcard.test(lowerName) || wildcard.test(lowerRel);
    return lowerRel.includes(normalized) || lowerName.includes(normalized);
  }

  async executeToolCall(call, toolsCfg) {
    const tool = String(call?.tool || '').trim();
    const args = call?.args || {};
    if (!toolsCfg.allow.includes(tool)) {
      return { ok: false, error: 'tool_not_allowed', tool };
    }
    if (tool === 'read_file') {
      const target = this.resolvePathInRepo(args.path);
      if (!target) return { ok: false, error: 'invalid_path' };
      if (!fs.existsSync(target)) return { ok: false, error: 'file_not_found' };
      const content = await fs.promises.readFile(target, 'utf8');
      const lines = content.split('\n');
      const maxRead = Number.isFinite(toolsCfg.maxReadLines) && toolsCfg.maxReadLines > 0 ? Math.floor(toolsCfg.maxReadLines) : 400;
      const startLine = Math.max(1, Number(args.startLine || 1));
      const endLine = Math.min(lines.length, Number(args.endLine || (startLine + maxRead - 1)));
      const safeEnd = Math.min(endLine, startLine + maxRead - 1);
      const slice = lines.slice(startLine - 1, safeEnd);
      return {
        ok: true,
        tool: 'read_file',
        path: path.relative(this.projectRoot, target).replace(/\\/g, '/'),
        startLine,
        endLine: safeEnd,
        content: slice.join('\n')
      };
    }
    if (tool === 'get_staged_diff') {
      const relPath = args.path ? String(args.path).replace(/\\/g, '/') : '';
      const staged = args.staged !== false;
      const diffArgs = staged ? ['diff', '--cached'] : ['diff'];
      const cmdArgs = ['-C', this.projectRoot, ...diffArgs, '--', ...(relPath ? [relPath] : [])];
      const { stdout } = await execFileAsync('git', cmdArgs, { maxBuffer: 10 * 1024 * 1024 });
      return {
        ok: true,
        tool: 'get_staged_diff',
        path: relPath || '*',
        staged,
        diff: String(stdout || '').slice(0, 120000)
      };
    }
    if (tool === 'get_file_diff') {
      const relPath = String(args.path || '').replace(/\\/g, '/').trim();
      if (!relPath) return { ok: false, error: 'empty_path' };
      const staged = args.staged !== false;
      const diffArgs = staged ? ['diff', '--cached', '-U8'] : ['diff', '-U8'];
      const cmdArgs = ['-C', this.projectRoot, ...diffArgs, '--', relPath];
      let stdout = '';
      try {
        const result = await execFileAsync('git', cmdArgs, { maxBuffer: 10 * 1024 * 1024 });
        stdout = result.stdout || '';
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
      if (!String(stdout).trim() && staged) {
        try {
          const fallback = await execFileAsync('git', ['-C', this.projectRoot, 'diff', '-U8', '--', relPath], { maxBuffer: 10 * 1024 * 1024 });
          stdout = fallback.stdout || '';
        } catch (e) {
          // keep empty
        }
      }
      return {
        ok: true,
        tool: 'get_file_diff',
        path: relPath,
        staged,
        diff: String(stdout || '').slice(0, 120000),
        hint: 'This diff is the change under review. Use other files only as context.'
      };
    }
    if (tool === 'list_files') {
      const relPath = String(args.path || '').trim();
      const root = relPath ? this.resolvePathInRepo(relPath) : this.projectRoot;
      if (!root) return { ok: false, error: 'invalid_path' };
      if (!fs.existsSync(root)) return { ok: false, error: 'path_not_found' };
      const stats = fs.statSync(root);
      if (!stats.isDirectory()) return { ok: false, error: 'path_not_directory' };
      const pattern = String(args.pattern || '').trim().toLowerCase();
      const maxResults = Math.max(1, Math.min(Number(args.maxResults || toolsCfg.maxListFiles || 200), toolsCfg.maxListFiles || 200));
      const all = this.walkFiles(root, maxResults * 3);
      const out = [];
      for (const file of all) {
        if (out.length >= maxResults) break;
        if (!this.isPatternMatched(file.rel, file.name, pattern)) continue;
        out.push(file.rel);
      }
      return {
        ok: true,
        tool: 'list_files',
        basePath: relPath || '.',
        count: out.length,
        files: out
      };
    }
    if (tool === 'search_in_file') {
      const target = this.resolvePathInRepo(args.path);
      if (!target) return { ok: false, error: 'invalid_path' };
      if (!fs.existsSync(target)) return { ok: false, error: 'file_not_found' };
      const content = await fs.promises.readFile(target, 'utf8');
      const lines = content.split('\n');
      const query = String(args.query || '').trim();
      if (!query) return { ok: false, error: 'empty_query' };
      const regexMode = args.regex === true;
      const caseSensitive = args.caseSensitive === true;
      const maxMatches = Math.max(1, Math.min(Number(args.maxMatches || toolsCfg.maxSearchMatches || 50), toolsCfg.maxSearchMatches || 50));
      const matches = [];
      let re = null;
      if (regexMode) {
        try {
          re = new RegExp(query, caseSensitive ? 'g' : 'gi');
        } catch (e) {
          return { ok: false, error: 'invalid_regex' };
        }
      }
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        const line = lines[i];
        if (regexMode) {
          re.lastIndex = 0;
          if (re.test(line)) {
            matches.push({ line: i + 1, content: line.slice(0, 400) });
          }
          continue;
        }
        const src = caseSensitive ? line : line.toLowerCase();
        const needle = caseSensitive ? query : query.toLowerCase();
        if (src.includes(needle)) {
          matches.push({ line: i + 1, content: line.slice(0, 400) });
        }
      }
      return {
        ok: true,
        tool: 'search_in_file',
        path: path.relative(this.projectRoot, target).replace(/\\/g, '/'),
        query,
        count: matches.length,
        matches
      };
    }
    if (tool === 'search_in_repo') {
      const relPath = String(args.path || '').trim();
      const root = relPath ? this.resolvePathInRepo(relPath) : this.projectRoot;
      if (!root) return { ok: false, error: 'invalid_path' };
      if (!fs.existsSync(root)) return { ok: false, error: 'path_not_found' };
      const stats = fs.statSync(root);
      if (!stats.isDirectory()) return { ok: false, error: 'path_not_directory' };
      const query = String(args.query || '').trim();
      if (!query) return { ok: false, error: 'empty_query' };
      const pattern = String(args.pattern || '').trim();
      const regexMode = args.regex === true;
      const caseSensitive = args.caseSensitive === true;
      const maxMatches = Math.max(1, Math.min(Number(args.maxMatches || toolsCfg.maxSearchMatches || 50), toolsCfg.maxSearchMatches || 50));
      const maxFiles = Math.max(1, Math.min(Number(args.maxFiles || toolsCfg.maxSearchFiles || 120), toolsCfg.maxSearchFiles || 120));
      const candidates = this.walkFiles(root, maxFiles * 4).filter((f) => this.isPatternMatched(f.rel, f.name, pattern));
      const scoped = candidates.slice(0, maxFiles);
      const results = [];
      let re = null;
      if (regexMode) {
        try {
          re = new RegExp(query, caseSensitive ? 'g' : 'gi');
        } catch (e) {
          return { ok: false, error: 'invalid_regex' };
        }
      }
      for (const file of scoped) {
        if (results.length >= maxMatches) break;
        let content = '';
        try {
          const fileStat = fs.statSync(file.abs);
          if (fileStat.size > 1024 * 1024) continue;
          content = await fs.promises.readFile(file.abs, 'utf8');
        } catch (e) {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < maxMatches; i++) {
          const line = lines[i];
          if (regexMode) {
            re.lastIndex = 0;
            if (re.test(line)) {
              results.push({ path: file.rel, line: i + 1, content: line.slice(0, 320) });
            }
            continue;
          }
          const src = caseSensitive ? line : line.toLowerCase();
          const needle = caseSensitive ? query : query.toLowerCase();
          if (src.includes(needle)) {
            results.push({ path: file.rel, line: i + 1, content: line.slice(0, 320) });
          }
        }
      }
      return {
        ok: true,
        tool: 'search_in_repo',
        basePath: relPath || '.',
        query,
        scannedFiles: scoped.length,
        count: results.length,
        matches: results
      };
    }
    if (tool === 'list_changed_files') {
      const staged = args.staged !== false;
      const relPath = String(args.path || '').trim();
      const statusFilter = String(args.statusFilter || '').trim().toUpperCase();
      const diffArgs = staged ? ['diff', '--cached', '--name-status'] : ['diff', '--name-status'];
      const cmdArgs = ['-C', this.projectRoot, ...diffArgs, '--', ...(relPath ? [relPath] : [])];
      const { stdout } = await execFileAsync('git', cmdArgs, { maxBuffer: 5 * 1024 * 1024 });
      const lines = String(stdout || '').split('\n').map((x) => x.trim()).filter(Boolean);
      const files = [];
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 2) continue;
        const status = parts[0].trim();
        const file = parts[parts.length - 1].trim().replace(/\\/g, '/');
        if (statusFilter && !statusFilter.includes(status[0])) continue;
        files.push({ status, path: file });
      }
      return {
        ok: true,
        tool: 'list_changed_files',
        staged,
        count: files.length,
        files
      };
    }
    if (tool === 'get_file_outline') {
      const target = this.resolvePathInRepo(args.path);
      if (!target) return { ok: false, error: 'invalid_path' };
      if (!fs.existsSync(target)) return { ok: false, error: 'file_not_found' };
      const content = await fs.promises.readFile(target, 'utf8');
      const lines = content.split('\n');
      const maxItems = Math.max(1, Math.min(Number(args.maxItems || 200), 500));
      const patterns = [
        { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
        { kind: 'function', re: /^\s*function\s+([A-Za-z_]\w*)\s*\(/ },
        { kind: 'method', re: /^\s*(?:public|private|protected|static|async|\s)*\s*([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/ },
        { kind: 'arrow', re: /^\s*(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*\([^)]*\)\s*=>/ },
        { kind: 'export', re: /^\s*export\s+(?:default\s+)?(?:class|function|const|let|var)?\s*([A-Za-z_]\w*)?/ },
        { kind: 'python-def', re: /^\s*def\s+([A-Za-z_]\w*)\s*\(/ },
        { kind: 'python-class', re: /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/ },
        { kind: 'go-func', re: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/ }
      ];
      const items = [];
      for (let i = 0; i < lines.length && items.length < maxItems; i++) {
        const line = lines[i];
        for (const p of patterns) {
          const m = line.match(p.re);
          if (m) {
            items.push({
              line: i + 1,
              kind: p.kind,
              name: m[1] || '',
              content: line.trim().slice(0, 240)
            });
            break;
          }
        }
      }
      return {
        ok: true,
        tool: 'get_file_outline',
        path: path.relative(this.projectRoot, target).replace(/\\/g, '/'),
        count: items.length,
        items
      };
    }
    const traceResult = executeTraceTool(tool, this.projectRoot, args, toolsCfg);
    if (traceResult) return traceResult;
    return { ok: false, error: 'unsupported_tool' };
  }

  async requestFinalReview(params, messages, signal, previousContent) {
    logger.progress(t(this.config, 'ai_progress_tools_finalize', { file: this.getProgressFileLabel() }));
    const finalizePrompt = [
      this.tForAI('tools_finalize_line1'),
      this.tForAI('tools_finalize_line2'),
      this.tForAI('tools_finalize_empty_visible'),
      this.tForAI('tools_finalize_line3'),
      this.tForAI('tools_finalize_line4'),
      this.tForAI('tools_finalize_line5'),
      this.tForAI('tools_finalize_line6'),
      this.tForAI('tools_finalize_line7')
    ].join('\n');
    const assistantText = String(previousContent || '').trim() || this.tForAI('tools_empty_assistant');
    const nextMessages = [
      ...messages,
      { role: 'assistant', content: assistantText },
      { role: 'user', content: finalizePrompt }
    ];
    const response = await this.createChatCompletion({ ...params, messages: nextMessages }, signal);
    return { response, messages: nextMessages };
  }

  async resolveToolCalls(params, initialResponse, signal, toolsCfg) {
    let response = initialResponse;
    let messages = [...(params?.messages || [])];
    const maxCalls = Number.isFinite(toolsCfg.maxCalls) && toolsCfg.maxCalls > 0 ? Math.floor(toolsCfg.maxCalls) : 2;
    let callsUsed = 0;
    for (let i = 0; i < maxCalls; i++) {
      const content = response?.choices?.[0]?.message?.content || '';
      const calls = this.extractToolCalls(content);
      if (calls.length === 0) break;
      const remaining = maxCalls - callsUsed;
      const batch = calls.slice(0, Math.max(1, remaining));
      this.logToolBatchProgress(batch);
      const results = await Promise.all(batch.map(async (call) => {
        try {
          return await this.executeToolCall(call, toolsCfg);
        } catch (e) {
          return { ok: false, error: e?.message || String(e), tool: call.tool };
        }
      }));
      callsUsed += batch.length;
      messages = [...messages, { role: 'assistant', content }, { role: 'user', content: `[TOOL_RESULT]\n${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n[/TOOL_RESULT]` }];
      response = await this.createChatCompletion({ ...params, messages }, signal);
      const updated = response?.choices?.[0]?.message?.content || '';
      if (this.isSubstantiveAnalysisResult(updated)) {
        break;
      }
      if (callsUsed >= maxCalls) break;
    }
    const tail = response?.choices?.[0]?.message?.content || '';
    if (this.extractToolCall(tail) || !this.isSubstantiveAnalysisResult(tail)) {
      const finalized = await this.requestFinalReview(params, messages, signal, tail);
      response = finalized.response;
      messages = finalized.messages;
    }
    return { response, messages, callsUsed };
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
      ? [process.env.AI_API_KEY, process.env.ANTHROPIC_API_KEY]
      : provider === 'gemini'
        ? [process.env.AI_API_KEY, process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY]
        : [process.env.AI_API_KEY, process.env.OPENAI_API_KEY];
    return candidates.find(Boolean) || '';
  }

  resolveBaseURL(provider, baseURL) {
    if (baseURL) return String(baseURL).trim();
    if (provider === 'anthropic') return 'https://api.anthropic.com';
    if (provider === 'gemini') return 'https://generativelanguage.googleapis.com';
    return '';
  }

  summarizeReplyFlags(content) {
    const text = String(content || '');
    const flags = [];
    if (/\[TOOL_CALL\]/i.test(text)) flags.push('TOOL_CALL');
    if (/\[REVIEW_FINAL\]/i.test(text)) flags.push('REVIEW_FINAL');
    if (/\[\/REVIEW_FINAL\]/i.test(text)) flags.push('/REVIEW_FINAL');
    if (/\[CHUNK_CONTINUE\]/i.test(text)) flags.push('CHUNK_CONTINUE');
    if (/\[SKILL_SELECT\]/i.test(text)) flags.push('SKILL_SELECT');
    if (isNoIssueText(extractReviewBody(text))) flags.push('NONE');
    if (/^问题\d+[:：]/m.test(text) || /(文件路径|File Path)\s*[:：]/.test(text)) flags.push('ISSUE');
    return flags.join(',') || 'none';
  }

  logModelReply(stage, response, extra = {}) {
    const choice = response?.choices?.[0] || {};
    const parts = extractResponseParts(response);
    const content = String(choice.message?.content || parts.visible || '');
    const finish = String(choice.finish_reason || extra.finishReason || '').toLowerCase() || 'unknown';
    const usage = response?.usage || {};
    const promptTokens = usage.prompt_tokens ?? usage.promptTokens ?? '-';
    const completionTokens = usage.completion_tokens ?? usage.completionTokens ?? '-';
    const maxTokens = extra.maxTokens ?? this.getMaxTokens() ?? 'unlimited';
    const flags = this.summarizeReplyFlags(content || parts.reasoning);
    logger.debug(t(this.config, 'ai_reply_summary', {
      file: this.getProgressFileLabel(),
      stage,
      finish,
      chars: content.length,
      reasoning: parts.reasoning.length,
      maxTokens,
      promptTokens,
      completionTokens,
      flags
    }));
    if (extra.note) {
      logger.debug(t(this.config, 'ai_reply_note', { note: extra.note }));
    }
    this.appendAIRequestLog(`model_reply_${stage}`, {
      finish,
      chars: content.length,
      reasoningChars: parts.reasoning.length,
      maxTokens,
      usage,
      flags,
      extra,
      content,
      reasoning: parts.reasoning.slice(0, 4000)
    });
  }

  async createChatCompletion(params, signal) {
    const request = normalizeChatRequest({
      ...params,
      max_tokens: params?.max_tokens ?? this.getMaxTokens()
    }, this.config);
    this.appendAIRequestLog('normalized_request', {
      provider: this.provider,
      model: request?.model,
      temperature: request?.temperature,
      max_tokens: request?.max_tokens,
      messageCount: Array.isArray(request?.messages) ? request.messages.length : 0,
      messages: request?.messages || []
    });
    const startedAt = Date.now();
    let response;
    if (this.provider === 'anthropic') {
      response = await this.createAnthropicCompletion(request, signal);
    } else if (this.provider === 'gemini') {
      response = await this.createGeminiCompletion(request, signal);
    } else {
      this.appendAIRequestLog('openai_payload', request || {});
      response = await this.client.chat.completions.create(
        request,
        signal ? { signal } : undefined
      );
    }
    response = hydrateResponseContent(response);
    this.logModelReply('api', response, { maxTokens: request?.max_tokens ?? 'unlimited' });
    const parts = extractResponseParts(response);
    const visible = String(response?.choices?.[0]?.message?.content || parts.visible || '');
    const reasoningLen = Number(parts.reasoning?.length || 0);
    logger.progress(t(this.config, 'ai_progress_model_round_done', {
      file: this.getProgressFileLabel(),
      secs: ((Date.now() - startedAt) / 1000).toFixed(1),
      reasoning: reasoningLen,
      chars: visible.length
    }));
    return response;
  }

  async createAnthropicCompletion(params, signal) {
    const { body, model } = buildAnthropicRequest({
      ...params,
      max_tokens: params.max_tokens ?? this.getMaxTokens()
    }, this.config);
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
    this.appendAIRequestLog('anthropic_payload', {
      endpoint,
      body
    });
    const response = await this.requestJson(endpoint, {
      method: 'POST',
      headers,
      body,
      signal
    });
    return normalizeAnthropicResponse(response);
  }

  async createGeminiCompletion(params, signal) {
    const { body, model } = buildGeminiRequest({
      ...params,
      max_tokens: params.max_tokens ?? this.getMaxTokens()
    }, this.config);
    const version = this.config.geminiApiVersion || 'v1beta';
    const endpoint = `${this.providerBaseURL.replace(/\/$/, '')}/${version}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    this.appendAIRequestLog('gemini_payload', {
      endpoint,
      body
    });
    const response = await this.requestJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal
    });
    return normalizeGeminiResponse(response);
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
      const err = new Error(extractProviderError(this.provider, parsed, response.status));
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
          const err = new Error(extractProviderError(this.provider, parsed, status));
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
    if (!error) return false;
    if (error.isCancelled) return true;
    const name = String(error.name || '');
    if (name === 'AbortError' || name === 'APIUserAbortError' || name === 'CanceledError') return true;
    const code = String(error.code || '');
    if (code === 'ABORT_ERR' || code === 'ERR_CANCELED' || code === 'ERR_ABORTED') return true;
    const msg = String(error.message || '').toLowerCase();
    return msg.includes('cancel') || msg.includes('abort') || msg.includes('中断');
  }

  isConnectionFailure(error) {
    if (!error || this.isCancellationError(error)) return false;
    const status = Number(error.status || error.statusCode || error.response?.status);
    if (status === 401 || status === 403 || status === 407) return true;
    const msg = String(error.message || '');
    if (/Connection error/i.test(msg)) return true;
    if (/请求失败/.test(msg)) return true;
    if (/\b(ECONNRESET|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/.test(msg)) return true;
    if (/fetch failed|network error|socket hang up/i.test(msg)) return true;
    return false;
  }

  propagateAiFailure(error) {
    if (isIncompleteReviewError(error) || isAiConnectionError(error) || isAiApiError(error)) {
      throw error;
    }
    if (isAiProviderHttpFailure(error)) {
      const detail = String(error.message || '').trim();
      throw createAiApiError(
        detail ? t(this.config, 'ai_api_failed_detail', { detail }) : t(this.config, 'ai_api_failed'),
        error
      );
    }
    if (this.isConnectionFailure(error)) {
      logger.error(t(this.config, 'ai_connection_failed'));
      throw createAiConnectionError(t(this.config, 'ai_connection_failed'), error);
    }
    throw createAiApiError(
      String(error?.message || t(this.config, 'ai_api_failed')),
      error
    );
  }

  getSystemPrompt() {
    // 使用缓存避免重复构建系统提示词
    if (this.systemPromptCache) {
      this.cacheStats.hits++;
      return this.systemPromptCache;
    }
    this.cacheStats.misses++;
    const { systemPrompt } = buildPrompts(this.aiLocaleConfig);
    const outputLanguage = this.getUserOutputLanguageInstruction();
    const riskRubric = this.tForAI('risk_rubric');
    const longOutput = this.tForAI('output_chunk_rule');
    this.systemPromptCache = [systemPrompt, riskRubric, longOutput, outputLanguage].filter(Boolean).join('\n\n');
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
    const { diffSystemPrompt } = buildPrompts(this.aiLocaleConfig);
    const outputLanguage = this.getUserOutputLanguageInstruction();
    const riskRubric = this.tForAI('risk_rubric');
    const longOutput = this.tForAI('output_chunk_rule');
    this.diffSystemPromptCache = [diffSystemPrompt, riskRubric, longOutput, outputLanguage]
      .filter(Boolean)
      .join('\n\n');
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
    const normalizedResponse = this.extractFinalReviewContent(response);
    if (!normalizedResponse || isNoIssueText(normalizedResponse)) {
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
      const matches = Array.from(normalizedResponse.matchAll(re));
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
      let blocks = normalizedResponse.split('\n\n');
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
      const problemBlocks = this.splitByProblemNumbers(normalizedResponse);
      for (const block of problemBlocks) {
        const issue = this.parseIssueBlock(block, filePath, context);
        if (issue) {
          issues.push(issue);
        }
      }
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
    const rawLines = block.split('\n');
    // Keep original lines for matching; normalize is only a fallback for legacy labels.
    const lines = rawLines.map((line) => String(line ?? ''));
    const issue = { source: 'ai' };

    const matchField = (text) => matchIssueFieldLine(normalizeIssueLabelLine(text)) || matchIssueFieldLine(text);
    const isFieldLine = (text) => isIssueFieldLine(normalizeIssueLabelLine(text)) || isIssueFieldLine(text);

    const applySnippetCandidate = (candidate) => {
      const next = String(candidate || '').trim();
      if (!next) return;
      if (!issue.snippet) {
        issue.snippet = next;
        return;
      }
      const cleanedExisting = stripIssueFieldLinesFromSnippet(issue.snippet);
      const cleanedNext = stripIssueFieldLinesFromSnippet(next);
      // Continue/finalize overlap often leaves a polluted first snippet; prefer cleaned text.
      if (cleanedExisting !== String(issue.snippet).trim()) {
        issue.snippet = cleanedNext || cleanedExisting;
      }
    };

    if (!filePath && context.fileList && context.fileList.length > 0) {
      const filePathLine = lines.find((line) => matchField(line)?.kind === 'file');
      if (filePathLine) {
        const aiPath = matchField(filePathLine)?.value || '';
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
    let collectFixSnippet = false;
    let suggestionLines = [];
    let fixSnippetLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (collectPlainSnippet) {
        if (isFieldLine(line)) {
          applySnippetCandidate(codeLines.join('\n'));
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

      if (collectFixSnippet) {
        if (isFieldLine(line)) {
          issue.fixSnippet = fixSnippetLines.join('\n').trim();
          collectFixSnippet = false;
          fixSnippetLines = [];
        } else {
          fixSnippetLines.push(line);
          continue;
        }
      }

      const field = matchField(line);
      if (!field) {
        if (isInCodeBlock) {
          if (line.trim() === '```') {
            isInCodeBlock = false;
            applySnippetCandidate(codeLines.join('\n'));
          } else {
            codeLines.push(line);
          }
        }
        continue;
      }

      if (field.kind === 'file') {
        // ignore; handled above
      } else if (field.kind === 'risk') {
        issue.risk = this.mapRiskLevel(field.value || '');
      } else if (field.kind === 'reason') {
        issue.message = field.value || '';
      } else if (field.kind === 'suggestion') {
        collectSuggestion = true;
        suggestionLines = field.value ? [field.value] : [];
      } else if (field.kind === 'snippet') {
        const snippetContent = field.value || '';
        if (snippetContent && !snippetContent.startsWith('```')) {
          collectPlainSnippet = true;
          codeLines = [snippetContent];
        } else if (i + 1 < lines.length && lines[i + 1].trim().startsWith('```')) {
          isInCodeBlock = true;
          i++;
          codeLines = [];
        } else {
          collectPlainSnippet = true;
          codeLines = [];
        }
      } else if (field.kind === 'fixSnippet') {
        collectFixSnippet = true;
        fixSnippetLines = field.value ? [field.value] : [];
      } else if (field.kind === 'line' || field.kind === 'lineRange') {
        const loc = parseIssueLineLocation(field.value);
        if (loc) {
          issue.lineStart = loc.start;
          issue.lineEnd = loc.end;
          issue.line = loc.start;
        }
      } else if (isInCodeBlock) {
        if (line.trim() === '```') {
          isInCodeBlock = false;
          applySnippetCandidate(codeLines.join('\n'));
        } else {
          codeLines.push(line);
        }
      }
    }

    if (collectPlainSnippet && (!issue.snippet || issue.snippet.length === 0)) {
      applySnippetCandidate(codeLines.join('\n'));
    }
    if (collectSuggestion && (!issue.suggestion || issue.suggestion.length === 0)) {
      issue.suggestion = suggestionLines.join('\n').trim();
    }
    if (collectFixSnippet && (!issue.fixSnippet || issue.fixSnippet.length === 0)) {
      issue.fixSnippet = fixSnippetLines.join('\n').trim();
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
    if (issue.fixSnippet && typeof issue.fixSnippet === 'string') {
      issue.fixSnippet = this.normalizeSnippet(issue.fixSnippet);
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
      if (isFormatPlaceholderIssue(issue)) return null;
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
      const lines = stripIssueFieldLinesFromSnippet(snippet).split('\n');
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

  mapRiskLevel(levelText) {
    return mapRiskLevel(levelText);
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
    return /\[CHUNK_CONTINUE\]/i.test(String(content || ''));
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
    let cleanContent = stripChunkMarkers(content);
    
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
      const chatMeta = meta ? { ...meta, onSuccess: undefined } : null;
      const payload = {
        model: this.config.model ?? 'gpt-3.5-turbo',
        messages: collector.messages
      };
      const maxTokens = this.getMaxTokens();
      if (maxTokens) payload.max_tokens = maxTokens;
      const response = await this.chatWithRetry(
        payload,
        isFirstCall ? chatMeta : (chatMeta ? { ...chatMeta, onStart: undefined } : null)
      );

      const choice = response?.choices?.[0] || {};
      const content = choice.message?.content || '';
      logger.debug(t(this.config, 'ai_response_len_dbg', { len: content.length }));
      const finishReason = String(choice.finish_reason || '').toLowerCase();
      const maxContinue = 3;
      collector.continueCount = Number(collector.continueCount || 0);
      const decision = this.shouldContinueOutput(content, finishReason, collector.continueCount, maxContinue);
      this.logModelReply('review', response, {
        maxTokens: this.getMaxTokens(),
        finishReason,
        note: t(this.config, decision.continue ? 'ai_reply_will_continue' : 'ai_reply_will_stop', {
          reason: decision.reason,
          finish: finishReason || 'unknown'
        })
      });

      if (decision.continue) {
        const chunkInfo = this.isChunkedResponse(content)
          ? this.parseChunkInfo(content)
          : { content, currentChunk: collector.chunks.length + 1, isComplete: false, isContinue: true };
        collector.chunks.push({
          index: chunkInfo.currentChunk,
          content: chunkInfo.content,
          timestamp: Date.now()
        });
        if (chunkInfo.isComplete && !this.looksIncompleteReview(content)) {
          collector.isComplete = true;
          this.chunkedResponseCollector.delete(requestId);
          return this.emitChunkSuccess(meta, assembleReviewChunks(collector.chunks));
        }
        collector.continueCount += 1;
        const reasonText = decision.reason === 'truncated'
          ? t(this.config, 'ai_progress_output_continue_truncated')
          : t(this.config, 'ai_progress_output_continue_unclosed');
        logger.progress(t(this.config, 'ai_progress_output_continue', {
          file: this.getProgressFileLabel(),
          reason: reasonText,
          round: collector.continueCount,
          max: maxContinue
        }));
        collector.messages.push({ role: 'assistant', content: content });
        collector.messages.push({
          role: 'user',
          content: decision.reason === 'truncated'
            ? this.tForAI('chunk_continue_after_truncate')
            : this.tForAI('chunk_continue_unclosed')
        });
        return await this.handleChunkedResponse(null, requestId, meta);
      }

      collector.chunks.push({
        index: collector.chunks.length + 1,
        content: content,
        timestamp: Date.now()
      });
      collector.isComplete = true;
      const fullContent = collector.chunks.length > 1
        ? assembleReviewChunks(collector.chunks)
        : stripChunkMarkers(content);
      this.chunkedResponseCollector.delete(requestId);
      return this.emitChunkSuccess(meta, fullContent);
    } catch (error) {
      // 清理收集器
      this.chunkedResponseCollector.delete(requestId);
      throw error;
    }
  }

  // 组装分段内容
  assembleChunks(chunks) {
    return assembleReviewChunks(chunks);
  }

  getMaxTokens() {
    const raw = this.config.maxResponseTokens;
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) return undefined;
    return Math.floor(num);
  }

  
}
