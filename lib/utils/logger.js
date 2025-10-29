/**
 * 简单的日志工具
 * 区分用户信息输出和调试信息
 */

export class Logger {
  constructor(options = {}) {
    this.debugMode = options.debug || process.env.DEBUG_SMART_REVIEW === 'true';
    this.silent = options.silent || false;
  }

  /**
   * 用户信息输出 - 总是显示
   */
  info(message, ...args) {
    if (!this.silent) {
      console.log(message, ...args);
    }
  }

  /**
   * 成功信息
   */
  success(message, ...args) {
    if (!this.silent) {
      console.log(`✅ ${message}`, ...args);
    }
  }

  /**
   * 警告信息
   */
  warn(message, ...args) {
    if (!this.silent) {
      console.log(`⚠️  ${message}`, ...args);
    }
  }

  /**
   * 错误信息
   */
  error(message, ...args) {
    console.error(`❌ ${message}`, ...args);
  }

  /**
   * 调试信息 - 只在调试模式下显示
   */
  debug(message, ...args) {
    if (this.debugMode) {
      console.log(`🔍 [DEBUG] ${message}`, ...args);
    }
  }

  /**
   * 进度信息
   */
  progress(message, ...args) {
    if (!this.silent) {
      console.log(`🔄 ${message}`, ...args);
    }
  }
}

// 默认实例
export const logger = new Logger();