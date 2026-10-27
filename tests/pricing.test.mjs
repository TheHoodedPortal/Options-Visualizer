import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDays, bivariateNormalCdf, daysUntil, expirationStats, intrinsic, netDebit, optionDelta, optionGreeks, optionPrice, profitLoss, PRICING_MODELS, strategyGreeks } from '../src/pricing.js';

const expiry = new Date(new Date().getFullYear() + 1, 10, 13).toLocaleDateString('en-CA');
const call = { symbol: 'MU', spot: 1047.6, iv: .465, expiry, legs: [{ type: 'call', side: 1, strike: 1050, qty: 1, premium: 62 }] };
const atExpiry = daysUntil(expiry);

test('reference long call has exact expiration loss and breakeven', () => {
  assert.equal(netDebit(call), 6200);
  assert.deepEqual(expirationStats(call), { maxLoss: 6200, maxProfit: Infinity, breakevens: [1112] });
  assert.equal(profitLoss(call, 1050, atExpiry), -6200);
  assert.equal(profitLoss(call, 1112, atExpiry), 0);
  assert.equal(profitLoss(call, 1200, atExpiry), 8800);
});

test('bull call spread is capped on both sides', () => {
  const spread = { ...call, legs: [
    { type: 'call', side: 1, strike: 100, qty: 1, premium: 12 },
    { type: 'call', side: -1, strike: 110, qty: 1, premium: 7 }
  ] };
  assert.deepEqual(expirationStats(spread), { maxLoss: 500, maxProfit: 500, breakevens: [105] });
  assert.equal(profitLoss(spread, 90, atExpiry), -500);
  assert.equal(profitLoss(spread, 120, atExpiry), 500);
});

test('short call exposes unlimited upside loss', () => {
  const short = { ...call, legs: [{ type: 'call', side: -1, strike: 100, qty: 1, premium: 5 }] };
  assert.deepEqual(expirationStats(short), { maxLoss: Infinity, maxProfit: 500, breakevens: [105] });
});

test('expiry pricing is intrinsic and volatility changes time value', () => {
  assert.equal(intrinsic('put', 90, 100), 10);
  assert.equal(optionPrice('call', 90, 100, 0, .3), 0);
  assert.equal(optionPrice('put', 90, 100, 0, .3), 10);
  assert.ok(optionPrice('call', 100, 100, 30, .5) > optionPrice('call', 100, 100, 30, .2));
});

test('Bjerksund–Stensland 2002 matches published American option reference values', () => {
  const model = PRICING_MODELS.AMERICAN;
  const days = 365 / 2;
  const rate = .1, dividendYield = .1;
  const examples = [
    ['call', 90, 100, .15, .8099],
    ['call', 100, 100, .25, 6.7661],
    ['call', 110, 100, .35, 15.5137],
    ['put', 90, 100, .15, 10.5400],
    ['put', 100, 100, .25, 6.7661],
    ['put', 110, 100, .35, 5.8374]
  ];
  for (const [type, spot, strike, volatility, expected] of examples) {
    const actual = optionPrice(type, spot, strike, days, volatility, rate, model, dividendYield);
    assert.ok(Math.abs(actual - expected) < .001, `${type} ${spot}/${strike}: expected ${expected}, got ${actual}`);
  }
});

test('American model respects exercise value and switches to European pricing without dividends', () => {
  const american = PRICING_MODELS.AMERICAN;
  const european = PRICING_MODELS.EUROPEAN;
  assert.equal(optionPrice('put', 80, 100, 0, .3, .04, american), 20);
  assert.equal(optionPrice('call', 100, 100, 120, .3, .04, american, 0), optionPrice('call', 100, 100, 120, .3, .04, european, 0));
  assert.ok(optionPrice('call', 110, 100, 180, .2, .04, american, .05) > optionPrice('call', 110, 100, 180, .2, .04, european, .05));
});

test('bivariate normal CDF handles independence and positive or negative correlation', () => {
  assert.ok(Math.abs(bivariateNormalCdf(0, 0, 0) - .25) < 1e-8);
  assert.ok(Math.abs(bivariateNormalCdf(0, 0, .5) - 1 / 3) < 1e-8);
  assert.ok(Math.abs(bivariateNormalCdf(0, 0, -.5) - 1 / 6) < 1e-8);
});

test('strategy Greeks aggregate long and short legs with contract multipliers', () => {
  const days = daysUntil(expiry);
  const longCall = optionGreeks('call', 100, 100, days, .3);
  const shortCall = optionGreeks('call', 100, 100, days, .3);
  assert.ok(longCall.delta > 0 && longCall.gamma > 0 && longCall.vega > 0 && longCall.theta < 0);
  const strategy = { ...call, spot: 100, iv: .3, legs: [
    { type: 'call', side: 1, strike: 100, qty: 2, premium: 1 },
    { type: 'call', side: -1, strike: 100, qty: 1, premium: 1 }
  ] };
  const total = strategyGreeks(strategy);
  assert.ok(Math.abs(total.delta - longCall.delta * 100) < .1);
  assert.ok(Math.abs(total.gamma - longCall.gamma * 100) < .01);
  assert.ok(Math.abs(total.theta - longCall.theta * 100) < .01);
  assert.ok(Math.abs(total.vega - longCall.vega * 100) < .01);
  assert.equal(shortCall.delta, longCall.delta);
});

test('strategy pricing and Greeks follow the selected model and dividend yield', () => {
  const strategy = {
    ...call,
    spot: 110,
    iv: .2,
    dividendYield: .05,
    model: PRICING_MODELS.AMERICAN,
    legs: [{ type: 'call', side: 1, strike: 100, qty: 1, premium: 5 }]
  };
  const americanValue = profitLoss(strategy, strategy.spot);
  const americanGreeks = strategyGreeks(strategy);
  const european = { ...strategy, model: PRICING_MODELS.EUROPEAN };
  assert.notEqual(americanValue, profitLoss(european, european.spot));
  assert.notEqual(americanGreeks.delta, strategyGreeks(european).delta);
});

test('standalone delta matches the selected model Greek', () => {
  for (const model of [PRICING_MODELS.AMERICAN, PRICING_MODELS.EUROPEAN]) {
    for (const type of ['call', 'put']) {
      const delta = optionDelta(type, 105, 110, 75, .42, .04, model, .012);
      const greek = optionGreeks(type, 105, 110, 75, .42, .04, model, .012).delta;
      assert.ok(Math.abs(delta - greek) < 1e-10, `${model} ${type}: ${delta} vs ${greek}`);
    }
  }
});

test('at expiration only intrinsic delta remains defined', () => {
  assert.deepEqual(optionGreeks('call', 110, 100, 0, .3), { delta: 1, gamma: 0, theta: 0, vega: 0 });
  assert.deepEqual(optionGreeks('put', 100, 100, 0, .3), { delta: -.5, gamma: 0, theta: 0, vega: 0 });
});


test('European dividend theta matches a finite difference in time', async () => {
  const { optionGreeks, optionPrice, PRICING_MODELS } = await import('../src/pricing.js');
  for (const type of ['call', 'put']) {
    const args = [type, 100, 100, 90, .3, .04, PRICING_MODELS.EUROPEAN, .08];
    const theta = optionGreeks(...args).theta;
    const forward = optionPrice(type, 100, 100, 90.01, .3, .04, PRICING_MODELS.EUROPEAN, .08);
    const backward = optionPrice(type, 100, 100, 89.99, .3, .04, PRICING_MODELS.EUROPEAN, .08);
    assert.ok(Math.abs(theta + (forward - backward) / .02) < .0001);
  }
});

test('zero net premium has no defined percentage return', async () => {
  const { outputValue } = await import('../src/pricing.js');
  const state = { spot: 100, iv: .3, expiry: '2099-01-01', legs: [{type:'call', side:1, qty:1, strike:100, premium:0}] };
  assert.ok(Number.isNaN(outputValue(state, 110, 0, 'percent')));
});

test('calendar days and expiration DTE cross spring and fall daylight saving changes', () => {
  const oldTZ = process.env.TZ;
  process.env.TZ = 'America/Toronto';
  try {
    for (const [start, days, expected] of [['2026-10-26', 7, '2026-11-02'], ['2027-03-07', 7, '2027-03-14']]) {
      const date = new Date(start + 'T00:00:00');
      const result = addCalendarDays(date, days);
      const local = result.getFullYear() + '-' + String(result.getMonth() + 1).padStart(2, '0') + '-' + String(result.getDate()).padStart(2, '0');
      assert.equal(local, expected);
      assert.equal(daysUntil(expected, date), days);
    }
  } finally { if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ; }
});

test('zero volatility discounts deterministic payoff and allows optimal American exercise', () => {
  const european = PRICING_MODELS.EUROPEAN, american = PRICING_MODELS.AMERICAN;
  assert.ok(Math.abs(optionPrice('call', 110, 100, 365, 0, .04, european, 0) - (110 - 100 * Math.exp(-.04))) < 1e-10);
  assert.ok(Math.abs(optionPrice('put', 80, 100, 365, 0, .04, european, 0) - (100 * Math.exp(-.04) - 80)) < 1e-10);
  assert.equal(optionPrice('put', 80, 100, 365, 0, .04, american, 0), 20);
  const candidate = Math.log(.04 * 100 / (.02 * 190)) / (.04 - .02);
  const expected = 190 * Math.exp(-.02 * candidate) - 100 * Math.exp(-.04 * candidate);
  assert.ok(candidate > 0 && candidate < 10);
  assert.ok(Math.abs(optionPrice('call', 190, 100, 3650, 0, .04, american, .02) - expected) < 1e-10);
});
