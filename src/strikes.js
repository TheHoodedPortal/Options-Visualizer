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

export function snapStrike(chain, spot, desired) {
  const step = standardStrikeStep(chain, spot);
  return Math.max(step, Number((Math.round(desired / step) * step).toFixed(3)));
}

export function snapStrikeForDrag(chain, spot, desired, movingLeg, legs) {
  const step = standardStrikeStep(chain, spot);
  const nearestOpposite = (legs || [])
    .filter(leg => leg.id !== movingLeg?.id && leg.type !== movingLeg?.type && !leg.excluded)
    .sort((a, b) => Math.abs(a.strike - desired) - Math.abs(b.strike - desired))[0];
  if (nearestOpposite && Math.abs(nearestOpposite.strike - desired) <= step * .75 + 1e-6) return nearestOpposite.strike;
  return snapStrike(chain, spot, desired);
}

