import { buildRefractionMap, roundedRectSample } from './glass-optics.js';

const ns = 'http://www.w3.org/2000/svg';
const design = new URLSearchParams(location.search).get('design');
const hierarchyDesign = design === 'hierarchy';
const exactPreviousDesign = design === 'previous';
const createSvg = (name, attributes = {}) => {
  const element = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
};
// The live vector tile also supplies an explicit source for chart refraction.
const svgFilters = CSS.supports('filter', 'url("#glass-support-test")');
const materials = [];
const glassByElement = new WeakMap();
const settings = Object.freeze({ refraction: .85, frost: .35 });
document.documentElement.dataset.glassRenderer = svgFilters ? 'refractive' : 'frosted';
const defsRoot = createSvg('svg', { 'aria-hidden': 'true', focusable: 'false', class: 'liquid-filter-defs' });
const defs = createSvg('defs');
defsRoot.append(defs);
document.body.prepend(defsRoot);
let nextId = 0, lightFrame = 0, lastLightTime = 0;

function applyOpticalSettings(material) {
  const blur = material.options.blur * (1 + settings.frost * 6);
  const popup = material.element.matches('.contract-menu, .contract-editor');
  const tooltipGlass = material.element.matches('.graph-tooltip') && !exactPreviousDesign;
  const floating = material.element.matches('.glass-interactive, .modal, .graph-tooltip') || popup;
  material.refractor.style.backdropFilter = floating ? `blur(${blur}px)${popup || tooltipGlass ? ' saturate(1.2)' : ''}` : 'none';
  material.refractor.style.webkitBackdropFilter = material.refractor.style.backdropFilter;
  if (!material.field) {
    return;
  }
  const strength = settings.refraction;
  for (let i = 0; i < material.displacements.length; i++) {
    material.displacements[i].setAttribute('scale', material.field.scale * strength);
  }
  material.blur?.setAttribute('stdDeviation', material.options.blur * (.25 + settings.frost * 1.75));
}

function buildFilter(material, width, height) {
  const style = getComputedStyle(material.element);
  const radius = parseFloat(style.borderTopLeftRadius) || 20;
  const field = buildRefractionMap(width, height, { radius, ...material.options });
  const canvas = document.createElement('canvas');
  canvas.width = field.pixelWidth;
  canvas.height = field.pixelHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');
  context.putImageData(new ImageData(field.pixels, field.pixelWidth, field.pixelHeight), 0, 0);
  const pad = field.padding;
  const bounds = { x: -pad, y: -pad, width: width + pad * 2, height: height + pad * 2 };
  const filter = material.filter || createSvg('filter', {
    id: material.id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB'
  });
  for (const [key, value] of Object.entries(bounds)) filter.setAttribute(key, value);
  filter.replaceChildren();
  filter.append(createSvg('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '.01', result: 'backdrop-source' }));
  filter.append(createSvg('feImage', {
    ...bounds, href: canvas.toDataURL(), preserveAspectRatio: 'none', result: 'normal-field'
  }));
  material.displacements = [];
  const addDisplacement = result => {
    const displacement = createSvg('feDisplacementMap', {
      in: 'backdrop-source', in2: 'normal-field', xChannelSelector: 'R', yChannelSelector: 'G', result
    });
    material.displacements.push(displacement);
    filter.append(displacement);
  };
  addDisplacement('refracted');
  material.blur = createSvg('feGaussianBlur', { in: 'refracted', stdDeviation: material.options.blur, result: 'scattered' });
  filter.append(material.blur);
  filter.append(createSvg('feColorMatrix', { in: 'scattered', type: 'saturate', values: '1' }));
  if (!material.filter) defs.append(filter);
  material.field = field;
  material.filter = filter;
  applyOpticalSettings(material);
  material.element.dataset.opticsReady = 'true';
}

function coloredLight(value) {
  let channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) return null;
  if (value.startsWith('color(srgb ')) channels = channels.map(channel => Math.round(channel * 255));
  // Neutral text and white controls do not emit a colored wash.
  if (Math.max(...channels) - Math.min(...channels) < 35) return null;
  return channels;
}

function collectContentLights() {
  const lights = [];
  for (const [selector, opacity, radius, background] of [
    ['.leg-icon', .24, 170, false],
    ['.strike-marker', .18, 135, true],
    ['.stat .positive, .stat .negative', .08, 120, false]
  ]) {
    for (const source of document.querySelectorAll(selector)) {
      if (!source.getClientRects().length) continue;
      const rect = source.getBoundingClientRect();
      const color = coloredLight(getComputedStyle(source)[background ? 'borderTopColor' : 'color']);
      if (!color || rect.width < 1 || rect.height < 1) continue;
      lights.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
        color, opacity: opacity * (source.closest('.excluded') ? .25 : 1), radius,
        owner: source.closest('.liquid-surface'), group: source });
    }
  }
  // Sample the currently rendered, clipped P/L curves. Reflections therefore
  // move with the chart animation and reflect its actual positive/negative parts.
  const svg = document.getElementById('payoff-chart');
  if (!svg) return lights;
  for (const clipId of ['profit-clip', 'loss-clip']) {
    const path = svg.querySelector(`path[clip-path="url(#${clipId})"][stroke]:not([stroke-dasharray])`);
    const clip = svg.querySelector(`#${clipId} rect`);
    if (!path || !clip) continue;
    const color = coloredLight(getComputedStyle(path).stroke);
    const matrix = path.getScreenCTM();
    if (!color || !matrix) continue;
    const length = path.getTotalLength();
    const top = Number(clip.getAttribute('y'));
    const bottom = top + Number(clip.getAttribute('height'));
    for (let i = 0; i < 12; i++) {
      const point = path.getPointAtLength(length * (i + .5) / 12);
      if (point.y < top || point.y > bottom) continue;
      const x = matrix.a * point.x + matrix.c * point.y + matrix.e;
      const y = matrix.b * point.x + matrix.d * point.y + matrix.f;
      lights.push({ x, y, color, opacity: .07, radius: 160, owner: null, group: path });
    }
  }
  return lights;
}

function renderContentLighting(time) {
  // The decorative bevels are expensive to repaint and are not needed while a
  // marker is moving. Their normal update resumes when dragging ends.
  if (document.querySelector('.strike-marker.dragging, .scenario-adjusting')) {
    lightFrame = 0;
    return;
  }
  if (time - lastLightTime < 32) {
    lightFrame = requestAnimationFrame(renderContentLighting);
    return;
  }
  lightFrame = 0;
  lastLightTime = time;
  if (document.hidden) return;
  const lights = collectContentLights();
  for (const material of materials) {
    const rect = material.element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    // The graph keeps its vector glow but has no visible rim canvas.
    if (material.element.id === 'graph-view') continue;
    const canvas = material.lightCanvas;
    const scale = Math.min(1.5, 720 / Math.max(rect.width, rect.height));
    const width = Math.ceil(rect.width * scale), height = Math.ceil(rect.height * scale);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) continue;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const nearby = lights.filter(light => {
      if (light.owner) return light.owner === material.element;
      // Exterior light only spills a short distance onto an adjacent surface.
      if (light.y < 0 || light.y > innerHeight) return false;
      const dx = Math.max(rect.left - light.x, 0, light.x - rect.right);
      const dy = Math.max(rect.top - light.y, 0, light.y - rect.bottom);
      return Math.hypot(dx, dy) < light.radius * .8;
    });
    const signature = JSON.stringify([width, height, nearby.map(light =>
      [Math.round((light.x - rect.left) * 2), Math.round((light.y - rect.top) * 2), light.color, light.opacity])]);
    if (material.lightSignature === signature) continue;
    material.lightSignature = signature;
    context.clearRect(0, 0, rect.width, rect.height);
    const counts = new Map();
    for (const light of nearby) counts.set(light.group, (counts.get(light.group) || 0) + 1);
    // A transmitted trace sits inside the glass, rather than behind its label.
    // Most of the colored energy is collected by the curved shoulder below.
    for (const light of nearby) {
      const x = light.x - rect.left, y = light.y - rect.top;
      const alpha = light.opacity * .09 / Math.max(1, Math.sqrt(counts.get(light.group)));
      const rgb = light.color.join(',');
      const gradient = context.createRadialGradient(x, y, 0, x, y, light.radius);
      gradient.addColorStop(0, `rgba(${rgb},${alpha})`);
      gradient.addColorStop(.35, `rgba(${rgb},${alpha * .5})`);
      gradient.addColorStop(1, `rgba(${rgb},0)`);
      context.fillStyle = gradient;
      context.fillRect(x - light.radius, y - light.radius, light.radius * 2, light.radius * 2);
    }
    paintBevel(material, context, rect, scale, nearby, counts);
    canvas.dataset.lightColors = [...new Set(nearby.map(light => light.color.join(',')))].join(';');
  }
  renderGraphGlow();
  renderTooltipScene();
}

function paintBevel(material, context, rect, scale, lights, counts) {
  // Same rounded geometry as the actual backdrop displacement: color is caught
  // in its shoulder, with a narrow bright rim and a softer inner reflection.
  const radius = parseFloat(getComputedStyle(material.element).borderTopLeftRadius) || 20;
  const neutral = getComputedStyle(material.element).getPropertyValue('--lg-reflection').match(/[\d.]+/g).map(Number);
  const w = material.lightCanvas.width, h = material.lightCanvas.height;
  const image = context.getImageData(0, 0, w, h);
  const pixels = image.data;
  const intensity = material.element.matches('.glass-interactive') ? .9 : .65;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const x = (px + .5) / scale, y = (py + .5) / scale;
    // The central pane does not need per-pixel optics work.
    if (x > 20 && x < rect.width - 20 && y > 20 && y < rect.height - 20) continue;
    const { distance, nx, ny } = roundedRectSample(x, y, rect.width, rect.height, radius);
    const depth = -distance;
    if (depth < 0 || depth > 19) continue;
    const rim = Math.exp(-Math.pow((depth - .8) / .65, 2)) * intensity;
    const shoulder = Math.exp(-Math.pow((depth - 3.8) / 2.2, 2)) * intensity;
    const face = Math.max(0, nx * -.5 + ny * -.86);
    const counter = Math.max(0, nx * .65 + ny * .76);
    let alpha = rim * (.025 + .19 * face + .055 * counter) + shoulder * (.004 + .012 * face);
    let red = neutral[0] * alpha, green = neutral[1] * alpha, blue = neutral[2] * alpha;
    for (const light of lights) {
      const dx = light.x - rect.left - x, dy = light.y - rect.top - y;
      const distanceToSource = Math.hypot(dx, dy);
      if (distanceToSource > light.radius) continue;
      const falloff = Math.pow(1 - distanceToSource / light.radius, 2);
      const facing = .3 + .7 * Math.abs((nx * dx + ny * dy) / Math.max(1, distanceToSource));
      const energy = light.opacity * falloff * facing / Math.sqrt(counts.get(light.group));
      const caustic = energy * (rim * 3.5 + shoulder * .4);
      alpha += caustic;
      red += light.color[0] * caustic;
      green += light.color[1] * caustic;
      blue += light.color[2] * caustic;
    }
    const i = (py * w + px) * 4, oldAlpha = pixels[i + 3] / 255;
    alpha = Math.min(.7, alpha);
    const combined = alpha + oldAlpha * (1 - alpha);
    if (!combined) continue;
    pixels[i] = (red + pixels[i] * oldAlpha * (1 - alpha)) / combined;
    pixels[i + 1] = (green + pixels[i + 1] * oldAlpha * (1 - alpha)) / combined;
    pixels[i + 2] = (blue + pixels[i + 2] * oldAlpha * (1 - alpha)) / combined;
    pixels[i + 3] = combined * 255;
  }
  context.putImageData(image, 0, 0);
}

function queueContentLighting() {
  if (!lightFrame && !document.hidden && !document.querySelector('.strike-marker.dragging, .scenario-adjusting')) lightFrame = requestAnimationFrame(renderContentLighting);
}

function attachGlass(element, options = {}) {
  // Keep the optical layer inside the material's stacking context and its
  // foreground labels above the sheen. No decoration filters the label text.
  for (const child of [...element.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
      const label = document.createElement('span');
      label.textContent = child.textContent;
      child.replaceWith(label);
    }
  }
  for (const child of element.children) {
    if (child.classList.contains('liquid-optics')) continue;
    child.classList.add('liquid-foreground');
    if (getComputedStyle(child).position === 'static') child.classList.add('liquid-static');
  }
  const existing = glassByElement.get(element);
  if (existing) {
    if (!existing.optics.isConnected || existing.optics.parentElement !== element) element.prepend(existing.optics);
    existing.resize();
    return existing;
  }
  const optics = document.createElement('span');
  optics.className = 'liquid-optics';
  optics.setAttribute('aria-hidden', 'true');
  for (const layer of ['frost', 'light', 'edge', 'pointer']) {
    const child = document.createElement('span');
    child.className = 'liquid-' + layer;
    optics.append(child);
  }
  const lightCanvas = document.createElement('canvas');
  optics.querySelector('.liquid-light').append(lightCanvas);
  element.classList.add('liquid-surface');
  element.prepend(optics);
  const material = {
    id: 'optical-glass-' + ++nextId, element, refractor: element, lightCanvas,
    options: { bevel: 16, thickness: 17, blur: .7, padding: 0, ...options },
    displacements: [], field: null, filter: null, blur: null, size: '', timer: 0
  };
  const resize = () => {
    clearTimeout(material.timer);
    material.timer = setTimeout(() => {
      const { width, height } = element.getBoundingClientRect();
      queueContentLighting();
      if (width < 2 || height < 2) return;
      const size = Math.round(width) + 'x' + Math.round(height);
      if (material.size === size) return;
      try {
        applyOpticalSettings(material);
        element.dataset.opticsReady = 'true';
        material.size = size;
      } catch (error) {
        element.dataset.glassFailed = 'true';
        console.warn('Glass surface uses the frosted fallback:', error.message);
      }
    }, 70);
  };
  material.resize = resize;
  material.optics = optics;
  glassByElement.set(element, material);
  new ResizeObserver(resize).observe(element);
  materials.push(material);
  if (element.matches('.toolbar-button, .output-tabs button')) {
    element.classList.add('glass-interactive');
    const pointer = optics.querySelector('.liquid-pointer');
    let frame = 0, targetX = 0, targetY = 0, x = 0, y = 0;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const animate = () => {
      const blend = reducedMotion.matches ? 1 : .25;
      x += (targetX - x) * blend;
      y += (targetY - y) * blend;
      pointer.style.setProperty('--pointer-x', x + 'px');
      pointer.style.setProperty('--pointer-y', y + 'px');
      frame = Math.abs(targetX - x) + Math.abs(targetY - y) > .15 ? requestAnimationFrame(animate) : 0;
    };
    element.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch' || element.matches(':disabled')) return;
      const rect = element.getBoundingClientRect();
      x = targetX = event.clientX - rect.left;
      y = targetY = event.clientY - rect.top;
      pointer.style.setProperty('--pointer-energy', '1');
      if (!frame) frame = requestAnimationFrame(animate);
    });
    element.addEventListener('pointermove', event => {
      if (event.pointerType === 'touch' || element.matches(':disabled')) return;
      const rect = element.getBoundingClientRect();
      targetX = event.clientX - rect.left;
      targetY = event.clientY - rect.top;
      if (!frame) frame = requestAnimationFrame(animate);
    });
    element.addEventListener('pointerleave', () => {
      pointer.style.setProperty('--pointer-energy', '0');
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    });
  }
  resize();
  return material;
}

const glassTargets = [
  ['.contract-controls', { bevel: 14, thickness: 16, blur: 1 }],
  ['.strategy-panel-card', { bevel: 19, thickness: 20, blur: 4 }],
  ['.analysis-card', { bevel: 16, thickness: 18, blur: 1.5 }],
  ['.output-tabs button', { bevel: 10, thickness: 14, blur: .6 }],
  ['#graph-view', { bevel: 13, thickness: 15, blur: 0 }],
  ['.toolbar-button', { bevel: 12, thickness: 15, blur: .5 }],
  ['.modal', { bevel: 18, thickness: 20, blur: 8 }]
];
if (!hierarchyDesign) glassTargets[2] = ['.analysis-card .controls', { bevel: 12, thickness: 13, blur: 1.1 }];
for (const [selector, options] of glassTargets) {
  for (const element of document.querySelectorAll(selector)) attachGlass(element, options);
}
if (!exactPreviousDesign) {
  const popupOptions = { bevel: 18, thickness: 21, blur: 4.8, padding: 0 };
  const popupGlass = new MutationObserver(records => {
    for (const record of records) {
      const popup = record.target.closest?.('.contract-menu, .contract-editor');
      if (popup) attachGlass(popup, popupOptions);
    }
  });
  for (const popup of document.querySelectorAll('.contract-menu, .contract-editor')) {
    attachGlass(popup, popupOptions);
    popupGlass.observe(popup, { childList: true });
  }
}

const graphView = document.getElementById('graph-view');
graphView.classList.add('graph-glass-active');
const graphGlowIntensity = .7;
const graphGlow = createSvg('svg', { class: 'graph-glow-layer', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
graphView.insertBefore(graphGlow, document.getElementById('payoff-chart'));
let graphGlowSignature = '';

function renderGraphGlow() {
  if (!graphView.classList.contains('graph-glass-active')) return;
  const source = document.getElementById('payoff-chart');
  const paths = [...source.querySelectorAll('path[clip-path][stroke]:not([stroke-dasharray])')];
  // Only the live P/L curves emit light. Axes, labels, expiry dashes, and hover
  // guides retain their exact geometry and contrast in the original SVG above.
  const signature = source.getAttribute('viewBox') + paths.map(path => path.outerHTML).join('') +
    (source.querySelector('defs')?.innerHTML || '');
  if (signature === graphGlowSignature) return;
  graphGlowSignature = signature;
  graphGlow.setAttribute('viewBox', source.getAttribute('viewBox'));
  const clonedDefs = source.querySelector('defs')?.cloneNode(true) || createSvg('defs');
  for (const [id, deviation] of [['graph-soft-bloom', 6], ['graph-tight-bloom', 1.4]]) {
    const filter = createSvg('filter', {id, x:'-20%', y:'-100%', width:'140%', height:'300%', 'color-interpolation-filters':'sRGB'});
    filter.append(createSvg('feGaussianBlur', {stdDeviation: deviation}));
    clonedDefs.append(filter);
  }
  const layers = [];
  for (const [filter, opacity, width] of [['graph-soft-bloom', .4, 9], ['graph-tight-bloom', .55, 3]]) {
    const group = createSvg('g', {filter:`url(#${filter})`, opacity: opacity * graphGlowIntensity});
    for (const path of paths) {
      const copy = path.cloneNode(true);
      copy.setAttribute('stroke-width', String(width));
      copy.setAttribute('fill', 'none');
      group.append(copy);
    }
    layers.push(group);
  }
  // Prefix references so the decorative SVG cannot capture the main chart's clips.
  const container = createSvg('g');
  container.append(clonedDefs, ...layers);
  container.innerHTML = container.innerHTML.replace(/id="([^"]+)"/g, 'id="glass-graph-$1"')
    .replace(/url\(#([^)]+)\)/g, 'url(#glass-graph-$1)');
  graphGlow.replaceChildren(container);
}

// A live chart tile gives the floating tooltip real detail to bend. It uses the
// original vector paths (not screenshots), aligned to their exact screen position.
const chartTooltip = document.getElementById('graph-tooltip');
const tooltipScene = document.createElement('span');
tooltipScene.className = 'liquid-tooltip-scene';
tooltipScene.setAttribute('aria-hidden', 'true');
chartTooltip.parentElement.append(tooltipScene);
const sceneSvg = createSvg('svg');
tooltipScene.append(sceneSvg);
const tooltipMaterial = {
  id: 'optical-tooltip', element: chartTooltip, refractor: chartTooltip,
  options: { bevel: 18, thickness: 21, blur: exactPreviousDesign ? .35 : 4.8, padding: 0 },
  displacements: [], field: null, filter: null, size: ''
};
function renderTooltipScene() {
  tooltipScene.hidden = !svgFilters || chartTooltip.hidden;
  if (tooltipScene.hidden) return;
  const { width, height } = chartTooltip.getBoundingClientRect();
  if (width < 2 || height < 2) return;
  const size = Math.round(width) + 'x' + Math.round(height);
  if (size !== tooltipMaterial.size) {
    try { buildFilter(tooltipMaterial, width, height); tooltipMaterial.size = size; }
    catch { tooltipScene.hidden = true; return; }
  }
  const source = document.getElementById('payoff-chart');
  const sourceRect = source.getBoundingClientRect(), tipRect = chartTooltip.getBoundingClientRect();
  const rootStyle = getComputedStyle(source);
  let markup = source.innerHTML.replace(/var\((--[^)]+)\)/g, (_, token) => rootStyle.getPropertyValue(token).trim());
  markup = markup.replace(/id="([^"]+)"/g, 'id="glass-tile-$1"').replace(/url\(#([^)]+)\)/g, 'url(#glass-tile-$1)');
  const tile = createSvg('svg', {x: sourceRect.left - tipRect.left, y: sourceRect.top - tipRect.top,
    width: sourceRect.width, height: sourceRect.height, viewBox: source.getAttribute('viewBox'),
    preserveAspectRatio: source.getAttribute('preserveAspectRatio') || 'xMidYMid meet'});
  tile.style.width = sourceRect.width + 'px';
  tile.style.height = sourceRect.height + 'px';
  tile.innerHTML = markup;
  sceneSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  sceneSvg.replaceChildren(tile);
  sceneSvg.style.filter = `url("#${tooltipMaterial.id}")`;
  tooltipScene.style.left = chartTooltip.style.left;
  tooltipScene.style.top = chartTooltip.style.top;
  tooltipScene.style.width = width + 'px';
  tooltipScene.style.height = height + 'px';
}
new ResizeObserver(queueContentLighting).observe(chartTooltip);

// The selected output moves as one continuous surface, without rebuilding the
// controls or changing their existing button handlers and ARIA state.
// Native SVG text can crowd at the smallest viewport widths. Preserve the
// whole-dollar ticks, but omit interior labels that physically overlap.
const payoffSvg = document.getElementById('payoff-chart');
// Keep the decorative curve in the same paint as the chart, independent of
// the slower ambient-light updates used by the surrounding glass surfaces.
new MutationObserver(renderGraphGlow).observe(payoffSvg, { childList: true, attributes: true, attributeFilter: ['viewBox'] });
let labelFrame = 0;
function spacePriceLabels() {
  labelFrame = 0;
  const height = payoffSvg.viewBox.baseVal.height;
  const labels = [...payoffSvg.querySelectorAll(':scope > text')].filter(text => Number(text.getAttribute('y')) > height - 12);
  if (labels.length < 3) return;
  for (const label of labels) label.style.visibility = '';
  const bounds = labels.map(label => label.getBoundingClientRect());
  let previousRight = bounds[0].right;
  const lastLeft = bounds.at(-1).left;
  for (let i = 1; i < labels.length - 1; i++) {
    const show = bounds[i].left >= previousRight + 8 && bounds[i].right <= lastLeft - 8;
    labels[i].style.visibility = show ? '' : 'hidden';
    if (show) previousRight = bounds[i].right;
  }
}
const queueLabels = () => { if (!labelFrame) labelFrame = requestAnimationFrame(spacePriceLabels); };
new MutationObserver(queueLabels).observe(payoffSvg, { childList: true });
new ResizeObserver(queueLabels).observe(payoffSvg);
queueLabels();

document.addEventListener('visibilitychange', () => {
  if (document.hidden && lightFrame) {
    cancelAnimationFrame(lightFrame);
    lightFrame = 0;
  } else if (!document.hidden) queueContentLighting();
});
// Ignore our own optical canvases and chart overlays. Real content changes and
// layout/scroll updates alone invalidate the reflected light field.
new MutationObserver(records => {
  if (records.some(record => {
    const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
    return target && !target.closest('.liquid-optics, .liquid-tooltip-scene, .graph-glow-layer');
  })) queueContentLighting();
}).observe(document.querySelector('.app-shell'), {
  subtree: true, childList: true, characterData: true,
  attributes: true, attributeFilter: ['class', 'style', 'hidden']
});
window.addEventListener('resize', queueContentLighting, { passive: true });
window.addEventListener('scroll', queueContentLighting, { passive: true });
for (const material of materials) applyOpticalSettings(material);
applyOpticalSettings(tooltipMaterial);
queueContentLighting();
