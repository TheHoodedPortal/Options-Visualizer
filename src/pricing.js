export const RATE = 0.04;
export const MULTIPLIER = 100;
export const PRICING_MODELS = Object.freeze({
  AMERICAN: 'bjerksund-stensland',
  EUROPEAN: 'black-scholes'
});

export function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

export function intrinsic(type, spot, strike) {
  return type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
}

function generalizedBlackScholes(type, spot, strike, years, volatility, rate, costOfCarry) {
  if (years <= 0 || volatility <= 0) return intrinsic(type, spot, strike);
  if (spot <= 0) return type === 'put' ? strike * Math.exp(-rate * years) : 0;
  const sigmaTime = volatility * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (costOfCarry + volatility * volatility / 2) * years) / sigmaTime;
  const d2 = d1 - sigmaTime;
  const discountedSpot = spot * Math.exp((costOfCarry - rate) * years);
  const discountedStrike = strike * Math.exp(-rate * years);
  if (type === 'call') return Math.max(0, discountedSpot * normalCdf(d1) - discountedStrike * normalCdf(d2));
  return Math.max(0, discountedStrike * normalCdf(-d2) - discountedSpot * normalCdf(-d1));
}

function gaussLegendre(order) {
  const points = [];
  const half = Math.ceil(order / 2);
  for (let index = 0; index < half; index++) {
    let root = Math.cos(Math.PI * (index + .75) / (order + .5));
    let derivative = 0;
    for (let iteration = 0; iteration < 12; iteration++) {
      let previous = 1, current = root;
      for (let degree = 2; degree <= order; degree++) {
        const next = ((2 * degree - 1) * root * current - (degree - 1) * previous) / degree;
        previous = current;
        current = next;
      }
      derivative = order * (root * current - previous) / (root * root - 1);
      const adjustment = current / derivative;
      root -= adjustment;
      if (Math.abs(adjustment) < 1e-15) break;
    }
    const weight = 2 / ((1 - root * root) * derivative * derivative);
    points.push({ node: -root, weight }, { node: root, weight });
  }
  return points.slice(0, order).sort((a, b) => a.node - b.node);
}

const GAUSS_LEGENDRE_20 = gaussLegendre(20);

// Plackett's identity reduces the bivariate normal CDF to a smooth one-dimensional
// integral. The Bjerksund–Stensland 2002 formula only needs correlations near ±0.786.
export function bivariateNormalCdf(a, b, correlation) {
  const rho = Math.max(-.999999, Math.min(.999999, correlation));
  if (Math.abs(rho) < 1e-12) return normalCdf(a) * normalCdf(b);
  if (rho > .9999) return normalCdf(Math.min(a, b));
  if (rho < -.9999) return Math.max(0, normalCdf(a) - normalCdf(-b));
  let integral = 0;
  for (const { node, weight } of GAUSS_LEGENDRE_20) {
    const t = rho * (node + 1) / 2;
    const denominator = 1 - t * t;
    const exponent = -(a * a - 2 * a * b * t + b * b) / (2 * denominator);
    integral += weight * Math.exp(exponent) / Math.sqrt(denominator);
  }
  const result = normalCdf(a) * normalCdf(b) + rho * integral / (4 * Math.PI);
  return Math.max(0, Math.min(normalCdf(a), normalCdf(b), result));
}

function bjerksundPhi(spot, years, gamma, trigger, reflection, rate, carry, volatility) {
  const sigmaTime = volatility * Math.sqrt(years);
  const drift = carry + (gamma - .5) * volatility * volatility;
  const d1 = -(Math.log(spot / trigger) + drift * years) / sigmaTime;
  const d2 = d1 - 2 * Math.log(reflection / spot) / sigmaTime;
  const lambda = -rate + gamma * carry + .5 * gamma * (gamma - 1) * volatility * volatility;
  const kappa = 2 * carry / (volatility * volatility) + 2 * gamma - 1;
  return Math.exp(lambda * years) * spot ** gamma * (normalCdf(d1) - (reflection / spot) ** kappa * normalCdf(d2));
}

function bjerksundPsi(spot, years, gamma, high, secondBoundary, firstBoundary, split, rate, carry, volatility) {
  const sigmaSplit = volatility * Math.sqrt(split);
  const sigmaTime = volatility * Math.sqrt(years);
  const driftSplit = (carry + (gamma - .5) * volatility * volatility) * split;
  const driftTime = (carry + (gamma - .5) * volatility * volatility) * years;
  const d1 = (Math.log(spot / firstBoundary) + driftSplit) / sigmaSplit;
  const d3 = (Math.log(spot / firstBoundary) - driftSplit) / sigmaSplit;
  const d2 = (Math.log(secondBoundary ** 2 / (spot * firstBoundary)) + driftSplit) / sigmaSplit;
  const d4 = (Math.log(secondBoundary ** 2 / (spot * firstBoundary)) - driftSplit) / sigmaSplit;
  const e1 = (Math.log(spot / high) + driftTime) / sigmaTime;
  const e2 = (Math.log(secondBoundary ** 2 / (spot * high)) + driftTime) / sigmaTime;
  const e3 = (Math.log(firstBoundary ** 2 / (spot * high)) + driftTime) / sigmaTime;
  const e4 = (Math.log(spot * firstBoundary ** 2 / (high * secondBoundary ** 2)) + driftTime) / sigmaTime;
  const tau = Math.sqrt(split / years);
  const lambda = -rate + gamma * carry + .5 * gamma * (gamma - 1) * volatility * volatility;
  const kappa = 2 * carry / (volatility * volatility) + 2 * gamma - 1;
  return Math.exp(lambda * years) * spot ** gamma * (
    bivariateNormalCdf(-d1, -e1, tau)
    - (secondBoundary / spot) ** kappa * bivariateNormalCdf(-d2, -e2, tau)
    - (firstBoundary / spot) ** kappa * bivariateNormalCdf(-d3, -e3, -tau)
    + (firstBoundary / secondBoundary) ** kappa * bivariateNormalCdf(-d4, -e4, -tau)
  );
}

function bjerksundStenslandCall(spot, strike, years, rate, carry, volatility) {
  const european = generalizedBlackScholes('call', spot, strike, years, volatility, rate, carry);
  if (carry >= rate || spot <= 0) return european;

  const variance = volatility * volatility;
  const betaTerm = carry / variance - .5;
  const beta = .5 - carry / variance + Math.sqrt(betaTerm * betaTerm + 2 * rate / variance);
  if (!Number.isFinite(beta) || beta <= 1) return european;

  const split = .5 * (Math.sqrt(5) - 1) * years;
  const infinityBoundary = beta / (beta - 1) * strike;
  const denominator = rate - carry;
  const zeroBoundary = Math.max(strike, Math.abs(denominator) < 1e-12 ? Infinity : rate / denominator * strike);
  if (!Number.isFinite(zeroBoundary) || infinityBoundary <= zeroBoundary) return european;

  const boundaryScale = strike * strike / ((infinityBoundary - zeroBoundary) * zeroBoundary);
  const h1 = -(carry * split + 2 * volatility * Math.sqrt(split)) * boundaryScale;
  const h2 = -(carry * years + 2 * volatility * Math.sqrt(years)) * boundaryScale;
  const firstBoundary = zeroBoundary + (infinityBoundary - zeroBoundary) * (1 - Math.exp(h1));
  const secondBoundary = zeroBoundary + (infinityBoundary - zeroBoundary) * (1 - Math.exp(h2));
  if (spot >= secondBoundary) return Math.max(european, spot - strike);

  const alpha1 = (firstBoundary - strike) * firstBoundary ** (-beta);
  const alpha2 = (secondBoundary - strike) * secondBoundary ** (-beta);
  const value = alpha2 * spot ** beta
    - alpha2 * bjerksundPhi(spot, split, beta, secondBoundary, secondBoundary, rate, carry, volatility)
    + bjerksundPhi(spot, split, 1, secondBoundary, secondBoundary, rate, carry, volatility)
    - bjerksundPhi(spot, split, 1, firstBoundary, secondBoundary, rate, carry, volatility)
    - strike * bjerksundPhi(spot, split, 0, secondBoundary, secondBoundary, rate, carry, volatility)
    + strike * bjerksundPhi(spot, split, 0, firstBoundary, secondBoundary, rate, carry, volatility)
    + alpha1 * bjerksundPhi(spot, split, beta, firstBoundary, secondBoundary, rate, carry, volatility)
    - alpha1 * bjerksundPsi(spot, years, beta, firstBoundary, secondBoundary, firstBoundary, split, rate, carry, volatility)
    + bjerksundPsi(spot, years, 1, firstBoundary, secondBoundary, firstBoundary, split, rate, carry, volatility)
    - bjerksundPsi(spot, years, 1, strike, secondBoundary, firstBoundary, split, rate, carry, volatility)
    - strike * bjerksundPsi(spot, years, 0, firstBoundary, secondBoundary, firstBoundary, split, rate, carry, volatility)
    + strike * bjerksundPsi(spot, years, 0, strike, secondBoundary, firstBoundary, split, rate, carry, volatility);
  return Math.max(intrinsic('call', spot, strike), european, Number.isFinite(value) ? value : european);
}

function bjerksundStensland(type, spot, strike, years, rate, carry, volatility) {
  if (type === 'call') return bjerksundStenslandCall(spot, strike, years, rate, carry, volatility);
  // Put–call transformation from Bjerksund & Stensland (2002).
  const transformed = bjerksundStenslandCall(strike, spot, years, rate - carry, -carry, volatility);
  return Math.max(intrinsic('put', spot, strike), transformed);
}

export function optionPrice(type, spot, strike, days, volatility, rate = RATE, model = 'black-scholes', dividendYield = 0) {
  if (days <= 0 || volatility <= 0) return intrinsic(type, spot, strike);
  if (spot <= 0 && model === PRICING_MODELS.AMERICAN) return intrinsic(type, spot, strike);
  const years = days / 365;
  const carry = rate - dividendYield;
  if (model === PRICING_MODELS.AMERICAN) return bjerksundStensland(type, spot, strike, years, rate, carry, volatility);
  return generalizedBlackScholes(type, spot, strike, years, volatility, rate, carry);
}

export function optionGreeks(type, spot, strike, days, volatility, rate = RATE, model = 'black-scholes', dividendYield = 0) {
  if (days <= 0 || volatility <= 0 || spot <= 0) {
    const delta = type === 'call'
      ? (spot > strike ? 1 : spot < strike ? 0 : .5)
      : (spot < strike ? -1 : spot > strike ? 0 : -.5);
    return { delta, gamma: 0, theta: 0, vega: 0 };
  }
  if (model === PRICING_MODELS.AMERICAN) {
    const value = optionPrice(type, spot, strike, days, volatility, rate, model, dividendYield);
    const spotStep = Math.min(Math.max(.01, spot * .0001), spot * .25);
    const up = optionPrice(type, spot + spotStep, strike, days, volatility, rate, model, dividendYield);
    const down = optionPrice(type, spot - spotStep, strike, days, volatility, rate, model, dividendYield);
    const delta = (up - down) / (2 * spotStep);
    const gamma = (up - 2 * value + down) / (spotStep * spotStep);
    const theta = optionPrice(type, spot, strike, days - 1, volatility, rate, model, dividendYield) - value;
    const volatilityStep = Math.min(.005, volatility / 2);
    const highVol = volatility + volatilityStep;
    const lowVol = Math.max(.0001, volatility - volatilityStep);
    const vega = (optionPrice(type, spot, strike, days, highVol, rate, model, dividendYield)
      - optionPrice(type, spot, strike, days, lowVol, rate, model, dividendYield)) * .01 / (highVol - lowVol);
    return { delta, gamma, theta, vega };
  }
  const years = days / 365;
  const rootTime = Math.sqrt(years);
  const sigmaTime = volatility * rootTime;
  const carry = rate - dividendYield;
  const d1 = (Math.log(spot / strike) + (carry + volatility * volatility / 2) * years) / sigmaTime;
  const d2 = d1 - sigmaTime;
  const density = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
  const discountedSpot = spot * Math.exp((carry - rate) * years);
  const discountedStrike = strike * Math.exp(-rate * years);
  const delta = type === 'call' ? Math.exp((carry - rate) * years) * normalCdf(d1) : Math.exp((carry - rate) * years) * (normalCdf(d1) - 1);
  const gamma = Math.exp((carry - rate) * years) * density / (spot * sigmaTime);
  const thetaAnnual = -(discountedSpot * density * volatility) / (2 * rootTime) + (type === 'call'
    ? dividendYield * discountedSpot * normalCdf(d1) - rate * discountedStrike * normalCdf(d2)
    : -dividendYield * discountedSpot * normalCdf(-d1) + rate * discountedStrike * normalCdf(-d2));
  const vega = discountedSpot * density * rootTime;
  return { delta, gamma, theta: thetaAnnual / 365, vega: vega / 100 };
}

export function optionDelta(type, spot, strike, days, volatility, rate = RATE, model = 'black-scholes', dividendYield = 0) {
  if (days <= 0 || volatility <= 0 || spot <= 0) {
    return type === 'call'
      ? (spot > strike ? 1 : spot < strike ? 0 : .5)
      : (spot < strike ? -1 : spot > strike ? 0 : -.5);
  }
  if (model === PRICING_MODELS.AMERICAN) {
    const spotStep = Math.min(Math.max(.01, spot * .0001), spot * .25);
    const up = optionPrice(type, spot + spotStep, strike, days, volatility, rate, model, dividendYield);
    const down = optionPrice(type, spot - spotStep, strike, days, volatility, rate, model, dividendYield);
    return (up - down) / (2 * spotStep);
  }
  const years = days / 365;
  const sigmaTime = volatility * Math.sqrt(years);
  const carry = rate - dividendYield;
  const d1 = (Math.log(spot / strike) + (carry + volatility * volatility / 2) * years) / sigmaTime;
  return Math.exp((carry - rate) * years) * (type === 'call' ? normalCdf(d1) : normalCdf(d1) - 1);
}

export function strategyGreeks(state, daysForward = 0, ivMultiplier = 1) {
  const days = Math.max(0, daysUntil(state.expiry) - daysForward);
  const greeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const leg of activeLegs(state)) {
    const option = optionGreeks(leg.type, state.spot, leg.strike, days, state.iv * ivMultiplier, RATE, state.model, state.dividendYield);
    const quantity = leg.side * leg.qty * MULTIPLIER;
    for (const key of Object.keys(greeks)) greeks[key] += option[key] * quantity;
  }
  return greeks;
}

export function daysUntil(dateString, today = new Date()) {
  const date = new Date(dateString + 'T00:00:00');
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((date - start) / 86400000));
}

export function activeLegs(state) {
  return state.legs.filter(leg => !leg.excluded);
}

export function netDebit(state) {
  return activeLegs(state).reduce((total, leg) => total + leg.side * leg.qty * leg.premium * MULTIPLIER, 0);
}

export function profitLoss(state, stockPrice, daysForward = 0, ivMultiplier = 1) {
  const remaining = Math.max(0, daysUntil(state.expiry) - daysForward);
  return activeLegs(state).reduce((sum, leg) => {
    const fair = optionPrice(leg.type, stockPrice, leg.strike, remaining, state.iv * ivMultiplier, RATE, state.model, state.dividendYield);
    return sum + leg.side * leg.qty * MULTIPLIER * (fair - leg.premium);
  }, 0);
}

export function contractValue(state, stockPrice, daysForward = 0, ivMultiplier = 1) {
  const remaining = Math.max(0, daysUntil(state.expiry) - daysForward);
  return activeLegs(state).reduce((sum, leg) => {
    const fair = optionPrice(leg.type, stockPrice, leg.strike, remaining, state.iv * ivMultiplier, RATE, state.model, state.dividendYield);
    return sum + leg.side * leg.qty * MULTIPLIER * fair;
  }, 0);
}

export function expirationStats(state) {
  const legs = activeLegs(state);
  if (!legs.length) return { maxLoss: 0, maxProfit: 0, breakevens: [] };
  const strikes = [...new Set(legs.map(leg => leg.strike))].sort((a, b) => a - b);
  const points = [0, ...strikes].map(price => ({ price, value: profitLoss(state, price, daysUntil(state.expiry)) }));
  const rightSlope = legs.reduce((sum, leg) => sum + (leg.type === 'call' ? leg.side * leg.qty * MULTIPLIER : 0), 0);
  const values = points.map(point => point.value);
  const maxProfit = rightSlope > 0 ? Infinity : Math.max(...values);
  const maxLoss = rightSlope < 0 ? Infinity : -Math.min(...values);
  const roots = [];
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1];
    const right = points[i];
    if (left.value === 0) roots.push(left.price);
    if (left.value * right.value < 0) {
      roots.push(left.price + (right.price - left.price) * -left.value / (right.value - left.value));
    }
  }
  const last = points[points.length - 1];
  if (last.value === 0) roots.push(last.price);
  if (rightSlope !== 0) {
    const root = last.price - last.value / rightSlope;
    if (root > last.price + 1e-8) roots.push(root);
  }
  const breakevens = [...new Set(roots.map(value => Math.round(value * 100) / 100))].sort((a, b) => a - b);
  return { maxLoss: Math.max(0, maxLoss), maxProfit: Math.max(0, maxProfit), breakevens };
}

export function outputValue(state, stockPrice, daysForward, output, ivMultiplier = 1) {
  const pnl = profitLoss(state, stockPrice, daysForward, ivMultiplier);
  if (output === 'value') return contractValue(state, stockPrice, daysForward, ivMultiplier);
  const capital = Math.abs(netDebit(state));
  if (output === 'percent') return capital > 1e-9 ? pnl / capital * 100 : NaN;
  if (output === 'risk') {
    const risk = expirationStats(state).maxLoss;
    return Number.isFinite(risk) && risk > 0 ? pnl / risk * 100 : NaN;
  }
  return pnl;
}

