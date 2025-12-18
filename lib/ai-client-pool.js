/**
 * AI客户端池管理器
 * 管理多个AI客户端实例，支持并发请求处理
 */

import { AIClient } from './ai-client.js';
import { logger } from './utils/logger.js';
import { t } from './utils/i18n.js';

export class AIClientPool {
  constructor(config, rules, poolSize = 3, concurrencyLimiter = null) {
    this.config = config;
    this.rules = rules;
    this.poolSize = poolSize;
    this.concurrencyLimiter = concurrencyLimiter;
    this.clients = [];
    this.busyClients = new Set();
    this.waitingQueue = [];
    this.stats = {
      totalRequests: 0,
      completedRequests: 0,
      failedRequests: 0,
      retryCount: 0
    };
    
    this.initializePool();
  }

  /**
   * 初始化客户端池
   */
  initializePool() {
    logger.debug(t(this.config, 'init_pool_dbg', { size: this.poolSize }));
    
    for (let i = 0; i < this.poolSize; i++) {
      // 将 reviewDir 与 locale 一并传递，确保池中客户端的国际化与自定义提示词目录正确
      const client = new AIClient({
        ...this.config.ai,
        reviewDir: this.config.reviewDir,
        locale: this.config.locale
      });
      client.poolId = i;
      // 注入全局并发限速器，确保批次与分段共享并发资源
      if (this.concurrencyLimiter) {
        client.concurrencyLimiter = this.concurrencyLimiter;
      }
      this.clients.push(client);
    }
    
    logger.debug(t(this.config, 'pool_init_done_dbg', { count: this.clients.length }));
  }

  /**
   * 获取可用的客户端
   * @returns {Promise<AIClient>} 可用的AI客户端
   */
  async getAvailableClient() {
    // 查找空闲的客户端
    const availableClient = this.clients.find(client => !this.busyClients.has(client));
    
    if (availableClient) {
      this.busyClients.add(availableClient);
      return availableClient;
    }
    
    // 如果没有可用客户端，等待
    return new Promise((resolve) => {
      this.waitingQueue.push(resolve);
    });
  }

  /**
   * 释放客户端
   * @param {AIClient} client - 要释放的客户端
   */
  releaseClient(client) {
    this.busyClients.delete(client);
    
    // 如果有等待的请求，分配给它们
    if (this.waitingQueue.length > 0) {
      const resolve = this.waitingQueue.shift();
      this.busyClients.add(client);
      resolve(client);
    }
  }

  /**
   * 将批次按文件分组
   * @param {Array} batches - 批次数组
   * @returns {Array} 文件组数组，每组包含同一文件的所有分段批次
   */
  groupBatchesByFile(batches) {
    const fileGroups = new Map();
    
    batches.forEach((batch, originalIndex) => {
      let fileKey;
      
      if (batch.isLargeFileSegment && batch.segmentedFile) {
        // 大文件分段：使用文件路径作为分组键
        fileKey = batch.segmentedFile;
      } else {
        // 小文件批次：每个批次独立成组
        fileKey = `batch_${originalIndex}`;
      }
      
      if (!fileGroups.has(fileKey)) {
        fileGroups.set(fileKey, []);
      }
      
      // 保存原始索引用于进度显示
      batch.originalIndex = originalIndex;
      fileGroups.get(fileKey).push(batch);
    });
    
    // 对每个文件组内的分段按currentSegment排序
    fileGroups.forEach(group => {
      if (group.length > 1 && group[0].isLargeFileSegment) {
        group.sort((a, b) => (a.currentSegment || 0) - (b.currentSegment || 0));
      }
    });
    
    return Array.from(fileGroups.values());
  }

  /**
   * 串行处理文件组内的所有批次
   * @param {Array} group - 文件组（包含同一文件的所有分段批次）
   * @param {Function} progressCallback - 进度回调函数
   * @returns {Promise<Object>} 处理结果
   */
  async processFileGroupSerially(group, progressCallback = null) {
    const allIssues = [];
    let successCount = 0;
    let failureCount = 0;
    let totalDurationMs = 0;
    
    // 串行处理组内的每个批次
     for (const batch of group) {
       try {
         const result = await this.processBatchWithRetry(batch, batch.originalIndex, progressCallback);
         // 新的返回格式 { issues: [...], durationMs }
         const issues = Array.isArray(result) ? result : (result.issues || []);
         allIssues.push(...issues);
         if (result && typeof result.durationMs === 'number') {
           totalDurationMs += result.durationMs;
         }
         successCount++;
       } catch (error) {
         failureCount++;
         logger.error(t(this.config, 'batch_process_failed', { i: batch.originalIndex + 1, error: error.message }));
       }
     }
    
    return {
      issues: allIssues,
      successCount,
      failureCount,
      totalDurationMs
    };
  }

  /**
   * 并发执行多个批次
   * @param {Array} batches - 批次数组
   * @param {Function} progressCallback - 进度回调函数
   * @returns {Promise<Array>} 所有批次的结果
   */
  async executeConcurrentBatches(batches, progressCallback = null) {
    if (!batches || batches.length === 0) {
      return [];
    }

    logger.debug(t(this.config, 'start_concurrent_dbg', { count: batches.length }));
    
    // 设置总请求数用于进度显示
    this.stats.totalRequests = batches.length;
    
    // 将批次按文件分组：同一文件的分段需要串行处理，不同文件可以并发
    const fileGroups = this.groupBatchesByFile(batches);
    
    // 创建文件组处理任务（文件组之间并发，组内分段串行）
    const fileGroupTasks = fileGroups.map(group => {
      return this.processFileGroupSerially(group, progressCallback);
    });

    try {
      // 使用Promise.allSettled来处理所有文件组，即使某些失败也继续
      const results = await Promise.allSettled(fileGroupTasks);
      
      // 收集成功的结果
      const allIssues = [];
      let successCount = 0;
      let failureCount = 0;
      let totalDurationMs = 0;
      
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          allIssues.push(...result.value.issues);
          successCount += result.value.successCount;
          failureCount += result.value.failureCount;
          if (typeof result.value.totalDurationMs === 'number') {
            totalDurationMs += result.value.totalDurationMs;
          }
        } else {
          failureCount++;
          logger.error(t(this.config, 'concurrent_group_failed', { index: index + 1, error: result.reason?.message || String(result.reason) }));
        }
      });

      logger.debug(t(this.config, 'concurrent_done_dbg', { succ: successCount, fail: failureCount }));
      return { issues: allIssues, totalDurationMs };
      
    } catch (error) {
      logger.error(t(this.config, 'concurrent_processing_error', { error: error?.message || String(error) }));
      throw error;
    }
  }

  /**
   * 带重试机制的批次处理
   * @param {Object} batch - 批次对象
   * @param {number} batchIndex - 批次索引
   * @param {Function} progressCallback - 进度回调
   * @param {number} retryCount - 重试次数
   * @returns {Promise<Array>} 处理结果
   */
  async processBatchWithRetry(batch, batchIndex, progressCallback = null, retryCount = 0) {
    const maxRetries = 3;
    
    try {
      // 获取可用客户端
      const client = await this.getAvailableClient();
      
      try {
        // 在批次对象上记录索引与总批次数，便于下游日志展示
        batch.batchIndex = batchIndex;
        batch.totalRequests = this.stats.totalRequests;
        
        // 格式化批次数据
        const formattedBatch = this.formatBatchForAI(batch);
        
        // 获取批次文件信息用于日志（统一使用绝对路径）
        const fileNames = batch.items.map(item => (item.originalFilePath || item.filePath)).join(', ');

        // 构造元数据：在释放并发许可前触发“批次完成”和进度回调，保证日志顺序
        let earlySuccessLogged = false;
        let requestMeta = null;
        if (!batch.isLargeFileSegment) {
          requestMeta = {
            onSuccess: (res) => {
              if (earlySuccessLogged) return;
              earlySuccessLogged = true;
              // 计算问题数量与耗时
              const duration = Date.now() - startTime;
              let issueCount = 0;
              try {
                const content = res?.choices?.[0]?.message?.content ?? '';
                const parsed = client.parseAIResponse(content, undefined, {});
                if (Array.isArray(parsed)) issueCount = parsed.length;
                else if (parsed && Array.isArray(parsed.issues)) issueCount = parsed.issues.length;
              } catch (e) {}
      logger.success(t(this.config, 'batch_complete', {
        i: batchIndex + 1,
        total: this.stats.totalRequests,
        context: fileNames,
        issues: issueCount,
        secs: (duration/1000).toFixed(1)
      }));
              if (typeof progressCallback === 'function') {
                try { progressCallback(batchIndex, batch, 'completed', null); } catch (e) {}
              }
            }
          };
        }
        
        // 执行AI分析
        if (batch.isLargeFileSegment) {
          // 大文件分段批次：仅展示总段数，避免与后续逐段日志重复
          const item = batch.items[0];
          const fullPath = item.originalFilePath || item.filePath;
          const totalSeg = item.totalChunks || batch.totalSegments || 1;
      logger.info(t(this.config, 'batch_start_segmented', {
        i: batchIndex + 1,
        total: this.stats.totalRequests,
        path: fullPath,
        segments: totalSeg
      }));
        } else {
          // 小文件批次：保持一致的“批次 i/x”格式
      logger.info(t(this.config, 'batch_start_regular', {
        i: batchIndex + 1,
        total: this.stats.totalRequests,
        files: fileNames,
        tokens: batch.totalTokens,
        count: batch.items.length
      }));
        }
        const startTime = Date.now();
        logger.debug(t(this.config, 'request_batch_start_dbg', { index: batchIndex + 1, client: client.constructor.name }));
        
        const result = await client.analyzeSmartBatch(formattedBatch, batch, requestMeta);
        
        const duration = Date.now() - startTime;
        const issueCount = result.issues?.length || 0;
        
        // 如果尚未提前输出，则统一输出批次完成日志
        if (!earlySuccessLogged) {
          if (batch.isLargeFileSegment) {
            const item = batch.items[0];
            const fullPath = item.originalFilePath || item.filePath;
      logger.success(t(this.config, 'batch_complete', {
        i: batchIndex + 1,
        total: this.stats.totalRequests,
        context: fullPath,
        issues: issueCount,
        secs: (duration/1000).toFixed(1)
      }));
          } else {
      logger.success(t(this.config, 'batch_complete', {
        i: batchIndex + 1,
        total: this.stats.totalRequests,
        context: fileNames,
        issues: issueCount,
        secs: (duration/1000).toFixed(1)
      }));
          }
        }
        
        if (issueCount === 0) {
          if (batch.isLargeFileSegment) {
            const item = batch.items[0];
            const fullPath = item.originalFilePath || item.filePath;
            logger.debug(t(this.config, 'seg_chunk_no_issues_dbg', { file: fullPath, chunk: item.chunkIndex + 1, total: item.totalChunks, preview: JSON.stringify(result).substring(0, 200) + '...' }));
          } else {
            const fileNamesAbs = batch.items.map(item => (item.originalFilePath || item.filePath)).join(', ');
            logger.debug(t(this.config, 'files_no_issues_dbg', { files: fileNamesAbs, preview: JSON.stringify(result).substring(0, 200) + '...' }));
          }
        } else {
            if (batch.isLargeFileSegment) {
              const item = batch.items[0];
              const fullPath = item.originalFilePath || item.filePath;
              logger.debug(t(this.config, 'issues_risk_levels_dbg', { file: fullPath, levels: result.issues.map(i => i.risk || 'unknown').join(', ') }));
            } else {
              const fileNamesAbs = batch.items.map(item => (item.originalFilePath || item.filePath)).join(', ');
              logger.debug(t(this.config, 'issues_risk_levels_dbg', { file: fileNamesAbs, levels: result.issues.map(i => i.risk || 'unknown').join(', ') }));
            }
          }
        
        // 如果有问题，输出详细信息用于调试
        if (issueCount > 0 && result.issues) {
          if (batch.isLargeFileSegment) {
            const item = batch.items[0];
            const fullPath = item.originalFilePath || item.filePath;
            logger.debug(t(this.config, 'issues_details_dbg', { file: fullPath }));
          } else {
            const fileNamesAbs = batch.items.map(item => (item.originalFilePath || item.filePath)).join(', ');
            logger.debug(t(this.config, 'issues_details_dbg', { file: fileNamesAbs }));
          }
          result.issues.forEach((issue, idx) => {
            logger.debug(t(this.config, 'issue_item_dbg', { index: idx + 1, risk: issue.risk, message: (issue.message || '').slice(0, 100) + '...' }));
          });
        }
        
        // 更新进度
        this.stats.completedRequests++;
        if (progressCallback && !earlySuccessLogged) {
          progressCallback(batchIndex, batch, 'completed', null);
        }
        return { issues: result.issues || result || [], durationMs: duration };
        
      } finally {
        // 确保释放客户端
        this.releaseClient(client);
      }
      
    } catch (error) {
      this.stats.retryCount++;
      
      if (retryCount < maxRetries) {
      logger.warn(t(this.config, 'batch_retry_warn', {
        i: batchIndex + 1,
        retry: retryCount + 1,
        error: error.message
      }));
        
        // 指数退避延迟
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        
        return this.processBatchWithRetry(batch, batchIndex, progressCallback, retryCount + 1);
      } else {
        logger.error(t(this.config, 'batch_retry_error', { i: batchIndex + 1, max: maxRetries, error: error.message }));
        
        if (progressCallback) {
          progressCallback(batchIndex, batch, 'failed', error);
        }
        
        throw error;
      }
    }
  }

  /**
   * 格式化批次数据供AI分析
   * @param {Object} batch - 批次对象
   * @returns {Object} 格式化的批次数据
   */
  formatBatchForAI(batch) {
    return {
      files: batch.items.map(item => ({
        filePath: item.filePath,
        content: item.content,
        staticIssues: item.staticIssues || [],
        isChunk: item.isChunk || false,
        chunkIndex: item.chunkIndex || 0,
        totalChunks: item.totalChunks || 1,
        startLine: item.startLine || 1,
        endLine: item.endLine || 1
      })),
      totalTokens: batch.totalTokens,
      batchIndex: batch.batchIndex,
      isLargeFileSegment: batch.isLargeFileSegment || false,
      segmentedFile: batch.segmentedFile || null,
      totalSegments: batch.totalSegments || 1
    };
  }

  /**
   * 获取池状态统计
   * @returns {Object} 统计信息
   */
  getPoolStats() {
    return {
      poolSize: this.poolSize,
      busyClients: this.busyClients.size,
      availableClients: this.clients.length - this.busyClients.size,
      waitingRequests: this.waitingQueue.length,
      stats: { ...this.stats }
    };
  }

  /**
   * 清理资源
   */
  cleanup() {
    logger.debug(t(this.config, 'cleanup_pool_dbg'));
    
    // 清理等待队列
    this.waitingQueue.forEach(resolve => {
      resolve(null); // 返回null表示池已关闭
    });
    this.waitingQueue = [];
    
    // 清理客户端
    this.clients.forEach(client => {
      if (client.cleanup && typeof client.cleanup === 'function') {
        client.cleanup();
      }
    });
    
    this.busyClients.clear();
    this.clients = [];
  }

  /**
   * 获取客户端（兼容方法）
   * @returns {Promise<AIClient>} 可用的AI客户端
   */
  async getClient() {
    return this.getAvailableClient();
  }
}