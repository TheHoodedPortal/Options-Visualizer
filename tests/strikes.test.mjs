import test from 'node:test';
import assert from 'node:assert/strict';
import { snapStrike, snapStrikeForDrag, standardStrikeStep, adjacentStrike } from '../src/strikes.js';
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

test('dragging does not snap to an unlisted opposite-type strike', () => {
  const chain = [1000, 1010, 1020, 1030, 1040, 1050].map(strike => ({ type: 'call', strike }));
  const call = { id: 1, type: 'call', strike: 1020 };
  const put = { id: 2, type: 'put', strike: 1045 };

  assert.equal(snapStrike(chain, 1029, 1044), 1040);
  assert.equal(snapStrikeForDrag(chain, 1029, 1044, call, [call, put]), 1040);
  assert.equal(snapStrikeForDrag(chain, 1029, 1035, call, [call, put]), 1030);
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

test('preserves Yahoo decimal implied volatility and falls back when missing', () => {
  assert.equal(contractImpliedVolatility(.42, .3), .42);
  assert.equal(contractImpliedVolatility(3.5, .3), 3.5);
  assert.equal(contractImpliedVolatility(5, .3), 5);
  assert.equal(contractImpliedVolatility(42, .3), 42);
  assert.equal(contractImpliedVolatility(0, .3), .3);
});

test('snaps to actual strikes for the requested option type', () => {
  const chain = [{ type: 'call', strike: 92.5 }, { type: 'call', strike: 97.5 }, { type: 'put', strike: 100 }];
  assert.equal(snapStrike(chain, 100, 97.5, 'call'), 97.5);
  assert.equal(snapStrike(chain, 100, 97.5, 'put'), 100);
});

test('keyboard movement reaches adjacent strikes across uneven grids', () => {
  const chain = [{type: 'call', strike: 90}, {type: 'call', strike: 90.5}, {type: 'call', strike: 100}, {type: 'put', strike: 95}];
  assert.equal(adjacentStrike(chain, 95, 90.5, 'call', 1), 100);
  assert.equal(adjacentStrike(chain, 95, 100, 'call', -1), 90.5);
  assert.equal(adjacentStrike(chain, 95, 100, 'call', 1), 100);
  assert.equal(adjacentStrike([], 20, 20, 'call', -1), 19.5);
});

test('connected chains never invent strikes for a missing option type', () => {
  const chain = [{type: 'call', strike: 92.5}, {type: 'call', strike: 97.5}];
  assert.equal(snapStrike(chain, 95, 95, 'put'), null);
  assert.equal(snapStrike([], 95, 95, 'put', true), null);
  assert.equal(adjacentStrike(chain, 95, 95, 'put', 1), null);
  assert.equal(snapStrikeForDrag(chain, 95, 95, {type:'put'}, []), null);
  assert.equal(snapStrikeForDrag([], 95, 95, {id: 1, type:'put'}, [{id: 2, type:'call', strike:95}], true), null);
  assert.equal(snapStrike([], 95, 95, 'put', false), 95);
});

test('delta mapping retains extremely high decimal volatility', () => {
  const chain = [80, 100, 120].map(strike => ({ type: 'call', strike, iv: 3.5 }));
  const target = optionDelta('call', 100, 120, 60, 3.5, .04, PRICING_MODELS.EUROPEAN);
  assert.equal(closestStrikeAtDelta({ chain, type: 'call', targetDelta: target, spot: 100, days: 60, iv: .3, model: PRICING_MODELS.EUROPEAN }), 120);
});
