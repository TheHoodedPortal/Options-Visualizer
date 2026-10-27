export class RequestQueue {
  constructor({ gapMs = 5000, maxQueued = 2, maxWaitMs = 15000 } = {}) {
    this.gapMs = gapMs; this.maxQueued = maxQueued; this.maxWaitMs = maxWaitMs;
    this.items = []; this.running = false; this.lastStarted = 0; this.timer = null;
  }
  enqueue(task, signal) {
    if (signal?.aborted) return Promise.reject(new Error('Request canceled.'));
    if (this.items.length >= this.maxQueued) return Promise.reject(Object.assign(new Error('Market data queue is full. Please retry shortly.'), { statusCode: 503 }));
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, signal };
      const remove = error => {
        const index = this.items.indexOf(item);
        if (index < 0) return;
        this.items.splice(index, 1); this.cleanup(item); reject(error); this.pump();
      };
      item.abort = () => remove(new Error('Request canceled.'));
      item.timeout = setTimeout(() => remove(Object.assign(new Error('Market data queue wait timed out. Please retry.'), { statusCode: 503 })), this.maxWaitMs);
      signal?.addEventListener('abort', item.abort, { once: true });
      this.items.push(item); this.pump();
    });
  }
  cleanup(item) { clearTimeout(item.timeout); item.signal?.removeEventListener('abort', item.abort); }
  pump() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.running || !this.items.length) return;
    const wait = Math.max(0, this.lastStarted + this.gapMs - Date.now());
    if (wait) { this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait); return; }
    const item = this.items.shift(); this.cleanup(item);
    this.running = true; this.lastStarted = Date.now();
    Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { this.running = false; this.pump(); });
  }
}
