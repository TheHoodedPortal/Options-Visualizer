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
