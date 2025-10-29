/**
 * AI客户端池管理器
 * 管理多个AI客户端实例，支持并发请求处理
 */

import path from 'path';
import { AIClient } from './ai-client.js';
import { logger } from './utils/logger.js';

export class AIClientPool {
  constructor(config, rules, poolSize = 3) {
    this.config = config;
    this.rules = rules;
    this.poolSize = poolSize;
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
    logger.debug(`初始化AI客户端池，大小: ${this.poolSize}`);
    
    for (let i = 0; i < this.poolSize; i++) {
      const client = new AIClient(this.config.ai);
      client.poolId = i;
      this.clients.push(client);
    }
    
    logger.debug(`AI客户端池初始化完成，共${this.clients.length}个客户端`);
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
    
    // 串行处理组内的每个批次
     for (const batch of group) {
       try {
         const result = await this.processBatchWithRetry(batch, batch.originalIndex, progressCallback);
         // 处理新的返回格式 { issues: [...], metadata: {...} }
         const issues = result.issues || result || [];
         allIssues.push(...issues);
         successCount++;
       } catch (error) {
         failureCount++;
         logger.error(`批次 ${batch.originalIndex + 1} 处理失败: ${error.message}`);
       }
     }
    
    return {
      issues: allIssues,
      successCount,
      failureCount
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

    logger.debug(`开始并发处理 ${batches.length} 个批次`);
    
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
      
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          allIssues.push(...result.value.issues);
          successCount += result.value.successCount;
          failureCount += result.value.failureCount;
        } else {
          failureCount++;
          logger.error(`文件组 ${index + 1} 处理失败: ${result.reason.message}`);
        }
      });

      logger.info(`并发处理完成: 成功 ${successCount}, 失败 ${failureCount}`);
      return allIssues;
      
    } catch (error) {
      logger.error(`并发处理过程中发生错误: ${error.message}`);
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
        // 格式化批次数据
        const formattedBatch = this.formatBatchForAI(batch);
        
        // 获取批次文件信息用于日志
        const fileNames = batch.items.map(item => path.basename(item.filePath)).join(', ');
        
        // 执行AI分析
        if (batch.isLargeFileSegment) {
          // 大文件分段（现在每个批次只包含一个分段）
          const item = batch.items[0];
          const fileName = item.originalFilePath || item.filePath;
          logger.info(`开始分析文件 ${fileName} 第 ${item.chunkIndex + 1}/${item.totalChunks} 段 (行 ${item.startLine}-${item.endLine})，预估${item.tokens} tokens, 共${item.endLine - item.startLine + 1} 行代码`);
        } else {
          // 小文件批次
          logger.info(`开始分析第 ${batchIndex + 1}/${this.stats.totalRequests} 批次，文件: ${fileNames}，预估${batch.totalTokens} tokens, 共${batch.items.length}个文件`);
        }
        const startTime = Date.now();
        logger.debug(`🔍 开始AI分析请求，批次 ${batchIndex + 1}，使用客户端: ${client.constructor.name}`);
        
        const result = await client.analyzeSmartBatch(formattedBatch, batch);
        
        const duration = Date.now() - startTime;
        const issueCount = result.issues?.length || 0;
        
        if (batch.isLargeFileSegment) {
          const item = batch.items[0];
          const fileName = item.originalFilePath || item.filePath;
          logger.info(`✅ ${fileName} 第 ${item.chunkIndex + 1}/${item.totalChunks} 段分析完成，发现 ${issueCount} 个问题，耗时 ${(duration/1000).toFixed(1)}s`);
        } else {
          // 获取批次中的文件名列表
          const fileNames = batch.items.map(item => path.basename(item.originalFilePath || item.filePath)).join(', ');
          logger.info(`✅ ${fileNames} 分析完成，发现 ${issueCount} 个问题，耗时 ${(duration/1000).toFixed(1)}s`);
        }
        
        if (issueCount === 0) {
          if (batch.isLargeFileSegment) {
            const item = batch.items[0];
            const fileName = path.basename(item.originalFilePath || item.filePath);
            logger.debug(`⚠️  ${fileName} 第 ${item.chunkIndex + 1}/${item.totalChunks} 段未发现问题，AI响应内容: ${JSON.stringify(result).substring(0, 200)}...`);
          } else {
            const fileNames = batch.items.map(item => path.basename(item.originalFilePath || item.filePath)).join(', ');
            logger.debug(`⚠️  ${fileNames} 未发现问题，AI响应内容: ${JSON.stringify(result).substring(0, 200)}...`);
          }
        } else {
            if (batch.isLargeFileSegment) {
              const item = batch.items[0];
              const fileName = path.basename(item.originalFilePath || item.filePath);
              logger.debug(`📋 ${fileName} 第 ${item.chunkIndex + 1}/${item.totalChunks} 段发现的问题风险等级: ${result.issues.map(i => i.risk || 'unknown').join(', ')}`);
            } else {
              const fileNames = batch.items.map(item => path.basename(item.originalFilePath || item.filePath)).join(', ');
              logger.debug(`📋 ${fileNames} 发现的问题风险等级: ${result.issues.map(i => i.risk || 'unknown').join(', ')}`);
            }
          }
        
        // 如果有问题，输出详细信息用于调试
        if (issueCount > 0 && result.issues) {
          if (batch.isLargeFileSegment) {
            const item = batch.items[0];
            const fileName = path.basename(item.originalFilePath || item.filePath);
            logger.debug(`${fileName} 第 ${item.chunkIndex + 1}/${item.totalChunks} 段发现的问题详情:`);
          } else {
            const fileNames = batch.items.map(item => path.basename(item.originalFilePath || item.filePath)).join(', ');
            logger.debug(`${fileNames} 发现的问题详情:`);
          }
          result.issues.forEach((issue, idx) => {
            logger.debug(`  问题 ${idx + 1}: ${issue.risk} - ${issue.message?.slice(0, 100)}...`);
          });
        }
        
        // 更新进度
        this.stats.completedRequests++;
        if (progressCallback) {
          progressCallback(batchIndex, batch, 'completed', null);
        }
        return result;
        
      } finally {
        // 确保释放客户端
        this.releaseClient(client);
      }
      
    } catch (error) {
      this.stats.retryCount++;
      
      if (retryCount < maxRetries) {
        logger.warn(`批次 ${batchIndex + 1} 处理失败，进行第 ${retryCount + 1} 次重试: ${error.message}`);
        
        // 指数退避延迟
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        
        return this.processBatchWithRetry(batch, batchIndex, progressCallback, retryCount + 1);
      } else {
        logger.error(`批次 ${batchIndex + 1} 重试 ${maxRetries} 次后仍然失败: ${error.message}`);
        
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
    logger.debug('清理AI客户端池资源');
    
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