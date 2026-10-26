export function standardStrikeStep(chain, spot) {
  const nearby = [...new Set((chain || []).map(option => Number(option.strike)).filter(strike =>
    Number.isFinite(strike) && Math.abs(strike - spot) <= Math.max(25, spot * .08)
  ))].sort((a, b) => a - b);
  const gaps = nearby.slice(1).map((strike, index) => strike - nearby[index]).filter(gap => gap >= .05);
  if (gaps.length) {
    const smallest = Math.min(...gaps);
    if (smallest <= 25) return Number(smallest.toFixed(3));
  }
  if (spot < 25) return .5;
  if (spot < 100) return 1;
  if (spot < 300) return 2.5;
  return 5;
}

export function snapStrike(chain, spot, desired, type = null, connected = Boolean(chain?.length)) {
  const listed = (chain || []).filter(option => !type || option.type === type).map(option => Number(option.strike)).filter(strike => Number.isFinite(strike) && strike > 0);
  if (listed.length) return listed.reduce((best, strike) => Math.abs(strike - desired) < Math.abs(best - desired) ? strike : best);
  if (connected) return null;
  const step = standardStrikeStep(chain, spot);
  return Math.max(step, Number((Math.round(desired / step) * step).toFixed(3)));
}

export function snapStrikeForDrag(chain, spot, desired, movingLeg, legs, connected = Boolean(chain?.length)) {
  const step = standardStrikeStep(chain, spot);
  const nearestOpposite = (legs || [])
    .filter(leg => leg.id !== movingLeg?.id && leg.type !== movingLeg?.type && !leg.excluded)
    .sort((a, b) => Math.abs(a.strike - desired) - Math.abs(b.strike - desired))[0];
  const listedForType = (chain || []).filter(option => option.type === movingLeg?.type);
  if (nearestOpposite && Math.abs(nearestOpposite.strike - desired) <= step * .75 + 1e-6 && (!connected || listedForType.some(option => option.strike === nearestOpposite.strike))) return nearestOpposite.strike;
  return snapStrike(chain, spot, desired, movingLeg?.type, connected);
}


// Move to an adjacent listed strike even when the grid has uneven gaps.
export function adjacentStrike(chain, spot, current, type, direction, connected = Boolean(chain?.length)) {
  const strikes = [...new Set((chain || []).filter(option => option.type === type)
    .map(option => Number(option.strike)).filter(strike => Number.isFinite(strike) && strike > 0))].sort((a, b) => a - b);
  if (strikes.length) {
    const next = direction > 0 ? strikes.find(strike => strike > current + 1e-8) : [...strikes].reverse().find(strike => strike < current - 1e-8);
    return next ?? current;
  }
  if (connected) return null;
  return snapStrike([], spot, Math.max(.01, current + direction * standardStrikeStep([], spot)), type);
}
