/**
 * 分段分析器 - 针对大文件进行智能分段分析
 * 实现每段独立分析，带上下文重叠，支持摘要传递
 */

import { stripCommentsForAI, stripNoReviewForAI } from './utils/strip.js';
import { logger } from './utils/logger.js';
import { SEGMENTATION_CONSTANTS, AI_CONSTANTS } from './utils/constants.js';

export class SegmentedAnalyzer {
  constructor(config = {}) {
    this.config = {
      // 每段最大行数
      maxLinesPerSegment: config.maxLinesPerSegment || SEGMENTATION_CONSTANTS.DEFAULT_MAX_LINES_PER_SEGMENT,
      // 上下文重叠行数
      contextOverlapLines: config.contextOverlapLines || SEGMENTATION_CONSTANTS.DEFAULT_CONTEXT_OVERLAP_LINES,
      // 每段最大Token数
      maxTokensPerSegment: config.maxTokensPerSegment || SEGMENTATION_CONSTANTS.DEFAULT_MAX_TOKENS_PER_SEGMENT,
      // Token估算比例（字符数/Token数）
      tokenRatio: config.tokenRatio || SEGMENTATION_CONSTANTS.DEFAULT_TOKEN_RATIO,
      // 是否启用摘要传递
      enableSummaryContext: config.enableSummaryContext !== false,
      // 摘要最大长度
      maxSummaryLength: config.maxSummaryLength || SEGMENTATION_CONSTANTS.DEFAULT_MAX_SUMMARY_LENGTH,
      ...config
    };
  }

  /**
   * 分段分析文件
   * @param {string} filePath - 文件路径
   * @param {string} content - 文件内容
   * @param {Object} aiClient - AI客户端
   * @param {string} customPrompt - 自定义提示词
   * @param {Array} staticIssues - 静态分析问题
   * @returns {Object} 分析结果
   */
  async analyzeFileSegmented(filePath, content, aiClient, customPrompt = '', staticIssues = []) {
    try {
      logger.progress(`开始分段分析文件: ${filePath}`);
      
      // 第一步：智能分段
      const segments = this.createIntelligentSegments(content, filePath);
      logger.info(`文件分为 ${segments.length} 段`);
      
      const allIssues = [];
      const segmentSummaries = []; // 存储每段的摘要
      let previousContext = ''; // 前面段落的上下文摘要
      
      // 第二步：逐段分析
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        logger.info(`开始分析第 ${i + 1}/${segments.length} 段 (行 ${segment.startLine}-${segment.endLine})`);
        logger.info(` 预估${segment.tokens} tokens, 共${segment.endLine - segment.startLine + 1} 行代码`);
        
        try {
          // 分析当前段
          const segmentResult = await this.analyzeSegment(
            segment, 
            filePath, 
            aiClient, 
            customPrompt,
            staticIssues,
            previousContext,
            i + 1,
            segments.length
          );
          
          // 收集问题
          if (segmentResult.issues && segmentResult.issues.length > 0) {
            allIssues.push(...segmentResult.issues);
            logger.success(`第 ${i + 1} 段分析完成，发现 ${segmentResult.issues.length} 个问题`);
          } else {
            logger.success(`第 ${i + 1} 段分析完成，未发现问题`);
          }
          
          // 收集摘要（如果启用）
          if (this.config.enableSummaryContext && segmentResult.summary) {
            segmentSummaries.push({
              segmentIndex: i + 1,
              summary: segmentResult.summary,
              lineRange: `${segment.startLine}-${segment.endLine}`
            });
            
            // 更新上下文（保留最近几段的摘要）
            const recentSummaries = segmentSummaries.slice(-3); // 保留最近3段摘要
            previousContext = recentSummaries.map(s => 
              `第${s.segmentIndex}段(行${s.lineRange}): ${s.summary}`
            ).join('\n');
          }
          
        } catch (error) {
          logger.error(`第 ${i + 1} 段分析失败: ${error.message}`);
          // 继续分析下一段，不中断整个流程
        }
      }
      
      return {
        issues: allIssues,
        metadata: {
          totalSegments: segments.length,
          successfulSegments: segments.length, // 简化处理，实际可以统计成功的段数
          summaries: segmentSummaries,
          filePath: filePath
        }
      };
      
    } catch (error) {
      logger.error(`分段分析失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 创建智能分段
   * @param {string} content - 文件内容
   * @param {string} filePath - 文件路径
   * @returns {Array} 分段数组
   */
  createIntelligentSegments(content, filePath) {
    const lines = content.split('\n');
    const segments = [];
    
    let currentSegmentStart = 0;
    let currentSegmentLines = [];
    let currentTokens = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineTokens = this.estimateTokens(line);
      
      // 检查是否需要结束当前段
      const shouldEndSegment = (
        currentSegmentLines.length >= this.config.maxLinesPerSegment ||
        currentTokens + lineTokens > this.config.maxTokensPerSegment
      ) && currentSegmentLines.length > 0;
      
      if (shouldEndSegment) {
        // 创建当前段
        const segment = this.createSegmentWithContext(
          lines,
          currentSegmentStart,
          currentSegmentStart + currentSegmentLines.length - 1,
          segments.length,
          segments.length === 0 // 是否为第一段
        );
        segments.push(segment);
        
        // 开始新段，考虑重叠
        const overlapStart = Math.max(0, currentSegmentStart + currentSegmentLines.length - this.config.contextOverlapLines);
        currentSegmentStart = overlapStart;
        currentSegmentLines = lines.slice(overlapStart, i + 1);
        currentTokens = this.estimateTokens(currentSegmentLines.join('\n'));
      } else {
        // 继续当前段
        currentSegmentLines.push(line);
        currentTokens += lineTokens;
      }
    }
    
    // 处理最后一段
    if (currentSegmentLines.length > 0) {
      const segment = this.createSegmentWithContext(
        lines,
        currentSegmentStart,
        lines.length - 1,
        segments.length,
        segments.length === 0 // 是否为第一段
      );
      segments.push(segment);
    }
    
    return segments;
  }

  /**
   * 创建带上下文的分段
   * @param {Array} allLines - 所有行
   * @param {number} startLine - 起始行号（0基）
   * @param {number} endLine - 结束行号（0基）
   * @param {number} segmentIndex - 分段索引
   * @param {boolean} isFirstSegment - 是否为第一段
   * @returns {Object} 分段对象
   */
  createSegmentWithContext(allLines, startLine, endLine, segmentIndex, isFirstSegment) {
    const contextLines = this.config.contextOverlapLines;
    
    // 第一段不需要前置上下文
    const actualStartLine = isFirstSegment ? startLine : Math.max(0, startLine - contextLines);
    const actualEndLine = Math.min(allLines.length - 1, endLine + contextLines);
    
    const segmentLines = allLines.slice(actualStartLine, actualEndLine + 1);
    const content = segmentLines.join('\n');
    
    // 计算上下文信息
    const contextInfo = {
      hasPreContext: !isFirstSegment && actualStartLine < startLine,
      hasPostContext: actualEndLine > endLine,
      preContextLines: !isFirstSegment ? Math.min(contextLines, startLine - actualStartLine) : 0,
      postContextLines: Math.min(contextLines, actualEndLine - endLine)
    };
    
    return {
      index: segmentIndex,
      startLine: startLine + 1, // 转为1基行号
      endLine: endLine + 1,     // 转为1基行号
      actualStartLine: actualStartLine + 1, // 包含上下文的实际起始行
      actualEndLine: actualEndLine + 1,     // 包含上下文的实际结束行
      content: content,
      tokens: this.estimateTokens(content),
      contextInfo: contextInfo,
      isFirstSegment: isFirstSegment
    };
  }

  /**
   * 分析单个分段
   * @param {Object} segment - 分段对象
   * @param {string} filePath - 文件路径
   * @param {Object} aiClient - AI客户端
   * @param {string} customPrompt - 自定义提示词
   * @param {Array} staticIssues - 静态问题
   * @param {string} previousContext - 前面段落的上下文
   * @param {number} currentSegmentNum - 当前段号
   * @param {number} totalSegments - 总段数
   * @returns {Object} 分析结果
   */
  async analyzeSegment(segment, filePath, aiClient, customPrompt, staticIssues, previousContext, currentSegmentNum, totalSegments) {
    try {
      logger.debug(` 准备第 ${currentSegmentNum} 段代码内容...`);
      
      // 准备代码内容
      const prepared = await stripNoReviewForAI(segment.content, filePath);
      const clean = await stripCommentsForAI(prepared, filePath);
      
      logger.debug(` 构建第 ${currentSegmentNum} 段分析提示词...`);
      
      // 构建分段分析提示词
      const segmentPrompt = this.buildSegmentPrompt(
        segment, 
        filePath, 
        clean, 
        customPrompt, 
        staticIssues, 
        previousContext,
        currentSegmentNum,
        totalSegments
      );
      
      
      
      // 调用AI分析
      const response = await aiClient.chatWithRetry({
        model: aiClient.config.model ?? 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: this.getSegmentSystemPrompt() },
          { role: 'user', content: segmentPrompt }
        ],
        temperature: aiClient.config.temperature !== undefined ? aiClient.config.temperature : 0.1,
        max_tokens: aiClient.config.maxResponseTokens ?? AI_CONSTANTS.DEFAULT_MAX_RESPONSE_TOKENS
      });
      
      
      
      const responseContent = response.choices[0].message.content;
      
      // 解析AI响应
      const result = this.parseSegmentResponse(responseContent, filePath, segment);
      
      logger.info(` 第 ${currentSegmentNum} 段响应解析完成，发现 ${result.issues ? result.issues.length : 0} 个问题`);
      
      return result;
      
    } catch (error) {
      logger.error(`第 ${currentSegmentNum} 段分析失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 构建分段分析提示词
   */
  buildSegmentPrompt(segment, filePath, cleanContent, customPrompt, staticIssues, previousContext, currentSegmentNum, totalSegments) {
    let prompt = `我正在对一个大文件进行分段代码审查。以下是第 ${currentSegmentNum}/${totalSegments} 段的内容：

**文件路径**: ${filePath}
**当前分段**: 第 ${currentSegmentNum}/${totalSegments} 段
**代码行范围**: ${segment.startLine}-${segment.endLine}`;

    // 添加上下文说明
    if (segment.contextInfo.hasPreContext || segment.contextInfo.hasPostContext) {
      prompt += `\n**上下文说明**: `;
      if (segment.contextInfo.hasPreContext) {
        prompt += `前 ${segment.contextInfo.preContextLines} 行为上文上下文`;
      }
      if (segment.contextInfo.hasPostContext) {
        if (segment.contextInfo.hasPreContext) prompt += `，`;
        prompt += `后 ${segment.contextInfo.postContextLines} 行为下文上下文`;
      }
      prompt += `，这些上下文行仅用于帮助理解代码逻辑，请避免对重叠部分重复报告问题。`;
    }

    // 添加前面段落的摘要上下文
    if (previousContext && this.config.enableSummaryContext) {
      prompt += `\n\n**前面段落摘要**:\n${previousContext}`;
    }

    // 添加代码内容
    prompt += `\n\n**代码内容**:\n\`\`\`\n${cleanContent}\n\`\`\``;

    // 添加静态问题提示
    if (staticIssues && staticIssues.length > 0) {
      const relevantStaticIssues = staticIssues.filter(issue => {
        // 简单的行号匹配，实际可以更精确
        return issue.line >= segment.startLine && issue.line <= segment.endLine;
      });
      
      if (relevantStaticIssues.length > 0) {
        prompt += `\n\n**本段相关的静态检测问题**:\n`;
        relevantStaticIssues.forEach((issue, idx) => {
          prompt += `${idx + 1}. 第${issue.line}行 (${issue.risk}): ${issue.message}\n`;
        });
      }
    }

    // 添加自定义提示词
    if (customPrompt) {
      prompt += `\n\n**自定义审查要求**:\n${customPrompt}`;
    }

    // 添加分段分析要求
    prompt += `\n\n**分段分析要求**:
1. 请仅分析当前分段的代码，不要分析上下文行中的问题
2. 如果启用摘要功能，请在分析结果后提供一个简短的代码摘要
3. 严格按照指定格式返回结果
4. 对于跨段的问题，请在当前段中标注，后续段会参考前面的摘要进行综合判断
5. 分段上下文限制：不要评估“导入是否被使用”，严格忽略关于“未使用的导入/模块/依赖”的任何提示或建议（包括建议删除未使用的导入）`;

    return prompt;
  }

  /**
   * 获取分段分析的系统提示词
   */
  getSegmentSystemPrompt() {
    let systemPrompt = `你是一个专业的代码审查专家，正在对大文件进行分段分析。

**分段分析特点**:
- 你收到的是文件的一个片段，可能包含上下文行
- 上下文行仅用于理解代码逻辑，不应对其报告问题
- 需要考虑代码的连续性和上下文关系
- 避免对重叠部分重复报告问题

**输出格式要求**:
请严格按照以下格式返回分析结果：

**-----代码分析结果-----**
文件路径：{文件路径}
代码片段：{具体的问题代码片段}
风险等级：{致命/高危/中危/低危/建议}
风险原因：{详细原因}
修改建议：{具体建议}

[如果有多个问题，用空行分隔]`;

    // 如果启用摘要功能，添加摘要要求
    if (this.config.enableSummaryContext) {
      systemPrompt += `

**摘要要求**:
在所有问题分析完成后，请提供一个简短摘要：

**-----段落摘要-----**
{简要描述这段代码的主要功能、关键逻辑和重要特征，控制在${this.config.maxSummaryLength}字符以内}`;
    }

    systemPrompt += `

**风险等级定义**:
- 致命：可能导致系统崩溃、数据丢失、严重安全漏洞
- 高危：可能导致安全漏洞、数据泄露、业务逻辑错误  
- 中危：可能影响系统稳定性、性能问题、用户体验
- 低危：代码质量问题、不符合最佳实践
- 建议：改进建议，提升代码质量`;

    systemPrompt += `

**分段场景的忽略规则（必须遵守）**:
- 由于其它段可能引用当前段的导入，请不要评估或报告“未使用的导入/模块/依赖”相关问题；即使当前片段内未见引用，也不要建议移除该导入。
- 仅在本段内可以明确识别的实际错误或风险时再输出问题。`;

    return systemPrompt;
  }

  /**
   * 解析分段响应
   */
  parseSegmentResponse(responseContent, filePath, segment) {
    const issues = [];
    let summary = '';
    
    try {
      // 分离问题分析和摘要
      const parts = responseContent.split('**-----段落摘要-----**');
      const analysisContent = parts[0];
      const summaryContent = parts[1];
      
      // 解析问题
      if (analysisContent.includes('**-----代码分析结果-----**')) {
        const problemSections = analysisContent.split('**-----代码分析结果-----**').slice(1);
        
        for (const section of problemSections) {
          const issue = this.parseIssueSection(section.trim(), filePath, segment);
          if (issue) {
            issues.push(issue);
          }
        }
      }
      
      // 解析摘要
      if (summaryContent && this.config.enableSummaryContext) {
        summary = summaryContent.trim().substring(0, this.config.maxSummaryLength);
      }
      
    } catch (error) {
      logger.warn(`解析AI响应失败: ${error.message}`);
    }
    
    return {
      issues: issues,
      summary: summary
    };
  }

  /**
   * 解析单个问题段落
   */
  parseIssueSection(section, filePath, segment) {
    try {
      const lines = section.split('\n').filter(line => line.trim());
      
      let issue = {
        file: filePath,
        source: 'ai',
        segment: segment.index + 1,
        segmentRange: `${segment.startLine}-${segment.endLine}`
      };
      
      for (const line of lines) {
        if (line.startsWith('文件路径：')) {
          // 文件路径已知，跳过
        } else if (line.startsWith('代码片段：')) {
          issue.snippet = line.substring('代码片段：'.length).trim();
        } else if (line.startsWith('风险等级：')) {
          issue.risk = line.substring('风险等级：'.length).trim();
        } else if (line.startsWith('风险原因：')) {
          issue.message = line.substring('风险原因：'.length).trim();
        } else if (line.startsWith('修改建议：')) {
          issue.suggestion = line.substring('修改建议：'.length).trim();
        }
      }
      
      // 验证必要字段
      if (issue.risk && issue.message) {
        return issue;
      }
      
    } catch (error) {
      logger.warn(`解析问题段落失败: ${error.message}`);
    }
    
    return null;
  }

  /**
   * 估算文本的Token数量
   */
  estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    
    const charCount = text.length;
    const chineseCharCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishCharCount = charCount - chineseCharCount;
    
    // 中文字符按1.5倍计算
    const adjustedCharCount = englishCharCount + (chineseCharCount * 1.5);
    
    return Math.ceil(adjustedCharCount / this.config.tokenRatio);
  }
}