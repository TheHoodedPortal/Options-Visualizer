import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('abandoned running Yahoo work is stopped and refresh bypasses server and worker caches', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'options-worker-test-'));
  const marker = join(dir, 'started');
  await writeFile(join(dir, 'yfinance.py'), `
import os, time
count = 0
class Frame:
    def to_dict(self, orient):
        return [{'strike':100, 'contractSize':'REGULAR', 'bid':1, 'ask':2}]
class Data:
    calls = Frame()
    puts = Frame()
    def __init__(self, price): self.underlying = {'regularMarketPrice':price, 'currency':'USD'}
class Ticker:
    options = ('2099-01-01',)
    def __init__(self, symbol): self.symbol = symbol
    def option_chain(self, expiration=None):
        global count
        if self.symbol == 'SLOW':
            open(os.environ['FAKE_MARKER'], 'w').close()
            time.sleep(25)
        count += 1
        return Data(100 + count)
`);
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), YFINANCE_PYTHON: process.env.TEST_PYTHON || 'python', PYTHONPATH: dir, FAKE_MARKER: marker },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server failed to start: ' + stderr)), 6000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code + ' ' + stderr)); });
    });
    // Walk frontend imports through the actual static server allowlist.
    const root = `http://127.0.0.1:${port}`;
    const assets = ['/src/main.js', '/src/liquid-glass.js', '/src/styles.previous.css', '/src/styles.hierarchy.css', '/src/liquid-glass.previous.css', '/src/popup-glass.css'];
    const seen = new Set();
    while (assets.length) {
      const path = assets.pop();
      if (seen.has(path)) continue;
      seen.add(path);
      const response = await fetch(root + path);
      assert.equal(response.status, 200, `frontend asset ${path}`);
      const source = await response.text();
      if (path.endsWith('.js')) {
        for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.\/[^'"]+)['"]/g)) {
          assets.push(new URL(match[1], root + path).pathname);
        }
      }
    }
    const base = root + '/api/yfinance?symbol=';
    const crossSite = await fetch(base + 'FAST', { headers: { Origin: 'https://other.example' } });
    assert.equal(crossSite.status, 403);
    const controller = new AbortController();
    const abandoned = fetch(base + 'SLOW', { signal: controller.signal }).catch(error => error);
    for (let i = 0; i < 100; i++) { try { await access(marker); break; } catch { await sleep(50); } }
    await access(marker);
    const secondController = new AbortController();
    let secondFinished = false;
    const shared = fetch(base + 'SLOW', { signal: secondController.signal }).then(value => { secondFinished = true; return value; }, error => { secondFinished = true; return error; });
    await sleep(150); // Allow the second HTTP client to join the in-flight request.
    controller.abort(); await abandoned;
    await sleep(150);
    assert.equal(secondFinished, false, 'canceling one client interrupted shared work');
    secondController.abort(); await shared;
    const started = Date.now();
    const result = await (await fetch(base + 'FAST')).json();
    assert.equal(result.quote.last, 101);
    assert.ok(Date.now() - started < 10000, 'new request waited behind abandoned work');
    const cached = await (await fetch(base + 'FAST')).json();
    assert.equal(cached.quote.last, 101);
    const refreshed = await (await fetch(base + 'FAST&refresh=1')).json();
    assert.equal(refreshed.quote.last, 102);
  } finally {
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 3000).unref(); } });
    await rm(dir, { recursive: true, force: true });
  }
});
