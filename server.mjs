import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname);
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const localPython = join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
const configuredPython = process.env.YFINANCE_PYTHON || process.env.PYTHON;
const hasPythonLauncher = !configuredPython && !existsSync(localPython) && process.platform === 'win32'
  && spawnSync('py', ['-3', '-c', 'import sys'], { windowsHide: true, stdio: 'ignore', timeout: 3000 }).status === 0;
const pythonCommand = configuredPython || (existsSync(localPython) ? localPython : process.platform === 'win32' ? (hasPythonLauncher ? 'py' : 'python') : 'python3');
const pythonArgs = hasPythonLauncher ? ['-3'] : [];
const workerPath = join(root, 'src', 'yfinance_worker.py');

class YFinanceWorker {
  child = null;
  starting = null;
  ready = false;
  nextId = 0;
  pending = new Map();

  start() {
    if (this.ready && this.child) return Promise.resolve();
    if (this.starting) return this.starting;

    this.starting = new Promise((resolveReady, rejectReady) => {
      let settled = false;
      const child = spawn(pythonCommand, [...pythonArgs, '-u', workerPath], {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.child = child;
      // A worker may exit between the readiness check and a write.
      child.stdin.on('error', () => {});
      const lines = createInterface({ input: child.stdout });
      let stderr = '';
      const timer = setTimeout(() => fail(new Error('The local yfinance worker did not start in time.')), 8000);

      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.starting = null;
        this.ready = false;
        if (this.child === child) this.child = null;
        rejectReady(error);
        child.kill();
      };

      lines.on('line', line => {
        if (this.child !== child) return;
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.kind === 'ready') {
          if (!message.ok) {
            fail(new Error(message.error || 'The Python yfinance package is unavailable.'));
            return;
          }
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.starting = null;
            this.ready = true;
            resolveReady();
          }
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.data);
        else pending.reject(new Error(message.error || 'yfinance could not load market data.'));
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
      child.once('error', error => fail(new Error(
        pythonCommand === 'py' || pythonCommand === 'python3' || pythonCommand === 'python'
          ? 'Python 3.10 or newer is required for Yahoo data. Install Python, then run py -3 -m pip install -r requirements.txt.'
          : 'Could not start the configured Python interpreter: ' + error.message
      )));
      child.once('close', code => {
        if (this.child !== child) return;
        const detail = stderr.trim();
        const error = new Error(detail || 'The local yfinance worker stopped' + (code == null ? '.' : ' (exit ' + code + ').'));
        if (!settled) fail(error);
        this.ready = false;
        this.child = null;
        this.starting = null;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear();
      });
    });
    return this.starting;
  }

  async request(symbol, expiration) {
    await this.start();
    if (!this.child || !this.ready) throw new Error('The local yfinance worker is not running.');
    const id = ++this.nextId;
    const child = this.child;
    const promise = new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        if (this.child !== child) return;
        const error = new Error('The local yfinance worker request timed out.');
        this.ready = false; this.child = null; this.starting = null;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear();
        child.kill();
      }, 40_000);
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult, timer });
    });
    this.child.stdin.write(JSON.stringify({ id, symbol, expiration }) + '\n', error => {
      if (error) {
        const pending = this.pending.get(id);
        if (pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); }
      }
    });
    return promise;
  }

  stop() {
    if (this.child && this.child.exitCode === null && !this.child.killed) this.child.kill();
  }
}

const worker = new YFinanceWorker();
const marketCache = new Map();
const marketPending = new Map();
const cacheTtlMs = 5 * 60_000;
const minimumFetchGapMs = 5_000;
let nextUpstreamRequestAt = 0;
let rateLimitUntil = 0;
let nextRateLimitCooldownMs = 5 * 60_000;
let connectionPauseUntil = 0;
let nextConnectionPauseMs = 30_000;

function cacheKey(symbol, expiration) {
  return symbol + ':' + (expiration || 'nearest');
}

function isRateLimit(error) {
  return /429|rate.?limit|too many requests/i.test(String(error?.message || error));
}

function isConnectionFailure(error) {
  return /curl:\s*\((7|28|35|56)\)|could not connect|failed to connect|connection timed out|connection reset/i.test(String(error?.message || error));
}

function rateLimitMessage() {
  const seconds = Math.max(1, Math.ceil((rateLimitUntil - Date.now()) / 1000));
  return 'Yahoo Finance rate limited this app. Requests are paused for ' + seconds + ' seconds; wait before trying again.';
}

function connectionPauseMessage() {
  const seconds = Math.max(1, Math.ceil((connectionPauseUntil - Date.now()) / 1000));
  return 'Yahoo Finance could not be reached. Requests are paused for ' + seconds + ' seconds; wait before trying again.';
}

async function marketData(symbol, expiration) {
  const key = cacheKey(symbol, expiration);
  const cached = marketCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (marketPending.has(key)) return marketPending.get(key);
  if (rateLimitUntil > Date.now()) throw Object.assign(new Error(rateLimitMessage()), { statusCode: 429 });
  if (connectionPauseUntil > Date.now()) throw Object.assign(new Error(connectionPauseMessage()), { statusCode: 503 });

  const pending = (async () => {
    const now = Date.now();
    const wait = Math.max(0, nextUpstreamRequestAt - now);
    nextUpstreamRequestAt = Math.max(now, nextUpstreamRequestAt) + minimumFetchGapMs;
    if (wait) await new Promise(resolveDelay => setTimeout(resolveDelay, wait));
    if (rateLimitUntil > Date.now()) throw Object.assign(new Error(rateLimitMessage()), { statusCode: 429 });
    if (connectionPauseUntil > Date.now()) throw Object.assign(new Error(connectionPauseMessage()), { statusCode: 503 });

    try {
      const data = await worker.request(symbol, expiration);
      rateLimitUntil = 0;
      nextRateLimitCooldownMs = 5 * 60_000;
      connectionPauseUntil = 0;
      nextConnectionPauseMs = 30_000;
      const entry = { data, expiresAt: Date.now() + cacheTtlMs };
      if (!expiration || data.selectedExpiration === expiration) marketCache.set(key, entry);
      if (!expiration && data.selectedExpiration) marketCache.set(cacheKey(symbol, data.selectedExpiration), entry);
      while (marketCache.size > 100) marketCache.delete(marketCache.keys().next().value);
      return data;
    } catch (error) {
      if (isRateLimit(error)) {
        rateLimitUntil = Date.now() + nextRateLimitCooldownMs;
        nextRateLimitCooldownMs = Math.min(nextRateLimitCooldownMs * 2, 60 * 60_000);
        throw Object.assign(new Error(rateLimitMessage()), { statusCode: 429 });
      }
      if (isConnectionFailure(error)) {
        connectionPauseUntil = Date.now() + nextConnectionPauseMs;
        nextConnectionPauseMs = Math.min(nextConnectionPauseMs * 2, 10 * 60_000);
        throw Object.assign(new Error(connectionPauseMessage()), { statusCode: 502 });
      }
      throw error;
    }
  })();

  marketPending.set(key, pending);
  try { return await pending; }
  finally { marketPending.delete(key); }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(request.headers.host || '')) {
      response.writeHead(403).end('Forbidden'); return;
    }
    const requestUrl = new URL(request.url, 'http://localhost');
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname === '/health' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, name: 'Options Visualizer' });
      return;
    }

    if (pathname === '/api/yfinance') {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Only GET requests are supported.' });
        return;
      }
      const symbol = (requestUrl.searchParams.get('symbol') || '').trim().toUpperCase();
      const expiration = requestUrl.searchParams.get('expiration') || '';
      if (!/^[A-Z0-9.^=-]{1,12}$/.test(symbol)) {
        sendJson(response, 400, { error: 'Enter a valid ticker symbol.' });
        return;
      }
      if (expiration && !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
        sendJson(response, 400, { error: 'Expiration must be a date in YYYY-MM-DD format.' });
        return;
      }
      try {
        sendJson(response, 200, await marketData(symbol, expiration));
      } catch (error) {
        const status = error.statusCode || (/Python 3|yfinance package|Python interpreter|local yfinance worker/i.test(error.message) ? 503 : 502);
        sendJson(response, status, { error: error.message || 'yfinance could not load market data.' });
      }
      return;
    }

    const allowed = pathname === '/' || pathname === '/index.html' || pathname === '/liquid.html' || /^\/src\/(?:main|yfinance|pricing|contract-mapping|strategies|strikes|tickers|chart-scale|glass-optics|liquid-glass)\.js$/.test(pathname) || /^\/src\/(?:styles\.(?:hierarchy|previous)|liquid-glass(?:\.previous)?|popup-glass)\.css$/.test(pathname);
    if (!allowed || request.method !== 'GET') { response.writeHead(404).end('Not found'); return; }
    let file = resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  worker.stop();
  if (!server.listening) {
    process.exit(0);
    return;
  }
  server.close(() => process.exit(0));
  const forceExit = setTimeout(() => process.exit(0), 2500);
  forceExit.unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write('Port ' + port + ' is already in use. Close the other server or choose another port with PORT.\n');
  } else {
    process.stderr.write('Could not start the local server: ' + error.message + '\n');
  }
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('Options Visualizer running at http://127.0.0.1:' + port + '\n');
});
