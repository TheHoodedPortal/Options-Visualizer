import test from 'node:test';
import assert from 'node:assert/strict';
import { YFinanceClient } from '../src/yfinance.js';

const originalLocation = globalThis.location;
globalThis.location = { origin: 'http://127.0.0.1:5173' };
test.after(() => {
  if (originalLocation === undefined) delete globalThis.location;
  else globalThis.location = originalLocation;
});

test('loads one combined quote, expiration list, and selected option chain', async () => {
  const urls = [];
  const client = new YFinanceClient(async url => {
    urls.push(new URL(url));
    return {
      ok: true,
      json: async () => ({
        quote: { symbol: 'AAPL', last: 200 },
        expirations: ['2026-11-13', '2026-11-20'],
        selectedExpiration: '2026-11-20',
        chain: [{ symbol: 'AAPL261120C00200000', type: 'call', strike: 200, bid: 4.5, ask: 5, volume: 8 }]
      })
    };
  });

  const data = await client.loadSymbol('aapl', '2026-11-20');
  assert.equal(data.quote.last, 200);
  assert.deepEqual(data.expirations, ['2026-11-13', '2026-11-20']);
  assert.equal(data.chain[0].volume, 8);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get('symbol'), 'AAPL');
  assert.equal(urls[0].searchParams.get('expiration'), '2026-11-20');
  assert.deepEqual(await client.chain('AAPL', '2026-11-20'), data.chain);
  assert.equal(urls.length, 1);
});

test('coalesces duplicate requests for the same ticker and expiration', async () => {
  let calls = 0;
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const client = new YFinanceClient(async () => {
    calls++;
    await response;
    return { ok: true, json: async () => ({
      quote: { symbol: 'MU', last: 100 },
      expirations: ['2026-11-13'],
      selectedExpiration: '2026-11-13',
      chain: []
    }) };
  });

  const first = client.loadSymbol('MU', '2026-11-13');
  const second = client.loadSymbol('MU', '2026-11-13');
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('does not automatically retry rate-limit responses', async () => {
  let calls = 0;
  const client = new YFinanceClient(async () => {
    calls++;
    return { ok: false, status: 429, json: async () => ({ error: 'Requests are paused for 60 seconds.' }) };
  });

  await assert.rejects(client.loadSymbol('SPY'), /paused for 60 seconds/i);
  assert.equal(calls, 1);
});

test('explicit expiration never overwrites the nearest expiration cache', async () => {
  let calls = 0;
  const client = new YFinanceClient(async url => {
    calls++;
    const expiration = new URL(url).searchParams.get('expiration') || '2026-11-13';
    return { ok: true, json: async () => ({ quote: {}, expirations: ['2026-11-13', '2026-12-18'], selectedExpiration: expiration, chain: [{ strike: expiration }] }) };
  });
  await client.request('MU');
  await client.request('MU', '2026-12-18');
  assert.equal((await client.request('MU')).selectedExpiration, '2026-11-13');
  assert.equal(calls, 2);
});

test('does not treat a fallback chain as the requested expiration', async () => {
  let calls = 0;
  const client = new YFinanceClient(async () => {
    calls++;
    return { ok: true, json: async () => ({ quote: {}, expirations: ['2026-11-13'], selectedExpiration: '2026-11-13', chain: [{ strike: 100 }] }) };
  });
  await assert.rejects(client.chain('MU', '2026-12-18'), /no longer available/);
  await assert.rejects(client.chain('MU', '2026-12-18'), /no longer available/);
  assert.equal(calls, 2);
  assert.equal((await client.request('MU', '2026-11-13')).selectedExpiration, '2026-11-13');
});
