/**
 * 简单的日志工具
 * 区分用户信息输出和调试信息
 */

export class Logger {
  constructor(options = {}) {
    this.debugMode = options.debug || process.env.DEBUG_SMART_REVIEW === 'true';
    this.silent = options.silent || false;
  }

  writeLine(message, ...args) {
    if (args.length > 0) {
      console.log(message, ...args);
      return;
    }
    const text = String(message ?? '');
    if (process.stdout && typeof process.stdout.write === 'function') {
      process.stdout.write(`${text}\n`);
      return;
    }
    console.log(text);
  }

  info(message, ...args) {
    if (!this.silent) {
      this.writeLine(message, ...args);
    }
  }

  /** 带自定义 emoji 的输出（工具调用等） */
  line(emoji, message, ...args) {
    if (this.silent) return;
    if (args.length > 0) {
      console.log(`${emoji} ${message}`, ...args);
      return;
    }
    this.writeLine(`${emoji} ${message}`);
  }

  /** 缩进子行（用于并行下探明细） */
  sub(message, ...args) {
    if (!this.silent) {
      if (args.length > 0) {
        console.log(`   ${message}`, ...args);
        return;
      }
      this.writeLine(`   ${message}`);
    }
  }

  success(message, ...args) {
    if (!this.silent) {
      this.writeLine(`✅ ${message}`, ...args);
    }
  }

  warn(message, ...args) {
    if (!this.silent) {
      this.writeLine(`⚠️  ${message}`, ...args);
    }
  }

  error(message, ...args) {
    console.error(`❌ ${message}`, ...args);
  }

  debug(message, ...args) {
    if (this.debugMode) {
      this.writeLine(`🔍 [DEBUG] ${message}`, ...args);
    }
  }

  progress(message, ...args) {
    if (!this.silent) {
      this.writeLine(`🔄 ${message}`, ...args);
    }
  }
}

// 默认实例
export const logger = new Logger();