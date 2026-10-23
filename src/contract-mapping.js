import { optionDelta, PRICING_MODELS, RATE } from './pricing.js';

export function contractImpliedVolatility(rawValue, fallback) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return raw > 3 ? raw / 100 : raw;
}

export function closestStrikeAtDelta({
  chain,
  type,
  targetDelta,
  spot,
  days,
  iv,
  ivScale = 1,
  model = PRICING_MODELS.AMERICAN,
  dividendYield = 0
}) {
  if (!Number.isFinite(targetDelta) || !Number.isFinite(spot) || spot <= 0) return null;
  let closest = null;
  let closestDistance = Infinity;
  for (const option of chain) {
    const strike = Number(option.strike);
    if (option.type !== type || !Number.isFinite(strike) || strike <= 0) continue;
    const volatility = contractImpliedVolatility(option.iv, iv) * ivScale;
    const delta = optionDelta(type, spot, strike, days, volatility, RATE, model, dividendYield);
    const distance = Math.abs(delta - targetDelta);
    if (Number.isFinite(distance) && distance < closestDistance) {
      closest = strike;
      closestDistance = distance;
    }
  }
  return closest;
}
