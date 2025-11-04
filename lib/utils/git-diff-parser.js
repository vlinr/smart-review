import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { logger } from './logger.js';
import { stripCommentsForAI, stripNoReviewForAI } from './strip.js';

const execAsync = promisify(exec);

/**
 * Git Diff 解析器
 * 用于解析git diff输出，提取新增代码片段，并构建带上下文的审查内容
 */
export class GitDiffParser {
  constructor(projectRoot, contextMergeLines = 10, config = {}) {
    this.projectRoot = projectRoot;
    this.contextMergeLines = contextMergeLines;
    this.config = config;
  }

  /**
   * 获取暂存区的git diff内容
   * @returns {Promise<string>} git diff输出
   */
  async getStagedDiff() {
    try {
      const { stdout } = await execAsync('git diff --cached -U10', {
        cwd: this.projectRoot,
        maxBuffer: 50 * 1024 * 1024 // 50MB buffer
      });
      return stdout;
    } catch (error) {
      logger.error('获取git diff失败:', error);
      return '';
    }
  }

  /**
   * 解析git diff输出，提取文件变更信息
   * @param {string} diffOutput git diff的输出内容
   * @returns {Array} 文件变更信息数组
   */
  parseDiffOutput(diffOutput) {
    if (!diffOutput.trim()) {
      return [];
    }

    const files = [];
    const fileBlocks = diffOutput.split(/^diff --git /m).filter(block => block.trim());

    for (const block of fileBlocks) {
      const fileInfo = this.parseFileBlock(block);
      if (fileInfo) {
        files.push(fileInfo);
      }
    }

    return files;
  }

  /**
   * 解析单个文件的diff块
   * @param {string} block 单个文件的diff内容
   * @returns {Object|null} 文件变更信息
   */
  parseFileBlock(block) {
    const lines = block.split('\n');
    
    // 解析文件路径
    const firstLine = lines[0];
    const pathMatch = firstLine.match(/^a\/(.+) b\/(.+)$/);
    if (!pathMatch) {
      return null;
    }

    const filePath = pathMatch[2]; // 使用新文件路径
    
    // 检查是否为删除文件
    const isDeleted = lines.some(line => line.startsWith('deleted file mode'));
    if (isDeleted) {
      return null; // 跳过删除的文件
    }

    // 检查文件是否应该被忽略
    if (!this.isReviewableFile(filePath)) {
      logger.debug(`文件被忽略规则跳过: ${filePath}`);
      return null;
    }

    // 解析hunks（代码块）
    const hunks = this.parseHunks(lines);
    if (hunks.length === 0) {
      return null;
    }

    return {
      filePath,
      hunks,
      hasChanges: hunks.some(hunk => hunk.addedLines.length > 0)
    };
  }

  /**
   * 解析diff hunks（代码变更块）
   * @param {Array} lines diff文件的所有行
   * @returns {Array} hunks数组
   */
  parseHunks(lines) {
    const hunks = [];
    let currentHunk = null;
    let lineIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 检测hunk头部 (@@开头)
      if (line.startsWith('@@')) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }

        const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch) {
          currentHunk = {
            oldStart: parseInt(hunkMatch[1]),
            oldCount: parseInt(hunkMatch[2] || '1'),
            newStart: parseInt(hunkMatch[3]),
            newCount: parseInt(hunkMatch[4] || '1'),
            lines: [],
            addedLines: [],
            contextLines: []
          };
          lineIndex = currentHunk.newStart;
        }
        continue;
      }

      // 处理hunk内容
      if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        const lineType = line[0];
        const content = line.substring(1);

        currentHunk.lines.push({
          type: lineType,
          content,
          lineNumber: lineType === '-' ? null : lineIndex
        });

        if (lineType === '+') {
          // 新增行
          currentHunk.addedLines.push({
            content,
            lineNumber: lineIndex
          });
          lineIndex++;
        } else if (lineType === ' ') {
          // 上下文行
          currentHunk.contextLines.push({
            content,
            lineNumber: lineIndex
          });
          lineIndex++;
        }
        // 删除行(-) 不增加行号
      }
    }

    // 添加最后一个hunk
    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return hunks;
  }

  /**
   * 构建审查内容
   * @param {Object} fileInfo 文件变更信息
   * @returns {Promise<Object>} 构建的审查内容
   */
  async buildReviewContent(fileInfo) {
    if (!fileInfo.hasChanges) {
      return null;
    }

    const reviewSections = [];
    
    for (const hunk of fileInfo.hunks) {
      if (hunk.addedLines.length === 0) {
        continue; // 跳过没有新增内容的hunk
      }

      const section = await this.buildHunkReviewSection(hunk, fileInfo.filePath);
      if (section) {
        reviewSections.push(section);
      }
    }

    if (reviewSections.length === 0) {
      return null;
    }

    // 应用智能分段策略
    const smartSegments = this.applySmartSegmentation(reviewSections, fileInfo.filePath);

    return {
      filePath: fileInfo.filePath,
      segments: smartSegments,
      totalAddedLines: fileInfo.hunks.reduce((sum, hunk) => sum + hunk.addedLines.length, 0)
    };
  }

  /**
   * 智能分段策略 - 根据token限制和上下文长度进行合理分段
   * @param {Array} sections 原始代码段
   * @param {string} filePath 文件路径
   * @returns {Array} 智能分段后的代码段
   */
  applySmartSegmentation(sections, filePath) {
    const MAX_TOKENS_PER_SEGMENT = 3000; // 每段最大token数
    const ESTIMATED_CHARS_PER_TOKEN = 4; // 估算每个token的字符数
    const MAX_CHARS_PER_SEGMENT = MAX_TOKENS_PER_SEGMENT * ESTIMATED_CHARS_PER_TOKEN;
    
    const smartSegments = [];
    let currentSegment = null;
    let currentSize = 0;

    for (const section of sections) {
      const sectionSize = section.content.length;
      
      // 如果当前段为空，或者添加这个section会超出限制，则开始新段
      if (!currentSegment || (currentSize + sectionSize > MAX_CHARS_PER_SEGMENT)) {
        // 保存当前段（如果存在）
        if (currentSegment) {
          smartSegments.push(this.finalizeSegment(currentSegment));
        }
        
        // 开始新段
        currentSegment = {
          startLine: section.startLine,
          endLine: section.endLine,
          content: section.content,
          addedLineNumbers: [...section.addedLineNumbers],
          addedLinesCount: section.addedLinesCount,
          sections: [section]
        };
        currentSize = sectionSize;
      } else {
        // 合并到当前段
        currentSegment.endLine = section.endLine;
        currentSegment.content += '\n\n' + section.content;
        currentSegment.addedLineNumbers.push(...section.addedLineNumbers);
        currentSegment.addedLinesCount += section.addedLinesCount;
        currentSegment.sections.push(section);
        currentSize += sectionSize;
      }
    }

    // 添加最后一段
    if (currentSegment) {
      smartSegments.push(this.finalizeSegment(currentSegment));
    }

    logger.debug(`文件 ${filePath} 智能分段完成: ${sections.length} 个原始段 -> ${smartSegments.length} 个智能段`);
    return smartSegments;
  }

  /**
   * 完善分段信息
   * @param {Object} segment 分段信息
   * @returns {Object} 完善后的分段信息
   */
  finalizeSegment(segment) {
    return {
      startLine: segment.startLine,
      endLine: segment.endLine,
      content: segment.content,
      addedLineNumbers: segment.addedLineNumbers,
      addedLinesCount: segment.addedLinesCount,
      estimatedTokens: Math.ceil(segment.content.length / 4), // 估算token数
      originalSections: segment.sections.length // 原始段数
    };
  }

  /**
   * 构建单个hunk的审查内容
   * @param {Object} hunk hunk信息
   * @param {string} filePath 文件路径
   * @returns {Promise<Object|null>} 审查内容
   */
  async buildHunkReviewSection(hunk, filePath) {
    const reviewLines = [];
    const addedLineNumbers = [];

    for (const line of hunk.lines) {
      if (line.type === '+') {
        // 新增行 - 需要审查，保留+标识符
        reviewLines.push(`+${line.content}`);
        addedLineNumbers.push(line.lineNumber);
      } else if (line.type === ' ') {
        // 上下文行 - 仅供参考，保留空格标识符
        reviewLines.push(` ${line.content}`);
      }
      // 删除行(-) 完全忽略，不发送给AI
    }

    if (addedLineNumbers.length === 0) {
      return null;
    }

    // 检查代码内指令忽略
    const filteredLines = this.filterDisabledLines(reviewLines, addedLineNumbers);
    if (filteredLines.addedLineNumbers.length === 0) {
      logger.debug(`所有新增行都被代码内指令忽略: ${filePath}`);
      return null;
    }

    // 过滤review-disable内容和注释内容
    let content = filteredLines.reviewLines.join('\n');
    try {
      // 先处理review-disable指令
      content = await stripNoReviewForAI(content, filePath);
      // 再移除注释
      content = await stripCommentsForAI(content, filePath);
      
      // 额外清理：移除diff格式中的空行，确保AI不会收到不必要的空行
      content = content
        .split('\n')
        .filter(line => {
          // 保留有实际内容的行（包括+和空格前缀的行）
          const trimmed = line.trim();
          if (trimmed.length === 0) return false; // 移除完全空白的行
          if (line === '+' || line === ' ') return false; // 移除只有前缀的行
          return true;
        })
        .join('\n');
      
      // 如果过滤后内容为空或只有空白字符，返回null
      if (!content || content.trim().length === 0) {
        return null;
      }
    } catch (error) {
      logger.debug(`内容过滤失败，使用原始内容: ${error.message}`);
      // 如果过滤失败，使用原始内容
      content = filteredLines.reviewLines.join('\n');
    }

    return {
      startLine: Math.min(...filteredLines.addedLineNumbers),
      endLine: Math.max(...filteredLines.addedLineNumbers),
      content,
      addedLineNumbers: filteredLines.addedLineNumbers,
      addedLinesCount: filteredLines.addedLineNumbers.length
    };
  }

  /**
   * 获取暂存区文件的完整内容（用于上下文参考）
   * @param {string} filePath 文件路径
   * @returns {Promise<string>} 文件内容
   */
  async getStagedFileContent(filePath) {
    try {
      const { stdout } = await execAsync(`git show :"${filePath}"`, {
        cwd: this.projectRoot,
        maxBuffer: 10 * 1024 * 1024
      });
      return stdout;
    } catch (error) {
      logger.debug(`无法获取暂存区文件内容 ${filePath}:`, error.message);
      return '';
    }
  }

  /**
   * 主要方法：获取暂存区的diff审查数据
   * @returns {Promise<Array>} 审查数据数组
   */
  async getStagedDiffReviewData() {
    logger.progress('正在分析暂存区变更...');
    
    const diffOutput = await this.getStagedDiff();
    if (!diffOutput.trim()) {
      logger.info('暂存区没有代码变更需要审查');
      return [];
    }

    const files = this.parseDiffOutput(diffOutput);
    const reviewData = [];

    for (const fileInfo of files) {
      const reviewContent = await this.buildReviewContent(fileInfo);
      if (reviewContent) {
        // 获取完整文件内容作为额外上下文
        const fullContent = await this.getStagedFileContent(fileInfo.filePath);
        
        reviewData.push({
          ...reviewContent,
          fullContent, // 完整文件内容，用于更好的上下文理解
          isDiffMode: true // 标记这是diff模式
        });
      }
    }

    logger.info(`发现 ${reviewData.length} 个文件有代码变更需要审查`);
    return reviewData;
  }

  /**
   * 检查文件是否可以审查（不在忽略列表中）
   * @param {string} filePath 文件路径
   * @returns {boolean} 是否可以审查
   */
  isReviewableFile(filePath) {
    const extensions = this.config.fileExtensions || [];
    const ignoreFiles = this.config.ignoreFiles || [];

    const ext = path.extname(filePath).toLowerCase();
    const shouldInclude = extensions.includes(ext);
    
    if (!shouldInclude || ignoreFiles.length === 0) {
      return shouldInclude;
    }

    const normalized = filePath.replace(/\\/g, '/');
    const relativePath = path.relative(this.config.projectRoot || this.projectRoot, filePath).replace(/\\/g, '/');
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

  /**
   * 匹配glob模式
   * @param {string} filePath 文件路径
   * @param {string} pattern glob模式
   * @returns {boolean} 是否匹配
   */
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

  /**
   * 检查是否为正则表达式模式
   * @param {string} pattern 模式字符串
   * @returns {boolean} 是否为正则表达式
   */
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

  /**
   * 从模式字符串创建正则表达式
   * @param {string} pattern 模式字符串
   * @returns {RegExp} 正则表达式对象
   */
  createRegexFromPattern(pattern) {
    // 如果是/pattern/flags格式
    if (pattern.startsWith('/') && pattern.length > 1) {
      const lastSlashIndex = pattern.lastIndexOf('/');
      if (lastSlashIndex > 0) {
        const regexBody = pattern.slice(1, lastSlashIndex);
        const flags = pattern.slice(lastSlashIndex + 1);
        return new RegExp(regexBody, flags);
      }
    }
    
    // 否则直接作为正则表达式主体
    return new RegExp(pattern);
  }

  /**
   * 过滤被代码内指令禁用的行
   * @param {Array} reviewLines 审查行数组
   * @param {Array} addedLineNumbers 新增行号数组
   * @returns {Object} 过滤后的结果
   */
  filterDisabledLines(reviewLines, addedLineNumbers) {
    const nextToken = 'review-disable-next-line';
    const startToken = 'review-disable-start';
    const endToken = 'review-disable-end';

    const filteredReviewLines = [];
    const filteredAddedLineNumbers = [];
    
    let blockDisabled = false;
    let nextLineDisabled = false;
    let addedLineIndex = 0; // 跟踪当前处理的新增行索引

    for (let i = 0; i < reviewLines.length; i++) {
      const line = reviewLines[i];
      const lineContent = line.substring(1); // 移除+或空格前缀
      const isAddedLine = line.startsWith('+');
      
      // 检查当前行是否包含禁用指令
      const lowerContent = lineContent.toLowerCase();
      
      if (lowerContent.includes(nextToken)) {
        nextLineDisabled = true;
        // 包含禁用指令的行本身不需要被忽略，只是设置下一行忽略标志
        filteredReviewLines.push(line);
        if (isAddedLine) {
          filteredAddedLineNumbers.push(addedLineNumbers[addedLineIndex]);
          addedLineIndex++;
        }
        continue;
      }
      
      if (lowerContent.includes(startToken)) {
        blockDisabled = true;
        // 包含start指令的行本身不需要被忽略，只是设置块忽略标志
        filteredReviewLines.push(line);
        if (isAddedLine) {
          filteredAddedLineNumbers.push(addedLineNumbers[addedLineIndex]);
          addedLineIndex++;
        }
        continue;
      }
      
      if (lowerContent.includes(endToken)) {
        blockDisabled = false;
        // 包含end指令的行本身不需要被忽略，只是取消块忽略标志
        filteredReviewLines.push(line);
        if (isAddedLine) {
          filteredAddedLineNumbers.push(addedLineNumbers[addedLineIndex]);
          addedLineIndex++;
        }
        continue;
      }
      
      // 检查当前行是否应该被忽略
      const shouldSkip = nextLineDisabled || blockDisabled;
      
      if (shouldSkip && isAddedLine) {
        logger.debug(`跳过被禁用的新增行: ${lineContent.trim()}`);
        addedLineIndex++; // 跳过这个新增行，但仍需要增加索引
        nextLineDisabled = false; // 重置下一行禁用标志
        continue;
      }
      
      // 保留该行
      filteredReviewLines.push(line);
      if (isAddedLine) {
        filteredAddedLineNumbers.push(addedLineNumbers[addedLineIndex]);
        addedLineIndex++;
      }
      
      nextLineDisabled = false; // 重置下一行禁用标志
    }

    return {
      reviewLines: filteredReviewLines,
      addedLineNumbers: filteredAddedLineNumbers
    };
  }
}