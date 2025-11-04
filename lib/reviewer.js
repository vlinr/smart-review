import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AIClient } from './ai-client.js';
import { AIClientPool } from './ai-client-pool.js';
import { SmartBatching } from './smart-batching.js';
import { GitDiffParser } from './utils/git-diff-parser.js';
import { logger } from './utils/logger.js';
import { DEFAULT_CONFIG, BATCH_CONSTANTS } from './utils/constants.js';

const execAsync = promisify(exec);

export class CodeReviewer {
  constructor(config, rules) {
    this.config = config;
    this.rules = rules;
    // 传递 reviewDir 给 AI 客户端用于读取自定义提示词目录 .smart-review/ai-rules
    this.aiClient = config.ai?.enabled ? new AIClient({ ...config.ai, reviewDir: config.reviewDir }) : null;
    this.issues = [];
    this.aiRan = false;
    
    // 初始化AI客户端池（根据concurrency值判断并发模式）
    const aiConfig = config?.ai || {};
    const concurrency = Math.round(aiConfig.concurrency || 1); // 四舍五入处理
    
    if (aiConfig.enabled && concurrency > 1) {
      this.aiClientPool = new AIClientPool(config, rules, concurrency);
      this.useConcurrency = true;
      this.concurrency = concurrency;
    } else {
      this.aiClientPool = null;
      this.useConcurrency = false;
      this.concurrency = 1;
    }
    
    // 添加缓存机制以减少对象创建
    this.regexCache = new Map(); // 缓存编译的正则表达式
    this.commentRangeCache = new Map(); // 缓存注释范围计算结果
    this.disableRangeCache = new Map(); // 缓存禁用范围计算结果
    this.extensionCache = new Map(); // 缓存文件扩展名
    
    // 缓存统计
    this.cacheStats = {
      regexHits: 0,
      regexMisses: 0,
      commentRangeHits: 0,
      commentRangeMisses: 0,
      disableRangeHits: 0,
      disableRangeMisses: 0
    };
  }

  async reviewStagedFiles() {
    try {
      logger.progress('开始审查暂存区代码...');
      
      // 检查是否启用git diff增量审查模式
      const reviewOnlyChanges = this.config.ai?.reviewOnlyChanges || false;
      
      if (reviewOnlyChanges) {
        logger.info('🔍 使用Git Diff增量审查模式 - 仅审查变动内容');
        return await this.reviewStagedDiff();
      } else {
        logger.info('📁 使用全文件审查模式');
        const stagedFiles = await this.getStagedFiles();
        
        if (stagedFiles.length === 0) {
          logger.info('📭 暂存区没有文件需要审查');
          return this.generateResult();
        }
        logger.info(`📁 发现 ${stagedFiles.length} 个文件需要审查`);
        
        await this.reviewFilesBatchAware(stagedFiles);
        return this.generateResult();
      }
    } catch (error) {
      logger.error('审查过程出错:', error);
      throw error;
    }
  }

  async reviewSpecificFiles(filePaths) {
    logger.progress(`开始审查指定文件: ${filePaths.join(', ')}`);
    const fullPaths = [];
    for (const filePath of filePaths) {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.config.projectRoot, filePath);
      if (fs.existsSync(fullPath)) {
        fullPaths.push(fullPath);
      } else {
        logger.warn(`文件不存在: ${fullPath}`);
      }
    }
    await this.reviewFilesBatchAware(fullPaths);
    return this.generateResult();
  }

  async getStagedFiles() {
    try {
      const { stdout } = await execAsync('git diff --cached --name-only --diff-filter=ACM', {
        cwd: this.config.projectRoot
      });
      
      return stdout.split('\n')
        .filter(file => file.trim())
        .map(file => path.resolve(this.config.projectRoot, file))
        .filter(file => this.isReviewableFile(file));
    } catch (error) {
      logger.error('获取暂存区文件失败:', error);
      return [];
    }
  }

  /**
   * Git Diff增量审查 - 仅审查暂存区变动内容
   */
  async reviewStagedDiff() {
    try {
      logger.info('🔍 启动Git Diff增量审查模式...');
      
      const contextMergeLines = this.config.ai?.contextMergeLines || 10;
      const diffParser = new GitDiffParser(this.config.projectRoot, contextMergeLines, this.config);
      
      // 获取diff审查数据
      const diffReviewData = await diffParser.getStagedDiffReviewData();
      
      if (diffReviewData.length === 0) {
        logger.info('📝 暂存区无变更内容，跳过审查');
        return this.generateResult();
      }

      logger.info(`📊 发现 ${diffReviewData.length} 个变更文件，开始增量审查...`);
      
      // 第一阶段：对所有文件进行静态规则检查，检测阻断风险
      const riskLevels = this.config.riskLevels || {};
      let hasBlockingIssues = false;
      const aiEligibleFiles = [];
      
      for (let i = 0; i < diffReviewData.length; i++) {
        const fileData = diffReviewData[i];
        const globalIndex = i + 1;
        const filePath = path.resolve(this.config.projectRoot, fileData.filePath);
        if (!this.isReviewableFile(filePath)) {
          logger.info(`文件已跳过审查: ${filePath} (文件类型被忽略)`);
          continue;
        }
        logger.progress(`[${globalIndex}/${diffReviewData.length}] 审查文件: ${fileData.filePath} (新增${fileData.totalAddedLines}行, ${fileData.segments.length}个分段)`);
        // 应用静态规则检查
        const staticIssues = await this.applyStaticRulesToDiff(fileData, filePath);
        this.issues.push(...staticIssues);
        
        if (staticIssues.length > 0) {
          logger.debug(`静态规则发现 ${staticIssues.length} 个问题`);
        }

        // 检查是否有阻断等级问题
        const blockedIssues = staticIssues.filter(issue => {
          const levelCfg = riskLevels[issue.risk || 'suggestion'];
          return levelCfg && levelCfg.block === true;
        });

        if (blockedIssues.length > 0) {
          const levelsText = [...new Set(blockedIssues.map(i => i.risk))].join(', ');
          logger.error(`发现阻断等级风险 (${levelsText})，跳过AI分析`);
          hasBlockingIssues = true;
        } else {
          // 没有阻断问题的文件可以进行AI分析
          aiEligibleFiles.push(fileData);
        }
      }
      
      // 如果发现阻断等级问题，终止整个审查流程
      if (hasBlockingIssues) {
        logger.error('发现阻断等级风险，终止审查流程');
        return this.generateResult();
      }
      
      // 第二阶段：对通过静态检查的文件进行AI分析
      if (aiEligibleFiles.length > 0 && this.aiClient) {
        logger.info(`🤖 开始AI智能分析 ${aiEligibleFiles.length} 个文件...`);
        
        // 使用并发处理AI分析
        const concurrency = this.config.concurrency || 3;
        const batches = [];
        
        // 将文件分批处理
        for (let i = 0; i < aiEligibleFiles.length; i += concurrency) {
          const batch = aiEligibleFiles.slice(i, i + concurrency);
          batches.push(batch);
        }
        
        // 并发处理每个批次
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
          const batch = batches[batchIndex];
          
          // 并发处理当前批次的文件
          const promises = batch.map((fileData, index) => {
            const globalIndex = batchIndex * concurrency + index + 1;
            logger.debug(`  🤖 [${globalIndex}/${aiEligibleFiles.length}] AI分析: ${fileData.filePath}`);
            return this.performAIDiffAnalysis(fileData);
          });
          
          await Promise.all(promises);
        }
      }
      
      logger.success('✨ Git Diff增量审查完成');

      return this.generateResult();
    } catch (error) {
      logger.error('Git Diff审查过程出错:', error);
      throw error;
    }
  }

  /**
   * 审查单个文件的diff变更
   * @param {Object} fileData diff审查数据
   */
  async reviewFileDiff(fileData) {
    const filePath = path.resolve(this.config.projectRoot, fileData.filePath);
    
    if (!this.isReviewableFile(filePath)) {
      logger.info(`文件已跳过审查: ${filePath} (文件类型被忽略)`);
      return;
    }

    try {
      // 1. 对新增代码应用静态规则
      logger.debug(`应用静态规则检查...`);
      const staticIssues = await this.applyStaticRulesToDiff(fileData, filePath);
      this.issues.push(...staticIssues);
      
      if (staticIssues.length > 0) {
        logger.debug(`静态规则发现 ${staticIssues.length} 个问题`);
      }

      // 2. 本地规则门槛判定
      const riskLevels = this.config.riskLevels || {};
      const blockedIssues = staticIssues.filter(issue => {
        const levelCfg = riskLevels[issue.risk || 'suggestion'];
        return levelCfg && levelCfg.block === true;
      });

      if (blockedIssues.length > 0) {
        const levelsText = [...new Set(blockedIssues.map(i => i.risk))].join(', ');
        logger.error(`发现阻断等级风险 (${levelsText})，跳过AI分析`);
      } else {
        // 3. 应用AI分析（如果启用）
        if (this.aiClient && this.shouldUseAI(filePath, fileData.fullContent)) {
          logger.debug(`启动AI智能分析...`);
          const aiIssues = await this.aiClient.analyzeDiffFile(fileData, { staticIssues });
          this.issues.push(...aiIssues);
          this.aiRan = true;
          
          if (aiIssues.length > 0) {
            logger.debug(`AI分析发现 ${aiIssues.length} 个问题`);
          }
        }
      }

    } catch (error) {
       logger.error(`审查文件变更失败 ${filePath}:`, error);
     }
   }

   /**
    * 对通过静态检查的文件执行AI分析
    * @param {Object} fileData diff审查数据
    * @param {Array} staticIssues 静态规则检查结果
    */
   async performAIDiffAnalysis(fileData, staticIssues) {
     const filePath = path.resolve(this.config.projectRoot, fileData.filePath);
     
     try {
       if (this.aiClient && this.shouldUseAI(filePath, fileData.fullContent)) {
         logger.debug(`启动AI智能分析...`);
         const aiIssues = await this.aiClient.analyzeDiffFile(fileData, { staticIssues });
         this.issues.push(...aiIssues);
         this.aiRan = true;
         
         if (aiIssues.length > 0) {
           logger.debug(`AI分析发现 ${aiIssues.length} 个问题`);
         }
       }
     } catch (error) {
       logger.error(`AI分析文件变更失败 ${filePath}:`, error);
     }
   }

   /**
    * 对diff变更应用静态规则 - 仅检查新增代码行
    * @param {Object} fileData diff审查数据
    * @param {string} filePath 文件路径
    * @returns {Array} 问题列表
    */
   async applyStaticRulesToDiff(fileData, filePath) {
     const issues = [];
     const ext = this.getCachedExtension(filePath);
     
     // 对每个智能分段应用静态规则
     for (const segment of fileData.segments) {
       // 提取新增行内容和行号映射
       const { addedLinesContent, lineMapping } = this.extractAddedLinesFromSegment(segment);
       
       if (!addedLinesContent.trim()) {
         continue; // 没有新增行内容，跳过
       }
       
       // 应用review-disable过滤
       const disableRanges = this.getCachedDisableRanges(addedLinesContent, filePath);
       const commentRanges = this.getCachedCommentRanges(addedLinesContent, ext);
       
       for (const rule of this.rules) {
         try {
           // 函数类型规则处理
           if (typeof rule.pattern === 'function') {
             let result;
             try {
               result = rule.pattern(addedLinesContent);
             } catch (_) {
               result = undefined;
             }
             
             if (result) {
               const pushIssue = (snippetText) => {
                 const snip = String(snippetText || '');
                 if (!snip) return;
                 issues.push({
                   file: filePath,
                   line: segment.startLine, // 使用段落起始行
                   risk: rule.risk,
                   message: rule.message,
                   suggestion: rule.suggestion,
                   snippet: snip,
                   ruleId: rule.id,
                   source: 'static'
                 });
               };
               
               if (Array.isArray(result)) {
                 for (const s of result) pushIssue(s);
               } else {
                 pushIssue(result);
               }
             }
             continue;
           }

           // 正则表达式规则处理
           const regex = this.getCachedRegex(rule.pattern, rule.flags || 'gm');
           let match;
           const reportedSnippets = new Set();

           while ((match = regex.exec(addedLinesContent)) !== null) {
             // 检查匹配位置是否在注释中
             if (this.isIndexInRanges(match.index, commentRanges)) {
               continue;
             }
             
             // 检查匹配位置是否在禁用范围内
             if (this.isIndexInRanges(match.index, disableRanges.suppressRanges || [])) {
               continue;
             }
             
             const snippetText = (match[0] || '').substring(0, 200); // 限制片段长度
             
             if (reportedSnippets.has(snippetText)) {
               continue; // 避免重复报告
             }
             
             reportedSnippets.add(snippetText);
             
             // 计算在新增行内容中的行号
             const matchLineInAddedContent = this.getLineNumber(addedLinesContent, match.index);
             
             // 映射回原文件的行号
             const actualLineNumber = lineMapping[matchLineInAddedContent - 1];
             
             if (actualLineNumber) {
               issues.push({
                 file: filePath,
                 line: actualLineNumber,
                 risk: rule.risk,
                 message: rule.message,
                 suggestion: rule.suggestion,
                 snippet: snippetText,
                 ruleId: rule.id,
                 source: 'static'
               });
             }
           }
         } catch (error) {
           logger.warn(`规则 ${rule.id} 在diff模式下执行失败:`, error.message);
         }
       }
     }
     
     return issues;
   }

   /**
    * 获取段落中新增行的位置集合
    * @param {Object} segment 代码段
    * @returns {Set} 新增行位置集合
    */
   getAddedLinePositions(segment) {
     const addedLines = new Set();
     const lines = segment.content.split('\n');
     
     for (let i = 0; i < lines.length; i++) {
       const line = lines[i];
       if (line.trim().length > 0) {
         addedLines.add(i + 1); // 行号从1开始
       }
     }
     
     return addedLines;
   }

   /**
    * 从段落中提取新增行内容和行号映射
    * @param {Object} segment 代码段
    * @returns {Object} { addedLinesContent: string, lineMapping: Array }
    */
   extractAddedLinesFromSegment(segment) {
     const lines = segment.content.split('\n');
     const addedLines = [];
     const lineMapping = []; // 映射：新内容行号 -> 原始段落行号
     
     for (let i = 0; i < lines.length; i++) {
       const line = lines[i];
       // 只提取新增行（以+开头的行）
       if (line.startsWith('+')) {
         // 移除+前缀，保留实际代码内容
         addedLines.push(line.substring(1));
         lineMapping.push(i + 1); // 记录在原始段落中的行号（1-based）
       }
     }
     
     return {
       addedLinesContent: addedLines.join('\n'),
       lineMapping
     };
   }



  // 批量感知：优先批量AI分析（方案A），同时保留静态规则与阻断判定
  async reviewFilesBatchAware(filePaths) {
    // 逐文件应用静态规则，若任一文件含阻断等级问题则全局跳过AI；否则所有可用文件进入AI批量
    const aiEligible = [];
    let anyBlocking = false;
    const riskLevels = this.config.riskLevels || {};

    for (const file of filePaths) {
      if (!this.isReviewableFile(file)) {
        logger.info(`文件已跳过审查: ${file} (文件类型被忽略)`);
        continue;
      }
      const relativePath = path.relative(this.config.projectRoot, file);
      logger.debug(`审查文件: ${relativePath}`);

      try {
        const content = await this.getFileContent(file);
        if (!content) continue;

        // 计算代码内指令禁用范围（行/段），不支持整文件禁用（整文件由 ignore 配置控制）
        const disable = this.computeDisableRanges(content, file);

        // 静态规则
        const staticIssues = this.applyStaticRules(content, file, disable);
        this.issues.push(...staticIssues);
        // 阻断级别判定（只要本地存在阻断等级问题，则全局跳过AI）
        const blockedIssues = staticIssues.filter(issue => {
          const levelCfg = riskLevels[issue.risk || 'suggestion'];
          return levelCfg && levelCfg.block === true;
        });
        if (blockedIssues.length > 0) {
          anyBlocking = true;
        }
        // 收集所有允许的文件，若最终无阻断则这些文件将进入AI批量
        if (this.aiClient && this.shouldUseAI(file, content)) {
          const contextStatic = this.config.ai && this.config.ai.useStaticHints === true ? staticIssues : [];
          aiEligible.push({ filePath: file, content, staticIssues: contextStatic });
        }
      } catch (error) {
          logger.error(`审查文件失败 ${file}:`, error);
        }
      }
    // 若任意文件存在阻断等级问题，直接返回（跳过AI）
    if (anyBlocking) {
      logger.info('本地规则存在阻断等级风险，跳过所有文件的AI分析。');
      return;
    }

    if (aiEligible.length === 0) return;

    // 使用增量式分析器进行分析（默认行为）
    logger.progress('使用增量式分析器进行分析...');
    await this.reviewFilesWithIncrementalAnalyzer(aiEligible);
  }

  async reviewFilesWithIncrementalAnalyzer(aiEligible) {
    try {
      // 直接使用智能批处理，它会自动处理大文件分段和小文件组合
      await this.reviewFilesWithSmartBatching(aiEligible);
      
    } catch (error) {
      logger.error(`增量式分析器失败: ${error.message}`);
      throw error;
    }
  }

  async reviewFilesWithSmartBatching(aiEligible) {
    const batchCfg = this.config.ai || {};
    
    // 使用智能分批处理
    try {
      const smartBatching = new SmartBatching({
        maxRequestTokens: batchCfg.maxRequestTokens || 8000,
        minFilesPerBatch: batchCfg.minFilesPerBatch || 1,
        maxFilesPerBatch: batchCfg.maxFilesPerBatch || 20,
        tokenRatio: batchCfg.tokenRatio || 4,
        chunkOverlapLines: batchCfg.chunkOverlapLines || 5
      });

      logger.progress('开始AI智能分析，根据文件大小耗时不同，请耐心等待...');
      const batchResult = smartBatching.createSmartBatches(aiEligible);

      if (this.useConcurrency && this.aiClientPool) {
        // 并发处理模式
        await this.processBatchesConcurrently(batchResult.batches, smartBatching);
      } else {
        // 串行处理模式（原有逻辑）
        await this.processBatchesSerially(batchResult.batches, smartBatching);
      }
      
      logger.success(`AI分析完成，发现${this.issues.filter(issue => issue.source === 'ai').length}个问题`);
      
      this.aiRan = true;
    } catch (error) {
      logger.error('AI智能批量分析过程出错:', error);
      
      // 回退到原有的简单分批方式
      logger.progress('回退到简单分析方式...');
      try {
        const max = Number(batchCfg.maxFilesPerBatch || 20);
        const batches = [];
        for (let i = 0; i < aiEligible.length; i += max) {
          batches.push(aiEligible.slice(i, i + max));
        }
        
        logger.info(`开始AI分析，共${batches.length}批文件`);
        
        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i];
          logger.info(`批次 ${i + 1}/${batches.length}: 分析${batch.length}个文件`);
          const aiIssues = await this.aiClient.analyzeFilesBatch(batch);
          this.issues.push(...aiIssues);
          logger.success(`批次 ${i + 1}/${batches.length} 完成`);
        }
        this.aiRan = true;
      } catch (fallbackError) {
        logger.error('回退分析也失败:', fallbackError);
      }
    }
  }

  /**
   * 并发处理批次
   * @param {Array} batches - 批次数组
   * @param {SmartBatching} smartBatching - 智能分批实例
   */
  async processBatchesConcurrently(batches, smartBatching) {
    // 只有当批次数量大于1且并发数量大于1时才显示并发处理日志
    if (batches.length > 1 && this.concurrency > 1) {
      logger.info(`启用并发处理，并发数: ${this.concurrency}`);
      logger.info(`使用并发模式处理 ${batches.length} 个批次`);
    }
    
    // 创建进度跟踪器
    const progressTracker = {
      completed: 0,
      failed: 0,
      total: batches.length,
      startTime: Date.now()
    };

    // 进度回调函数
    const progressCallback = (batchIndex, batch, status, error) => {
      if (status === 'completed') {
        progressTracker.completed++;
        // 只在特定间隔输出进度，避免日志混乱
        if (progressTracker.completed % Math.max(1, Math.floor(batches.length / 10)) === 0 || 
            progressTracker.completed === batches.length) {
          const elapsed = ((Date.now() - progressTracker.startTime) / 1000).toFixed(1);
          logger.info(`当前已完成进度: ${progressTracker.completed}/${progressTracker.total}，总耗时: ${elapsed}s`);
        }
      } else if (status === 'failed') {
        progressTracker.failed++;
        logger.warn(`批次 ${batchIndex + 1} 处理失败: ${error?.message || '未知错误'}`);
      }
    };

    try {
      // 使用AI客户端池执行并发处理
      const allResults = await this.aiClientPool.executeConcurrentBatches(batches, progressCallback);
      
      // 汇总结果
      this.issues.push(...allResults);
      
      const elapsed = ((Date.now() - progressTracker.startTime) / 1000).toFixed(1);
      logger.success(`并发处理完成: 成功 ${progressTracker.completed}, 失败 ${progressTracker.failed}, 耗时 ${elapsed}s`);
      
    } catch (error) {
      logger.error(`并发处理过程中发生错误: ${error.message}`);
      throw error;
    }
  }

  /**
   * 串行处理批次（原有逻辑）
   * @param {Array} batches - 批次数组
   * @param {SmartBatching} smartBatching - 智能分批实例
   */
  async processBatchesSerially(batches, smartBatching) {
    logger.info(`使用串行模式处理 ${batches.length} 个批次`);
    
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const formattedBatch = smartBatching.formatBatchForAI(batch);
      
      // 判断批次类型并输出相应信息
      if (batch.isLargeFileSegment) {
        // 大文件批次 - 显示文件路径和总段数
        logger.info(`批次 ${i + 1}/${batches.length}: 分析 ${batch.segmentedFile} 文件，共${batch.totalSegments}段`);
      } else {
        // 小文件批次 - 列出所有文件
        const fileList = batch.items.map(item => item.filePath).join(',');
        logger.info(`批次 ${i + 1}/${batches.length}: 分析 ${fileList} 文件`);
      }
      
      const aiIssues = await this.aiClient.analyzeSmartBatch(formattedBatch, batch);
      this.issues.push(...aiIssues);
      
      logger.success(`批次 ${i + 1}/${batches.length} 完成`);
    }
  }

  async getFileContent(filePath) {
    try {
      const relativePath = path.relative(this.config.projectRoot, filePath);
      
      // 尝试获取暂存区内容
      try {
        const { stdout } = await execAsync(`git show :"${relativePath}"`, {
          cwd: this.config.projectRoot,
          maxBuffer: 10 * 1024 * 1024
        });
        return stdout;
      } catch (stagedError) {
        // 回退到读取工作区文件，使用流式读取处理大文件
        return await this.readFileStream(filePath);
      }
    } catch (error) {
      logger.error(`❌ 读取文件内容失败 ${filePath}:`, error);
      return null;
    }
  }

  async readFileStream(filePath) {
    return new Promise((resolve, reject) => {
      const stats = fs.statSync(filePath);
      const fileSizeKB = stats.size / 1024;
      
      // 对于小文件（< 1MB），直接使用同步读取
      if (fileSizeKB < 1024) {
        try {
          resolve(fs.readFileSync(filePath, 'utf8'));
          return;
        } catch (error) {
          reject(error);
          return;
        }
      }
      
      // 对于大文件，使用流式读取
      logger.debug(`使用流式读取大文件: ${filePath} (${fileSizeKB.toFixed(1)}KB)`);
      
      const chunks = [];
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      
      stream.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      stream.on('end', () => {
        resolve(chunks.join(''));
      });
      
      stream.on('error', (error) => {
        reject(error);
      });
    });
  }

  applyStaticRules(content, filePath, disableCtx) {
    const issues = [];
    const ext = this.getCachedExtension(filePath);
    const commentRanges = this.getCachedCommentRanges(content, ext);
    const disable = disableCtx || this.getCachedDisableRanges(content, filePath);
    let skippedByComments = 0;
    let skippedByDirectives = 0;
    for (const rule of this.rules) {
      try {
        // 可选：当文件中存在指定清理/反证模式时，跳过该规则以降低误报
        if (Array.isArray(rule.requiresAbsent) && rule.requiresAbsent.length > 0 && typeof rule.pattern !== 'function') {
          const hasCleanup = rule.requiresAbsent.some(rxStr => {
            try {
              const rx = this.getCachedRegex(rxStr, rule.flags || 'gm');
              return rx.test(content);
            } catch (_) {
              return false;
            }
          });
          if (hasCleanup) continue; // 文件已存在对应清理逻辑，跳过此规则
        }

        // 简化：pattern 支持函数。若返回片段字符串或字符串数组，则直接使用该片段作为结果；
        // 若返回 falsy，则视为规则校验通过（不报告）。不进行额外的二次匹配或行号计算。
        if (typeof rule.pattern === 'function') {
          let result;
          try {
            result = rule.pattern(content);
          } catch (_) {
            result = undefined;
          }
          const pushIssue = (snippetText) => {
            const snip = String(snippetText || '');
            if (!snip) return;
            issues.push({
              file: filePath,
              line: undefined,
              risk: rule.risk,
              message: rule.message,
              suggestion: rule.suggestion,
              snippet: snip,
              ruleId: rule.id,
              source: 'static'
            });
          };
          if (!result) {
            // 规则校验通过
          } else if (Array.isArray(result)) {
            for (const s of result) pushIssue(s);
          } else {
            pushIssue(result);
          }
          continue; // 进入下一条规则
        }

        const regex = this.getCachedRegex(rule.pattern, rule.flags || 'gm');
        let match;

        // 记录该规则已在哪些代码片段上报过，避免重复片段
        const reportedSnippets = new Set();

        while ((match = regex.exec(content)) !== null) {
          // 若匹配位置在注释中，跳过
          if (this.isIndexInRanges(match.index, commentRanges)) {
            skippedByComments++;
            continue;
          }
          // 若匹配位置在禁用范围内，跳过
          if (this.isIndexInRanges(match.index, disable.suppressRanges || [])) {
            skippedByDirectives++;
            continue;
          }
          const lineNumber = this.getLineNumber(content, match.index);
          const snippetText = (match[0] || '').substring(0, BATCH_CONSTANTS.MAX_SNIPPET_LENGTH);

          if (reportedSnippets.has(snippetText)) {
            continue; // 本规则在该片段已报告，避免重复
          }

          reportedSnippets.add(snippetText);

          issues.push({
            file: filePath,
            line: lineNumber,
            risk: rule.risk,
            message: rule.message,
            suggestion: rule.suggestion,
            snippet: snippetText,
            ruleId: rule.id,
            source: 'static'
          });
        }
      } catch (error) {
        logger.warn(`规则 ${rule.id} 执行失败:`, error.message);
      }
    }

    if (skippedByComments > 0) {
      logger.debug(`注释代码已跳过审查（${skippedByComments}条匹配）`);
    }
    if (skippedByDirectives > 0) {
      logger.debug(`指令禁用范围已跳过审查（${skippedByDirectives}条匹配）`);
    }

    return issues;
  }

  getLineNumber(content, position) {
    return content.substring(0, position).split('\n').length;
  }

  isReviewableFile(filePath) {
    const extensions = this.config.fileExtensions || [];
    
    // 统一的忽略文件配置：支持相对路径、绝对路径、glob模式和正则表达式
    const ignoreFiles = this.config.ignoreFiles || [];

    const ext = path.extname(filePath).toLowerCase();
    const shouldInclude = extensions.includes(ext);
    if (!shouldInclude || ignoreFiles.length === 0) {
      return shouldInclude;
    }

    const normalized = filePath.replace(/\\/g, '/');
    const relativePath = path.relative(this.config.projectRoot || process.cwd(), filePath).replace(/\\/g, '/');
    const basename = path.basename(filePath);

    // 检查是否应该忽略此文件
    const shouldIgnore = ignoreFiles.some(pattern => {
      const originalPattern = String(pattern);
      
      // 1. 精确匹配（支持相对路径、绝对路径、文件名）
      if (originalPattern === normalized || originalPattern === relativePath || originalPattern === basename) {
        return true;
      }
      // 2. 检查是否为正则表达式（以/开头和结尾，或包含正则特殊字符但不是glob）
      if (this.isRegexPattern(originalPattern)) {
        try {
          const regex = this.createRegexFromPattern(originalPattern);
          const normalizedMatch = regex.test(normalized);
          const relativeMatch = regex.test(relativePath);
          return normalizedMatch || relativeMatch;
        } catch (e) {
          return false;
        }
      }
      
      // 3. glob模式匹配（只对glob模式进行路径分隔符转换）
      const patternStr = originalPattern.replace(/\\/g, '/');
      return this.matchPattern(normalized, patternStr) || this.matchPattern(relativePath, patternStr);
    });

    return !shouldIgnore;
  }

  getFileReviewStatus(filePath) {
    const extensions = this.config.fileExtensions || [];
    const ignoreFiles = this.config.ignoreFiles || [];

    const ext = path.extname(filePath).toLowerCase();
    const shouldInclude = extensions.includes(ext);
    
    if (!shouldInclude) {
      return {
        reviewable: false,
        reason: `文件扩展名 ${ext} 不在支持列表中`,
        matchedPattern: null
      };
    }

    if (ignoreFiles.length === 0) {
      return { reviewable: true, reason: null, matchedPattern: null };
    }

    const normalized = filePath.replace(/\\/g, '/');
    const relativePath = path.relative(this.config.projectRoot || process.cwd(), filePath).replace(/\\/g, '/');
    const basename = path.basename(filePath);

    // 检查是否应该忽略此文件
    for (const pattern of ignoreFiles) {
      const originalPattern = String(pattern);
      
      // 1. 精确匹配（支持相对路径、绝对路径、文件名）
      if (originalPattern === normalized || originalPattern === relativePath || originalPattern === basename) {
        return {
          reviewable: false,
          reason: '匹配精确模式',
          matchedPattern: originalPattern
        };
      }
      
      // 2. 检查是否为正则表达式（以/开头和结尾，或包含正则特殊字符但不是glob）
      if (this.isRegexPattern(originalPattern)) {
        try {
          const regex = this.createRegexFromPattern(originalPattern);
          const normalizedMatch = regex.test(normalized);
          const relativeMatch = regex.test(relativePath);
          if (normalizedMatch || relativeMatch) {
            return {
              reviewable: false,
              reason: '匹配正则表达式',
              matchedPattern: originalPattern
            };
          }
        } catch (e) {
          // 正则表达式创建失败，继续下一个模式
          continue;
        }
      } else {
        // 3. glob模式匹配（只对glob模式进行路径分隔符转换）
        const patternStr = originalPattern.replace(/\\/g, '/');
        if (this.matchPattern(normalized, patternStr) || this.matchPattern(relativePath, patternStr)) {
          return {
            reviewable: false,
            reason: '匹配glob模式',
            matchedPattern: originalPattern
          };
        }
      }
    }

    return { reviewable: true, reason: null, matchedPattern: null };
  }

  matchPattern(filePath, pattern) {
     // 处理glob模式转换为正则表达式
    let regexPattern = pattern
      // 转义正则表达式特殊字符（除了*和?）
      .replace(/[.+^${}()|[\]\\]/g, '\\$&');
    
    // 先处理 ** 模式（必须在单个 * 之前处理）
    regexPattern = regexPattern.replace(/\*\*/g, '§DOUBLESTAR§');
    
    // 处理单个 * 匹配单个路径段中的任意字符（不包括路径分隔符）
    regexPattern = regexPattern.replace(/\*/g, '[^/]*');
    
    // 恢复 ** 为匹配任意路径（包括跨目录）
    regexPattern = regexPattern.replace(/§DOUBLESTAR§/g, '.*');
    
    // 处理 ? 匹配单个字符
    regexPattern = regexPattern.replace(/\?/g, '.');
    
    // 特殊处理：如果模式以 **/ 开头，允许匹配根目录
    if (pattern.startsWith('**/')) {
      regexPattern = regexPattern.replace(/^\.\*\//, '(.*\/|^)');
    }
    
    // 特殊处理：/**/* 模式应该匹配目录下的任何文件
    regexPattern = regexPattern.replace(/\/\.\*\/\[.*?\]\*$/, '(/.*)?');
    
    return new RegExp(`^${regexPattern}$`).test(filePath);
  }

  // 检查是否为正则表达式模式
  isRegexPattern(pattern) {
    // 以/开头和结尾的正则表达式格式（优先检查）
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      return true;
    }
    
    // 检查是否包含典型的glob模式（双星号或单独的星号用于路径匹配）
    const globPatterns = /\*\*\/|\*\*$|\/\*\*|^\*\*|\/\*\.|\*\.[a-zA-Z]+$/;
    
    // 如果包含明显的glob模式，则不是正则表达式
    if (globPatterns.test(pattern)) {
      return false;
    }
    
    // 检查是否看起来像普通的文件路径（包含路径分隔符和文件扩展名）
    if (/^[^()[\]{}^$+|\\*?]+\.[a-zA-Z0-9]+$/.test(pattern) || 
        /^[^()[\]{}^$+|\\*?]*\/[^()[\]{}^$+|\\*?]*\.[a-zA-Z0-9]+$/.test(pattern)) {
      return false;
    }
    
    // 包含正则特殊字符的字符串（排除普通的点号）
    const regexChars = /[()[\]{}^$+|\\*?]/;
    
    // 如果包含正则表达式特殊字符，则认为是正则表达式
    return regexChars.test(pattern);
  }

  // 从模式字符串创建正则表达式
  createRegexFromPattern(pattern) {
    // 如果是/pattern/flags格式
    if (pattern.startsWith('/') && pattern.length > 1) {
      const lastSlash = pattern.lastIndexOf('/');
      if (lastSlash > 0) {
        const regexBody = pattern.slice(1, lastSlash);
        const flags = pattern.slice(lastSlash + 1);
        return new RegExp(regexBody, flags);
      }
    }
    
    // 否则直接作为正则表达式字符串
    // 注意：pattern已经是从JSON解析后的字符串，不需要额外的转义处理
    return new RegExp(pattern);
  }

  shouldUseAI(filePath, content) {
    if (!this.config.ai?.enabled) return false;
    
    // 检查文件大小限制
    if (content.length > (this.config.ai?.maxFileSizeKB || DEFAULT_CONFIG.MAX_FILE_SIZE_KB) * 1024) {
      logger.info(`跳过AI分析大文件: ${filePath}`);
      return false;
    }

    // 检查文件类型
    const ext = path.extname(filePath).toLowerCase();
    const enabledFor = this.config.ai?.enabledFor || [];
    return enabledFor.includes(ext);
  }

  // 计算注释范围（基于文件扩展名的简单规则）
  computeCommentRanges(content, ext) {
    const ranges = [];
    const pushRange = (start, end) => {
      if (start >= 0 && end > start) ranges.push({ start, end });
    };

    const addByRegex = (regex) => {
      let m;
      while ((m = regex.exec(content)) !== null) {
        pushRange(m.index, m.index + m[0].length);
      }
    };

    const jsLike = ['.js','.jsx','.ts','.tsx','.java','.go','.c','.cpp','.h','.rs','.php'];
    if (jsLike.includes(ext)) {
      addByRegex(/\/\/.*|\/\*[\s\S]*?\*\//g);
    } else if (ext === '.py' || ext === '.rb') {
      addByRegex(/(^|\s)#.*$/gm);
    } else if (ext === '.html' || ext === '.svelte') {
      addByRegex(/<!--[\s\S]*?-->/g);
    } else if (ext === '.css' || ext === '.scss' || ext === '.less') {
      addByRegex(/\/\*[\s\S]*?\*\//g);
    } else {
      // 通用：尝试移除常见注释模式
      addByRegex(/\/\/.*|\/\*[\s\S]*?\*\//g);
      addByRegex(/(^|\s)#.*$/gm);
      addByRegex(/<!--[\s\S]*?-->/g);
    }

    return ranges;
  }

  isIndexInRanges(index, ranges) {
    return ranges.some(r => index >= r.start && index < r.end);
  }

  // 计算代码禁用范围（按行/按段），基于固定注释令牌
  computeDisableRanges(content, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const ranges = this.computeCommentRanges(content, ext);
    const nextToken = 'review-disable-next-line';
    const startToken = 'review-disable-start';
    const endToken = 'review-disable-end';

    // 每行起始偏移
    const lineOffsets = [];
    const lines = content.split('\n');
    let offset = 0;
    for (const ln of lines) { lineOffsets.push(offset); offset += ln.length + 1; }

    const suppressRanges = [];
    let pendingBlockStart = null;

    for (const r of ranges) {
      const lower = content.slice(r.start, r.end).toLowerCase();
      // 下一行禁用
      if (lower.includes(nextToken)) {
        const lineIdx = content.substring(0, r.start).split('\n').length - 1;
        const nextStart = lineOffsets[lineIdx + 1];
        const nextEnd = lineOffsets[lineIdx + 2] ?? content.length;
        if (Number.isFinite(nextStart)) suppressRanges.push({ start: nextStart, end: nextEnd });
        continue;
      }
      // 段落开始
      if (lower.includes(startToken)) {
        const lineIdx = content.substring(0, r.start).split('\n').length - 1;
        const nextStart = lineOffsets[lineIdx + 1];
        if (Number.isFinite(nextStart)) pendingBlockStart = nextStart;
        continue;
      }
      // 段落结束
      if (lower.includes(endToken)) {
        const lineIdx = content.substring(0, r.start).split('\n').length - 1;
        const endStart = lineOffsets[lineIdx]; // 结束注释所在行的起始位置
        if (Number.isFinite(pendingBlockStart)) {
          const startPos = pendingBlockStart;
          const endPos = Number.isFinite(endStart) ? endStart : content.length;
          if (startPos < endPos) suppressRanges.push({ start: startPos, end: endPos });
        }
        pendingBlockStart = null;
        continue;
      }
    }

    // 若存在起始但没有结束，禁用到文件末尾
    if (Number.isFinite(pendingBlockStart)) {
      suppressRanges.push({ start: pendingBlockStart, end: content.length });
    }

    return { suppressRanges };
  }

  stripComments(content, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const ranges = this.computeCommentRanges(content, ext);
    if (ranges.length === 0) return content;
    // 按范围从后向前移除，避免索引偏移
    let result = content;
    ranges.sort((a,b) => b.start - a.start).forEach(r => {
      result = result.slice(0, r.start) + result.slice(r.end);
    });
    return result;
  }

  generateResult() {
    // 合并与去重策略：按 file+snippet 归并，同一代码片段仅保留一条
    // 选择规则：保留风险等级更高的；若 AI 与本地风险一致，保留本地规则项
    const riskWeight = { critical: 5, high: 4, medium: 3, low: 2, suggestion: 1 };
    const pickByKey = new Map();

    for (const issue of this.issues) {
      const snippetPart = String(issue.snippet || '').trim().slice(0, 200);
      let keyPart = snippetPart;
      if (!keyPart) {
        const msg = String(issue.message || '').trim().replace(/\s+/g, ' ');
        const src = String(issue.source || 'unknown');
        const rid = issue.ruleId ? String(issue.ruleId) : '';
        const msgPart = msg.slice(0, 80);
        keyPart = [src, rid, msgPart].filter(Boolean).join(':');
      }
      const key = `${issue.file}::${keyPart}`;
      const current = pickByKey.get(key);
      if (!current) {
        pickByKey.set(key, issue);
        continue;
      }

      const currWeight = riskWeight[current.risk] || 0;
      const nextWeight = riskWeight[issue.risk] || 0;

      if (nextWeight > currWeight) {
        pickByKey.set(key, issue);
      } else if (nextWeight === currWeight) {
        // 风险一致：优先保留本地规则（static）
        if (issue.source === 'static' && current.source !== 'static') {
          pickByKey.set(key, issue);
        }
        // 同源或都为 static：保留现有，避免抖动
      }
    }

    let deduped = Array.from(pickByKey.values());

    const blockingLevels = Object.entries(this.config.riskLevels || {})
      .filter(([_, config]) => config.block)
      .map(([level]) => level);

    // 如果启用了suppressLowLevelOutput，过滤掉非阻断等级的问题
    if (this.config.suppressLowLevelOutput) {
      deduped = deduped.filter(issue => blockingLevels.includes(issue.risk));
    }

    const hasBlockingIssues = deduped.some(issue => blockingLevels.includes(issue.risk));

    return {
      issues: deduped,
      blockSubmission: hasBlockingIssues,
      aiRan: !!this.aiRan,
      summary: {
        total: deduped.length,
        blocking: deduped.filter(issue => blockingLevels.includes(issue.risk)).length
      }
    };
  }

  getCachedExtension(filePath) {
    if (this.extensionCache.has(filePath)) {
      return this.extensionCache.get(filePath);
    }
    
    const ext = path.extname(filePath).toLowerCase();
    this.extensionCache.set(filePath, ext);
    return ext;
  }

  getCachedRegex(pattern, flags) {
    const cacheKey = `${pattern}::${flags}`;
    
    if (this.regexCache.has(cacheKey)) {
      this.cacheStats.regexHits++;
      return this.regexCache.get(cacheKey);
    }
    
    this.cacheStats.regexMisses++;
    const regex = new RegExp(pattern, flags);
    this.regexCache.set(cacheKey, regex);
    
    // 限制缓存大小，避免内存泄漏
    if (this.regexCache.size > BATCH_CONSTANTS.MAX_REGEX_CACHE_SIZE) {
      const firstKey = this.regexCache.keys().next().value;
      this.regexCache.delete(firstKey);
    }
    
    return regex;
  }

  getCachedCommentRanges(content, ext) {
    const cacheKey = `${ext}::${content.length}::${content.substring(0, BATCH_CONSTANTS.CACHE_KEY_PREFIX_LENGTH)}`;
    
    if (this.commentRangeCache.has(cacheKey)) {
      this.cacheStats.commentRangeHits++;
      return this.commentRangeCache.get(cacheKey);
    }
    
    this.cacheStats.commentRangeMisses++;
    const ranges = this.computeCommentRanges(content, ext);
    this.commentRangeCache.set(cacheKey, ranges);
    
    // 限制缓存大小
    if (this.commentRangeCache.size > BATCH_CONSTANTS.MAX_COMMENT_RANGE_CACHE_SIZE) {
      const firstKey = this.commentRangeCache.keys().next().value;
      this.commentRangeCache.delete(firstKey);
    }
    
    return ranges;
  }

  getCachedDisableRanges(content, filePath) {
    const cacheKey = `${filePath}::${content.length}::${content.substring(0, BATCH_CONSTANTS.CACHE_KEY_PREFIX_LENGTH)}`;
    
    if (this.disableRangeCache.has(cacheKey)) {
      this.cacheStats.disableRangeHits++;
      return this.disableRangeCache.get(cacheKey);
    }
    
    this.cacheStats.disableRangeMisses++;
    const ranges = this.computeDisableRanges(content, filePath);
    this.disableRangeCache.set(cacheKey, ranges);
    
    // 限制缓存大小
    if (this.disableRangeCache.size > BATCH_CONSTANTS.MAX_DISABLE_RANGE_CACHE_SIZE) {
      const firstKey = this.disableRangeCache.keys().next().value;
      this.disableRangeCache.delete(firstKey);
    }
    
    return ranges;
  }

  getCacheStats() {
    const totalRegex = this.cacheStats.regexHits + this.cacheStats.regexMisses;
    const totalCommentRange = this.cacheStats.commentRangeHits + this.cacheStats.commentRangeMisses;
    const totalDisableRange = this.cacheStats.disableRangeHits + this.cacheStats.disableRangeMisses;
    
    return {
      regex: {
        hits: this.cacheStats.regexHits,
        misses: this.cacheStats.regexMisses,
        hitRate: totalRegex > 0 ? (this.cacheStats.regexHits / totalRegex * 100).toFixed(2) + '%' : '0%',
        cacheSize: this.regexCache.size
      },
      commentRange: {
        hits: this.cacheStats.commentRangeHits,
        misses: this.cacheStats.commentRangeMisses,
        hitRate: totalCommentRange > 0 ? (this.cacheStats.commentRangeHits / totalCommentRange * 100).toFixed(2) + '%' : '0%',
        cacheSize: this.commentRangeCache.size
      },
      disableRange: {
        hits: this.cacheStats.disableRangeHits,
        misses: this.cacheStats.disableRangeMisses,
        hitRate: totalDisableRange > 0 ? (this.cacheStats.disableRangeHits / totalDisableRange * 100).toFixed(2) + '%' : '0%',
        cacheSize: this.disableRangeCache.size
      },
      extension: {
        cacheSize: this.extensionCache.size
      }
    };
  }
}
