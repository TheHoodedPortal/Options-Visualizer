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
  install('innerHeight', 900);
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
  const respond = (symbol, expiration, {currency = 'USD', types = ['call', 'put'], iv = .3, strikes = [92.5, 97.5, 102.5], bid = 1, ask = 2, last = null} = {}) => {
    const index = pending.findIndex(item => item.url.searchParams.get('symbol') === symbol && (item.url.searchParams.get('expiration') || '') === expiration);
    assert.notEqual(index, -1, `missing request ${symbol} ${expiration}`);
    const [{ resolve }] = pending.splice(index, 1);
    const selectedExpiration = expiration || '2026-11-13';
    resolve({ ok: true, json: async () => ({ quote: { symbol, last: 100, currency }, expirations: ['2026-11-13', '2026-11-20', '2026-12-18'], selectedExpiration, chain: types.flatMap(type => strikes.map(strike => ({ type, strike, bid, ask, last, iv, volume: 1 }))) }) });
  };
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
  const el = id => w.document.getElementById(id);
  const click = id => el(id).click();
  try {
    await import('../src/main.js');
    assert.equal(el('date-slider').value, el('date-slider').max);
    assert.equal(el('date-label').textContent, 'Expiration');
    el('date-slider').dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
    el('date-slider').value = '3.2'; el('date-slider').dispatchEvent(new w.Event('input'));
    assert.equal(el('date-slider').value, '3.2');
    assert.equal(el('date-label').textContent, 'Nov 3');
    el('date-slider').value = '3.7'; el('date-slider').dispatchEvent(new w.Event('input'));
    assert.equal(el('date-slider').value, '3.7');
    assert.equal(el('date-label').textContent, 'Nov 4');
    w.dispatchEvent(new w.Event('pointerup'));
    assert.equal(el('date-slider').value, '4');
    el('date-slider').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(el('date-slider').value, '5');
    click('reset-scenario');
    el('range-slider').value = '15.5'; el('range-slider').dispatchEvent(new w.Event('input'));
    assert.equal(el('range-label').textContent, '±15.5%');
    el('iv-slider').value = '100.5'; el('iv-slider').dispatchEvent(new w.Event('input'));
    assert.equal(el('iv-slider').value, '100.5');
    click('reset-scenario');
    respond('MU', '2026-11-13', {currency: 'CAD', iv: 3.5}); await flush();
    assert.equal(el('iv-label').textContent, '350.0%');
    assert.equal(el('iv-slider').min, '40');
    assert.match(w.document.querySelector('.iv-scale').textContent, /0\.4×1×2×/);
    click('data-button');
    [...el('modal-content').querySelectorAll('button')].find(button => button.textContent === 'Reload data').click();
    assert.equal(pending.find(item => item.url.searchParams.get('symbol') === 'MU').url.searchParams.get('refresh'), '1');
    respond('MU', '2026-11-13', {currency: 'CAD', iv: 3.5}); await flush();
    assert.match(w.document.querySelector('.data-note').textContent, /flat scenario volatility/);
    assert.match(el('greeks-note').textContent, /flat scenario IV/);
    const callBar = [...el('volume-bars').querySelectorAll('.volume-bar.call')].find(bar => bar.title.includes('$102.50'));
    const putBar = [...el('volume-bars').querySelectorAll('.volume-bar.put')].find(bar => bar.title.includes('$102.50'));
    const marker = el('strike-markers').querySelector('.strike-marker');
    assert.ok(callBar && putBar && marker);
    assert.equal(callBar.style.left, putBar.style.left);
    assert.equal(callBar.style.left, marker.style.left);
    assert.equal(callBar.style.width, putBar.style.width);
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
    el('spot-input').value = '1047,60'; el('spot-input').dispatchEvent(new w.Event('change'));
    assert.equal(el('spot-input').value, '100.00');
    assert.match(el('toast').textContent, /decimal point/);
    el('dividend-yield').value = '40'; el('dividend-yield').dispatchEvent(new w.Event('change'));
    assert.equal(el('dividend-yield').value, '40.00');
    el('dividend-yield').value = '1001'; el('dividend-yield').dispatchEvent(new w.Event('change'));
    assert.equal(el('dividend-yield').value, '40.00');
    assert.match(el('toast').textContent, /dividend yield/);
    el('spot-input').value = '125'; el('spot-input').dispatchEvent(new w.Event('change'));
    el('iv-slider').value = '150'; el('iv-slider').dispatchEvent(new w.Event('input'));
    el('strategy-select').value = 'short-straddle'; el('strategy-select').dispatchEvent(new w.Event('change'));
    assert.equal(el('net-value').textContent, '$200'); // Two sales at the $1 bid.
    const payoffPath = () => el('payoff-chart').querySelector('path[stroke]:not([stroke-dasharray])').getAttribute('d');
    const priorPayoff = payoffPath();

    el('strategy-select').value = 'long-call'; el('strategy-select').dispatchEvent(new w.Event('change'));
    assert.equal(el('net-value').textContent, '$200'); // One purchase at the $2 ask.
    // The new payoff and its fitted axis appear together, without waiting for animation frames.
    assert.notEqual(payoffPath(), priorPayoff);
    const payoffY = [...payoffPath().matchAll(/[ML][^,]+,([^ML]+)/g)].map(match => Number(match[1]));
    assert.ok(payoffY.length && payoffY.every(y => y >= 24 && y <= 310));
    el('date-slider').value = '3'; el('date-slider').dispatchEvent(new w.Event('input'));
    click('save-button');
    [...el('modal-content').querySelectorAll('button')].find(button => button.textContent === 'Save Locally').click();
    assert.equal(JSON.parse(w.localStorage.getItem('openstrat-trades')).length, 1);

    el('date-slider').value = '7'; el('date-slider').dispatchEvent(new w.Event('input'));
    assert.equal(el('date-label').textContent, 'Nov 7');
    assert.equal(el('net-value').textContent, '$200');
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
    const novButton = el('expiration-strip').querySelector('[data-expiry="2026-11-20"]');
    const decButton = el('expiration-strip').querySelector('[data-expiry="2026-12-18"]');
    selectExpiry('November 20, 2026');
    assert.equal(novButton.getAttribute('aria-busy'), 'true');
    selectExpiry('December 18, 2026');
    assert.equal(novButton.getAttribute('aria-busy'), 'false');
    assert.equal(decButton.getAttribute('aria-busy'), 'true');
    respond('MSFT', '2026-12-18', {iv: 5}); await flush();
    assert.equal(decButton.getAttribute('aria-busy'), 'false');
    assert.equal(el('expiration-strip').querySelector('[data-expiry="2026-11-20"]'), novButton);
    assert.equal(el('expiration-strip').querySelector('[data-expiry="2026-12-18"]'), decButton);
    respond('MSFT', '2026-11-20'); await flush();
    assert.match(el('expiration-dte').textContent, /Dec 18/);
    // An unrelated full render between a press and click must not replace the button or move the strip.
    el('expiration-strip').scrollLeft = 100;
    novButton.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    el('dividend-yield').dispatchEvent(new w.Event('change'));
    assert.equal(el('expiration-strip').querySelector('[data-expiry="2026-11-20"]'), novButton);
    assert.equal(el('expiration-strip').scrollLeft, 100);
    novButton.click(); await flush();
    assert.match(el('expiration-dte').textContent, /Nov 20/);
    decButton.click(); await flush();
    assert.match(el('expiration-dte').textContent, /Dec 18/);
    assert.equal(el('iv-label').textContent, '750.0%');
    assert.equal(el('date-slider').value, el('date-slider').max);
    el('date-slider').value = '1'; el('date-slider').dispatchEvent(new w.Event('input'));
    click('reset-scenario');
    assert.equal(el('date-slider').value, el('date-slider').max);
    assert.equal(el('date-label').textContent, 'Expiration');

    click('history-button');
    [...el('modal-content').querySelectorAll('button')].find(button => button.textContent === 'Load').click();
    await flush(); // MU's earlier quote is cached.
    assert.equal(el('symbol-input').value, 'MU');
    assert.equal(el('spot-currency').textContent, '$');
    assert.match(el('data-status-detail').textContent, /Currency: CAD/);
    assert.equal(el('net-value').textContent, '$200');
    assert.equal(el('iv-label').textContent, '525.0%');
    assert.equal(el('spot-input').value, '125.00');
    assert.equal(el('iv-slider').value, '150');
    assert.equal(el('date-slider').value, '3');

    // A manually entered premium remains visible and is marked with its original contract date.
    el('strategy-legs-summary').querySelector('button').click();
    const editorPrice = w.document.querySelector('[data-editor-price]');
    editorPrice.value = '7.25'; editorPrice.dispatchEvent(new w.Event('change'));
    w.document.querySelector('.contract-editor-close').click();
    selectExpiry('November 20, 2026');
    respond('MU', '2026-11-20', { currency: 'CAD' }); await flush();
    assert.match(el('strategy-legs-summary').textContent, /\$7\.25.*carried from MU 2026-11-13/);
    selectExpiry('November 13, 2026'); await flush();
    assert.doesNotMatch(el('strategy-legs-summary').textContent, /carried from/);
    const customStrike = Number(el('strategy-legs-summary').querySelector('button').textContent.match(/\$([\d,.]+)/)[1].replaceAll(',', ''));
    el('symbol-input').value = 'SHIFT'; el('symbol-input').dispatchEvent(new w.Event('change'));
    respond('SHIFT', '2026-11-13', {strikes: [150]}); await flush();
    assert.match(el('strategy-legs-summary').textContent, new RegExp('carried from MU 2026-11-13 at \\$' + customStrike.toFixed(customStrike % 1 ? 2 : 0) + ' strike'));

    // Suggested prices follow side changes in Manage Positions, while edited prices stay manual.
    el('symbol-input').value = 'BIDASK'; el('symbol-input').dispatchEvent(new w.Event('change'));
    respond('BIDASK', '2026-11-13', { bid: 1, ask: 2 }); await flush();
    el('strategy-select').value = 'bull-call-spread'; el('strategy-select').dispatchEvent(new w.Event('change'));
    click('positions-button');
    let card = el('modal-content').querySelector('.position-card');
    let controls = card.querySelectorAll('select');
    controls[1].value = '-1'; controls[1].dispatchEvent(new w.Event('change'));
    assert.equal(card.querySelectorAll('input[type="number"]')[2].value, '1.00');
    [...el('modal-content').querySelectorAll('button')].find(button => button.textContent === 'Save changes').click();
    assert.match(el('strategy-legs-summary').textContent, /\$1\.00 \/ share/);
    click('positions-button');
    card = el('modal-content').querySelector('.position-card');
    const customPremium = card.querySelectorAll('input[type="number"]')[2];
    customPremium.value = '7.25'; customPremium.dispatchEvent(new w.Event('input'));
    controls = card.querySelectorAll('select');
    controls[1].value = '1'; controls[1].dispatchEvent(new w.Event('change'));
    assert.equal(customPremium.value, '7.25');
    [...el('modal-content').querySelectorAll('button')].find(button => button.textContent === 'Save changes').click();

    // An untouched Add Option suggestion keeps its source and refreshes on expiration change.
    click('add-leg');
    [...el('modal-content').querySelectorAll('button')].find(button => button.textContent === 'Add Position').click();
    selectExpiry('November 20, 2026');
    respond('BIDASK', '2026-11-20', { bid: 3, ask: 4 }); await flush();
    assert.match(el('strategy-legs-summary').lastElementChild.textContent, /\$4\.00 \/ share/);
    el('strategy-select').value = 'long-call'; el('strategy-select').dispatchEvent(new w.Event('change'));
    selectExpiry('November 13, 2026'); await flush();

    // A zero bid is not an executable sell premium, even if a last trade exists.
    el('symbol-input').value = 'ZERO'; el('symbol-input').dispatchEvent(new w.Event('change'));
    respond('ZERO', '2026-11-13', { bid: 0, ask: 2 }); await flush();
    el('strategy-select').value = 'short-straddle'; el('strategy-select').dispatchEvent(new w.Event('change'));
    assert.match(el('strategy-legs-summary').textContent, /Model estimate; no usable bid/);
    assert.notEqual(el('net-value').textContent, '$0');
    const putRow = [...el('strategy-legs-summary').querySelectorAll('button')].find(row => / put/.test(row.textContent));
    putRow.click();
    const includePut = w.document.querySelector('[data-editor-include]');
    includePut.checked = false; includePut.dispatchEvent(new w.Event('change'));
    w.document.querySelector('.contract-editor-close').click();
    selectExpiry('November 20, 2026');
    respond('ZERO', '2026-11-20', {types: ['call']}); await flush();
    assert.match(el('expiration-dte').textContent, /Nov 20/);
    const unavailablePut = [...el('strategy-legs-summary').querySelectorAll('button')].find(row => / put/.test(row.textContent));
    assert.match(unavailablePut.textContent, /Excluded from analysis.*Not listed/);
    unavailablePut.click();
    const unavailableInclude = w.document.querySelector('[data-editor-include]');
    unavailableInclude.checked = true; unavailableInclude.dispatchEvent(new w.Event('change'));
    assert.equal(unavailableInclude.checked, false);
    assert.match(el('toast').textContent, /listed contract/);
    w.document.querySelector('.contract-editor-close').click();
    selectExpiry('November 13, 2026'); await flush();
    el('strategy-select').value = 'long-call'; el('strategy-select').dispatchEvent(new w.Event('change'));

    // Enter submits unhighlighted ticker text, and delta mapping uses today even when the scenario is at expiration.
    const oldStrike = Number(el('strategy-legs-summary').querySelector('button').textContent.match(/\$([\d,.]+)/)[1].replaceAll(',', ''));
    const { optionDelta, daysUntil, RATE, PRICING_MODELS } = await import('../src/pricing.js');
    const { closestStrikeAtDelta } = await import('../src/contract-mapping.js');
    const dte = daysUntil('2026-11-13');
    const targetDelta = optionDelta('call', 100, oldStrike, dte, .3 * 1.5, RATE, PRICING_MODELS.AMERICAN, 0);
    const newStrikes = [85, 90, 95, 100, 105, 110, 115, 120, 125, 130];
    const expectedStrike = closestStrikeAtDelta({ chain: newStrikes.map(strike => ({ type: 'call', strike, iv: .3 })), type: 'call', targetDelta, spot: 100, days: dte, iv: .3, ivScale: 1.5, model: PRICING_MODELS.AMERICAN, dividendYield: 0 });
    el('symbol-input').value = 'MS'; el('symbol-input').dispatchEvent(new w.Event('input', { bubbles: true }));
    el('symbol-input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    respond('MS', '2026-11-13', {strikes: newStrikes, bid: 0, ask: 0, last: 1.25}); await flush();
    assert.match(el('strategy-legs-summary').textContent, new RegExp('\\$' + expectedStrike));
    assert.match(el('strategy-legs-summary').textContent, /Last trade estimate; no usable ask/);

    // Reclassify an expired spread if the new chain cannot preserve distinct strikes.
    el('strategy-select').value = 'bull-call-spread'; el('strategy-select').dispatchEvent(new w.Event('change'));
    assert.equal(el('strategy-select').value, 'bull-call-spread');
    selectExpiry('November 20, 2026');
    respond('MS', '2026-11-20', {strikes: [100], ask: 0, bid: 0}); await flush();
    assert.equal(el('strategy-select').value, 'custom');
    assert.match(el('strategy-legs-summary').textContent, /Model estimate; no usable ask/);
    el('strategy-select').value = 'long-call'; el('strategy-select').dispatchEvent(new w.Event('change'));
    selectExpiry('November 13, 2026'); await flush();

    // Sparse chains must not be mislabeled as spreads or condors.
    el('symbol-input').value = 'SPARSE'; el('symbol-input').dispatchEvent(new w.Event('change'));
    respond('SPARSE', '2026-11-13', {strikes: [100]}); await flush();
    const oldStrategy = el('strategy-select').value;
    el('strategy-select').value = 'iron-condor'; el('strategy-select').dispatchEvent(new w.Event('change'));
    assert.equal(el('strategy-select').value, oldStrategy);
    assert.match(el('toast').textContent, /could not form/i);

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

    // A saved CAD scenario retains its currency if reconnecting fails.
    click('close-modal');
    now += 6 * 60_000;
    click('history-button');
    [...el('modal-content').querySelectorAll('button')].find(button => button.textContent === 'Load').click();
    const index = pending.findIndex(item => item.url.searchParams.get('symbol') === 'MU');
    assert.notEqual(index, -1);
    pending.splice(index, 1)[0].resolve({ ok: false, json: async () => ({error: 'Offline'}) });
    await flush();
    assert.match(el('data-status-detail').textContent, /Saved currency: CAD/);
    assert.equal(el('spot-currency').textContent, '$');
  } finally {
    w.close();
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete globalThis[name]; else Object.defineProperty(globalThis, name, value); }
  }
});
