/**
 * 智能文件分批处理模块
 * 基于Token限制进行最优分组，支持大文件分段处理
 */

import { BATCH_CONSTANTS } from './utils/constants.js';

export class SmartBatching {
  constructor(config = {}) {
    this.config = { ...config };
    this.config.tokenRatio = Number(config.tokenRatio) > 0 ? Number(config.tokenRatio) : BATCH_CONSTANTS.TOKEN_RATIO;
    this.config.chunkOverlapLines = Number(config.chunkOverlapLines) >= 0
      ? Number(config.chunkOverlapLines)
      : BATCH_CONSTANTS.CHUNK_OVERLAP_LINES;
    this.config.minFilesPerBatch = Number(config.minFilesPerBatch) > 0
      ? Math.floor(Number(config.minFilesPerBatch))
      : 1;
    const maxRequestTokens = Number(config.maxRequestTokens);
    this.config.maxRequestTokens = Number.isFinite(maxRequestTokens) && maxRequestTokens > 0
      ? Math.floor(maxRequestTokens)
      : undefined;
    const maxFilesPerBatch = Number(config.maxFilesPerBatch);
    this.config.maxFilesPerBatch = Number.isFinite(maxFilesPerBatch) && maxFilesPerBatch > 0
      ? Math.floor(maxFilesPerBatch)
      : undefined;

    // 仅在用户限制了请求 token 时才分段；未限制则整文件送出
    this.maxFileTokens = this.hasTokenBudget()
      ? Math.floor(this.config.maxRequestTokens * BATCH_CONSTANTS.UTILIZATION_THRESHOLD)
      : Number.POSITIVE_INFINITY;
    
    // Token估算缓存，避免重复计算
    this.tokenCache = new Map();
    this.cacheStats = { hits: 0, misses: 0 };
    
    // 添加对象池和缓存机制以减少对象创建
    this.batchObjectPool = []; // 批次对象池
    this.itemObjectPool = []; // 项目对象池
    this.chunkObjectPool = []; // 分块对象池
    this.statsObjectPool = []; // 统计对象池
    
    // 预分配一些对象到池中
    this.initializeObjectPools();
  }

  hasTokenBudget() {
    return Number.isFinite(this.config.maxRequestTokens) && this.config.maxRequestTokens > 0;
  }

  tokenBudget() {
    return this.hasTokenBudget() ? this.config.maxRequestTokens : Number.POSITIVE_INFINITY;
  }

  fileBudget() {
    const maxFiles = Number(this.config.maxFilesPerBatch);
    return Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : Number.POSITIVE_INFINITY;
  }

  utilizationOf(tokens = 0) {
    const max = this.tokenBudget();
    if (!Number.isFinite(max)) return 0;
    return (tokens / max) * 100;
  }

  /**
   * 初始化对象池，预分配一些对象以减少运行时创建开销
   */
  initializeObjectPools() {
    // 预分配批次对象
    for (let i = 0; i < BATCH_CONSTANTS.INITIAL_BATCH_POOL_SIZE; i++) {
      this.batchObjectPool.push(this.createBatchObject());
    }
    
    // 预分配项目对象
    for (let i = 0; i < BATCH_CONSTANTS.INITIAL_ITEM_POOL_SIZE; i++) {
      this.itemObjectPool.push(this.createItemObject());
    }
    
    // 预分配分块对象
    for (let i = 0; i < BATCH_CONSTANTS.INITIAL_CHUNK_POOL_SIZE; i++) {
      this.chunkObjectPool.push(this.createChunkObject());
    }
    
    // 预分配统计对象
    for (let i = 0; i < BATCH_CONSTANTS.INITIAL_STATS_POOL_SIZE; i++) {
      this.statsObjectPool.push(this.createStatsObject());
    }
  }

  /**
   * 创建批次对象
   * @returns {Object} 新的批次对象
   */
  createBatchObject() {
    return {
      items: [],
      totalTokens: 0,
      totalFiles: 0,
      utilization: 0,
      isLargeFileSegment: false,
      segmentedFile: null
    };
  }

  /**
   * 创建项目对象
   * @returns {Object} 新的项目对象
   */
  createItemObject() {
    return {
      filePath: '',
      content: '',
      tokens: 0,
      isSegment: false,
      segmentInfo: null
    };
  }

  /**
   * 创建分块对象
   * @returns {Object} 新的分块对象
   */
  createChunkObject() {
    return {
      content: '',
      startLine: 0,
      endLine: 0,
      tokens: 0
    };
  }

  /**
   * 创建统计对象
   * @returns {Object} 新的统计对象
   */
  createStatsObject() {
    return {
      totalFiles: 0,
      totalTokens: 0,
      avgTokensPerFile: 0,
      maxTokensInBatch: 0,
      minTokensInBatch: 0,
      avgUtilization: 0
    };
  }

  /**
   * 从池中获取批次对象
   * @returns {Object} 批次对象
   */
  getBatchFromPool() {
    if (this.batchObjectPool.length > 0) {
      const obj = this.batchObjectPool.pop();
      // 重置对象状态
      obj.items = [];
      obj.totalTokens = 0;
      obj.totalFiles = 0;
      obj.utilization = 0;
      obj.isLargeFileSegment = false;
      obj.segmentedFile = null;
      return obj;
    }
    return this.createBatchObject();
  }

  /**
   * 从池中获取项目对象
   * @returns {Object} 项目对象
   */
  getItemFromPool() {
    if (this.itemObjectPool.length > 0) {
      const obj = this.itemObjectPool.pop();
      // 重置对象状态
      obj.filePath = '';
      obj.content = '';
      obj.tokens = 0;
      obj.isSegment = false;
      obj.segmentInfo = null;
      return obj;
    }
    return this.createItemObject();
  }

  /**
   * 从池中获取分块对象
   * @returns {Object} 分块对象
   */
  getChunkFromPool() {
    if (this.chunkObjectPool.length > 0) {
      const obj = this.chunkObjectPool.pop();
      // 重置对象状态
      obj.content = '';
      obj.startLine = 0;
      obj.endLine = 0;
      obj.tokens = 0;
      return obj;
    }
    return this.createChunkObject();
  }

  /**
   * 从池中获取统计对象
   * @returns {Object} 统计对象
   */
  getStatsFromPool() {
    if (this.statsObjectPool.length > 0) {
      const obj = this.statsObjectPool.pop();
      // 重置对象状态
      obj.totalFiles = 0;
      obj.totalTokens = 0;
      obj.avgTokensPerFile = 0;
      obj.maxTokensInBatch = 0;
      obj.minTokensInBatch = 0;
      obj.avgUtilization = 0;
      return obj;
    }
    return this.createStatsObject();
  }

  /**
   * 将批次对象回收到池中
   * @param {Object} obj - 要回收的批次对象
   */
  recycleBatchToPool(obj) {
    if (this.batchObjectPool.length < BATCH_CONSTANTS.MAX_BATCH_POOL_SIZE) { // 限制池大小
      this.batchObjectPool.push(obj);
    }
  }

  /**
   * 将项目对象回收到池中
   * @param {Object} obj - 要回收的项目对象
   */
  recycleItemToPool(obj) {
    if (this.itemObjectPool.length < BATCH_CONSTANTS.MAX_ITEM_POOL_SIZE) { // 限制池大小
      this.itemObjectPool.push(obj);
    }
  }

  /**
   * 将分块对象回收到池中
   * @param {Object} obj - 要回收的分块对象
   */
  recycleChunkToPool(obj) {
    if (this.chunkObjectPool.length < BATCH_CONSTANTS.MAX_CHUNK_POOL_SIZE) { // 限制池大小
      this.chunkObjectPool.push(obj);
    }
  }

  /**
   * 将统计对象回收到池中
   * @param {Object} obj - 要回收的统计对象
   */
  recycleStatsToPool(obj) {
    if (this.statsObjectPool.length < BATCH_CONSTANTS.MAX_STATS_POOL_SIZE) { // 限制池大小
      this.statsObjectPool.push(obj);
    }
  }

  /**
   * 获取对象池统计信息
   * @returns {Object} 对象池统计信息
   */
  getObjectPoolStats() {
    return {
      batchPool: {
        size: this.batchObjectPool.length,
        type: 'batch'
      },
      itemPool: {
        size: this.itemObjectPool.length,
        type: 'item'
      },
      chunkPool: {
        size: this.chunkObjectPool.length,
        type: 'chunk'
      },
      statsPool: {
        size: this.statsObjectPool.length,
        type: 'stats'
      }
    };
  }

  /**
   * 根据文件平均大小动态计算每批次最大文件数
   * @param {Array} files - 文件列表
   * @returns {number} 动态计算的最大文件数
   */
  calculateDynamicMaxFiles(files) {
    if (files.length === 0) return this.config.minFilesPerBatch;
    
    // 计算平均文件token数
    const totalTokens = files.reduce((sum, file) => sum + this.estimateTokens(file.content), 0);
    const avgTokensPerFile = totalTokens / files.length;
    
    // 基于平均文件大小计算合理的文件数量
    const estimatedMaxFiles = Math.floor(this.tokenBudget() / avgTokensPerFile);
    
    // 调试信息
    // 应用边界限制
    const result = Math.max(
      this.config.minFilesPerBatch,
      Math.min(this.fileBudget(), estimatedMaxFiles)
    );
    return result;
  }

  /**
   * 基于处理后的项目计算动态最大文件数
   * @param {Array} items - 处理后的文件项目数组
   * @returns {number} 动态最大文件数
   */
  calculateDynamicMaxFilesFromItems(items) {
    if (items.length === 0) return this.config.minFilesPerBatch;
    
    // 按文件分组，计算每个文件的平均token数
    const fileGroups = new Map();
    items.forEach(item => {
      const filePath = item.originalFilePath || item.filePath;
      if (!fileGroups.has(filePath)) {
        fileGroups.set(filePath, []);
      }
      fileGroups.get(filePath).push(item);
    });
    
    // 计算每个文件的token数组
    const fileTokens = [];
    fileGroups.forEach((fileItems, filePath) => {
      const totalTokens = fileItems.reduce((sum, item) => sum + item.tokens, 0);
      const avgTokensPerSegment = totalTokens / fileItems.length;
      fileTokens.push(avgTokensPerSegment);
    });
    
    // 排序文件token数，用于更精确的估算
    fileTokens.sort((a, b) => a - b);
    
    // 使用更智能的策略：尝试找到能组合的最大文件数
    let maxFiles = this.config.minFilesPerBatch;
    const maxTokens = this.tokenBudget();
    
    // 从小文件开始累加，找到理论最大文件数
    let currentTokens = 0;
    let currentFiles = 0;
    
    for (const tokens of fileTokens) {
      if (currentTokens + tokens <= maxTokens) {
        currentTokens += tokens;
        currentFiles++;
      } else {
        break;
      }
    }
    
    // 为了保险起见，允许比理论最大值稍大一些的组合
    // 因为实际组合可能有更好的搭配
    const theoreticalMax = currentFiles;
    const allowedMax = Math.min(
      Math.max(theoreticalMax, Math.ceil(theoreticalMax * 1.5)), // 允许50%的余量
      this.fileBudget()
    );
    
    
    
    return Math.max(this.config.minFilesPerBatch, allowedMax);
  }

  /**
   * 估算文本的Token数量（带缓存）
   * @param {string} text - 文本内容
   * @returns {number} 估算的Token数量
   */
  estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    
    // 生成缓存键（使用文本长度和前100字符的哈希）
    const cacheKey = this.generateTokenCacheKey(text);
    
    // 检查缓存
    if (this.tokenCache.has(cacheKey)) {
      this.cacheStats.hits++;
      return this.tokenCache.get(cacheKey);
    }
    
    this.cacheStats.misses++;
    
    // 计算token数量
    const tokenCount = this.calculateTokenCount(text);
    
    // 缓存结果（限制缓存大小）
    if (this.tokenCache.size >= BATCH_CONSTANTS.MAX_TOKEN_CACHE_SIZE) {
      // 清理最旧的缓存项
      const firstKey = this.tokenCache.keys().next().value;
      this.tokenCache.delete(firstKey);
    }
    
    this.tokenCache.set(cacheKey, tokenCount);
    return tokenCount;
  }

  /**
   * 生成token缓存键
   * @param {string} text - 文本内容
   * @returns {string} 缓存键
   */
  generateTokenCacheKey(text) {
    const length = text.length;
    const prefix = text.substring(0, Math.min(BATCH_CONSTANTS.CACHE_KEY_PREFIX_LENGTH, length));
    // 简单哈希函数
    let hash = 0;
    for (let i = 0; i < prefix.length; i++) {
      const char = prefix.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    return `${length}_${hash}`;
  }

  /**
   * 计算文本的Token数量
   * @param {string} text - 文本内容
   * @returns {number} Token数量
   */
  calculateTokenCount(text) {
    // 基础字符数估算
    const charCount = text.length;
    
    // 考虑中文字符（通常占用更多Token）
    const chineseCharCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishCharCount = charCount - chineseCharCount;
    
    // 中文字符按1.5倍计算，英文字符按标准比例
    const adjustedCharCount = englishCharCount + (chineseCharCount * BATCH_CONSTANTS.CHINESE_CHAR_MULTIPLIER);
    
    // 考虑代码结构（括号、关键字等会增加Token数）
    const codeStructureBonus = (text.match(/[{}()\[\];,]/g) || []).length * BATCH_CONSTANTS.CODE_STRUCTURE_BONUS;
    
    return Math.ceil((adjustedCharCount + codeStructureBonus) / this.config.tokenRatio);
  }

  /**
   * 获取缓存统计信息
   * @returns {Object} 缓存统计
   */
  getCacheStats() {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    const hitRate = total > 0 ? (this.cacheStats.hits / total * 100).toFixed(2) : 0;
    
    return {
      ...this.cacheStats,
      total,
      hitRate: `${hitRate}%`,
      cacheSize: this.tokenCache.size
    };
  }

  /**
   * 将大文件分段
   * @param {string} content - 文件内容
   * @param {string} filePath - 文件路径
   * @returns {Array} 分段信息数组
   */
  chunkLargeFile(content, filePath) {
    const lines = content.split('\n');
    // 每段目标大小接近maxRequestTokens，确保最大利用率
    const maxTokensPerChunk = Math.floor(this.tokenBudget() * 0.95);
    const overlapLines = this.config.chunkOverlapLines;
    const chunks = [];
    let currentChunk = [];
    let currentTokens = 0;
    let startLine = 1;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineTokens = this.estimateTokens(line);
      
      // 如果添加这一行会超过限制，且当前块不为空，则结束当前块
      if (currentTokens + lineTokens > maxTokensPerChunk && currentChunk.length > 0) {
        // 保存当前块，使用对象池
        const chunkInfo = this.getChunkFromPool();
        chunkInfo.content = currentChunk.join('\n');
        chunkInfo.startLine = startLine;
        chunkInfo.endLine = startLine + currentChunk.length - 1;
        chunkInfo.tokens = currentTokens;
        chunkInfo.chunkIndex = chunks.length;
        chunkInfo.isChunk = true;
        chunks.push(chunkInfo);
        
        // 开始新块，保留重叠行
        const overlapStart = Math.max(0, currentChunk.length - overlapLines);
        const overlapContent = currentChunk.slice(overlapStart);
        
        startLine = startLine + currentChunk.length - overlapContent.length;
        currentChunk = overlapContent;
        currentTokens = this.estimateTokens(currentChunk.join('\n'));
      }
      
      currentChunk.push(line);
      currentTokens += lineTokens;
    }
    
    // 添加最后一个块，使用对象池
    if (currentChunk.length > 0) {
      const chunkInfo = this.getChunkFromPool();
      chunkInfo.content = currentChunk.join('\n');
      chunkInfo.startLine = startLine;
      chunkInfo.endLine = startLine + currentChunk.length - 1;
      chunkInfo.tokens = currentTokens;
      chunkInfo.chunkIndex = chunks.length;
      chunkInfo.isChunk = true;
      chunks.push(chunkInfo);
    }
    
    // 如果只有一个块且不超过限制，标记为非分块
    if (chunks.length === 1 && chunks[0].tokens <= maxTokensPerChunk) {
      chunks[0].isChunk = false;
    }
    
    return chunks;
  }

  packByFileCountOnly(files = []) {
    const fileStats = new Map();
    const items = [];
    for (const file of files) {
      const tokens = this.estimateTokens(file.content);
      const item = this.getItemFromPool();
      Object.assign(item, file);
      item.tokens = tokens;
      item.isChunk = false;
      item.chunkIndex = 0;
      item.totalChunks = 1;
      items.push(item);

      const stats = this.getStatsFromPool();
      stats.originalTokens = tokens;
      stats.needsChunking = false;
      stats.chunkCount = 1;
      stats.processedTokens = tokens;
      fileStats.set(file.filePath, stats);
    }

    const maxFiles = this.fileBudget();
    const batches = [];
    let current = [];
    let totalTokens = 0;
    const flush = () => {
      if (current.length === 0) return;
      const batch = this.getBatchFromPool();
      batch.batchIndex = batches.length;
      batch.items = current;
      batch.totalTokens = totalTokens;
      batch.fileCount = current.length;
      batch.utilization = this.utilizationOf(totalTokens);
      batches.push(batch);
      current = [];
      totalTokens = 0;
    };

    for (const item of items) {
      if (current.length > 0 && current.length >= maxFiles) flush();
      current.push(item);
      totalTokens += item.tokens || 0;
    }
    flush();

    const processedBatches = this.postProcessSegmentedFiles(batches);
    const stats = this.generateBatchStats(processedBatches, fileStats);
    return {
      batches: processedBatches,
      stats,
      fileStats: Object.fromEntries(fileStats)
    };
  }

  /**
   * 智能分批处理文件
   * @param {Array} files - 文件信息数组 [{filePath, content, ...}]
   * @returns {Object} 分批结果
   */
  createSmartBatches(files) {
    if (!this.hasTokenBudget()) {
      return this.packByFileCountOnly(files);
    }

    const fileStats = new Map();
    const smallFiles = [];
    const largeBatches = [];
    for (const file of files) {
      const { filePath, content } = file;
      const originalTokens = this.estimateTokens(content);
      
      if (originalTokens > this.maxFileTokens) {
        // 大文件：分段处理，但同一文件的所有分段合并为一个批次
        const chunks = this.chunkLargeFile(content, filePath);

        const segmentItems = [];
        let sumTokens = 0;
        for (const chunk of chunks) {
          const item = this.getItemFromPool();
          Object.assign(item, file);
          item.content = chunk.content;
          item.tokens = chunk.tokens;
          item.isChunk = true;
          item.chunkIndex = chunk.chunkIndex;
          item.totalChunks = chunks.length;
          item.startLine = chunk.startLine;
          item.endLine = chunk.endLine;
          item.originalFilePath = filePath;
          item.segmentGroup = filePath;
          // 合并为单批次，不需要分段等待标记
          item.needsWaiting = false;

          segmentItems.push(item);
          sumTokens += (chunk.tokens || 0);
        }

        const batch = this.getBatchFromPool();
        batch.batchIndex = -1; // 稍后重新编号
        batch.items = segmentItems; // 同一文件的所有分段放入一个批次
        batch.totalTokens = sumTokens;
        batch.fileCount = 1; // 单文件的分段
        batch.utilization = this.utilizationOf(sumTokens);
        batch.isLargeFileSegment = true;
        batch.segmentedFile = filePath;
        batch.totalSegments = chunks.length;
        // 不再使用currentSegment（批次包含全部分段）

        largeBatches.push(batch);
        
        const stats = this.getStatsFromPool();
        stats.originalTokens = originalTokens;
        stats.needsChunking = true;
        stats.chunkCount = chunks.length;
        stats.processedTokens = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
        fileStats.set(filePath, stats);
      } else {
        // 未超过请求上限的文件按 token 预算打包；只有超过 maxFileTokens 才分段
        const item = this.getItemFromPool();
        Object.assign(item, file);
        item.tokens = originalTokens;
        item.isChunk = false;
        item.chunkIndex = 0;
        item.totalChunks = 1;
        smallFiles.push(item);
        
        const stats = this.getStatsFromPool();
        stats.originalTokens = originalTokens;
        stats.needsChunking = false;
        stats.chunkCount = 1;
        stats.processedTokens = originalTokens;
        fileStats.set(filePath, stats);
      }
    }

    const smallFileBatches = [];
    if (smallFiles.length > 0) {
      const dynamicMaxFiles = this.calculateDynamicMaxFilesFromItems(smallFiles);
      smallFileBatches.push(...this.optimizedBinPacking(smallFiles, dynamicMaxFiles));
    }
    
    // 合并所有批次并重新编号
    const allBatches = [...smallFileBatches, ...largeBatches];
    allBatches.forEach((batch, index) => {
      batch.batchIndex = index;
    });
    
    // 后处理分段文件，确保同一文件的分段能够正确组织
    const processedBatches = this.postProcessSegmentedFiles(allBatches);
    
    // 生成统计信息
    const stats = this.generateBatchStats(processedBatches, fileStats);
    

    
    return {
      batches: processedBatches,
      stats,
      fileStats: Object.fromEntries(fileStats)
    };
  }

  /**
   * 最优组合算法 - 实现最接近token限制的最优分批
   * @param {Array} items - 处理后的文件项目
   * @param {number} maxFiles - 每批次最大文件数
   * @returns {Array} 批次数组
   */
  optimizedBinPacking(items, maxFiles) {
    const maxTokens = this.tokenBudget();
    
    // 第一步：分离超大文件和普通文件
    const { largeFiles, normalFiles } = this.separateFilesBySize(items, maxTokens);
    
    // 第二步：处理超大文件（需要分段）
    const largeBatches = this.handleLargeFiles(largeFiles, maxFiles);
    
    // 第三步：对普通文件进行最优组合
    const optimalBatches = this.findOptimalCombinations(normalFiles, maxFiles, maxTokens);
    
    // 第四步：合并所有批次并重新编号
    const allBatches = [...largeBatches, ...optimalBatches];
    allBatches.forEach((batch, index) => {
      batch.batchIndex = index;
    });
    
    return allBatches;
  }

  /**
   * 分离超大文件和普通文件
   */
  separateFilesBySize(items, maxTokens) {
    const largeFiles = [];
    const normalFiles = [];
    
    items.forEach(item => {
      if (item.tokens > maxTokens) {
        largeFiles.push(item);
      } else {
        normalFiles.push(item);
      }
    });
    
    return { largeFiles, normalFiles };
  }

  /**
   * 处理超大文件 - 需要分段的文件
   */
  handleLargeFiles(largeFiles, maxFiles) {
    const batches = [];
    
    largeFiles.forEach(file => {
      // 超大文件需要分段处理：同一文件的所有分段合并为一个批次
      const segments = this.chunkLargeFile(file.content, file.filePath);

      const items = [];
      let sumTokens = 0;
      for (const seg of segments) {
        const item = this.getItemFromPool();
        Object.assign(item, file);
        item.content = seg.content;
        item.tokens = seg.tokens;
        item.isChunk = true;
        item.chunkIndex = seg.chunkIndex;
        item.totalChunks = segments.length;
        item.startLine = seg.startLine;
        item.endLine = seg.endLine;
        item.originalFilePath = file.filePath;
        item.segmentGroup = file.filePath;
        item.needsWaiting = false;
        items.push(item);
        sumTokens += (seg.tokens || 0);
      }

      const batch = this.getBatchFromPool();
      batch.batchIndex = 0; // 稍后重新编号
      batch.items = items;
      batch.totalTokens = sumTokens;
      batch.fileCount = 1;
      batch.utilization = this.utilizationOf(sumTokens);
      batch.isLargeFileSegment = true;
      batch.segmentedFile = file.filePath;
      batch.totalSegments = segments.length;
      batches.push(batch);
    });
    
    return batches;
  }

  /**
   * 找到最优组合 - 多重背包问题的最优解
   */
  findOptimalCombinations(normalFiles, maxFiles, maxTokens) {
    if (normalFiles.length === 0) return [];
    
    // 使用动态规划找到最优组合
    const combinations = this.findAllOptimalCombinations(normalFiles, maxFiles, maxTokens);
    
    // 将组合转换为批次格式
    const batches = combinations.map(combination => {
      const totalTokens = combination.reduce((sum, item) => sum + item.tokens, 0);
      return {
        batchIndex: 0, // 稍后重新编号
        items: combination,
        totalTokens,
        fileCount: combination.length,
        utilization: (totalTokens / maxTokens) * 100,
        isSegmented: false
      };
    });
    
    return batches;
  }

  /**
   * 找到所有最优组合 - 真正的最优算法
   */
  findAllOptimalCombinations(files, maxFiles, maxTokens) {
    if (files.length === 0) return [];
    
    // 第一步：分离超大文件（单个文件就超过限制的）
    const largeFiles = files.filter(f => f.tokens > maxTokens);
    const normalFiles = files.filter(f => f.tokens <= maxTokens);
    
    // 第二步：对普通文件进行最优组合
    const combinations = this.findOptimalNormalFileCombinations(normalFiles, maxFiles, maxTokens);
    
    // 第三步：处理超大文件（需要分段）
    largeFiles.forEach(file => {
      combinations.push([file]); // 超大文件单独成批，后续会被分段处理
    });
    
    return combinations;
  }

  /**
   * 对普通文件进行最优组合
   */
  findOptimalNormalFileCombinations(files, maxFiles, maxTokens) {
    if (files.length === 0) return [];
    
    // 使用真正的最优算法：尝试所有可能的组合，找到最接近maxTokens的
    const allCombinations = this.generateAllValidCombinations(files, maxFiles, maxTokens);
    
    // 选择最优的组合集合
     return this.selectOptimalCombinationSet(allCombinations, files, maxFiles, maxTokens);
  }

  /**
   * 生成所有有效的组合
   */
  generateAllValidCombinations(files, maxFiles, maxTokens) {
    const validCombinations = [];
    
    // 生成所有可能的组合（从1个文件到maxFiles个文件）
    for (let size = 1; size <= Math.min(maxFiles, files.length); size++) {
      const combinations = this.getCombinations(files, size);
      
      for (const combo of combinations) {
        const totalTokens = combo.reduce((sum, file) => sum + file.tokens, 0);
        if (totalTokens <= maxTokens) {
          validCombinations.push({
            files: combo,
            totalTokens,
            utilization: (totalTokens / maxTokens) * 100,
            efficiency: totalTokens // 效率 = 总token数
          });
        }
      }
    }
    
    // 按效率降序排列
    return validCombinations.sort((a, b) => b.efficiency - a.efficiency);
  }

  /**
   * 获取指定大小的所有组合
   */
  getCombinations(arr, size) {
    if (size === 1) return arr.map(item => [item]);
    if (size > arr.length) return [];
    
    const result = [];
    
    for (let i = 0; i <= arr.length - size; i++) {
      const head = arr[i];
      const tailCombinations = this.getCombinations(arr.slice(i + 1), size - 1);
      
      for (const tail of tailCombinations) {
        result.push([head, ...tail]);
      }
    }
    
    return result;
  }

  /**
   * 选择最优的组合集合 - 使用高效的贪心算法
   */
  selectOptimalCombinationSet(allCombinations, files, maxFiles, maxTokens) {
    // 对于大量文件，使用高效的贪心算法而不是指数级的动态规划
    if (files.length > 20) {
      return this.findOptimalCombinationSetGreedy(allCombinations, files, maxFiles, maxTokens);
    }
    // 对于小量文件，仍可使用动态规划获得最优解
    return this.findOptimalCombinationSetDP(allCombinations, files, maxFiles, maxTokens);
  }

  /**
   * 使用高效的贪心算法找到近似最优的组合集合
   * 时间复杂度: O(n * m * log m)，其中n是文件数，m是组合数
   */
  findOptimalCombinationSetGreedy(allCombinations, files, maxFiles, maxTokens) {
    // 计算每个组合的效率分数
    const scoredCombinations = allCombinations.map(combo => {
      const utilization = combo.utilization / 100;
      const fileCount = combo.files.length;
      // 效率分数 = 利用率 * 文件数量 / 批次数量
      const efficiency = utilization * fileCount;
      
      return {
        ...combo,
        efficiency,
        fileSet: new Set(combo.files.map(f => f.path || f.filePath))
      };
    });

    // 按效率分数降序排序
    scoredCombinations.sort((a, b) => b.efficiency - a.efficiency);

    const selectedCombinations = [];
    const usedFiles = new Set();

    // 贪心选择：优先选择效率最高且不冲突的组合
    for (const combo of scoredCombinations) {
      // 检查是否与已选择的文件冲突
      const hasConflict = Array.from(combo.fileSet).some(filePath => usedFiles.has(filePath));
      
      if (!hasConflict) {
        selectedCombinations.push(combo.files);
        combo.fileSet.forEach(filePath => usedFiles.add(filePath));
      }
    }

    // 处理剩余文件
    const remainingFiles = files.filter(file => 
      !usedFiles.has(file.path || file.filePath)
    );

    if (remainingFiles.length > 0) {
      const finalCombinations = this.combineRemainingFiles(remainingFiles, maxFiles, maxTokens);
      selectedCombinations.push(...finalCombinations);
    }

    return selectedCombinations;
  }

  /**
   * 使用动态规划找到最优的组合集合（仅用于小规模问题）
   * 时间复杂度: O(2^n * m)，仅在文件数量较少时使用
   */
  findOptimalCombinationSetDP(allCombinations, files, maxFiles, maxTokens) {
    const fileCount = files.length;
    
    // 文件数量过多时，回退到贪心算法
    if (fileCount > 20) {
      return this.findOptimalCombinationSetGreedy(allCombinations, files, maxFiles, maxTokens);
    }
    
    // 为每个文件创建唯一标识
    const fileIds = new Map();
    files.forEach((file, index) => {
      fileIds.set(file.path || file.filePath, index);
    });
    
    // 将组合转换为位掩码表示，并计算价值函数
    const combosWithMask = allCombinations.map(combo => {
      let mask = 0;
      combo.files.forEach(file => {
        const fileId = fileIds.get(file.path || file.filePath);
        if (fileId !== undefined) {
          mask |= (1 << fileId);
        }
      });
      
      const utilization = combo.utilization / 100;
      const fileCount = combo.files.length;
      const value = Math.floor(utilization * utilization * fileCount * 1000);
      
      return {
        ...combo,
        mask,
        value
      };
    });
    
    // 动态规划状态数组
    const stateCount = 1 << fileCount;
    const dp = new Array(stateCount).fill(null).map(() => ({value: 0, count: 0}));
    const parent = new Array(stateCount).fill(-1);
    
    // 遍历所有组合
    for (let i = 0; i < combosWithMask.length; i++) {
      const combo = combosWithMask[i];
      
      // 从高位到低位遍历状态，避免重复计算
      for (let mask = stateCount - 1; mask >= 0; mask--) {
        if ((mask & combo.mask) === 0) {
          const newMask = mask | combo.mask;
          const newValue = dp[mask].value + combo.value;
          const newCount = dp[mask].count + 1;
          
          if (newValue > dp[newMask].value || 
              (newValue === dp[newMask].value && newCount < dp[newMask].count)) {
            dp[newMask] = {value: newValue, count: newCount};
            parent[newMask] = i;
          }
        }
      }
    }
    
    // 找到最优解
    const fullMask = stateCount - 1;
    let bestMask = fullMask;
    let bestScore = dp[fullMask];
    
    if (bestScore.value === 0) {
      for (let mask = 0; mask < stateCount; mask++) {
        const popCount = this.popCount(mask);
        const score = dp[mask];
        if (score.value > 0 && popCount > this.popCount(bestMask)) {
          bestMask = mask;
          bestScore = score;
        }
      }
    }
    
    // 回溯构建解
    const selectedCombinations = [];
    let currentMask = bestMask;
    
    while (currentMask > 0 && parent[currentMask] !== -1) {
      const comboIndex = parent[currentMask];
      const combo = combosWithMask[comboIndex];
      selectedCombinations.push(combo.files);
      currentMask ^= combo.mask;
    }
    
    // 处理剩余文件
    const usedFiles = new Set();
    selectedCombinations.forEach(combo => {
      combo.forEach(file => {
        usedFiles.add(file.path || file.filePath);
      });
    });
    
    const remainingFiles = files.filter(file => 
      !usedFiles.has(file.path || file.filePath)
    );
    
    if (remainingFiles.length > 0) {
      const finalCombinations = this.combineRemainingFiles(remainingFiles, maxFiles, maxTokens);
      selectedCombinations.push(...finalCombinations);
    }
    
    return selectedCombinations;
  }

  /**
   * 计算位掩码中1的个数
   */
  popCount(mask) {
    let count = 0;
    while (mask) {
      count += mask & 1;
      mask >>= 1;
    }
    return count;
  }

  /**
   * 组合剩余文件
   */
  combineRemainingFiles(files, maxFiles, maxTokens) {
    const combinations = [];
    let remaining = [...files];
    
    while (remaining.length > 0) {
      // 尝试找到最佳组合
      let bestCombo = [remaining[0]];
      let bestSum = remaining[0].tokens;
      
      // 尝试添加更多文件到当前组合
      for (let i = 1; i < remaining.length && bestCombo.length < maxFiles; i++) {
        if (bestSum + remaining[i].tokens <= maxTokens) {
          bestCombo.push(remaining[i]);
          bestSum += remaining[i].tokens;
        }
      }
      
      combinations.push(bestCombo);
      
      // 移除已使用的文件
      remaining = remaining.filter(file => 
        !bestCombo.some(used => (used.path || used.filePath) === (file.path || file.filePath))
      );
    }
    
    return combinations;
  }

  /**
   * 使用贪心算法找到最佳组合
   */
  findBestGreedyCombination(files, maxFiles, maxTokens) {
    if (files.length === 0) return [];
    
    let bestCombination = [];
    let bestSum = 0;
    
    // 尝试以每个文件为起点的组合
    for (let i = 0; i < files.length; i++) {
      const currentCombination = [files[i]];
      let currentSum = files[i].tokens;
      
      if (currentSum > maxTokens) continue; // 跳过超大文件
      
      // 贪心添加其他文件
      for (let j = 0; j < files.length; j++) {
        if (i === j || currentCombination.length >= maxFiles) continue;
        
        if (currentSum + files[j].tokens <= maxTokens) {
          currentCombination.push(files[j]);
          currentSum += files[j].tokens;
        }
      }
      
      // 如果这个组合更好，更新最优解
      if (currentSum > bestSum) {
        bestCombination = [...currentCombination];
        bestSum = currentSum;
      }
    }
    
    return bestCombination;
  }

  /**
   * 组合剩余的小文件
   */
  combineSmallFiles(files, maxFiles, maxTokens) {
    const combinations = [];
    const used = new Array(files.length).fill(false);
    
    for (let i = 0; i < files.length; i++) {
      if (used[i]) continue;
      
      const currentCombination = [files[i]];
      let currentSum = files[i].tokens;
      used[i] = true;
      
      // 尝试添加更多文件到当前组合
      for (let j = i + 1; j < files.length; j++) {
        if (used[j]) continue;
        
        if (currentSum + files[j].tokens <= maxTokens && currentCombination.length < maxFiles) {
          currentCombination.push(files[j]);
          currentSum += files[j].tokens;
          used[j] = true;
        }
      }
      
      combinations.push(currentCombination);
    }
    
    return combinations;
  }

  /**
   * 找到单个最优组合 - 最接近maxTokens的组合
   */
  findSingleOptimalCombination(files, used, maxFiles, maxTokens) {
    const availableFiles = files.filter((file, index) => !used[index]);
    
    if (availableFiles.length === 0) return [];
    
    let bestCombination = [];
    let bestSum = 0;
    
    // 使用回溯算法找到最优组合
    const backtrack = (index, currentCombination, currentSum) => {
      // 如果当前组合更接近目标值，更新最优解
      if (currentSum > bestSum && currentSum <= maxTokens && currentCombination.length <= maxFiles) {
        bestCombination = [...currentCombination];
        bestSum = currentSum;
      }
      
      // 如果已经达到最大文件数或遍历完所有文件，返回
      if (currentCombination.length >= maxFiles || index >= availableFiles.length) {
        return;
      }
      
      // 尝试添加当前文件
      const file = availableFiles[index];
      if (currentSum + file.tokens <= maxTokens) {
        currentCombination.push(file);
        backtrack(index + 1, currentCombination, currentSum + file.tokens);
        currentCombination.pop();
      }
      
      // 不添加当前文件，继续下一个
      backtrack(index + 1, currentCombination, currentSum);
    };
    
    backtrack(0, [], 0);
    
    // 如果没有找到多文件组合，至少返回一个文件（避免无限循环）
    if (bestCombination.length === 0 && availableFiles.length > 0) {
      bestCombination = [availableFiles[0]];
    }
    
    return bestCombination;
  }

  /**
   * First Fit Decreasing算法 - 按大小降序排列后依次放入第一个能容纳的批次
   */
  firstFitDecreasingPacking(items, maxFiles) {
    // 按token数降序排列
    const sortedItems = [...items].sort((a, b) => b.tokens - a.tokens);
    const batches = [];
    
    for (const item of sortedItems) {
      let placed = false;
      
      // 尝试放入现有批次
      for (const batch of batches) {
        if (this.canAddToBatch(batch, item, maxFiles)) {
          batch.items.push(item);
          batch.totalTokens += item.tokens;
          batch.fileCount = new Set(batch.items.map(i => i.originalFilePath || i.filePath)).size;
          batch.utilization = this.utilizationOf(batch.totalTokens);
          placed = true;
          break;
        }
      }
      
      // 如果无法放入现有批次，创建新批次，使用对象池
      if (!placed) {
        const batch = this.getBatchFromPool();
        batch.batchIndex = batches.length;
        batch.items = [item];
        batch.totalTokens = item.tokens;
        batch.fileCount = 1;
        batch.utilization = this.utilizationOf(item.tokens);
        batches.push(batch);
      }
    }
    
    return batches;
  }

  /**
   * 全局优化 - 重新分配文件以提高整体利用率
   */
  globalOptimization(batches, maxFiles) {
    const maxTokens = this.tokenBudget();
    let improved = true;
    let iterations = 0;
    const maxIterations = 10; // 防止无限循环
    
    // 迭代优化直到无法改进或达到最大迭代次数
    while (improved && iterations < maxIterations) {
      improved = false;
      iterations++;
      
      // 找到利用率最低的批次
      const sortedBatches = [...batches].sort((a, b) => a.utilization - b.utilization);
      const lowUtilBatch = sortedBatches[0];
      
      if (!lowUtilBatch || lowUtilBatch.utilization >= 80) break; // 如果最低利用率已经很高，停止优化
      
      // 尝试将其他批次的小文件移动到低利用率批次
      for (let i = 1; i < sortedBatches.length; i++) {
        const sourceBatch = sortedBatches[i];
        
        if (sourceBatch.items.length === 0) continue; // 跳过空批次
        
        // 找到源批次中最小的文件
        const smallestItem = sourceBatch.items.reduce((min, item) => 
          item.tokens < min.tokens ? item : min
        );
        
        // 检查是否可以移动到低利用率批次
        if (this.canAddToBatch(lowUtilBatch, smallestItem, maxFiles)) {
          // 执行移动
          const itemIndex = sourceBatch.items.indexOf(smallestItem);
          if (itemIndex !== -1) {
            sourceBatch.items.splice(itemIndex, 1);
            sourceBatch.totalTokens -= smallestItem.tokens;
            sourceBatch.fileCount = new Set(sourceBatch.items.map(i => i.originalFilePath || i.filePath)).size;
            sourceBatch.utilization = sourceBatch.totalTokens > 0 ? (sourceBatch.totalTokens / maxTokens) * 100 : 0;
            
            lowUtilBatch.items.push(smallestItem);
            lowUtilBatch.totalTokens += smallestItem.tokens;
            lowUtilBatch.fileCount = new Set(lowUtilBatch.items.map(i => i.originalFilePath || i.filePath)).size;
            lowUtilBatch.utilization = (lowUtilBatch.totalTokens / maxTokens) * 100;
            
            improved = true;
            break;
          }
        }
      }
    }
    
    // 移除空批次
    return batches.filter(batch => batch.items.length > 0);
  }

  /**
   * 回填优化 - 尝试合并利用率低的批次
   */
  backfillOptimization(batches, maxFiles) {
    const maxTokens = this.tokenBudget();
    let optimized = true;
    let iterations = 0;
    const maxIterations = 5; // 防止无限循环
    
    while (optimized && iterations < maxIterations) {
      optimized = false;
      iterations++;
      
      // 按利用率升序排列
      const sortedBatches = [...batches].sort((a, b) => a.utilization - b.utilization);
      
      for (let i = 0; i < sortedBatches.length - 1; i++) {
        const batch1 = sortedBatches[i];
        
        if (!batch1 || batch1.items.length === 0) continue;
        
        for (let j = i + 1; j < sortedBatches.length; j++) {
          const batch2 = sortedBatches[j];
          
          if (!batch2 || batch2.items.length === 0) continue;
          
          // 检查是否可以合并两个批次
          const combinedTokens = batch1.totalTokens + batch2.totalTokens;
          const combinedFileCount = new Set([
            ...batch1.items.map(i => i.originalFilePath || i.filePath),
            ...batch2.items.map(i => i.originalFilePath || i.filePath)
          ]).size;
          
          if (combinedTokens <= maxTokens && combinedFileCount <= maxFiles) {
            // 合并批次
            batch1.items.push(...batch2.items);
            batch1.totalTokens = combinedTokens;
            batch1.fileCount = combinedFileCount;
            batch1.utilization = (combinedTokens / maxTokens) * 100;
            
            // 移除第二个批次
            const batch2Index = batches.indexOf(batch2);
            if (batch2Index !== -1) {
              batches.splice(batch2Index, 1);
            }
            
            optimized = true;
            break;
          }
        }
        
        if (optimized) break;
      }
    }
    
    // 重新编号批次
    batches.forEach((batch, index) => {
      batch.batchIndex = index;
    });
    
    return batches;
  }

  /**
   * 后处理分段文件，确保同一文件的分段能够正确组织
   * @param {Array} batches - 原始批次数组
   * @returns {Array} 处理后的批次数组
   */
  postProcessSegmentedFiles(batches) {
    const processedBatches = [];
    const segmentGroups = new Map(); // 存储分段组信息
    
    // 第一步：识别所有分段组
    for (const batch of batches) {
      for (const item of batch.items) {
        if (item.isChunk && item.segmentGroup) {
          if (!segmentGroups.has(item.segmentGroup)) {
            segmentGroups.set(item.segmentGroup, {
              segments: [],
              totalChunks: item.totalChunks,
              batchIndices: new Set()
            });
          }
          segmentGroups.get(item.segmentGroup).segments.push({
            item,
            batchIndex: batch.batchIndex
          });
          segmentGroups.get(item.segmentGroup).batchIndices.add(batch.batchIndex);
        }
      }
    }
    
    // 第二步：为每个批次添加分段等待信息
    for (const batch of batches) {
      const processedBatch = {
        ...batch,
        hasSegmentedFiles: false,
        segmentInfo: {},
        needsWaiting: false
      };
      
      // 检查批次中是否有分段文件
      for (const item of batch.items) {
        if (item.isChunk && item.segmentGroup) {
          processedBatch.hasSegmentedFiles = true;
          processedBatch.needsWaiting = true;
          
          const groupInfo = segmentGroups.get(item.segmentGroup);
          if (!processedBatch.segmentInfo[item.segmentGroup]) {
            processedBatch.segmentInfo[item.segmentGroup] = {
              currentChunk: item.chunkIndex,
              totalChunks: item.totalChunks,
              allBatchIndices: Array.from(groupInfo.batchIndices).sort(),
              isComplete: groupInfo.segments.length === item.totalChunks
            };
          }
        }
      }
      
      processedBatches.push(processedBatch);
    }
    
    return processedBatches;
  }

  /**
   * 找到最接近maxRequestTokens的最优文件组合
   * @param {Array} items - 可选择的文件项目
   * @param {number} maxFiles - 最大文件数限制
   * @returns {Object} 最优组合 {items: [], totalTokens: number}
   */
  findOptimalCombination(items, maxFiles) {
    const maxTokens = this.tokenBudget();
    let bestCombination = { items: [], totalTokens: 0 };
    
    // 使用贪心算法 + 回溯优化
    // 首先按token密度排序（token/文件数比例）
    const sortedItems = [...items].sort((a, b) => {
      return b.tokens - a.tokens; // 降序
    });
    
    // 尝试不同的组合策略
    this.tryGreedyCombination(sortedItems, maxFiles, maxTokens, bestCombination);
    this.tryBalancedCombination(sortedItems, maxFiles, maxTokens, bestCombination);
    
    return bestCombination;
  }

  /**
   * 贪心策略：优先选择大文件，然后填充小文件
   */
  tryGreedyCombination(items, maxFiles, maxTokens, bestCombination) {
    const combination = { items: [], totalTokens: 0 };
    const uniqueFiles = new Set();
    
    for (const item of items) {
      const itemFilePath = item.originalFilePath || item.filePath;
      const wouldExceedTokens = combination.totalTokens + item.tokens > maxTokens;
      const wouldExceedFiles = !uniqueFiles.has(itemFilePath) && uniqueFiles.size >= maxFiles;
      
      if (!wouldExceedTokens && !wouldExceedFiles) {
        combination.items.push(item);
        combination.totalTokens += item.tokens;
        uniqueFiles.add(itemFilePath);
      }
    }
    
    // 如果这个组合更好，更新最佳组合
    if (combination.totalTokens > bestCombination.totalTokens) {
      bestCombination.items = [...combination.items];
      bestCombination.totalTokens = combination.totalTokens;
    }
  }

  /**
   * 平衡策略：尝试找到更均衡的文件大小组合
   */
  tryBalancedCombination(items, maxFiles, maxTokens, bestCombination) {
    // 按token数升序排列，尝试组合多个小文件
    const ascendingItems = [...items].sort((a, b) => a.tokens - b.tokens);
    const combination = { items: [], totalTokens: 0 };
    const uniqueFiles = new Set();
    
    for (const item of ascendingItems) {
      const itemFilePath = item.originalFilePath || item.filePath;
      const wouldExceedTokens = combination.totalTokens + item.tokens > maxTokens;
      const wouldExceedFiles = !uniqueFiles.has(itemFilePath) && uniqueFiles.size >= maxFiles;
      
      if (!wouldExceedTokens && !wouldExceedFiles) {
        combination.items.push(item);
        combination.totalTokens += item.tokens;
        uniqueFiles.add(itemFilePath);
      }
    }
    
    // 如果这个组合的利用率更高，更新最佳组合
    const currentUtilization = bestCombination.totalTokens / maxTokens;
    const newUtilization = combination.totalTokens / maxTokens;
    
    if (newUtilization > currentUtilization || 
        (Math.abs(newUtilization - currentUtilization) < 0.1 && combination.items.length > bestCombination.items.length)) {
      bestCombination.items = [...combination.items];
      bestCombination.totalTokens = combination.totalTokens;
    }
  }

  /**
   * 检查是否可以将项目添加到批次中
   * @param {Object} batch - 批次对象
   * @param {Object} item - 文件项目
   * @param {number} maxFiles - 每批次最大文件数
   * @returns {boolean} 是否可以添加
   */
  canAddToBatch(batch, item, maxFiles) {
    // 检查Token限制
    if (batch.totalTokens + item.tokens > this.tokenBudget()) {
      return false;
    }
    
    // 检查文件数限制
    const uniqueFiles = new Set(batch.items.map(i => i.originalFilePath || i.filePath));
    const itemFilePath = item.originalFilePath || item.filePath;
    if (!uniqueFiles.has(itemFilePath) && uniqueFiles.size >= maxFiles) {
      return false;
    }
    
    return true;
  }

  /**
   * 生成批次统计信息
   * @param {Array} batches - 批次数组
   * @param {Map} fileStats - 文件统计信息
   * @returns {Object} 统计信息
   */
  generateBatchStats(batches, fileStats) {
    const totalFiles = fileStats.size;
    const totalBatches = batches.length;
    const totalTokens = Array.from(fileStats.values()).reduce((sum, stat) => sum + stat.originalTokens, 0);
    const chunkedFiles = Array.from(fileStats.values()).filter(stat => stat.needsChunking).length;
    
    const avgUtilization = batches.length > 0 
      ? batches.reduce((sum, batch) => sum + batch.utilization, 0) / batches.length 
      : 0;
    
    return {
      totalFiles,
      totalBatches,
      totalTokens,
      chunkedFiles,
      avgUtilization: Math.round(avgUtilization * 100) / 100,
      maxBatchTokens: this.config.maxBatchTokens,
      maxFileTokens: this.config.maxFileTokens
    };
  }

  /**
   * 格式化批次信息用于AI分析
   * @param {Object} batch - 批次对象
   * @returns {Object} 格式化的批次信息
   */
  formatBatchForAI(batch) {
    const fileGroups = new Map();
    
    // 按文件分组
    for (const item of batch.items) {
      const filePath = item.originalFilePath || item.filePath;
      if (!fileGroups.has(filePath)) {
        fileGroups.set(filePath, []);
      }
      fileGroups.get(filePath).push(item);
    }
    
    const formattedFiles = [];
    
    for (const [filePath, items] of fileGroups) {
      if (items.length === 1 && !items[0].isChunk) {
        // 单个完整文件
        formattedFiles.push({
          filePath,
          content: items[0].content,
          isChunked: false,
          staticIssues: items[0].staticIssues || []
        });
      } else {
        // 分段文件
        const sortedItems = items.sort((a, b) => a.chunkIndex - b.chunkIndex);
        formattedFiles.push({
          filePath,
          content: sortedItems.map(item => item.content).join('\n'),
          isChunked: true,
          totalChunks: sortedItems[0].totalChunks,
          chunks: sortedItems.map(item => ({
            index: item.chunkIndex,
            content: item.content,
            startLine: item.startLine,
            endLine: item.endLine,
            tokens: item.tokens
          })),
          staticIssues: sortedItems[0].staticIssues || []
        });
      }
    }
    
    return {
      batchIndex: batch.batchIndex,
      totalTokens: batch.totalTokens,
      utilization: batch.utilization,
      files: formattedFiles
    };
  }



  /**
   * 全局优化组合 - 重新分配以提高整体利用率
   */
  globalOptimizeCombinations(combinations, maxFiles, maxTokens) {
    if (combinations.length <= 1) return combinations;
    
    // 转换为批次格式
    const batches = combinations.map((combo, index) => ({
      batchIndex: index,
      items: combo,
      totalTokens: combo.reduce((sum, file) => sum + file.tokens, 0),
      fileCount: combo.length,
      utilization: (combo.reduce((sum, file) => sum + file.tokens, 0) / maxTokens) * 100
    }));
    
    // 尝试合并低利用率的批次
    const optimizedBatches = this.mergeLowUtilizationBatches(batches, maxFiles, maxTokens);
    
    // 转换回组合格式
    return optimizedBatches.map(batch => batch.items);
  }

  /**
   * 合并低利用率批次
   */
  mergeLowUtilizationBatches(batches, maxFiles, maxTokens) {
    const result = [];
    const used = new Array(batches.length).fill(false);
    
    // 按利用率排序
    const sortedBatches = batches
      .map((batch, index) => ({ ...batch, originalIndex: index }))
      .sort((a, b) => b.utilization - a.utilization);
    
    for (const batch of sortedBatches) {
      if (used[batch.originalIndex]) continue;
      
      let currentBatch = { ...batch, items: [...batch.items] };
      used[batch.originalIndex] = true;
      
      // 尝试合并其他低利用率批次
      for (const otherBatch of sortedBatches) {
        if (used[otherBatch.originalIndex]) continue;
        
        const combinedTokens = currentBatch.totalTokens + otherBatch.totalTokens;
        const combinedFileCount = currentBatch.fileCount + otherBatch.fileCount;
        
        if (combinedTokens <= maxTokens && combinedFileCount <= maxFiles) {
          currentBatch.items.push(...otherBatch.items);
          currentBatch.totalTokens = combinedTokens;
          currentBatch.fileCount = combinedFileCount;
          currentBatch.utilization = (combinedTokens / maxTokens) * 100;
          used[otherBatch.originalIndex] = true;
        }
      }
      
      result.push(currentBatch);
    }
    
    return result;
  }

  /**
   * 清理资源并回收对象到池中
   * @param {Array} batches - 要清理的批次数组
   */
  cleanupBatches(batches) {
    if (!batches || !Array.isArray(batches)) return;
    
    for (const batch of batches) {
      if (batch.items && Array.isArray(batch.items)) {
        for (const item of batch.items) {
          this.recycleItemToPool(item);
        }
      }
      this.recycleBatchToPool(batch);
    }
  }

  /**
   * 清理文件统计对象
   * @param {Map} fileStats - 文件统计Map
   */
  cleanupFileStats(fileStats) {
    if (!fileStats || !(fileStats instanceof Map)) return;
    
    for (const stats of fileStats.values()) {
      this.recycleStatsToPool(stats);
    }
  }

  /**
   * 清理所有缓存和对象池
   */
  cleanup() {
    // 清理token缓存
    this.tokenCache.clear();
    this.cacheStats = { hits: 0, misses: 0 };
    
    // 清理对象池
    this.batchObjectPool.length = 0;
    this.itemObjectPool.length = 0;
    this.chunkObjectPool.length = 0;
    this.statsObjectPool.length = 0;
  }

  /**
   * 获取对象池统计信息
   * @returns {Object} 对象池统计
   */
  getPoolStats() {
    return {
      batchPool: {
        size: this.batchObjectPool.length,
        type: 'batch'
      },
      itemPool: {
        size: this.itemObjectPool.length,
        type: 'item'
      },
      chunkPool: {
        size: this.chunkObjectPool.length,
        type: 'chunk'
      },
      statsPool: {
        size: this.statsObjectPool.length,
        type: 'stats'
      },
      tokenCache: this.getCacheStats()
    };
  }
}