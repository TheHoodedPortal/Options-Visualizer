import assert from 'node:assert/strict';
import test from 'node:test';
import { niceTicks, wholeDollarTicks } from '../src/chart-scale.js';

test('nice chart bounds round outward and keep the full payoff in frame', () => {
  const axis = niceTicks(-5945, 9160, 6);

  assert.equal(axis.step, 5000);
  assert.deepEqual(axis.ticks, [-10000, -5000, 0, 5000, 10000]);
  assert.ok(axis.ticks[0] <= -5945);
  assert.ok(axis.ticks.at(-1) >= 9160);
});

test('nice chart ticks use readable whole-dollar intervals for smaller payoffs', () => {
  const axis = niceTicks(-2.4, 3.1, 6);

  assert.equal(axis.step, 1);
  assert.deepEqual(axis.ticks, [-3, -2, -1, 0, 1, 2, 3, 4]);
});

test('small unit ranges retain a useful fractional tick interval', () => {
  const axis = niceTicks(-0.42, 0.62, 6);

  assert.equal(axis.step, 0.2);
  assert.deepEqual(axis.ticks, [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8]);
});

test('price ticks use clean whole-dollar steps and rounded bounds', () => {
  const axis = wholeDollarTicks(875, 1183, 20);

  assert.equal(axis.step, 20);
  assert.deepEqual(axis.ticks.slice(0, 3), [860, 880, 900]);
  assert.equal(axis.ticks.at(-1), 1200);
  assert.ok(axis.ticks[0] <= 875);
  assert.ok(axis.ticks.at(-1) >= 1183);
});

test('price ticks stay whole dollars for a sub-dollar underlying', () => {
  const axis = wholeDollarTicks(0.12, 0.87, 8);

  assert.equal(axis.step, 1);
  assert.deepEqual(axis.ticks, [0, 1]);
});
