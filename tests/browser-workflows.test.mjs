import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

process.env.TZ = 'America/Toronto';

test('browser workflows keep dates, currency, saved trades, and the latest market request consistent', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = () => ({ measureText: () => ({ width: 30 }) });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const original = {};
  const install = (name, value) => { original[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value, writable: true, configurable: true }); };
  for (const name of ['window', 'document', 'localStorage', 'location', 'navigator', 'getComputedStyle']) install(name, name === 'getComputedStyle' ? w.getComputedStyle.bind(w) : w[name]);
  install('innerWidth', 1200);
  install('requestAnimationFrame', () => 1);
  install('cancelAnimationFrame', () => {});
  const intervals = [];
  install('setInterval', fn => { intervals.push(fn); return 1; });
  const RealDate = Date;
  let now = new RealDate('2026-10-31T23:59:00-04:00').getTime();
  class FakeDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  install('Date', FakeDate);
  const pending = [];
  install('fetch', url => new Promise(resolve => pending.push({ url: new URL(url), resolve })));
  const respond = (symbol, expiration, {currency = 'USD', types = ['call', 'put'], iv = .3} = {}) => {
    const index = pending.findIndex(item => item.url.searchParams.get('symbol') === symbol && (item.url.searchParams.get('expiration') || '') === expiration);
    assert.notEqual(index, -1, `missing request ${symbol} ${expiration}`);
    const [{ resolve }] = pending.splice(index, 1);
    const selectedExpiration = expiration || '2026-11-13';
    resolve({ ok: true, json: async () => ({ quote: { symbol, last: 100, currency }, expirations: ['2026-11-13', '2026-11-20', '2026-12-18'], selectedExpiration, chain: types.flatMap(type => [92.5, 97.5, 102.5].map(strike => ({ type, strike, bid: 1, ask: 2, iv, volume: 1 }))) }) });
  };
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
  const el = id => w.document.getElementById(id);
  const click = id => el(id).click();
  try {
    await import('../src/main.js');
    respond('MU', '2026-11-13', {currency: 'CAD', iv: 3.5}); await flush();
    assert.equal(el('iv-label').textContent, '350.0%');
    assert.match(w.document.querySelector('.data-note').textContent, /flat scenario volatility/);
    assert.match(el('greeks-note').textContent, /flat scenario IV/);
    assert.equal(el('spot-currency').textContent, '$');
    assert.match(el('data-status-detail').textContent, /Currency: CAD/);
    assert.match(el('net-value').textContent, /^\$/);
    assert.equal(el('gamma-unit').textContent, 'shares / $1');
    for (const id of ['net-value', 'max-loss', 'breakeven', 'greek-theta', 'greek-vega']) {
      assert.match(el(id).textContent, /^[+−-]?\$/, id);
      assert.doesNotMatch(el(id).textContent, /CAD/);
    }
    assert.match(el('strategy-legs-summary').textContent, /\$/);
    assert.doesNotMatch(el('strategy-legs-summary').textContent, /CAD/);
    assert.equal(el('output-pl').textContent, 'Profit / loss $');
    const chartLabels = el('payoff-chart').textContent;
    assert.match(chartLabels, /\$/);
    assert.doesNotMatch(chartLabels, /CAD/);
    click('save-button');
    [...el('modal-content').querySelectorAll('button')].find(button => button.textContent === 'Save Locally').click();
    assert.equal(JSON.parse(w.localStorage.getItem('openstrat-trades')).length, 1);

    el('date-slider').value = '7'; el('date-slider').dispatchEvent(new w.Event('input'));
    assert.equal(el('date-label').textContent, 'Nov 7');
    assert.equal(el('net-value').textContent, '$150');
    // The timer advances the stored calendar date only once after midnight.
    now = new RealDate('2026-11-01T00:01:00-04:00').getTime();
    intervals[0]();
    assert.match(el('expiration-dte').textContent, /12d/);
    assert.equal(el('date-label').textContent, 'Nov 8');
    const before = el('expiration-strip').firstElementChild;
    intervals[0]();
    assert.equal(el('expiration-strip').firstElementChild, before);

    // Two symbol requests resolve out of order; the last user selection wins.
    el('symbol-input').value = 'AAPL'; el('symbol-input').dispatchEvent(new w.Event('change'));
    el('symbol-input').value = 'MSFT'; el('symbol-input').dispatchEvent(new w.Event('change'));
    respond('MSFT', '2026-11-13', {currency:'EUR'}); await flush();
    respond('AAPL', '2026-11-13'); await flush();
    assert.equal(el('symbol-input').value, 'MSFT');
    assert.equal(el('spot-currency').textContent, '€');
    assert.match(el('data-status-detail').textContent, /Currency: EUR/);
    assert.match(el('net-value').textContent, /^€/);

    const selectExpiry = date => [...el('expiration-strip').querySelectorAll('button')].find(button => button.getAttribute('aria-label')?.includes(date)).click();
    selectExpiry('November 20, 2026');
    selectExpiry('December 18, 2026');
    respond('MSFT', '2026-12-18', {iv: 5}); await flush();
    respond('MSFT', '2026-11-20'); await flush();
    assert.match(el('expiration-dte').textContent, /Dec 18/);
    assert.equal(el('iv-label').textContent, '500.0%');

    click('history-button');
    [...el('modal-content').querySelectorAll('button')].find(button => button.textContent === 'Load').click();
    await flush(); // MU's earlier quote is cached.
    assert.equal(el('symbol-input').value, 'MU');
    assert.equal(el('spot-currency').textContent, '$');
    assert.match(el('data-status-detail').textContent, /Currency: CAD/);
    assert.equal(el('net-value').textContent, '$150');
    assert.equal(el('iv-label').textContent, '350.0%');

    // Starting with calls only must reject puts and prevent invented contracts.
    el('symbol-input').value = 'CALL'; el('symbol-input').dispatchEvent(new w.Event('change'));
    respond('CALL', '2026-11-13', {types: ['call']}); await flush();
    el('strategy-select').value = 'long-put'; el('strategy-select').dispatchEvent(new w.Event('change'));
    assert.match(el('toast').textContent, /no listed contracts/i);
    assert.notEqual(el('strategy-select').value, 'long-put');
    click('add-leg');
    const selects = el('modal-content').querySelectorAll('select');
    selects[0].value = 'put'; selects[0].dispatchEvent(new w.Event('change'));
    [...el('modal-content').querySelectorAll('button')].find(button => button.textContent === 'Add Position').click();
    assert.match(el('toast').textContent, /listed strike/i);
  } finally {
    w.close();
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete globalThis[name]; else Object.defineProperty(globalThis, name, value); }
  }
});
