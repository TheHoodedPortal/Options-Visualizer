import test from 'node:test';
import assert from 'node:assert/strict';
import { getTickerSuggestions } from '../src/tickers.js';

test('ranks popular ticker prefixes first, with NVDA leading N suggestions', () => {
  const suggestions = getTickerSuggestions('N');
  assert.equal(suggestions[0].symbol, 'NVDA');
  assert.ok(suggestions.some(ticker => ticker.symbol === 'NFLX'));
  assert.ok(suggestions.length <= 7);
});

test('exact ticker matches outrank other prefix matches', () => {
  assert.equal(getTickerSuggestions('mu')[0].symbol, 'MU');
});

test('company-name prefixes find the related symbol', () => {
  assert.equal(getTickerSuggestions('nvidia')[0].symbol, 'NVDA');
});

test('unknown text returns no suggestions and blank input stays closed', () => {
  assert.deepEqual(getTickerSuggestions('xqz'), []);
  assert.deepEqual(getTickerSuggestions('   '), []);
});
