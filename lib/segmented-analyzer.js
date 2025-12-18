/**
 * 分段分析器 - 针对大文件进行智能分段分析
 * 实现每段独立分析，带上下文重叠，支持摘要传递
 */

import { stripCommentsForAI, stripNoReviewForAI } from './utils/strip.js';
import { logger } from './utils/logger.js';
import { SEGMENTATION_CONSTANTS, AI_CONSTANTS } from './utils/constants.js';
import { t, getLocale, FIELD_LABELS, buildPrompts } from './utils/i18n.js';

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
      // 第一步：智能分段
      const segments = this.createIntelligentSegments(content, filePath);
      logger.progress(t(this.config, 'segment_overall_start', { file: filePath, total: segments.length, concurrency: '', totalNote: '' }));
      
      const allIssues = [];
      const segmentSummaries = []; // 存储每段的摘要
      let previousContext = ''; // 前面段落的上下文摘要
      
      // 第二步：逐段分析
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        logger.info(t(this.config, 'segment_start_label', { file: filePath, index: i + 1, total: segments.length, start: segment.startLine, end: segment.endLine }));
        logger.debug(t(this.config, 'segment_size_estimate_dbg', { tokens: segment.tokens, lines: (segment.endLine - segment.startLine + 1) }));
        
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
            logger.success(t(this.config, 'segment_analysis_done_n_issues', { batch: '', file: filePath, index: i + 1, count: segmentResult.issues.length }));
          } else {
            logger.success(t(this.config, 'segment_analysis_done_zero', { batch: '', file: filePath, index: i + 1 }));
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
            const loc = getLocale(this.config);
            previousContext = [t(this.config, 'segment_prev_context_header'),
              ...recentSummaries.map(s => t(this.config, 'segment_prev_context_item', { index: s.segmentIndex, range: s.lineRange, summary: s.summary }))
            ].join('\n');
          }
          
        } catch (error) {
          logger.error(t(this.config, 'segment_analysis_failed', { index: i + 1, error: error?.message || String(error) }));
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
      logger.error(t(this.config, 'segment_file_failed', { error: error?.message || String(error) }));
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
      logger.debug(t(this.config, 'segment_prepare_content_dbg', { index: currentSegmentNum }));
      
      // 准备代码内容
      const prepared = await stripNoReviewForAI(segment.content, filePath);
      const clean = await stripCommentsForAI(prepared, filePath);
      
      logger.debug(t(this.config, 'segment_build_prompt_dbg', { index: currentSegmentNum }));
      
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
      
      logger.info(t(this.config, 'segment_response_parsed_info', { index: currentSegmentNum, count: (result.issues ? result.issues.length : 0) }));
      
      return result;
      
    } catch (error) {
      logger.error(t(this.config, 'segment_analysis_failed', { index: currentSegmentNum, error: error?.message || String(error) }));
      throw error;
    }
  }

  /**
   * 构建分段分析提示词
   */
  buildSegmentPrompt(segment, filePath, cleanContent, customPrompt, staticIssues, previousContext, currentSegmentNum, totalSegments) {
    const loc = getLocale(this.config);
    const L = FIELD_LABELS[loc];
    let prompt = t(this.config, 'segment_prompt_template', {
      index: currentSegmentNum,
      total: totalSegments,
      Lfile: L.file,
      Lcontent: L.content,
      file: filePath,
      content: cleanContent
    });

    // 追加前面段落摘要上下文
    if (previousContext && this.config.enableSummaryContext) {
      prompt += `\n\n${previousContext}`;
    }

    // 添加静态问题提示（仅与当前段相关）
    if (staticIssues && staticIssues.length > 0) {
      const relevantStaticIssues = staticIssues.filter(issue => issue.line >= segment.startLine && issue.line <= segment.endLine);
      if (relevantStaticIssues.length > 0) {
        prompt += `\n\n${t(this.config, 'segment_static_issues_header', { index: currentSegmentNum })}\n`;
        relevantStaticIssues.forEach((issue, idx) => {
          const riskDisp = issue.risk;
          const snippetLabel = L.snippet;
          const suggest = issue.suggestion ? ` ${issue.suggestion}` : '';
          prompt += t(this.config, 'segment_static_issue_line', {
            index: idx + 1,
            risk: riskDisp,
            message: issue.message,
            suggest,
            snippetLabel,
            snippet: issue.snippet || ''
          }) + '\n';
        });
      }
    }

    // 追加自定义提示词
    if (customPrompt) {
      prompt += `\n\n${customPrompt}`;
    }

    return prompt;
  }

  /**
   * 获取分段分析的系统提示词
   */
  getSegmentSystemPrompt() {
    const { systemPrompt } = buildPrompts(this.config);
    return systemPrompt;
  }

  /**
   * 解析分段响应
   */
  parseSegmentResponse(responseContent, filePath, segment) {
    const issues = [];
    let summary = '';
    
    try {
      // 分离问题分析和摘要（支持中英文摘要标记）
      const summaryMarkerZh = t(this.config, 'segment_summary_marker');
      const summaryMarkerEn = '**-----Segment Summary-----**';
      let analysisContent = responseContent;
      let summaryContent = '';
      if (responseContent.includes(summaryMarkerZh)) {
        const parts = responseContent.split(summaryMarkerZh);
        analysisContent = parts[0];
        summaryContent = parts[1];
      } else if (responseContent.includes(summaryMarkerEn)) {
        const parts = responseContent.split(summaryMarkerEn);
        analysisContent = parts[0];
        summaryContent = parts[1];
      }
      
      // 解析问题（支持多种标记：开始/结束 或 单标记 中英文）
      const startEndMarkers = [
        { start: '**-----代码分析结果开始-----**', end: '**-----代码分析结果结束-----**' },
        { start: '**-----Code Analysis Result Start-----**', end: '**-----Code Analysis Result End-----**' },
      ];
      let parsedByStartEnd = false;
      for (const m of startEndMarkers) {
        if (analysisContent.includes(m.start) && analysisContent.includes(m.end)) {
          parsedByStartEnd = true;
          const regex = new RegExp(`${m.start}([\s\S]*?)${m.end}`, 'g');
          const matches = Array.from(analysisContent.matchAll(regex));
          for (const match of matches) {
            const section = match[1].trim();
            const issue = this.parseIssueSection(section, filePath, segment);
            if (issue) issues.push(issue);
          }
          break;
        }
      }

      if (!parsedByStartEnd) {
        const singleMarkers = ['**-----代码分析结果-----**', '**-----Code Review Result-----**'];
        for (const marker of singleMarkers) {
          if (analysisContent.includes(marker)) {
            const problemSections = analysisContent.split(marker).slice(1);
            for (const section of problemSections) {
              const issue = this.parseIssueSection(section.trim(), filePath, segment);
              if (issue) issues.push(issue);
            }
            break;
          }
        }
      }
      
      // 解析摘要
      if (summaryContent && this.config.enableSummaryContext) {
        summary = summaryContent.trim().substring(0, this.config.maxSummaryLength);
      }
      
    } catch (error) {
      logger.warn(t(this.config, 'parse_seg_response_failed_warn', { error: error?.message || String(error) }));
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
      const loc = getLocale(this.config);
      const L = FIELD_LABELS[loc];
      
      let issue = {
        file: filePath,
        source: 'ai',
        segment: segment.index + 1,
        segmentRange: `${segment.startLine}-${segment.endLine}`
      };
      
      for (const line of lines) {
        if (line.startsWith(L.file)) {
          // 文件路径已知，跳过
        } else if (line.startsWith(L.snippet)) {
          issue.snippet = line.substring(L.snippet.length).trim();
        } else if (line.startsWith(L.risk)) {
          issue.risk = line.substring(L.risk.length).trim();
        } else if (line.startsWith(L.reason)) {
          issue.message = line.substring(L.reason.length).trim();
        } else if (line.startsWith(L.suggestion)) {
          issue.suggestion = line.substring(L.suggestion.length).trim();
        }
      }
      
      // 验证必要字段
      if (issue.risk && issue.message) {
        return issue;
      }
      
    } catch (error) {
      logger.warn(t(this.config, 'parse_issue_section_failed_warn', { error: error?.message || String(error) }));
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