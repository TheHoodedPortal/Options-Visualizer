export function recognizeStrategy(legs) {
  const positions = legs.filter(leg => !leg.excluded);
  if (positions.length === 1) {
    const [leg] = positions;
    if (leg.side === 1 && leg.qty > 0) return leg.type === 'call' ? 'long-call' : 'long-put';
    return 'custom';
  }

  const equalQuantity = positions.every(leg => leg.qty === positions[0]?.qty);
  if (!equalQuantity) return 'custom';

  if (positions.length === 2) {
    const [a, b] = positions;
    const call = a.type === 'call' ? a : b.type === 'call' ? b : null;
    const put = a.type === 'put' ? a : b.type === 'put' ? b : null;
    if (call && put) {
      if (call.side === 1 && put.side === 1) {
        if (call.strike === put.strike) return 'straddle';
        return call.strike < put.strike ? 'long-guts' : 'long-strangle';
      }
      if (call.side === -1 && put.side === -1) {
        if (call.strike === put.strike) return 'short-straddle';
        return put.strike < call.strike ? 'short-strangle' : 'custom';
      }
    }

    if (a.type === 'call' && b.type === 'call' && a.side !== b.side) {
      const long = a.side === 1 ? a : b;
      const short = a.side === -1 ? a : b;
      return long.strike < short.strike ? 'bull-call-spread' : 'custom';
    }
    if (a.type === 'put' && b.type === 'put' && a.side !== b.side) {
      const long = a.side === 1 ? a : b;
      const short = a.side === -1 ? a : b;
      return long.strike > short.strike ? 'bear-put-spread' : 'custom';
    }
    return 'custom';
  }

  if (positions.length === 4) {
    const puts = positions.filter(leg => leg.type === 'put');
    const calls = positions.filter(leg => leg.type === 'call');
    if (puts.length === 2 && calls.length === 2) {
      const longPut = puts.find(leg => leg.side === 1);
      const shortPut = puts.find(leg => leg.side === -1);
      const shortCall = calls.find(leg => leg.side === -1);
      const longCall = calls.find(leg => leg.side === 1);
      if (longPut && shortPut && shortCall && longCall &&
          longPut.strike < shortPut.strike && shortPut.strike < shortCall.strike &&
          shortCall.strike < longCall.strike) return 'iron-condor';
    }
  }
  return 'custom';
}

// Find the closest ordered set of actual contracts for a multi-leg preset.
export function alignPresetStrikes(strategy, legs, chain) {
  const roles = { 'bull-call-spread': [['call', 1], ['call', -1]],
    'bear-put-spread': [['put', -1], ['put', 1]],
    'long-guts': [['call', 1], ['put', 1]],
    'long-strangle': [['put', 1], ['call', 1]],
    'short-strangle': [['put', -1], ['call', -1]],
    'iron-condor': [['put', 1], ['put', -1], ['call', -1], ['call', 1]] }[strategy];
  const order = roles?.map(([type, side]) => legs.findIndex(leg => !leg.excluded && leg.type === type && leg.side === side));
  const values = type => [...new Set(chain.filter(option => option.type === type)
    .map(option => Number(option.strike)).filter(value => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
  if (strategy === 'straddle' || strategy === 'short-straddle') {
    const puts = new Set(values('put'));
    const common = values('call').filter(strike => puts.has(strike));
    const active = legs.map((leg, index) => ({ leg, index })).filter(item => !item.leg.excluded);
    if (!common.length || active.length !== 2) return null;
    const strike = common.reduce((best, n) => active.reduce((sum, item) => sum + Math.abs(n - item.leg.strike), 0) < active.reduce((sum, item) => sum + Math.abs(best - item.leg.strike), 0) ? n : best);
    return legs.map(leg => leg.excluded ? leg.strike : strike);
  }
  if (!order || order.some(index => index < 0) || new Set(order).size !== order.length) return null;
  let previous = [];
  for (let step = 0; step < order.length; step++) {
    const index = order[step];
    const current = [];
    let p = 0, best = null;
    for (const strike of values(legs[index].type)) {
      while (p < previous.length && previous[p].strike < strike) {
        if (!best || previous[p].score < best.score) best = previous[p];
        p++;
      }
      if (step && !best) continue;
      const path = best ? [...best.path] : legs.map(leg => leg.strike);
      path[index] = strike;
      current.push({ strike, path, score: (best?.score || 0) + Math.abs(strike - legs[index].strike) });
    }
    if (!current.length) return null;
    previous = current;
  }
  return previous.reduce((best, item) => item.score < best.score ? item : best).path;
}
