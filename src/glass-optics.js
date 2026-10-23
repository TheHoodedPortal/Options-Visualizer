// Original rounded-lens model. Geometry is expressed in CSS pixels, independent
// of the lower-resolution texture used to encode the displacement field.
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function roundedRectSample(x, y, width, height, radius) {
  const r = clamp(radius, 0, Math.min(width, height) / 2);
  const cx = x - width / 2, cy = y - height / 2;
  const qx = Math.abs(cx) - (width / 2 - r);
  const qy = Math.abs(cy) - (height / 2 - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  const length = Math.hypot(ox, oy);
  const distance = length + Math.min(Math.max(qx, qy), 0) - r;
  let nx = 0, ny = 0;
  if (length > 0) {
    nx = Math.sign(cx) * ox / length;
    ny = Math.sign(cy) * oy / length;
  } else if (qx > qy) nx = Math.sign(cx);
  else ny = Math.sign(cy);
  return { distance, nx, ny };
}

export function refractedOffset(x, y, width, height, {
  radius = 20, bevel = 16, thickness = 18, index = 1.46, magnification = 0
} = {}) {
  const { distance, nx, ny } = roundedRectSample(x, y, width, height, radius);
  if (distance >= 0) return { x: 0, y: 0 };
  const depth = -distance;
  const t = clamp(depth / Math.max(1, bevel), .004, 1);
  // A circular shoulder joins a flat center. Its derivative gives the normal
  // of the glass surface; Snell's law bends a perpendicular viewing ray.
  const profile = Math.sqrt(t * (2 - t));
  const slope = thickness * (1 - t) / (Math.max(1, bevel) * profile);
  const normalZ = 1 / Math.hypot(slope, 1);
  const normalXY = slope * normalZ;
  const eta = 1 / Math.max(1.001, index);
  const transmitted = Math.sqrt(1 - eta * eta * (1 - normalZ * normalZ));
  const bend = eta * normalZ - transmitted;
  const rayZ = -eta + bend * normalZ;
  const travel = (thickness * (.55 + profile) + 3) / Math.max(.08, -rayZ);
  const shift = bend * normalXY * travel;
  const centerWeight = Math.min(1, depth / 3);
  return {
    x: nx * shift + (width / 2 - x) * magnification * centerWeight,
    y: ny * shift + (height / 2 - y) * magnification * centerWeight
  };
}

export function buildRefractionMap(width, height, options = {}) {
  const padding = options.padding ?? 32;
  const maxSize = options.maxSize ?? 640;
  const fullWidth = width + padding * 2, fullHeight = height + padding * 2;
  const ratio = Math.min(options.resolution ?? 1, maxSize / Math.max(fullWidth, fullHeight));
  const pixelWidth = Math.max(2, Math.ceil(fullWidth * ratio));
  const pixelHeight = Math.max(2, Math.ceil(fullHeight * ratio));
  const vectors = new Float32Array(pixelWidth * pixelHeight * 2);
  let maximum = 1;
  for (let y = 0; y < pixelHeight; y++) {
    for (let x = 0; x < pixelWidth; x++) {
      const position = (y * pixelWidth + x) * 2;
      const offset = refractedOffset(
        (x + .5) / pixelWidth * fullWidth - padding,
        (y + .5) / pixelHeight * fullHeight - padding,
        width, height, options
      );
      vectors[position] = offset.x;
      vectors[position + 1] = offset.y;
      maximum = Math.max(maximum, Math.abs(offset.x), Math.abs(offset.y));
    }
  }
  // feDisplacementMap: sample + scale * (channel / 255 - .5).
  // Doubling the maximum keeps all signed offsets inside the encoded range.
  const scale = maximum * 2;
  const pixels = new Uint8ClampedArray(pixelWidth * pixelHeight * 4);
  for (let i = 0; i < vectors.length / 2; i++) {
    pixels[i * 4] = 255 * (.5 + vectors[i * 2] / scale);
    pixels[i * 4 + 1] = 255 * (.5 + vectors[i * 2 + 1] / scale);
    pixels[i * 4 + 2] = 128;
    pixels[i * 4 + 3] = 255;
  }
  return { pixels, pixelWidth, pixelHeight, padding, scale, maximum };
}
