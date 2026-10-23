export function niceTicks(minimum, maximum, targetCount = 6) {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
    return { step: 1, ticks: [] };
  }

  const roughStep = (maximum - minimum) / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep || 1));
  const fraction = roughStep / magnitude;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
  // Expand to the nearest nice values so the chart never clips its own curve.
  const first = Math.floor(minimum / step + 1e-10) * step;
  const last = Math.ceil(maximum / step - 1e-10) * step;
  const ticks = [];
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 2);
  for (let index = 0; index < 100; index++) {
    const value = Number((first + step * index).toFixed(decimals));
    if (value > last + step * 1e-9) break;
    ticks.push(value);
  }
  return { step, ticks };
}

export function wholeDollarTicks(minimum, maximum, targetCount = 6) {
  const axis = niceTicks(minimum, maximum, targetCount);
  if (axis.step >= 1 || !axis.ticks.length) return axis;
  const step = 1;
  const first = Math.floor(minimum + 1e-10);
  const last = Math.ceil(maximum - 1e-10);
  const ticks = [];
  for (let value = first; value <= last && ticks.length < 100; value += step) ticks.push(value);
  return { step, ticks };
}
