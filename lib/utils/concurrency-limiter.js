/**
 * 全局并发限速器：统一管理AI请求的并发占用（批次与分段共享）
 */
export class ConcurrencyLimiter {
  constructor(limit = 1) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return this._release.bind(this);
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    }).then(() => {
      this.active++;
      return this._release.bind(this);
    });
  }

  _release() {
    if (this.active > 0) this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async withPermit(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  getAvailable() {
    return Math.max(0, this.limit - this.active);
  }

  getActive() {
    return this.active;
  }
}