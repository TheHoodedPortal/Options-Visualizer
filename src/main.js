import { YFinanceClient } from './yfinance.js';
import { optionPrice, optionDelta, daysUntil, addCalendarDays, profitLoss, contractValue, outputValue, netDebit, expirationStats, activeLegs, strategyGreeks, MULTIPLIER, PRICING_MODELS, RATE } from './pricing.js';
import { closestStrikeAtDelta, contractImpliedVolatility } from './contract-mapping.js';
import { recognizeStrategy } from './strategies.js';
import { snapStrike, snapStrikeForDrag, adjacentStrike } from './strikes.js';
import { getTickerSuggestions } from './tickers.js';
import { niceTicks, wholeDollarTicks } from './chart-scale.js';

const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const names = {
  'long-call': 'Long Call', 'long-put': 'Long Put', 'bull-call-spread': 'Bull Call Spread',
  'bear-put-spread': 'Bear Put Spread', straddle: 'Long Straddle', 'short-straddle': 'Short Straddle',
  'short-strangle': 'Short Strangle', 'iron-condor': 'Iron Condor',
  'long-guts': 'Long Guts', 'long-strangle': 'Long Strangle', custom: 'Custom Strategy'
};
const currency = () => market.connected && market.quote?.currency ? market.quote.currency : null;
const currencyLabel = () => currency() || 'Currency';
const currencyPrefix = () => currencyLabel() + ' ';
const money = (n, decimals = 0) => Number.isFinite(n) ? currencyPrefix() + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : 'Infinite';
const signed = (n, suffix = '') => Number.isFinite(n) ? (n < 0 ? '−' : '+') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 1 }) + suffix : '—';
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const today = new Date();
let startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
const iso = date => date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
const dateAfter = days => addCalendarDays(startDate, days);
const displayDate = date => new Date(date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const defaultExpiry = today <= new Date('2026-11-13T00:00:00') ? '2026-11-13' : iso(dateAfter(36));
let market = { client: null, connected: false, quote: null, expirations: [], chain: [], loading: true, error: '' };
let marketRequestVersion = 0;
let restoredFromLink = false;
let state = {
  symbol: 'MU', spot: 1047.60, iv: 0.465, expiry: defaultExpiry, strategy: 'long-call',
  legs: [{ id: 1, type: 'call', side: 1, strike: 1050, qty: 1, premium: 62, manual: false, excluded: false }],
  day: 0, range: 15, ivScale: 1, output: 'pl', model: PRICING_MODELS.AMERICAN, dividendYield: 0, dividendYieldMode: 'auto'
};
let toastTimer;
let modalReturnFocus = null;
let drag = null;
let dragHoldTimer = 0;
let contractEditorLegId = null;
let chartTargetModel = null;
let displayedChartModel = null;
let chartAnimationFrame = 0;
let chartAnimationLastFrame = 0;
let dragFrame = 0;
let tickerActiveIndex = -1;
let requestedSymbol = '';
let tickerCommitVersion = 0;
let marketRetryAt = 0;
let marketStatusTimer = 0;
const axisMeasure = document.createElement('canvas').getContext('2d');
let strategyPreviewSignature = '';
const payoffExamples = {
  'long-call': [[3,25],[25,25],[61,3]],
  'long-put': [[3,3],[39,25],[61,25]],
  'bull-call-spread': [[3,25],[20,25],[44,7],[61,7]],
  'bear-put-spread': [[3,7],[20,7],[44,25],[61,25]],
  straddle: [[3,3],[32,27],[61,3]],
  'short-straddle': [[3,29],[32,5],[61,29]],
  'long-guts': [[3,3],[23,25],[41,25],[61,3]],
  'long-strangle': [[3,3],[23,25],[41,25],[61,3]],
  'short-strangle': [[3,29],[23,7],[41,7],[61,29]],
  'iron-condor': [[3,26],[13,26],[24,7],[40,7],[51,26],[61,26]],
  custom: [[3,25],[17,25],[30,7],[44,7],[61,23]]
};

const boundedNumber = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, min, max) : fallback;
};
function safeState(raw) {
  if (!raw || !Array.isArray(raw.legs)) return null;
  const legs = raw.legs.slice(0, 16).filter(leg => leg && typeof leg === 'object').map((leg, index) => ({
    id: index + 1, type: leg.type === 'put' ? 'put' : 'call', side: leg.side === -1 ? -1 : 1,
    strike: boundedNumber(leg?.strike, 100, .01, 1000000), qty: Math.round(boundedNumber(leg?.qty, 1, 1, 100)),
    premium: boundedNumber(leg?.premium, 0, 0, 1000000), manual: !!leg.manual, excluded: !!leg.excluded
  }));
  if (!legs.length) return null;
  const expiryDate = new Date(String(raw.expiry) + 'T00:00:00');
  const validExpiry = /^\d{4}-\d{2}-\d{2}$/.test(raw.expiry) && Number.isFinite(expiryDate.getTime()) && iso(expiryDate) === raw.expiry && Math.abs(expiryDate - startDate) <= 3660 * 86400000;
  const expiry = validExpiry ? raw.expiry : defaultExpiry;
  return {
    symbol: /^[A-Z0-9.^=-]{1,12}$/.test(String(raw.symbol || '').toUpperCase()) ? String(raw.symbol).toUpperCase() : 'MU', spot: boundedNumber(raw.spot, 100, .01, 1000000),
    iv: boundedNumber(raw.iv, .35, .01, 3), expiry,
    strategy: names[raw.strategy] ? raw.strategy : 'custom', legs,
    day: boundedNumber(raw.day, 0, 0, daysUntil(expiry)),
    range: boundedNumber(raw.range, 15, 5, 50), ivScale: boundedNumber(raw.ivScale, 1, .4, 2),
    output: ['pl', 'percent', 'value', 'risk'].includes(raw.output) ? raw.output : 'pl',
    model: [PRICING_MODELS.AMERICAN, PRICING_MODELS.EUROPEAN].includes(raw.model) ? raw.model : PRICING_MODELS.AMERICAN,
    dividendYield: boundedNumber(raw.dividendYield, 0, 0, .25),
    dividendYieldMode: raw.dividendYieldMode === 'manual' ? 'manual' : 'auto'
  };
}
try {
  const encoded = new URLSearchParams(location.search).get('s');
  if (encoded) {
    const loaded = safeState(JSON.parse(atob(encoded)));
    if (loaded) { state = loaded; restoredFromLink = true; }
  }
} catch {}
let nextId = Math.max(...state.legs.map(leg => leg.id)) + 1;

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function svgNode(tag, attributes = {}) {
  const item = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
  return item;
}
function clear(item) { item.replaceChildren(); }
function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}
function availableStrike(type, desired) {
  return snapStrike(market.connected ? market.chain : [], state.spot, desired, type, market.connected);
}
function samplePremium(type, strike) {
  if (market.connected) {
    const quote = market.chain.find(option => option.type === type && Math.abs(option.strike - strike) < .001);
    if (quote) {
      const bid = Number(quote.bid), ask = Number(quote.ask);
      if (bid >= 0 && ask > 0 && bid <= ask) return Math.round((bid + ask) * 50) / 100;
      if (Number(quote.last) > 0) return Number(quote.last);
    }
  }
  return Math.max(.01, Math.round(optionPrice(type, state.spot, strike, daysUntil(state.expiry), state.iv, RATE, state.model, state.dividendYield) * 100) / 100);
}
function classifyStrategy() {
  state.strategy = recognizeStrategy(state.legs);
  $('strategy-select').value = state.strategy;
}
function makeLeg(type, side, strike, qty = 1) {
  strike = availableStrike(type, strike);
  return { id: nextId++, type, side, strike, qty, premium: samplePremium(type, strike), manual: false, excluded: false };
}
function preset(key) {
  const needsCall = !['long-put', 'bear-put-spread'].includes(key);
  const needsPut = !['long-call', 'bull-call-spread'].includes(key);
  if ((needsCall && availableStrike('call', state.spot) == null) || (needsPut && availableStrike('put', state.spot) == null)) { showToast('This expiration has no listed contracts for the selected strategy.'); $('strategy-select').value = state.strategy; return; }
  const at = Math.round(state.spot / 5) * 5;
  const width = Math.max(5, Math.round(state.spot * .05 / 5) * 5);
  const lower = Math.max(5, at - width);
  const upper = at + width;
  const farLower = Math.max(5, lower - width);
  const farUpper = upper + width;
  state.strategy = key;
  if (key === 'long-call') state.legs = [makeLeg('call', 1, at)];
  if (key === 'long-put') state.legs = [makeLeg('put', 1, at)];
  if (key === 'bull-call-spread') state.legs = [makeLeg('call', 1, at), makeLeg('call', -1, upper)];
  if (key === 'bear-put-spread') state.legs = [makeLeg('put', 1, at), makeLeg('put', -1, lower)];
  if (key === 'straddle') state.legs = [makeLeg('call', 1, at), makeLeg('put', 1, at)];
  if (key === 'short-straddle') state.legs = [makeLeg('call', -1, at), makeLeg('put', -1, at)];
  if (key === 'long-guts') state.legs = [makeLeg('call', 1, lower), makeLeg('put', 1, upper)];
  if (key === 'long-strangle') state.legs = [makeLeg('put', 1, lower), makeLeg('call', 1, upper)];
  if (key === 'short-strangle') state.legs = [makeLeg('put', -1, lower), makeLeg('call', -1, upper)];
  if (key === 'iron-condor') state.legs = [makeLeg('put', 1, farLower), makeLeg('put', -1, lower), makeLeg('call', -1, upper), makeLeg('call', 1, farUpper)];
  state.day = 0;
  render();
}
function expirationDates() {
  if (market.connected) return market.expirations.filter(date => date >= iso(startDate));
  const dates = new Set([state.expiry]);
  for (let i = 1; i <= 35; i++) {
    const date = dateAfter(i);
    if ([1, 3, 5].includes(date.getDay())) dates.add(iso(date));
  }
  for (let i = 0; i < 20; i++) {
    const base = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    const offset = (5 - base.getDay() + 7) % 7;
    const thirdFriday = new Date(base.getFullYear(), base.getMonth(), 1 + offset + 14);
    if (thirdFriday > startDate) dates.add(iso(thirdFriday));
  }
  return [...dates].filter(date => date >= iso(startDate)).sort();
}
function renderExpiration() {
  const strip = $('expiration-strip');
  clear(strip);
  let currentMonth = '';
  let daysBox;
  for (const value of expirationDates()) {
    const date = new Date(value + 'T00:00:00');
    const month = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    if (month !== currentMonth) {
      currentMonth = month;
      const group = node('div', 'exp-month');
      const label = node('div', 'exp-month-label', date.toLocaleDateString('en-US', { month: 'short' }) + (date.getFullYear() !== startDate.getFullYear() ? " '" + String(date.getFullYear()).slice(-2) : ''));
      daysBox = node('div', 'exp-days');
      group.append(label, daysBox);
      strip.append(group);
    }
    const button = node('button', 'exp-day' + (value === state.expiry ? ' selected' : ''), String(date.getDate()));
    button.type = 'button';
    button.title = new Date(value + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    button.setAttribute('aria-label', button.title + ' expiration');
    button.setAttribute('aria-pressed', String(value === state.expiry));
    button.onclick = () => {
      if (market.connected) { loadMarketExpiry(value); return; }
      state.expiry = value;
      state.day = 0;
      for (const leg of state.legs) if (!leg.manual) leg.premium = samplePremium(leg.type, leg.strike);
      render();
    };
    daysBox.append(button);
  }
  const customDate = node('button', 'exp-custom', '+ Custom date');
  customDate.type = 'button'; customDate.onclick = openCustomExpiry; strip.append(customDate);
  $('expiration-dte').textContent = new Date(state.expiry + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + daysUntil(state.expiry) + 'd';
  requestAnimationFrame(() => {
    const selected = strip.querySelector('.exp-day.selected');
    if (!selected) return;
    const delta = selected.getBoundingClientRect().left - strip.getBoundingClientRect().left - (strip.clientWidth - selected.clientWidth) / 2;
    strip.scrollLeft += delta;
    updateExpirationNav();
  });
}
function updateExpirationNav() {
  const strip = $('expiration-strip');
  $('expiry-prev').disabled = strip.scrollLeft < 2;
  $('expiry-next').disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2;
}
function scrollExpirations(direction) {
  const strip = $('expiration-strip');
  strip.scrollBy({ left: direction * Math.max(180, strip.clientWidth * .7), behavior: 'smooth' });
}

// Strike-local contract menu. Quotes and expiration come from the current strategy.
let contractMenuReturnFocus = null;
function closeContractMenu(restoreFocus = false) {
  const menu = $('contract-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  if (restoreFocus) {
    const target = contractMenuReturnFocus?.isConnected ? contractMenuReturnFocus : $('strike-ruler');
    target.focus({ preventScroll: true });
  }
  contractMenuReturnFocus = null;
}
function strikeAt(clientX) {
  const rect = $('ruler-ticks').getBoundingClientRect();
  const bounds = rulerBounds();
  const value = bounds.min + clamp((clientX - rect.left) / rect.width, 0, 1) * (bounds.max - bounds.min);
  return availableStrike(null, value);
}
function markerText(leg) {
  return leg.strike + (leg.type === 'call' ? 'C' : 'P') + (leg.qty > 1 ? ' ×' + leg.qty : '');
}
function quickAddContract(type, side, desiredStrike) {
  const strike = availableStrike(type, desiredStrike);
  if (strike == null) { showToast('No listed ' + type + ' contracts are available for this expiration.'); return; }
  const existing = state.legs.find(leg => leg.type === type && leg.side === side && leg.strike === strike && !leg.manual && !leg.excluded);
  if (existing && existing.qty >= 100) { showToast('This position already has 100 contracts.'); return; }
  if (!existing && state.legs.length >= 16) { showToast('A strategy can contain up to 16 positions.'); return; }
  let id;
  if (existing) { existing.qty += 1; id = existing.id; }
  else {
    const leg = makeLeg(type, side, strike);
    state.legs.push(leg);
    id = leg.id;
  }
  closeContractMenu(false);
  classifyStrategy();
  render();
  requestAnimationFrame(() => $('strike-markers').querySelector('[data-leg-id="' + id + '"]')?.focus({ preventScroll: true }));
}
function openContractMenu(strike, clientX, clientY, legId = null) {
  closeContractEditor(false);
  closeContractMenu(false);
  const menu = $('contract-menu');
  contractMenuReturnFocus = legId == null ? $('strike-ruler') : $('strike-markers').querySelector('[data-leg-id="' + legId + '"]');
  clear(menu);
  const heading = node('div', 'contract-menu-heading');
  heading.append(node('strong', '', 'Add option'), node('span', '', displayDate(state.expiry) + ' · 1 contract'));
  menu.append(heading);
  for (const [type, side] of [['call', 1], ['call', -1], ['put', 1], ['put', -1]]) {
    const selectedStrike = availableStrike(type, strike);
    const button = node('button', 'contract-menu-item');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.dataset.type = type;
    button.dataset.side = side;
    button.dataset.strike = selectedStrike ?? '';
    button.disabled = selectedStrike == null;
    if (button.disabled) button.title = 'No listed ' + type + ' contracts are available for this expiration.';
    const verb = side === 1 ? 'Buy' : 'Sell';
    button.append(node('span', '', verb + ' ' + (selectedStrike ?? 'unavailable')), node('span', 'contract-type ' + type, type === 'call' ? 'Call' : 'Put'));
    button.setAttribute('aria-label', verb + ' 1 ' + selectedStrike + ' ' + type + ' expiring ' + displayDate(state.expiry));
    button.onclick = () => quickAddContract(type, side, selectedStrike);
    menu.append(button);
  }
  if (legId != null) {
    menu.append(node('div', 'contract-menu-divider'));
    const edit = node('button', 'contract-menu-item', 'Edit this position');
    edit.type = 'button'; edit.setAttribute('role', 'menuitem');
    edit.onclick = () => { closeContractMenu(false); openContractEditor(legId); };
    const remove = node('button', 'contract-menu-item menu-remove', 'Remove this position');
    remove.type = 'button'; remove.setAttribute('role', 'menuitem'); remove.disabled = state.legs.length <= 1;
    remove.onclick = () => { state.legs = state.legs.filter(leg => leg.id !== legId); closeContractMenu(false); classifyStrategy(); render(); $('strike-ruler').focus({ preventScroll: true }); };
    menu.append(edit, remove);
  }
  menu.hidden = false;
  menu.style.left = clamp(clientX, 8, Math.max(8, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = clamp(clientY + 6, 8, Math.max(8, innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
}
function closeContractEditor(restoreFocus = false) {
  const panel = $('contract-editor');
  if (panel.hidden) return;
  const legId = contractEditorLegId;
  panel.hidden = true;
  panel.replaceChildren();
  contractEditorLegId = null;
  if (restoreFocus && legId != null) requestAnimationFrame(() => {
    $('strike-markers').querySelector('[data-leg-id="' + legId + '"]')?.focus({ preventScroll: true });
  });
}
function positionContractEditor() {
  const panel = $('contract-editor');
  if (panel.hidden || contractEditorLegId == null) return;
  const marker = $('strike-markers').querySelector('[data-leg-id="' + contractEditorLegId + '"]');
  if (!marker) { closeContractEditor(false); return; }
  let anchor = marker.getBoundingClientRect();
  if (anchor.bottom < 0 || anchor.top > innerHeight) {
    const sideCardRow = document.querySelector('.strategy-leg-row[data-leg-id="' + contractEditorLegId + '"]');
    if (sideCardRow) anchor = sideCardRow.getBoundingClientRect();
  }
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const left = clamp(anchor.left + anchor.width / 2 - width / 2, 8, innerWidth - width - 8);
  let top = anchor.bottom + 8;
  if (top + height > innerHeight - 8 && anchor.top - height - 8 >= 8) top = anchor.top - height - 8;
  panel.style.left = left + 'px';
  panel.style.top = clamp(top, 8, innerHeight - height - 8) + 'px';
}
function syncContractEditor() {
  const panel = $('contract-editor');
  if (panel.hidden || contractEditorLegId == null) return;
  const leg = state.legs.find(item => item.id === contractEditorLegId);
  if (!leg) { closeContractEditor(false); return; }
  panel.classList.toggle('contract-editor-call', leg.type === 'call');
  panel.classList.toggle('contract-editor-put', leg.type === 'put');
  const quote = market.connected ? market.chain.find(option => option.type === leg.type && Math.abs(option.strike - leg.strike) < .001) : null;
  const days = Math.max(0, daysUntil(state.expiry) - state.day);
  const iv = contractImpliedVolatility(quote?.iv, state.iv) * state.ivScale;
  const delta = optionDelta(leg.type, state.spot, leg.strike, days, iv, RATE, state.model, state.dividendYield);
  panel.querySelector('[data-editor-title]').textContent = state.symbol + ' ' + money(leg.strike, leg.strike % 1 ? 2 : 0) + ' ' + (leg.type === 'call' ? 'Call' : 'Put');
  panel.querySelector('[data-editor-expiry]').textContent = displayDate(state.expiry) + ', ' + state.expiry.slice(0, 4) + ' · ' + daysUntil(state.expiry) + 'd';
  const sideBadge = panel.querySelector('[data-editor-side-badge]');
  sideBadge.textContent = leg.side === 1 ? 'Buy' : 'Sell';
  sideBadge.classList.toggle('sell', leg.side === -1);
  for (const button of panel.querySelectorAll('[data-editor-side]')) {
    const selected = Number(button.dataset.editorSide) === leg.side;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  for (const button of panel.querySelectorAll('[data-editor-type]')) {
    const selected = button.dataset.editorType === leg.type;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  const quantity = panel.querySelector('[data-editor-quantity]');
  if (document.activeElement !== quantity) quantity.value = String(leg.qty);
  const price = panel.querySelector('[data-editor-price]');
  if (document.activeElement !== price) price.value = leg.premium.toFixed(2);
  const quoteValue = (key, decimals = 2) => {
    const value = Number(quote?.[key]);
    return Number.isFinite(value) && value > 0 ? money(value, decimals) : '—';
  };
  panel.querySelector('[data-editor-bid]').textContent = quoteValue('bid');
  panel.querySelector('[data-editor-ask]').textContent = quoteValue('ask');
  panel.querySelector('[data-editor-iv]').textContent = Number.isFinite(iv) ? (iv * 100).toFixed(1) + '%' : '—';
  panel.querySelector('[data-editor-delta]').textContent = Number.isFinite(delta) ? signedGreek(delta, 3) : '—';
  panel.querySelector('[data-editor-include]').checked = !leg.excluded;
  panel.querySelector('[data-editor-remove]').disabled = state.legs.length <= 1;
  positionContractEditor();
}
function openContractEditor(legId) {
  const leg = state.legs.find(item => item.id === legId);
  if (!leg) return;
  closeContractMenu(false);
  contractEditorLegId = legId;
  const panel = $('contract-editor');
  clear(panel);

  const header = node('div', 'contract-editor-header');
  const titleBlock = node('div', 'contract-editor-title-block');
  titleBlock.append(node('strong', '', ''), node('small', '', ''));
  titleBlock.children[0].dataset.editorTitle = '';
  titleBlock.children[1].dataset.editorExpiry = '';
  const sideBadge = node('span', 'contract-editor-side-badge', 'Buy');
  sideBadge.dataset.editorSideBadge = '';
  const close = node('button', 'contract-editor-close', '×');
  close.type = 'button'; close.setAttribute('aria-label', 'Close contract editor');
  close.onclick = () => closeContractEditor(true);
  header.append(titleBlock, sideBadge, close);
  panel.append(header);

  const quotes = node('div', 'contract-editor-quotes');
  for (const [key, label] of [['bid', 'Bid'], ['ask', 'Ask'], ['iv', 'IV est.'], ['delta', 'Delta est.']]) {
    const cell = node('div', 'contract-editor-quote-cell');
    cell.append(node('span', '', label), node('strong', '', '—'));
    cell.lastChild.dataset['editor' + key[0].toUpperCase() + key.slice(1)] = '';
    quotes.append(cell);
  }
  panel.append(quotes);

  const selectors = node('div', 'contract-editor-selectors');
  for (const [property, choices, label] of [
    ['side', [[1, 'Buy'], [-1, 'Sell']], 'Position side'],
    ['type', [['call', 'Call'], ['put', 'Put']], 'Option type']
  ]) {
    const group = node('div', 'contract-editor-segmented');
    group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    for (const [value, text] of choices) {
      const button = node('button', '', text);
      button.type = 'button';
      button.dataset['editor' + property[0].toUpperCase() + property.slice(1)] = String(value);
      button.onclick = () => {
        const current = state.legs.find(item => item.id === contractEditorLegId);
        if (!current) return;
        if (property === 'side') current.side = Number(value);
        else if (current.type !== value) {
          const strike = availableStrike(value, current.strike);
          if (strike == null) { showToast('No listed ' + value + ' contracts are available for this expiration.'); return; }
          current.type = value;
          current.strike = strike;
          current.premium = samplePremium(value, current.strike);
          current.manual = false;
        }
        classifyStrategy(); render();
      };
      group.append(button);
    }
    selectors.append(group);
  }
  panel.append(selectors);

  const fields = node('div', 'contract-editor-fields');
  const quantityField = node('label', 'contract-editor-field');
  quantityField.append(node('span', '', 'Contracts'));
  const quantityStepper = node('div', 'contract-editor-stepper');
  const decrement = node('button', '', '−');
  decrement.type = 'button'; decrement.setAttribute('aria-label', 'Remove one contract');
  const quantity = node('input');
  quantity.type = 'number'; quantity.min = '1'; quantity.max = '100'; quantity.step = '1'; quantity.inputMode = 'numeric';
  quantity.setAttribute('aria-label', 'Contract quantity'); quantity.dataset.editorQuantity = '';
  const increment = node('button', '', '+');
  increment.type = 'button'; increment.setAttribute('aria-label', 'Add one contract');
  const setQuantity = value => {
    const current = state.legs.find(item => item.id === contractEditorLegId);
    if (!current) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) { quantity.value = String(current.qty); return; }
    current.qty = clamp(Math.round(parsed), 1, 100);
    render();
  };
  decrement.onclick = () => setQuantity(leg.qty - 1);
  increment.onclick = () => setQuantity(leg.qty + 1);
  quantity.onchange = () => setQuantity(quantity.value);
  quantityStepper.append(decrement, quantity, increment);
  quantityField.append(quantityStepper);

  const priceField = node('label', 'contract-editor-field');
  priceField.append(node('span', '', 'Entry price / share'));
  const priceWrap = node('span', 'contract-editor-price');
  priceWrap.append(node('span', '', currencyLabel()));
  const price = node('input');
  price.type = 'number'; price.min = '0'; price.max = '1000000'; price.step = '0.01'; price.inputMode = 'decimal';
  price.setAttribute('aria-label', 'Entry premium per share'); price.dataset.editorPrice = '';
  price.onchange = () => {
    const current = state.legs.find(item => item.id === contractEditorLegId);
    const parsed = Number(price.value);
    if (!current) return;
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000000) { price.value = current.premium.toFixed(2); return; }
    current.premium = parsed;
    current.manual = true;
    render();
  };
  priceWrap.append(price); priceField.append(priceWrap);
  fields.append(quantityField, priceField);
  panel.append(fields);

  const footer = node('div', 'contract-editor-footer');
  const includeLabel = node('label', 'contract-editor-include');
  const include = node('input'); include.type = 'checkbox'; include.dataset.editorInclude = '';
  include.onchange = () => {
    const current = state.legs.find(item => item.id === contractEditorLegId);
    if (!current) return;
    current.excluded = !include.checked;
    classifyStrategy(); render();
  };
  includeLabel.append(include, node('span', '', 'Include in analysis'));
  const remove = node('button', 'contract-editor-remove', 'Remove');
  remove.type = 'button'; remove.dataset.editorRemove = '';
  remove.onclick = () => {
    const current = state.legs.find(item => item.id === contractEditorLegId);
    if (!current) return;
    if (state.legs.length <= 1) { showToast('Keep at least one position.'); return; }
    state.legs = state.legs.filter(item => item.id !== current.id);
    classifyStrategy(); closeContractEditor(false); render(); $('strike-ruler').focus({ preventScroll: true });
  };
  footer.append(includeLabel, remove);
  panel.append(footer);

  panel.hidden = false;
  syncContractEditor();
  panel.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); closeContractEditor(true); }
  };
  requestAnimationFrame(() => quantity.focus({ preventScroll: true }));
}
$('strike-ruler').addEventListener('contextmenu', event => {
  event.preventDefault();
  const marker = event.target.closest('.strike-marker');
  const leg = marker ? state.legs.find(item => item.id === Number(marker.dataset.legId)) : null;
  closeContractEditor(false);
  openContractMenu(leg?.strike ?? strikeAt(event.clientX), event.clientX, event.clientY, leg?.id ?? null);
});
$('strike-ruler').addEventListener('click', event => {
  if (event.target.closest('.strike-marker')) return;
  if (event.detail === 0) return;
  openContractMenu(strikeAt(event.clientX), event.clientX, event.clientY);
});
$('strike-ruler').addEventListener('keydown', event => {
  if (!['ContextMenu', 'F10', 'Enter', ' '].includes(event.key)) return;
  if (event.key === 'F10' && !event.shiftKey) return;
  if (event.target.closest('.strike-marker') && ['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  const marker = event.target.closest('.strike-marker');
  const leg = marker ? state.legs.find(item => item.id === Number(marker.dataset.legId)) : null;
  const rect = (marker || $('strike-ruler')).getBoundingClientRect();
  openContractMenu(leg?.strike ?? Math.round(state.spot / 5) * 5, rect.left + rect.width / 2, rect.bottom, leg?.id ?? null);
});
$('contract-menu').addEventListener('keydown', event => {
  const items = [...$('contract-menu').querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const current = items.indexOf(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeContractMenu(true); }
  else if (event.key === 'Tab') { closeContractMenu(true); }
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
});
document.addEventListener('pointerdown', event => {
  const editor = $('contract-editor');
  if (!editor.hidden && !editor.contains(event.target) && !event.target.closest?.('.strike-marker')) closeContractEditor(false);
  if (!$('contract-menu').hidden && !$('contract-menu').contains(event.target)) closeContractMenu(false);
}, true);
window.addEventListener('scroll', () => { closeContractMenu(false); positionContractEditor(); }, true);
window.addEventListener('resize', positionContractEditor);

function rulerBounds() {
  if (drag?.bounds) return drag.bounds;
  const baseMin = Math.max(.01, state.spot * (1 - state.range / 100));
  const baseMax = state.spot * (1 + state.range / 100);
  const strikes = state.legs.map(leg => leg.strike);
  const pad = Math.max(5, state.spot * .0125);
  return {
    min: Math.max(.01, Math.min(baseMin, ...strikes.map(strike => strike - pad))),
    max: Math.max(baseMax, ...strikes.map(strike => strike + pad))
  };
}
function renderRuler() {
  const ticks = $('ruler-ticks');
  const markers = $('strike-markers');
  const volumeBars = $('volume-bars');
  clear(ticks); clear(markers); clear(volumeBars);
  const bounds = rulerBounds();
  const span = bounds.max - bounds.min;
  const plotWidth = $('ruler-ticks').clientWidth;
  const minLabelGap = window.innerWidth < 600 ? 36 : 52;
  const labelSteps = [5, 10, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
  const majorStep = labelSteps.find(step => step / span * plotWidth >= minLabelGap) || Math.max(labelSteps.at(-1), Math.ceil(span / 10));
  const minorStep = Math.max(1, majorStep / 5);
  for (let strike = Math.ceil(bounds.min / minorStep) * minorStep; strike <= bounds.max; strike += minorStep) {
    const major = strike % majorStep === 0 && strike > bounds.min + majorStep * .4 && strike < bounds.max - majorStep * .4;
    const tick = node('div', 'ruler-tick' + (major ? ' major' : '') + (Math.abs(strike - state.spot) < 25 ? ' near' : ''));
    tick.style.left = ((strike - bounds.min) / span * 100) + '%';
    if (major) tick.append(node('span', '', String(strike)));
    ticks.append(tick);
  }
  const placement = new Map();
  const laneCounts = new Map();
  for (const side of [1, -1]) {
    const lanes = [];
    for (const leg of state.legs.filter(item => item.side === side).sort((a, b) => a.strike - b.strike || a.id - b.id)) {
      const center = (leg.strike - bounds.min) / span * plotWidth;
      const markerWidth = Math.max(52, markerText(leg).length * 7 + 20);
      let lane = lanes.findIndex(end => end + 8 < center - markerWidth / 2);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = center + markerWidth / 2;
      placement.set(leg.id, lane);
    }
    laneCounts.set(side, lanes.length);
  }
  const visibleContracts = market.connected ? market.chain.filter(option =>
    ['call', 'put'].includes(option.type) && option.strike >= bounds.min && option.strike <= bounds.max &&
    Number.isFinite(option.volume) && option.volume > 0
  ) : [];
  volumeBars.setAttribute('aria-label', visibleContracts.length
    ? 'Call volume bars extend above the baseline; put volume bars extend below it. Bar heights use a relative logarithmic scale.'
    : market.loading ? 'Loading option volume data.'
      : market.connected ? 'No reported option volume in the visible strike range.'
        : 'Option volume is unavailable while sample data is shown.');
  const volumeBand = visibleContracts.length ? 42 : 0;
  const tickTop = Math.max(1, laneCounts.get(1)) * 28 + 7 + volumeBand;
  ticks.style.top = tickTop + 'px';
  $('strike-ruler').style.height = (tickTop + 30 + laneCounts.get(-1) * 28) + 'px';
  if (visibleContracts.length) {
    const maxVolume = Math.max(...visibleContracts.map(option => option.volume));
    const strikeCount = new Set(visibleContracts.map(option => option.strike)).size;
    const barWidth = clamp(plotWidth / Math.max(1, strikeCount) * .36, 2, 4.5);
    const pairGap = Math.min(2, barWidth * .6);
    const axisY = tickTop - volumeBand / 2;
    const baseline = node('div', 'volume-baseline');
    baseline.style.top = axisY + 'px';
    volumeBars.append(baseline);
    for (const option of visibleContracts) {
      const bar = node('span', 'volume-bar ' + option.type);
      const x = (option.strike - bounds.min) / span * 100;
      const height = Math.max(1, Math.round(Math.log1p(option.volume) / Math.log1p(maxVolume) * (volumeBand / 2 - 1)));
      bar.style.left = option.type === 'call'
        ? `calc(${x}% - ${pairGap / 2 + barWidth}px)`
        : `calc(${x}% + ${pairGap / 2}px)`;
      bar.style.width = barWidth + 'px';
      bar.style.height = height + 'px';
      bar.style.top = (option.type === 'call' ? axisY - height : axisY + 1) + 'px';
      bar.title = `${option.type === 'call' ? 'Call' : 'Put'} volume at ${money(option.strike, option.strike % 1 ? 2 : 0)}: ${option.volume.toLocaleString('en-US')} contracts`;
      volumeBars.append(bar);
    }
  }
  for (const leg of state.legs) {
    const marker = node('button', 'strike-marker' + (leg.type === 'put' ? ' put' : '') + (leg.side === -1 ? ' short' : '') + (leg.excluded ? ' excluded' : ''), markerText(leg));
    marker.type = 'button';
    marker.dataset.legId = String(leg.id);
    marker.style.left = ((leg.strike - bounds.min) / span * 100) + '%';
    marker.style.top = (leg.side === 1 ? tickTop - volumeBand - (placement.get(leg.id) + 1) * 28 : tickTop + 26 + placement.get(leg.id) * 28) + 'px';
    marker.title = (leg.side === 1 ? 'Long ' : 'Short ') + leg.type + ' • click to edit; hold and drag to change strike';
    marker.setAttribute('aria-label', (leg.side === 1 ? 'Long ' : 'Short ') + leg.qty + ' contract' + (leg.qty === 1 ? '' : 's') + ' at ' + leg.strike + ' ' + leg.type + '. Click or press Enter to edit. Hold and drag, or use the left and right arrow keys, to adjust strike; Shift moves all legs.');
    marker.onclick = event => { if (event.detail === 0) openContractEditor(leg.id); };
    marker.onkeydown = event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const current = state.legs.find(item => item.id === leg.id);
      if (!current) return;
      const target = adjacentStrike(market.connected ? market.chain : [], state.spot, current.strike, current.type, direction, market.connected);
      if (target == null) { showToast('No listed ' + current.type + ' contracts are available for this expiration.'); return; }
      if (target === current.strike) return;
      const delta = target - current.strike;
      for (const item of state.legs) {
        if (item.id !== current.id && !event.shiftKey) continue;
        const desired = item.id === current.id ? target : availableStrike(item.type, Math.max(1, item.strike + delta));
        if (desired == null) { showToast('No listed ' + item.type + ' contracts are available for this expiration.'); continue; }
        item.strike = desired;
        item.manual = false;
        item.premium = samplePremium(item.type, desired);
      }
      classifyStrategy(); render();
      requestAnimationFrame(() => $('strike-markers').querySelector('[data-leg-id="' + current.id + '"]')?.focus());
    };
    marker.onpointerdown = event => {
      if (event.button !== 0) return;
      closeContractEditor(false);
      closeContractMenu(false);
      drag = { id: leg.id, startX: event.clientX, moved: false, armed: false, pointerId: event.pointerId, bounds, marker, startStrikes: new Map(state.legs.map(item => [item.id, item.strike])) };
      marker.setPointerCapture?.(event.pointerId);
      clearTimeout(dragHoldTimer);
      dragHoldTimer = setTimeout(() => {
        if (drag?.pointerId !== event.pointerId) return;
        drag.armed = true;
        drag.marker.classList.add('dragging');
      }, 180);
      event.preventDefault();
    };
    markers.append(marker);
  }
}
document.addEventListener('pointermove', event => {
  if (!drag) return;
  if (drag.pointerId != null && event.pointerId !== drag.pointerId) return;
  const distance = Math.abs(event.clientX - drag.startX);
  if (!drag.armed && distance > 4) {
    drag.armed = true;
    clearTimeout(dragHoldTimer);
    drag.marker.classList.add('dragging');
  }
  if (!drag.armed) return;
  const rect = $('ruler-ticks').getBoundingClientRect();
  if (!drag.moved && distance > 4) drag.moved = true;
  if (!drag.moved) return;
  const raw = drag.bounds.min + clamp((event.clientX - rect.left) / rect.width, 0, 1) * (drag.bounds.max - drag.bounds.min);
  const selected = state.legs.find(item => item.id === drag.id);
  if (!selected) return;
  const target = snapStrikeForDrag(market.connected ? market.chain : [], state.spot, raw, selected, state.legs, market.connected);
  if (target == null) return;
  const delta = target - drag.startStrikes.get(selected.id);
  let changed = false;
  for (const leg of state.legs) {
    const desired = leg.id === selected.id ? target : event.shiftKey ? availableStrike(leg.type, drag.startStrikes.get(leg.id) + delta) : drag.startStrikes.get(leg.id);
    if (desired == null || leg.strike === desired) continue;
    leg.strike = desired;
    leg.manual = false;
    leg.premium = samplePremium(leg.type, desired);
    changed = true;
    const marker = [...$('strike-markers').children].find(item => Number(item.dataset.legId) === leg.id);
    if (marker) {
      marker.textContent = markerText(leg);
      marker.style.left = ((desired - drag.bounds.min) / (drag.bounds.max - drag.bounds.min) * 100) + '%';
    }
  }
  if (changed && !dragFrame) dragFrame = requestAnimationFrame(() => {
    dragFrame = 0;
    if (!drag) return;
    classifyStrategy();
    renderStats();
    renderVisualization();
  });
});
document.addEventListener('pointerup', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  clearTimeout(dragHoldTimer);
  const moved = drag.moved;
  const id = drag.id;
  drag.marker.classList.remove('dragging');
  drag = null;
  if (moved) { classifyStrategy(); render(); }
  else openContractEditor(id);
});
document.addEventListener('pointercancel', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  clearTimeout(dragHoldTimer);
  const moved = drag.moved;
  drag.marker.classList.remove('dragging');
  drag = null;
  if (moved) { classifyStrategy(); render(); }
});

function chanceOfProfit() {
  const dte = daysUntil(state.expiry);
  if (!activeLegs(state).length) return 0;
  const adjustedIv = state.iv * state.ivScale; const sigma = adjustedIv * Math.sqrt(dte / 365);
  if (sigma <= 0) return profitLoss(state, state.spot, dte) > 0 ? 100 : 0;
  let total = 0, positive = 0;
  const step = .025;
  for (let z = -5; z <= 5; z += step) {
    const weight = Math.exp(-z * z / 2) * step;
    const price = state.spot * Math.exp((RATE - state.dividendYield - adjustedIv * adjustedIv / 2) * dte / 365 + sigma * z);
    total += weight;
    if (profitLoss(state, price, dte) > 0) positive += weight;
  }
  return positive / total * 100;
}
function signedGreek(value, decimals = 2) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.abs(value) < .5 * 10 ** -decimals ? 0 : value;
  return (rounded > 0 ? '+' : rounded < 0 ? '−' : '') + Math.abs(rounded).toFixed(decimals);
}
function signedGreekMoney(value) {
  if (!Number.isFinite(value)) return '—';
  return (value > 0 ? '+' : value < 0 ? '−' : '') + money(value, 2);
}
function renderGreeks() {
  const dte = daysUntil(state.expiry);
  const greeks = strategyGreeks(state, state.day, state.ivScale);
  $('greek-delta').textContent = signedGreek(greeks.delta, 1);
  $('greek-gamma').textContent = signedGreek(greeks.gamma, 3);
  $('greek-theta').textContent = signedGreekMoney(greeks.theta);
  $('greek-vega').textContent = signedGreekMoney(greeks.vega);
  $('greeks-asof').textContent = state.day === 0 ? 'Now' : state.day === dte ? 'At expiration' : displayDate(iso(dateAfter(state.day)));
  const yieldContext = state.dividendYieldMode === 'manual' ? 'manual' : market.quote?.dividendYieldSource ? 'TTM estimate' : 'estimate unavailable';
  $('greeks-note').textContent = (state.model === PRICING_MODELS.AMERICAN ? 'Bjerksund–Stensland 2002' : 'Black–Scholes') + ' · 4% risk-free rate · ' + (state.dividendYield * 100).toFixed(2) + '% annual dividend (' + yieldContext + ')';
}
function renderStrategyPayoffPreview() {
  const preview = $('strategy-payoff-preview');
  if (state.strategy === strategyPreviewSignature) return;
  strategyPreviewSignature = state.strategy;
  clear(preview);
  const label = names[state.strategy] + ' example payoff at expiration';
  preview.setAttribute('aria-label', label);
  // Fixed examples communicate the strategy's characteristic shape, without
  // implying that this thumbnail is a second chart of the current contracts.
  const points = payoffExamples[state.strategy] || payoffExamples.custom;
  const zero = 16;
  const title = svgNode('title');
  title.textContent = label + ' · Illustrative shape; actual payoffs depend on your contracts.';
  preview.append(title);
  const defs = svgNode('defs');
  for (const [name, top, height] of [['profit', 0, zero], ['loss', zero, 32 - zero]]) {
    const clip = svgNode('clipPath', { id: 'strategy-preview-' + name });
    clip.append(svgNode('rect', { x: 0, y: top, width: 64, height }));
    defs.append(clip);
  }
  preview.append(defs, svgNode('line', { x1: 2, y1: zero, x2: 62, y2: zero, class: 'preview-zero' }));
  const path = points.map(([x, y], index) => (index ? 'L' : 'M') + x + ',' + y).join(' ');
  for (const name of ['profit', 'loss']) {
    preview.append(svgNode('path', { d: path, class: 'preview-line preview-' + name, 'clip-path': 'url(#strategy-preview-' + name + ')' }));
  }
}
function renderStats() {
  const net = netDebit(state);
  const result = expirationStats(state);
  renderStrategyPayoffPreview();
  $('strategy-title').firstChild.textContent = names[state.strategy] + ' ';
  $('net-label').textContent = net >= 0 ? 'Net debit' : 'Net credit';
  $('net-value').textContent = money(net);
  $('max-loss').textContent = Number.isFinite(result.maxLoss) ? money(result.maxLoss) : 'Unlimited';
  $('max-profit').textContent = Number.isFinite(result.maxProfit) ? money(result.maxProfit) : 'Unlimited';
  $('max-profit').className = result.maxProfit > 0 ? 'positive' : '';
  $('chance-profit').textContent = chanceOfProfit().toFixed(1) + '%';
  $('chance-profit').title = 'Illustrative risk-neutral estimate based on constant implied volatility.';
  const breaks = result.breakevens;
  $('breakeven').textContent = breaks.length ? breaks.map(value => money(value, 2)).join(', ') : 'None';
  $('positions-count').textContent = '(' + state.legs.length + ')';
  $('positions-button').hidden = state.legs.length < 2;
  $('ticket-expiry').textContent = displayDate(state.expiry) + ', ' + state.expiry.slice(0, 4);
  const activeCount = activeLegs(state).length;
  $('ticket-leg-count').textContent = activeCount + ' active' + (activeCount < state.legs.length ? ' / ' + state.legs.length : '');
  renderGreeks();
  const summary = $('strategy-legs-summary');
  clear(summary);
  for (const leg of state.legs) {
    const row = node('button', 'strategy-leg-row' + (leg.excluded ? ' excluded' : ''));
    row.dataset.legId = String(leg.id);
    row.type = 'button';
    const direction = leg.side === 1 ? 'Buy' : 'Sell';
    const title = direction + ' ' + leg.qty + ' × ' + money(leg.strike, leg.strike % 1 ? 2 : 0) + ' ' + leg.type;
    const contractQuote = market.connected ? market.chain.find(option => option.type === leg.type && Math.abs(option.strike - leg.strike) < .001) : null;
    const hasBidAsk = contractQuote && (Number(contractQuote.bid) > 0 || Number(contractQuote.ask) > 0);
    const quoteText = value => hasBidAsk && Number.isFinite(contractQuote[value]) ? money(contractQuote[value], 2) : '—';
    const bid = quoteText('bid'), ask = quoteText('ask');
    row.setAttribute('aria-label', 'Edit ' + title + '. Bid ' + bid + ', ask ' + ask + (leg.excluded ? ', excluded from analysis' : ''));
    const details = node('span', 'ticket-leg-details');
    details.append(node('span', 'ticket-leg-title', title), node('small', '', leg.excluded ? 'Excluded from analysis' : money(leg.premium, 2) + ' / share' + (leg.manual ? ' · Custom' : '')));
    const quote = node('span', 'ticket-leg-quotes');
    for (const [label, value] of [['Bid', bid], ['Ask', ask]]) {
      const item = node('span', 'ticket-quote');
      item.append(node('span', '', label), node('strong', '', value));
      quote.append(item);
    }
    details.append(quote);
    const cost = node('span', 'ticket-leg-cost');
    cost.append(node('strong', '', money(leg.qty * leg.premium * MULTIPLIER)), node('small', '', leg.side === 1 ? 'Debit' : 'Credit'), node('span', 'ticket-edit-affordance', 'Edit'));
    row.append(node('span', 'leg-icon ' + leg.type, leg.type === 'call' ? 'C' : 'P'), details, cost);
    row.onclick = () => openContractEditor(leg.id);
    summary.append(row);
  }
}
function formattedOutput(value) {
  if (!Number.isFinite(value)) return '—';
  if (state.output === 'percent' || state.output === 'risk') return signed(value, '%');
  return (value < 0 ? '−' : '') + money(value, Math.abs(value) < 100 ? 2 : 0);
}
function axisText(value, step = 1) {
  const decimals = Math.abs(step) < 1 ? 2 : 0;
  const sign = value < 0 ? '−' : '';
  if (state.output === 'percent' || state.output === 'risk') {
    const percentDecimals = Math.abs(step) < 1 ? 1 : 0;
    return sign + Math.abs(value).toFixed(percentDecimals) + '%';
  }
  if (window.innerWidth < 600 && Math.abs(value) >= 1000) {
    return sign + currencyPrefix() + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(value)).toLowerCase();
  }
  return sign + money(Math.abs(value), decimals);
}
function linePath(points, toX, toY) {
  return points.map((point, index) => (index ? 'L' : 'M') + toX(point.x).toFixed(2) + ',' + toY(point.y).toFixed(2)).join(' ');
}
function chartSeries(model, minPrice, maxPrice, day, output = state.output, ivScale = state.ivScale, count = 161) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const price = minPrice + (maxPrice - minPrice) * i / (count - 1);
    points.push({ x: price, y: outputValue(model, price, day, output, ivScale) });
  }
  return points;
}
function makeChartModel(chart) {
  const width = Math.max(1, Math.round(chart.getBoundingClientRect().width)), height = 340;
  let left = window.innerWidth < 600 ? 48 : 64;
  const right = 14, top = 24, bottom = 30;
  const bounds = rulerBounds();
  const targetTicks = Math.max(1, Math.floor((width - left - right) / 58));
  // Keep price labels on whole-dollar values, even for low-priced underlyings.
  const xAxis = wholeDollarTicks(bounds.min, bounds.max, targetTicks);
  const minPrice = xAxis.ticks[0] ?? bounds.min;
  const maxPrice = xAxis.ticks.at(-1) ?? bounds.max;
  const dte = daysUntil(state.expiry);
  const selected = chartSeries(state, minPrice, maxPrice, state.day);
  const expiry = chartSeries(state, minPrice, maxPrice, dte);
  const all = [...selected, ...expiry].map(point => point.y).filter(Number.isFinite);
  let minY = Math.min(0, ...all), maxY = Math.max(0, ...all);
  const padding = Math.max(100, (maxY - minY) * .09);
  minY -= padding; maxY += padding;
  const yAxis = niceTicks(minY, maxY, 6);
  if (yAxis.ticks.length > 1) {
    minY = yAxis.ticks[0];
    maxY = yAxis.ticks.at(-1);
  }
  if (axisMeasure) {
    axisMeasure.font = '11px ' + getComputedStyle(chart).fontFamily;
    left = Math.max(left, Math.ceil(Math.max(...yAxis.ticks.map(value => axisMeasure.measureText(axisText(value, yAxis.step)).width)) + 12));
  }
  return { width, height, left, right, top, bottom, minPrice, maxPrice, minY, maxY, xAxis, yAxis, selected, expiry, dte };
}
function interpolateChartModel(from, to, amount) {
  if (!from || from.width !== to.width || from.selected.length !== to.selected.length || from.expiry.length !== to.expiry.length) return to;
  const lerp = (a, b) => a + (b - a) * amount;
  const blendSeries = (a, b) => a.map((point, index) => ({ x: lerp(point.x, b[index].x), y: lerp(point.y, b[index].y) }));
  return {
    ...to,
    minPrice: lerp(from.minPrice, to.minPrice), maxPrice: lerp(from.maxPrice, to.maxPrice),
    minY: lerp(from.minY, to.minY), maxY: lerp(from.maxY, to.maxY),
    selected: blendSeries(from.selected, to.selected), expiry: blendSeries(from.expiry, to.expiry)
  };
}
function chartModelSettled(from, to) {
  if (!from || from.width !== to.width) return true;
  const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
  if (!near(from.minPrice, to.minPrice, .02) || !near(from.maxPrice, to.maxPrice, .02) || !near(from.minY, to.minY, .25) || !near(from.maxY, to.maxY, .25)) return false;
  for (let i = 0; i < to.selected.length; i++) {
    if (!near(from.selected[i].y, to.selected[i].y, .25) || !near(from.expiry[i].y, to.expiry[i].y, .25)) return false;
  }
  return true;
}
function renderChart() {
  const chart = $('payoff-chart');
  const width = Math.max(1, Math.round(chart.getBoundingClientRect().width));
  chart.setAttribute('viewBox', '0 0 ' + width + ' 340');
  if ((state.output === 'risk' && (!Number.isFinite(expirationStats(state).maxLoss) || expirationStats(state).maxLoss <= 0)) || (state.output === 'percent' && Math.abs(netDebit(state)) < 1e-9)) {
    if (chartAnimationFrame) cancelAnimationFrame(chartAnimationFrame);
    chartAnimationFrame = 0; chartAnimationLastFrame = 0;
    chartTargetModel = displayedChartModel = null;
    clear(chart);
    const label = svgNode('text', { x: width / 2, y: 170, fill: 'var(--color-muted)', 'font-size': 14, 'text-anchor': 'middle' });
    label.textContent = state.output === 'percent' ? 'Return is unavailable for zero net premium' : 'Return on max risk is unavailable for this strategy';
    chart.append(label);
    return;
  }
  chartTargetModel = makeChartModel(chart);
  if (!displayedChartModel || displayedChartModel.width !== chartTargetModel.width) {
    if (chartAnimationFrame) cancelAnimationFrame(chartAnimationFrame);
    chartAnimationFrame = 0; chartAnimationLastFrame = 0;
    displayedChartModel = chartTargetModel;
    drawChartFrame(displayedChartModel);
    return;
  }
  if (!chartAnimationFrame) chartAnimationFrame = requestAnimationFrame(animateChartFrame);
}
function animateChartFrame(timestamp) {
  const elapsed = chartAnimationLastFrame ? timestamp - chartAnimationLastFrame : 16;
  chartAnimationLastFrame = timestamp;
  // A damped follow keeps up with strike dragging while easing out when movement stops.
  const amount = 1 - Math.exp(-Math.max(1, elapsed) / 68);
  displayedChartModel = interpolateChartModel(displayedChartModel, chartTargetModel, amount);
  if (chartModelSettled(displayedChartModel, chartTargetModel)) {
    displayedChartModel = chartTargetModel;
    chartAnimationFrame = 0; chartAnimationLastFrame = 0;
  }
  drawChartFrame(displayedChartModel);
  if (chartAnimationFrame) chartAnimationFrame = requestAnimationFrame(animateChartFrame);
}
function drawChartFrame(model) {
  const chart = $('payoff-chart');
  clear(chart);
  const { width, height, left, right, top, bottom, minPrice, maxPrice, minY, maxY, xAxis, yAxis, selected, expiry, dte } = model;
  $('graph-view').style.setProperty('--plot-left', left + 'px');
  const toX = value => left + (value - minPrice) / (maxPrice - minPrice) * (width - left - right);
  const toY = value => top + (maxY - value) / (maxY - minY) * (height - top - bottom);
  const zero = toY(0);
  const defs = svgNode('defs');
  const green = svgNode('linearGradient', { id: 'green-fill', x1: '0', y1: '0', x2: '0', y2: '1' });
  green.append(svgNode('stop', { offset: '0%', 'stop-color': 'var(--color-green)', 'stop-opacity': '.10' }), svgNode('stop', { offset: '100%', 'stop-color': 'var(--color-green)', 'stop-opacity': '.04' }));
  const red = svgNode('linearGradient', { id: 'red-fill', x1: '0', y1: '0', x2: '0', y2: '1' });
  red.append(svgNode('stop', { offset: '0%', 'stop-color': 'var(--color-red)', 'stop-opacity': '.03' }), svgNode('stop', { offset: '100%', 'stop-color': 'var(--color-red)', 'stop-opacity': '.10' }));
  const topClip = svgNode('clipPath', { id: 'profit-clip' });
  topClip.append(svgNode('rect', { x: left, y: top, width: width - left - right, height: Math.max(0, zero - top) }));
  const bottomClip = svgNode('clipPath', { id: 'loss-clip' });
  bottomClip.append(svgNode('rect', { x: left, y: zero, width: width - left - right, height: Math.max(0, height - bottom - zero) }));
  defs.append(green, red, topClip, bottomClip);
  chart.append(defs);
  for (const value of yAxis.ticks) {
    if (Math.abs(value) < (maxY - minY) * .05) continue;
    const y = toY(value);
    chart.append(svgNode('line', { x1: left, y1: y, x2: width - right, y2: y, stroke: 'var(--color-grid)', 'stroke-width': .7 }));
    const text = svgNode('text', { x: left - 6, y: y + 4, fill: 'var(--color-muted)', 'font-size': 11, 'text-anchor': 'end' });
    text.textContent = axisText(value, yAxis.step);
    chart.append(text);
  }
  for (let i = 0; i < xAxis.ticks.length; i++) {
    const price = xAxis.ticks[i];
    const x = toX(price);
    const labelX = i === xAxis.ticks.length - 1 ? width - right - 2 : i === 0 ? left + 2 : x;
    const anchor = i === xAxis.ticks.length - 1 ? 'end' : i === 0 ? 'start' : 'middle';
    const text = svgNode('text', { x: labelX, y: height - 8, fill: 'var(--color-muted)', 'font-size': 11, 'text-anchor': anchor });
    text.textContent = money(price);
    chart.append(text);
  }
  chart.append(svgNode('line', { x1: left, y1: zero, x2: width - right, y2: zero, stroke: 'var(--color-muted)', 'stroke-width': 1.2 }));
  const zeroLabel = svgNode('text', { x: left - 6, y: zero + 4, fill: 'var(--color-text)', 'font-size': 11, 'text-anchor': 'end' });
  zeroLabel.textContent = axisText(0, yAxis.step);
  chart.append(zeroLabel);

  chart.append(svgNode('line', { x1: left, y1: height - bottom, x2: width - right, y2: height - bottom, stroke: 'var(--color-muted)', 'stroke-width': 1 }));
  const area = linePath(selected, toX, toY) + ' L' + toX(maxPrice) + ',' + zero + ' L' + toX(minPrice) + ',' + zero + ' Z';
  chart.append(svgNode('path', { d: area, fill: 'url(#green-fill)', 'clip-path': 'url(#profit-clip)' }));
  chart.append(svgNode('path', { d: area, fill: 'url(#red-fill)', 'clip-path': 'url(#loss-clip)' }));
  const guide = (points, dash, opacity) => {
    const d = linePath(points, toX, toY);
    chart.append(
      svgNode('path', { d, fill: 'none', stroke: 'var(--color-green)', 'stroke-width': 1.3, 'stroke-dasharray': dash, opacity, 'clip-path': 'url(#profit-clip)' }),
      svgNode('path', { d, fill: 'none', stroke: 'var(--color-red)', 'stroke-width': 1.3, 'stroke-dasharray': dash, opacity, 'clip-path': 'url(#loss-clip)' })
    );
  };
  if (dte !== state.day) guide(expiry, '2 4', .58);
  const selectedPath = linePath(selected, toX, toY);
  chart.append(
    svgNode('path', { d: selectedPath, fill: 'none', stroke: 'var(--color-green)', 'stroke-width': 2, 'clip-path': 'url(#profit-clip)' }),
    svgNode('path', { d: selectedPath, fill: 'none', stroke: 'var(--color-red)', 'stroke-width': 2, 'clip-path': 'url(#loss-clip)' })
  );
  const spotX = toX(state.spot);
  chart.append(svgNode('line', { x1: spotX, y1: top, x2: spotX, y2: height - bottom, stroke: 'var(--color-muted)', 'stroke-width': 1, 'stroke-dasharray': '3 5', opacity: .48 }));
  const hoverLine = svgNode('line', { id: 'hover-line', x1: spotX, y1: top, x2: spotX, y2: height - bottom, stroke: 'var(--color-blue)', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
  const hoverDot = svgNode('circle', { id: 'hover-dot', cx: spotX, cy: zero, r: 4, fill: 'var(--color-white)', visibility: 'hidden' });
  chart.append(hoverLine, hoverDot);
  const capture = svgNode('rect', { x: left, y: top, width: width - left - right, height: height - top - bottom, fill: 'transparent' });
  capture.addEventListener('pointermove', event => {
    const rect = chart.getBoundingClientRect();
    const px = clamp((event.clientX - rect.left) / rect.width * width, left, width - right);
    const price = minPrice + (px - left) / (width - left - right) * (maxPrice - minPrice);
    const value = outputValue(state, price, state.day, state.output, state.ivScale);
    hoverLine.setAttribute('x1', px); hoverLine.setAttribute('x2', px); hoverLine.setAttribute('visibility', 'visible');
    hoverDot.setAttribute('cx', px); hoverDot.setAttribute('cy', toY(Number.isFinite(value) ? value : 0)); hoverDot.setAttribute('visibility', 'visible');
    const tip = $('graph-tooltip');
    const measure = { pl: 'Profit / loss', percent: 'Profit / loss', value: 'Contract value', risk: '% of max risk' }[state.output];
    const movePercent = (price / state.spot - 1) * 100;
    const moveClass = Math.abs(movePercent) < 0.005 ? 'flat' : movePercent > 0 ? 'up' : 'down';
    const moveLabel = (movePercent < 0 ? '−' : '+') + Math.abs(movePercent).toFixed(2) + '% underlying move';
    tip.replaceChildren(
      node('span', 'tooltip-caption', 'Stock at ' + money(price, 2)),
      node('small', 'tooltip-move ' + moveClass, moveLabel),
      node('strong', value >= 0 ? 'tooltip-gain' : 'tooltip-loss', formattedOutput(value)),
      node('small', '', measure + ' · ' + (state.day === 0 ? 'today' : state.day === dte ? 'expiration' : displayDate(iso(dateAfter(state.day)))))
    );
    tip.hidden = false;
    tip.style.left = Math.min(rect.width - tip.offsetWidth - 6, Math.max(5, event.clientX - rect.left + 13)) + 'px';
    tip.style.top = Math.min(rect.height - tip.offsetHeight - 6, Math.max(8, event.clientY - rect.top - tip.offsetHeight - 12)) + 'px';
  });
  capture.addEventListener('pointerleave', () => {
    hoverLine.setAttribute('visibility', 'hidden'); hoverDot.setAttribute('visibility', 'hidden'); $('graph-tooltip').hidden = true;
  });
  chart.append(capture);
}
function renderVisualization() {
  $("analysis-title").textContent = { pl: "Profit & loss", percent: "Profit & loss (%)", value: "Contract value", risk: "Return on max risk" }[state.output];
  for (const button of document.querySelectorAll("[data-output]")) {
    const selected = button.dataset.output === state.output;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  renderChart();
}function renderControls() {
  const dte = daysUntil(state.expiry);
  state.day = clamp(state.day, 0, dte);
  $('model-select').value = state.model;
  $('dividend-yield').value = (state.dividendYield * 100).toFixed(2);
  const yieldSource = $('dividend-yield-source');
  const hasEstimate = Number.isFinite(market.quote?.dividendYield);
  yieldSource.textContent = state.dividendYieldMode === 'manual' ? 'Manual' : hasEstimate ? 'TTM est.' : 'No data';
  yieldSource.classList.toggle('yield-source-muted', state.dividendYieldMode === 'manual' || !hasEstimate);
  yieldSource.title = state.dividendYieldMode === 'manual'
    ? 'Manual annual dividend-yield assumption; overrides the automatic estimate.'
    : hasEstimate
      ? 'Yahoo Finance trailing annual dividend-yield estimate. Backward-looking; edit to override.'
      : 'No dividend history estimate is available; using 0%. You can enter a manual assumption.';
  $('yield-auto').hidden = state.dividendYieldMode !== 'manual';
  $('date-slider').max = dte;
  $('date-slider').value = state.day;
  $('range-slider').value = state.range;
  $('iv-slider').value = Math.round(state.ivScale * 100);
  $('date-label').textContent = state.day === 0 ? 'Now' : state.day === dte ? 'Expiration' : displayDate(iso(dateAfter(state.day)));
  $('remaining-label').textContent = (dte - state.day) + 'd to expiration';
  $('reset-scenario').disabled = state.day === 0 && state.range === 15 && state.ivScale === 1;
  $('range-label').textContent = '±' + state.range + '%';
  $('iv-label').textContent = (state.iv * state.ivScale * 100).toFixed(1) + '%';
  $('legend-now').textContent = state.day === 0 ? 'Today' : state.day === dte ? 'Expiration' : displayDate(iso(dateAfter(state.day)));
  $('legend-exp').textContent = 'Expiration';
  $('legend-exp-item').hidden = state.day === dte;
  for (const id of ['date-slider', 'range-slider', 'iv-slider']) {
    const input = $(id);
    const percent = (Number(input.value) - Number(input.min)) / Math.max(1, Number(input.max) - Number(input.min)) * 100;
    input.style.setProperty('--range-fill', percent + '%');
  }
}
function recordMarketFailure(error) {
  market.error = error.message;
  const seconds = /paused for (\d+) seconds/i.exec(error.message)?.[1];
  marketRetryAt = seconds ? Date.now() + Number(seconds) * 1000 : 0;
}
function renderDataStatus() {
  const badge = $('data-button');
  const detail = $('data-status-detail');
  const seconds = Math.max(0, Math.ceil((marketRetryAt - Date.now()) / 1000));
  const wait = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  badge.textContent = market.connected ? '● Yahoo Finance' : '◌ Sample data';
  badge.classList.toggle('connected', market.connected);
  badge.classList.toggle('sample', !market.connected);
  badge.setAttribute('aria-busy', String(market.loading));
  badge.title = market.connected ? 'Yahoo Finance connected; quotes may be delayed' : 'View market data status and source details';
  if (market.connected) {
    const time = Number(market.quote?.regularMarketTime);
    const asOf = time > 0 ? new Date(time * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : null;
    const adjusted = Math.abs(state.spot - Number(market.quote?.last)) > .005;
    const parts = [];
    if (adjusted) parts.push(node('span', '', 'Custom underlying price'));
    parts.push(node('span', 'quote-freshness', 'Delayed'));
    parts.push(node('span', '', asOf ? 'Quote as of ' + asOf : 'Quote time unavailable'));
    if (state.legs.some(leg => !market.chain.some(option => option.type === leg.type && Math.abs(option.strike - leg.strike) < .001))) parts.push(node('span', '', 'Some saved positions are not listed in the current chain'));
    if (market.error) parts.push(node('span', '', 'Refresh unavailable'));
    else if (market.loading) parts.push(node('span', '', 'Refreshing…'));
    detail.replaceChildren(...parts.flatMap((part, index) => index ? [document.createTextNode(' · '), part] : [part]));
  } else {
    if (market.loading) detail.textContent = 'Illustrative prices · Connecting to Yahoo Finance…';
    else detail.replaceChildren(node('span', '', 'Illustrative prices · Yahoo unavailable'), node('span', 'status-retry', seconds ? '· Retry in ' + wait : '· Open data details to retry'));
  }
  const retry = $('retry-market-data');
  if (retry) {
    retry.disabled = market.loading || seconds > 0;
    retry.textContent = market.loading ? 'Connecting…' : seconds ? 'Retry in ' + wait : market.connected ? 'Reload data' : 'Retry Yahoo Finance';
  }
  clearTimeout(marketStatusTimer);
  if (seconds > 0) marketStatusTimer = setTimeout(renderDataStatus, 1000);
}
function render() {
  const now = new Date();
  const currentDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (currentDate.getTime() !== startDate.getTime()) {
    startDate = currentDate;
    state.day = clamp(state.day, 0, daysUntil(state.expiry));
  }
  closeContractMenu(false);
  $('spot-currency').textContent = currencyLabel();
  $('output-pl').textContent = 'Profit / loss ' + currencyLabel();
  $('gamma-unit').textContent = 'shares / 1 ' + currencyLabel();
  $('symbol-input').value = state.symbol;
  if (document.activeElement !== $('spot-input')) $('spot-input').value = state.spot.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $('strategy-select').value = state.strategy;
  const changeLabel = document.querySelector('.quote-change');
  renderDataStatus();
  if (market.connected) {
    const change = market.quote.change_percentage == null ? NaN : Number(market.quote.change_percentage), dollars = market.quote.change == null ? NaN : Number(market.quote.change);
    changeLabel.hidden = !Number.isFinite(change) || Math.abs(state.spot - Number(market.quote.last)) > .005;
    changeLabel.style.color = change >= 0 ? 'var(--color-green)' : 'var(--color-red)';
    if (Number.isFinite(change)) changeLabel.replaceChildren(document.createTextNode((change >= 0 ? '+' : '') + change.toFixed(2) + '%'), node('small', '', Number.isFinite(dollars) ? (dollars >= 0 ? '+' : '−') + money(dollars, 2) : ''));
  } else {
    changeLabel.hidden = true;
  }
  document.querySelector('.data-note').textContent = 'Payoffs are model estimates for the full strategy. Standard contracts represent 100 shares; prices are in ' + (market.connected && market.quote?.currency ? market.quote.currency : 'the quote currency') + '.';
  renderExpiration(); renderRuler(); renderStats(); renderControls(); renderVisualization(); syncContractEditor();
}
function modal(title) {
  if ($('modal-backdrop').hidden) modalReturnFocus = document.activeElement;
  $('modal-title').textContent = title;
  clear($('modal-content'));
  $('modal-backdrop').hidden = false;
  requestAnimationFrame(() => $('close-modal').focus());
}
function closeModal() {
  if ($('modal-backdrop').hidden) return;
  $('modal-backdrop').hidden = true;
  const target = modalReturnFocus;
  modalReturnFocus = null;
  if (target?.isConnected && target.getClientRects().length) target.focus();
  else ($('positions-button').hidden ? document.querySelector('.strategy-leg-row') : $('positions-button'))?.focus();
}
function field(label, value, kind = 'text', options = []) {
  const wrap = node('label', 'form-field');
  wrap.append(node('span', '', label));
  let control;
  if (kind === 'select') {
    control = node('select');
    for (const option of options) {
      const choice = node('option', '', option[1]);
      choice.value = option[0];
      control.append(choice);
    }
  } else {
    control = node('input');
    control.type = kind;
    if (kind === 'number') { control.min = '0'; control.step = 'any'; }
  }
  control.value = String(value);
  wrap.append(control);
  return { wrap, control };
}
function actions(...buttons) {
  const bar = node('div', 'modal-actions');
  for (const [label, className, handler] of buttons) {
    const button = node('button', className, label);
    button.type = 'button'; button.onclick = handler; bar.append(button);
  }
  return bar;
}
function captureContractDeltas() {
  const days = Math.max(0, daysUntil(state.expiry) - state.day);
  return state.legs.map(leg => {
    const contract = market.chain.find(option => option.type === leg.type && Math.abs(option.strike - leg.strike) < .001);
    const volatility = contractImpliedVolatility(contract?.iv, state.iv) * state.ivScale;
    return {
      id: leg.id,
      type: leg.type,
      delta: optionDelta(leg.type, state.spot, leg.strike, days, volatility, RATE, state.model, state.dividendYield),
      moneyness: leg.strike / state.spot
    };
  });
}

async function loadMarketSymbol(client, symbol, deltaTargets = null, preservePositions = false) {
  const version = ++marketRequestVersion;
  market.loading = true;
  market.error = '';
  renderDataStatus();
  let quote, dates, expiry, chain;
  try {
    if (typeof client.loadSymbol === 'function') {
      const snapshot = await client.loadSymbol(symbol, state.expiry);
      quote = snapshot.quote;
      dates = snapshot.expirations;
      expiry = dates.includes(snapshot.selectedExpiration) ? snapshot.selectedExpiration : dates.includes(state.expiry) ? state.expiry : dates[0];
      chain = snapshot.chain;
    } else {
      [quote, dates] = await Promise.all([client.quote(symbol), client.expirations(symbol)]);
    }
    if (!dates.length) throw new Error('No option expirations were returned for ' + symbol + '.');
    if (!expiry) expiry = dates.includes(state.expiry) ? state.expiry : dates.find(date => daysUntil(date) > 0) || dates[0];
    if (!chain) chain = await client.chain(symbol, expiry);
    if (!chain.length) throw new Error('No standard 100-share options were returned for this expiration.');
    if (!preservePositions && state.legs.some(leg => !chain.some(option => option.type === leg.type))) throw new Error('No listed contracts are available for a position type in this expiration.');
    if (preservePositions && expiry !== state.expiry) throw new Error('The saved expiration is no longer listed. Saved positions remain unchanged.');
  } catch (error) {
    if (version !== marketRequestVersion) return false;
    market.loading = false;
    recordMarketFailure(error);
    renderDataStatus();
    throw error;
  }
  if (version !== marketRequestVersion) return false;
  market = { client, connected: true, quote, expirations: dates, chain, loading: false, error: '' };
  marketRetryAt = 0;
  if (symbol !== state.symbol) state.dividendYieldMode = 'auto';
  state.symbol = symbol;
  state.spot = Number(quote.last);
  if (state.dividendYieldMode === 'auto') state.dividendYield = clamp(Number(quote.dividendYield) || 0, 0, .25);
  state.expiry = expiry;
  if (!preservePositions) state.day = 0;
  else state.day = clamp(state.day, 0, daysUntil(expiry));
  const near = chain.filter(option => option.type === 'call' && option.iv > 0).sort((a, b) => Math.abs(a.strike - state.spot) - Math.abs(b.strike - state.spot))[0];
  if (near) state.iv = near.iv > 3 ? near.iv / 100 : near.iv;
  const targetsById = new Map((deltaTargets || []).map(target => [target.id, target]));
  for (const leg of state.legs) {
    if (preservePositions) continue;
    const candidates = chain.filter(option => option.type === leg.type);
    const target = targetsById.get(leg.id);
    if (target && candidates.length) {
      leg.strike = closestStrikeAtDelta({
        chain: candidates,
        type: leg.type,
        targetDelta: target.delta,
        spot: state.spot,
        days: daysUntil(state.expiry),
        iv: state.iv,
        ivScale: state.ivScale,
        model: state.model,
        dividendYield: state.dividendYield
      }) ?? candidates.reduce((best, option) => Math.abs(option.strike - state.spot * target.moneyness) < Math.abs(best.strike - state.spot * target.moneyness) ? option : best, candidates[0]).strike;
    } else if (candidates.length && !candidates.some(option => Math.abs(option.strike - leg.strike) < .001)) {
      leg.strike = candidates.reduce((best, option) => Math.abs(option.strike - leg.strike) < Math.abs(best.strike - leg.strike) ? option : best, candidates[0]).strike;
    }
    if (!leg.manual) leg.premium = samplePremium(leg.type, leg.strike);
  }
  render();
  return true;
}
function closeTickerSuggestions() {
  const input = $('symbol-input');
  const list = $('ticker-suggestions');
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
  list.hidden = true;
  clear(list);
  tickerActiveIndex = -1;
}
function highlightTickerSuggestion(index) {
  const options = [...$('ticker-suggestions').querySelectorAll('[role="option"]')];
  if (!options.length) return;
  tickerActiveIndex = (index + options.length) % options.length;
  options.forEach((option, optionIndex) => {
    const selected = optionIndex === tickerActiveIndex;
    option.classList.toggle('active', selected);
    option.setAttribute('aria-selected', String(selected));
  });
  $('symbol-input').setAttribute('aria-activedescendant', options[tickerActiveIndex].id);
  options[tickerActiveIndex].scrollIntoView({ block: 'nearest' });
}
function renderTickerSuggestions(query) {
  const input = $('symbol-input');
  const list = $('ticker-suggestions');
  clear(list);
  const suggestions = getTickerSuggestions(query);
  input.removeAttribute('aria-activedescendant');
  tickerActiveIndex = -1;
  if (!String(query || '').trim()) {
    closeTickerSuggestions();
    return;
  }
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  if (!suggestions.length) {
    list.append(node('div', 'symbol-suggestions-empty', 'No popular matches · press Enter to try this ticker'));
    return;
  }
  suggestions.forEach((ticker, index) => {
    const option = node('div', 'symbol-suggestion');
    option.id = 'ticker-option-' + index;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.dataset.symbol = ticker.symbol;
    option.append(node('strong', 'symbol-suggestion-symbol', ticker.symbol), node('span', 'symbol-suggestion-name', ticker.name));
    option.addEventListener('pointerdown', event => event.preventDefault());
    option.addEventListener('click', () => chooseTicker(ticker.symbol));
    list.append(option);
  });
}
async function commitTicker(value) {
  const symbol = String(value || '').trim().toUpperCase() || 'MU';
  closeTickerSuggestions();
  $('symbol-input').value = symbol;
  if (symbol === state.symbol) {
    if (requestedSymbol) {
      tickerCommitVersion++;
      requestedSymbol = '';
      marketRequestVersion++;
      market.loading = false;
      render();
    }
    return;
  }
  if (symbol === requestedSymbol) return;
  const deltaTargets = captureContractDeltas();
  const requestVersion = ++tickerCommitVersion;
  requestedSymbol = symbol;
  try {
    const loaded = await loadMarketSymbol(market.client || new YFinanceClient(), symbol, deltaTargets);
    const mappedContractExists = deltaTargets.some(target => {
      const leg = state.legs.find(item => item.id === target.id);
      return leg && market.chain.some(option => option.type === leg.type && Math.abs(option.strike - leg.strike) < .001);
    });
    if (loaded && mappedContractExists) showToast('Contracts adjusted to similar deltas on ' + symbol + '.');
  } catch (error) {
    if (!market.connected) market.client = null;
    showToast(error.message);
    render();
  } finally {
    if (requestVersion === tickerCommitVersion) requestedSymbol = '';
  }
}
function chooseTicker(symbol) {
  $('symbol-input').value = symbol;
  closeTickerSuggestions();
  commitTicker(symbol);
}
async function loadMarketExpiry(value) {
  const version = ++marketRequestVersion;
  const symbol = state.symbol, client = market.client;
  try {
    const chain = await client.chain(symbol, value);
    if (version !== marketRequestVersion || state.symbol !== symbol || market.client !== client) return;
    if (!chain.length) throw new Error('No standard options returned for that expiration.');
    if (state.legs.some(leg => !chain.some(option => option.type === leg.type))) throw new Error('No listed contracts are available for a position type in that expiration.');
    market.chain = chain;
    market.loading = false;
    state.expiry = value;
    state.day = 0;
    const near = chain.filter(option => option.type === 'call' && option.iv > 0).sort((a, b) => Math.abs(a.strike - state.spot) - Math.abs(b.strike - state.spot))[0];
    if (near) state.iv = contractImpliedVolatility(near.iv, state.iv);
    for (const leg of state.legs) {
      leg.strike = availableStrike(leg.type, leg.strike);
      if (!leg.manual) leg.premium = samplePremium(leg.type, leg.strike);
    }
    render();
  } catch (error) { if (version === marketRequestVersion) { market.loading = false; renderDataStatus(); showToast(error.message); } }
}
function openDataSettings() {
  modal('Market Data');
  const message = node('p', '', market.connected
    ? 'Quotes and option chains come from Yahoo Finance. Data may be delayed, and an option’s last trade can be older than its bid and ask.'
    : market.loading
      ? 'Connecting to Yahoo Finance. Illustrative sample values are shown until data is available.'
      : 'Yahoo Finance is unavailable. Prices, option premiums, and results currently use editable sample values.');
  $('modal-content').append(message);
  $('modal-content').append(node('p', 'provider-note', 'Data is cached for five minutes. After a connection failure or rate limit, requests pause before a manual retry is available.'));
  const errorText = node('p', '', '');
  errorText.setAttribute('role', 'status');
  $('modal-content').append(errorText);
  const bar = actions(['Close', 'secondary-button', closeModal], [market.connected ? 'Reload data' : 'Retry Yahoo Finance', 'primary-button', async () => {
    const button = bar.lastChild;
    button.disabled = true;
    errorText.textContent = '';
    try {
      renderDataStatus();
      const connected = await loadMarketSymbol(market.client || new YFinanceClient(), state.symbol);
      if (!connected) return;
      closeModal();
      showToast('Yahoo Finance data loaded.');
    } catch (error) {
      errorText.textContent = /paused for \d+ seconds/i.test(error.message) ? 'Yahoo Finance is still unavailable. Please wait for the retry countdown.' : error.message;
      renderDataStatus();
    }
  }]);
  bar.lastChild.id = 'retry-market-data';
  $('modal-content').append(bar);
  renderDataStatus();
}
function openAssumptions() {
  modal('Pricing assumptions');
  $('modal-content').append(
    node('p', '', 'The selected model estimates option values before expiration. Bjerksund–Stensland 2002 approximates American options, including early exercise. Black–Scholes provides a European-style comparison.'),
    node('p', '', 'Interest rate: fixed at 4% annually. Dividend yield: a trailing Yahoo Finance estimate when available, or your manual assumption. A missing estimate defaults to 0%; it does not confirm that the stock pays no dividend.'),
    node('p', '', 'The volatility slider adjusts the base implied-volatility estimate for this scenario. Reset returns to today, ±15% chart range, and the base volatility; your contracts and pricing assumptions are preserved.'),
    actions(['Close', 'primary-button', closeModal])
  );
}
function openCustomExpiry() {
  modal('Custom Expiration');
  const date = field('Expiration date', state.expiry, 'date');
  $('modal-content').append(date.wrap, actions(['Cancel', 'secondary-button', closeModal], ['Use Date', 'primary-button', () => {
    const value = date.control.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || daysUntil(value) < 1) { showToast('Choose a future expiration date.'); return; }
    if (market.connected && !market.expirations.includes(value)) { showToast('Choose an expiration listed by the connected data source.'); return; }
    if (market.connected) { closeModal(); loadMarketExpiry(value); return; }
    state.expiry = value;
    state.day = 0;
    for (const leg of state.legs) if (!leg.manual) leg.premium = samplePremium(leg.type, leg.strike);
    closeModal(); render();
  }]));
}
function openAdd() {
  if (state.legs.length >= 16) { showToast('A strategy can contain up to 16 positions.'); return; }
  modal('Add Option');
  $('modal-content').append(node('p', '', 'Add a call or put to the current strategy. The suggested premium is illustrative and can be edited.'));
  const grid = node('div', 'form-grid');
  const type = field('Option type', 'call', 'select', [['call', 'Call'], ['put', 'Put']]);
  const side = field('Side', '1', 'select', [['1', 'Buy (long)'], ['-1', 'Sell (short)']]);
  const initialStrike = availableStrike('call', state.spot);
  const strike = field('Strike price (' + currencyLabel() + ')', initialStrike ?? state.spot, 'number');
  const qty = field('Contracts', 1, 'number');
  const premium = field('Entry premium (' + currencyLabel() + ' / share)' , samplePremium('call', Number(strike.control.value)).toFixed(2), 'number');
  strike.control.min = '.01'; strike.control.max = '1000000'; premium.control.max = '1000000'; qty.control.min = '1'; qty.control.max = '100'; qty.control.step = '1';
  type.control.onchange = () => {
    const listed = availableStrike(type.control.value, Number(strike.control.value));
    if (listed == null) { showToast('No listed ' + type.control.value + ' contracts are available for this expiration.'); return; }
    strike.control.value = String(listed);
    premium.control.value = samplePremium(type.control.value, listed).toFixed(2);
  };
  strike.control.onchange = () => { if (availableStrike(type.control.value, Number(strike.control.value)) != null) premium.control.value = samplePremium(type.control.value, Number(strike.control.value)).toFixed(2); };
  for (const item of [type, side, strike, qty, premium]) grid.append(item.wrap);
  $('modal-content').append(grid, actions(['Cancel', 'secondary-button', closeModal], ['Add Position', 'primary-button', () => {
    for (const control of [strike.control, qty.control, premium.control]) { control.required = true; if (!control.reportValidity()) return; }
    const k = Number(strike.control.value), q = Number(qty.control.value), p = Number(premium.control.value);
    if (market.connected && !market.chain.some(option => option.type === type.control.value && Math.abs(option.strike - k) < .001)) { showToast('Choose a listed strike for this option type.'); return; }
    if (!(k > 0 && q > 0 && p >= 0)) { showToast('Enter a valid strike, quantity, and premium.'); return; }
    state.legs.push({ id: nextId++, type: type.control.value, side: Number(side.control.value), strike: k, qty: q, premium: p, manual: true, excluded: false });
    classifyStrategy(); closeModal(); render(); showToast('Position added.');
  }]));
}
function openPositions(focusLegId = null) {
  const single = typeof focusLegId === 'number' ? focusLegId : null;
  const entries = [];
  modal(single == null ? 'Manage positions' : 'Edit position');
  $('modal-content').append(node('p', '', 'Set your entry premium per share. One standard contract represents 100 shares. Changes apply when you save.'));
  for (const leg of state.legs.filter(leg => single == null || leg.id === single)) {
    const card = node('div', 'position-card' + (leg.excluded ? ' excluded' : ''));
    card.dataset.legId = String(leg.id);
    const head = node('div', 'position-head');
    head.append(node('strong', leg.type === 'put' ? 'put' : '', (leg.side === 1 ? 'Buy ' : 'Sell ') + money(leg.strike, leg.strike % 1 ? 2 : 0) + ' ' + leg.type), node('span', '', displayDate(state.expiry)));
    card.append(head);
    const grid = node('div', 'form-grid');
    const type = field('Option type', leg.type, 'select', [['call', 'Call'], ['put', 'Put']]);
    const side = field('Side', leg.side, 'select', [['1', 'Buy (long)'], ['-1', 'Sell (short)']]);
    const strike = field('Strike price (' + currencyLabel() + ')' , leg.strike, 'number');
    const qty = field('Contracts', leg.qty, 'number');
    const premium = field('Entry premium (' + currencyLabel() + ' / share)' , leg.premium.toFixed(2), 'number');
    strike.control.min = '.01'; strike.control.max = '1000000'; premium.control.max = '1000000'; qty.control.min = '1'; qty.control.max = '100'; qty.control.step = '1'; premium.control.min = '0';
    for (const item of [type, side, strike, qty, premium]) grid.append(item.wrap);
    card.append(grid);
    const controls = node('div', 'position-actions');
    const entry = { leg, type, side, strike, qty, premium, removed: false, modelPremium: null };
    entries.push(entry);
    const toggle = node('label', 'position-include');
    const included = node('input'); included.type = 'checkbox'; included.checked = !leg.excluded;
    toggle.append(included, node('span', '', 'Include in analysis'));
    included.onchange = () => card.classList.toggle('excluded', !included.checked);
    entry.included = included;
    const reset = node('button', 'text-button', 'Use model premium');
    reset.type = 'button';
    reset.onclick = () => {
      if (!(Number(strike.control.value) > 0)) { strike.control.reportValidity(); return; }
      premium.control.value = samplePremium(type.control.value, Number(strike.control.value)).toFixed(2);
      entry.modelPremium = { type: type.control.value, strike: Number(strike.control.value), premium: Number(premium.control.value) };
    };
    const remove = node('button', 'position-remove', 'Remove position'); remove.type = 'button';
    remove.disabled = state.legs.length === 1;
    remove.onclick = () => {
      const remaining = state.legs.length - entries.filter(item => item.removed).length;
      if (!entry.removed && remaining <= 1) { showToast('Keep at least one position.'); return; }
      entry.removed = !entry.removed;
      grid.hidden = entry.removed; toggle.hidden = entry.removed; reset.hidden = entry.removed;
      card.classList.toggle('removed', entry.removed);
      remove.textContent = entry.removed ? 'Undo removal' : 'Remove position';
    };
    controls.append(toggle, reset, remove); card.append(controls);
    $('modal-content').append(card);
  }
  $('modal-content').append(actions(['Cancel', 'secondary-button', closeModal], ['Save changes', 'primary-button', () => {
    const updates = new Map();
    for (const entry of entries) {
      if (entry.removed) { updates.set(entry.leg.id, null); continue; }
      const { type, side, strike, qty, premium, leg } = entry;
      for (const control of [strike.control, qty.control, premium.control]) {
        control.required = true;
        if (!control.reportValidity()) return;
      }
      const k = Number(strike.control.value), q = Number(qty.control.value), p = Number(premium.control.value);
      if (market.connected && (type.control.value !== leg.type || k !== leg.strike) && !market.chain.some(option => option.type === type.control.value && Math.abs(option.strike - k) < .001)) { showToast('Choose a listed strike for this option type.'); return; }
      const model = entry.modelPremium;
      const usesModel = model && model.type === type.control.value && model.strike === k && model.premium === p;
      const priceChanged = type.control.value !== leg.type || k !== leg.strike || p !== leg.premium;
      updates.set(leg.id, { ...leg, type: type.control.value, side: Number(side.control.value), strike: k, qty: q, premium: p,
        manual: usesModel ? false : priceChanged ? true : leg.manual, excluded: !entry.included.checked });
    }
    state.legs = state.legs.flatMap(leg => updates.has(leg.id) ? updates.get(leg.id) ? [updates.get(leg.id)] : [] : [leg]);
    classifyStrategy(); closeModal(); render(); showToast('Position changes saved.');
    const returnRow = single == null ? null : document.querySelector('.strategy-leg-row[data-leg-id="' + single + '"]');
    (returnRow || ($('positions-button').hidden ? document.querySelector('.strategy-leg-row') : $('positions-button')))?.focus();
  }]));
}
function getSaved() {
  try { const trades = JSON.parse(localStorage.getItem('openstrat-trades') || '[]'); return Array.isArray(trades) ? trades.filter(trade => trade && typeof trade === 'object') : []; } catch { return []; }
}
async function share() {
  const url = new URL(location.href);
  url.searchParams.set('s', btoa(JSON.stringify(state)));
  try { await navigator.clipboard.writeText(url.href); showToast('Share link copied.'); }
  catch { showToast('Could not copy the share link.'); }
}
function openSave() {
  modal('Save Trade');
  $('modal-content').append(node('p', '', 'Save this strategy in this browser, or copy a link that contains the current settings.'));
  const name = field('Strategy name', state.symbol + ' ' + names[state.strategy] + ' ' + displayDate(state.expiry));
  $('modal-content').append(name.wrap, actions(['Copy Share Link', 'secondary-button', share], ['Save Locally', 'primary-button', () => {
    const trades = getSaved();
    trades.unshift({ id: Date.now(), name: name.control.value.trim() || 'Untitled Trade', savedAt: new Date().toISOString(), state: structuredClone(state) });
    try { localStorage.setItem('openstrat-trades', JSON.stringify(trades.slice(0, 50))); showToast('Trade saved in this browser.'); closeModal(); }
    catch { showToast('This browser could not save the strategy.'); }
  }]));
}
async function showContractHistory() {
  const leg = state.legs[0];
  const option = market.chain.find(item => item.type === leg.type && Math.abs(item.strike - leg.strike) < .001);
  if (!option?.symbol) { $('modal-content').prepend(node('p', '', 'No matching contract history is available for this leg.')); return; }
  const host = node('div', 'history-host');
  const status = node('p', '', 'Loading historical contract prices…');
  host.append(status);
  $('modal-content').prepend(host);
  try {
    const history = await market.client.history(option.symbol);
    clear(host);
    if (history.length < 2) { host.append(node('p', '', 'Yahoo Finance option history is not available through this connector.')); return; }
    host.append(node('p', '', option.symbol + ' · daily close per share'));
    const width = 500, height = 180, left = 45, right = 12, top = 12, bottom = 28;
    const values = history.map(day => day.close);
    const min = Math.min(...values), max = Math.max(...values);
    const span = Math.max(.01, max - min);
    const x = index => left + index / (history.length - 1) * (width - left - right);
    const y = value => top + (max - value + span * .08) / (span * 1.16) * (height - top - bottom);
    const chart = svgNode('svg', { viewBox: '0 0 500 180', class: 'historical-mini-chart', role: 'img', 'aria-label': 'Historical option contract close prices' });
    chart.append(svgNode('line', { x1: left, y1: height - bottom, x2: width - right, y2: height - bottom, stroke: 'var(--color-border)' }));
    chart.append(svgNode('polyline', { points: history.map((day, index) => x(index) + ',' + y(day.close)).join(' '), fill: 'none', stroke: 'var(--color-blue)', 'stroke-width': 2.5 }));
    for (const [index, label] of [[0, history[0].date], [history.length - 1, history[history.length - 1].date]]) {
      const text = svgNode('text', { x: x(index), y: height - 7, fill: 'var(--color-muted)', 'font-size': 11, 'text-anchor': index === 0 ? 'start' : 'end' });
      text.textContent = label; chart.append(text);
    }
    const high = svgNode('text', { x: left - 4, y: top + 12, fill: 'var(--color-muted)', 'font-size': 11, 'text-anchor': 'end' });
    high.textContent = money(max, 2);
    const low = svgNode('text', { x: left - 4, y: height - bottom, fill: 'var(--color-muted)', 'font-size': 11, 'text-anchor': 'end' });
    low.textContent = money(min, 2);
    chart.append(high, low); host.append(chart);
  } catch (error) { clear(host); host.append(node('p', '', error.message)); }
}
function openHistory() {
  modal('Saved strategies');
  $('modal-content').append(node('p', '', 'Strategies saved in this browser are listed below.'));
  if (market.connected && state.legs.length === 1) showContractHistory();
  const trades = getSaved();
  if (!trades.length) $('modal-content').append(node('p', '', 'No strategies saved yet.'));
  for (const trade of trades) {
    const row = node('div', 'saved-item');
    const info = node('div');
    info.append(node('strong', '', trade.name), node('small', '', new Date(trade.savedAt).toLocaleString()));
    const load = node('button', 'secondary-button', 'Load');
    load.onclick = () => {
      const restored = safeState(trade.state);
      if (!restored) { showToast('Could not load that trade.'); return; }
      state = restored; nextId = Math.max(...state.legs.map(leg => leg.id)) + 1;
      const client = market.client || new YFinanceClient();
      marketRequestVersion++;
      market = { client, connected: false, quote: null, expirations: [], chain: [], loading: true, error: '' };
      closeModal(); render();
      loadMarketSymbol(client, state.symbol, null, true).then(loaded => { if (loaded) showToast('Trade loaded; saved entry prices preserved.'); }).catch(error => { render(); showToast('Trade loaded; market data unavailable: ' + error.message); });
    };
    row.append(info, load); $('modal-content').append(row);
  }
}
function openStrategyHelp() {
  modal('Using the strategy builder');
  $('modal-content').append(
    node('p', '', 'Choose a preset and expiration, then click a contract to edit it. Press and hold a contract while moving to adjust its strike. Click empty space on the strike ruler to add a call or put; right-click for the same add menu.'),
    node('p', '', 'The solid payoff line uses the scenario date below the chart. The dotted line shows the payoff at expiration.'),
    actions(['Edit positions', 'secondary-button', () => openPositions()], ['Close', 'primary-button', closeModal])
  );
}
$('strategy-select').addEventListener('change', event => {
  if (event.target.value === 'custom') { state.strategy = 'custom'; renderStats(); }
  else preset(event.target.value);
});
$('symbol-input').addEventListener('input', event => {
  event.currentTarget.value = event.currentTarget.value.toUpperCase();
  renderTickerSuggestions(event.currentTarget.value);
});
$('symbol-input').addEventListener('blur', () => setTimeout(closeTickerSuggestions, 0));
$('ticker-suggestions').addEventListener('pointerdown', event => {
  if (event.target.closest('[role="option"]')) event.preventDefault();
});
$('symbol-input').addEventListener('change', event => commitTicker(event.currentTarget.value));
$('symbol-input').addEventListener('keydown', event => {
  const list = $('ticker-suggestions');
  const options = list.querySelectorAll('[role="option"]');
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (list.hidden) renderTickerSuggestions(event.currentTarget.value);
    const currentOptions = list.querySelectorAll('[role="option"]');
    if (currentOptions.length) {
      const target = tickerActiveIndex < 0
        ? (event.key === 'ArrowDown' ? 0 : currentOptions.length - 1)
        : tickerActiveIndex + (event.key === 'ArrowDown' ? 1 : -1);
      highlightTickerSuggestion(target);
    }
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (!list.hidden && options.length) chooseTicker(options[tickerActiveIndex >= 0 ? tickerActiveIndex : 0].dataset.symbol);
    else commitTicker(event.currentTarget.value);
    event.currentTarget.blur();
  } else if (event.key === 'Escape' && !list.hidden) {
    event.preventDefault();
    event.currentTarget.value = state.symbol;
    closeTickerSuggestions();
  }
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.symbol-combobox')) closeTickerSuggestions();
});
$('strategy-help').onclick = openStrategyHelp;
$('data-button').onclick = openDataSettings;
$('expiry-prev').onclick = () => scrollExpirations(-1);
$('expiry-next').onclick = () => scrollExpirations(1);
$('expiration-strip').addEventListener('scroll', updateExpirationNav, { passive: true });
$('spot-input').addEventListener('focus', event => { event.target.value = state.spot.toFixed(2); event.target.select(); });
$('spot-input').addEventListener('change', event => { const value = Number(event.target.value.replaceAll(',', '')); if (Number.isFinite(value) && value > 0 && value <= 1000000) state.spot = value; else showToast('Enter a price greater than zero.'); render(); });
$('spot-input').addEventListener('blur', event => { event.target.value = state.spot.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); });
$('assumptions-help').onclick = openAssumptions;
$('reset-scenario').onclick = () => { state.day = 0; state.range = 15; state.ivScale = 1; render(); };
$('model-select').addEventListener('change', event => {
  state.model = [PRICING_MODELS.AMERICAN, PRICING_MODELS.EUROPEAN].includes(event.target.value) ? event.target.value : PRICING_MODELS.AMERICAN;
  render();
});
$('dividend-yield').addEventListener('change', event => {
  state.dividendYield = clamp((Number(event.target.value) || 0) / 100, 0, .25);
  state.dividendYieldMode = 'manual';
  render();
});
$('yield-auto').addEventListener('click', () => {
  state.dividendYieldMode = 'auto';
  state.dividendYield = clamp(Number(market.quote?.dividendYield) || 0, 0, .25);
  render();
});
$('add-leg').onclick = openAdd;
$('positions-button').onclick = () => openPositions();
$('save-button').onclick = openSave;
$('history-button').onclick = openHistory;
$('close-modal').onclick = closeModal;
$('modal-backdrop').addEventListener('click', event => { if (event.target === $('modal-backdrop')) closeModal(); });
document.addEventListener('keydown', event => {
  if ($('modal-backdrop').hidden) return;
  if (event.key === 'Escape') { closeModal(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...$('modal-backdrop').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')].filter(item => item.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$('date-slider').addEventListener('input', event => { state.day = Number(event.target.value); renderGreeks(); renderControls(); renderVisualization(); });
$('range-slider').addEventListener('input', event => { state.range = Number(event.target.value); renderRuler(); renderControls(); renderVisualization(); });
$('iv-slider').addEventListener('input', event => { state.ivScale = Number(event.target.value) / 100; renderStats(); renderControls(); renderVisualization(); });
for (const button of document.querySelectorAll('[data-output]')) button.onclick = () => { state.output = button.dataset.output; renderVisualization(); };
render();
if (market.loading) {
  const client = new YFinanceClient();
  loadMarketSymbol(client, state.symbol, null, restoredFromLink).then(connected => {
    if (connected) showToast('Yahoo Finance data loaded through yfinance.');
  }).catch(error => {
    market.client = null;
    market.loading = false;
    recordMarketFailure(error);
    render();
  });
}


// Refresh calendar-relative controls if the page remains open overnight.
setInterval(() => { if (iso(new Date()) !== iso(startDate)) render(); }, 60_000);
window.addEventListener('resize', () => { closeContractMenu(false); renderExpiration(); renderRuler(); renderVisualization(); });
