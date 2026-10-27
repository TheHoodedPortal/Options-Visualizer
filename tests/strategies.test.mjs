import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeStrategy, alignPresetStrikes } from '../src/strategies.js';

const leg = (type, side, strike, qty = 1, excluded = false) => ({ type, side, strike, qty, excluded });

test('recognizes a long guts after adding a put to a long call', () => {
  assert.equal(recognizeStrategy([leg('call', 1, 965), leg('put', 1, 995)]), 'long-guts');
});

test('recognizes built-in spreads and straddles only when their legs match', () => {
  assert.equal(recognizeStrategy([leg('call', 1, 100), leg('call', -1, 110)]), 'bull-call-spread');
  assert.equal(recognizeStrategy([leg('put', 1, 110), leg('put', -1, 100)]), 'bear-put-spread');
  assert.equal(recognizeStrategy([leg('call', 1, 100), leg('put', 1, 100)]), 'straddle');
  assert.equal(recognizeStrategy([leg('call', -1, 100), leg('put', -1, 100)]), 'short-straddle');
  assert.equal(recognizeStrategy([leg('put', -1, 90), leg('call', -1, 110)]), 'short-strangle');
  assert.equal(recognizeStrategy([leg('put', 1, 80), leg('put', -1, 90), leg('call', -1, 110), leg('call', 1, 120)]), 'iron-condor');
});

test('leaves unmatched quantities and directions custom, while ignoring excluded legs', () => {
  assert.equal(recognizeStrategy([leg('call', 1, 100), leg('put', 1, 110, 2)]), 'custom');
  assert.equal(recognizeStrategy([leg('call', 1, 100), leg('put', 1, 110, 1, true)]), 'long-call');
});

test('finds ordered listed strikes when initial condor strikes collapse', () => {
  const legs = [
    {type:'put',side:1,strike:100,qty:1}, {type:'put',side:-1,strike:100,qty:1},
    {type:'call',side:-1,strike:100,qty:1}, {type:'call',side:1,strike:100,qty:1}
  ];
  const chain = [90, 95, 100, 105, 110].flatMap(strike => [{type:'put',strike}, {type:'call',strike}]);
  const strikes = alignPresetStrikes('iron-condor', legs, chain);
  assert.ok(strikes[0] < strikes[1] && strikes[1] < strikes[2] && strikes[2] < strikes[3]);
  assert.equal(alignPresetStrikes('iron-condor', legs, [{type:'put',strike:100},{type:'call',strike:100}]), null);
});
