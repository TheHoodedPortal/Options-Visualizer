import test from 'node:test';
import assert from 'node:assert/strict';
import { snapStrike, snapStrikeForDrag, standardStrikeStep } from '../src/strikes.js';
import { closestStrikeAtDelta, contractImpliedVolatility } from '../src/contract-mapping.js';
import { optionDelta, PRICING_MODELS } from '../src/pricing.js';

test('strike spacing includes listed contracts with zero volume', () => {
  const chain = [
    { strike: 100, volume: 10 },
    { strike: 105, volume: 0 },
    { strike: 110, volume: 0 }
  ];
  assert.equal(standardStrikeStep(chain, 105), 5);
  assert.equal(snapStrike(chain, 105, 107), 105);
});

test('uses a sensible stock-price interval when no nearby contracts are present', () => {
  assert.equal(snapStrike([], 20, 22.2), 22);
  assert.equal(snapStrike([], 180, 183.2), 182.5);
  assert.equal(snapStrike([], 1029, 1031.8), 1030);
});

test('dragging a call near an opposite-type leg aligns to its exact strike', () => {
  const chain = [1000, 1010, 1020, 1030, 1040, 1050].map(strike => ({ strike }));
  const call = { id: 1, type: 'call', strike: 1020 };
  const put = { id: 2, type: 'put', strike: 1045 };

  assert.equal(snapStrike(chain, 1029, 1044), 1040);
  assert.equal(snapStrikeForDrag(chain, 1029, 1044, call, [call, put]), 1045);
  assert.equal(snapStrikeForDrag(chain, 1029, 1035, call, [call, put]), 1040);
});

test('maps a contract to the closest listed strike with its target delta', () => {
  const chain = [80, 90, 100, 110, 120].map(strike => ({ type: 'call', strike, iv: .3 }));
  const targetDelta = optionDelta('call', 100, 90, 60, .3, .04, PRICING_MODELS.AMERICAN);
  assert.equal(closestStrikeAtDelta({
    chain,
    type: 'call',
    targetDelta,
    spot: 100,
    days: 60,
    iv: .3,
    model: PRICING_MODELS.AMERICAN
  }), 90);
  assert.equal(closestStrikeAtDelta({ chain, type: 'put', targetDelta, spot: 100, days: 60, iv: .3 }), null);
});

test('normalizes Yahoo implied volatility values and falls back when missing', () => {
  assert.equal(contractImpliedVolatility(.42, .3), .42);
  assert.equal(contractImpliedVolatility(42, .3), .42);
  assert.equal(contractImpliedVolatility(0, .3), .3);
});
