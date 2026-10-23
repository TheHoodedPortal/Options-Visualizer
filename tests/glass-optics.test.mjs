import test from 'node:test';
import assert from 'node:assert/strict';
import { roundedRectSample, refractedOffset, buildRefractionMap } from '../src/glass-optics.js';

test('rounded rectangle distance and normals distinguish faces and curved corners', () => {
  assert.equal(roundedRectSample(100, 50, 200, 100, 20).distance, -50);
  assert.equal(roundedRectSample(0, 50, 200, 100, 20).distance, 0);
  assert.deepEqual(roundedRectSample(3, 50, 200, 100, 20), { distance: -3, nx: -1, ny: 0 });
  const corner = roundedRectSample(8, 8, 200, 100, 20);
  assert.ok(corner.distance < 0);
  assert.ok(Math.abs(Math.hypot(corner.nx, corner.ny) - 1) < 1e-12);
  assert.ok(Math.abs(corner.nx - corner.ny) < 1e-12);
});

test('convex glass bends edges toward the center with mirrored displacement', () => {
  const options = { radius: 24, bevel: 16, thickness: 20 };
  const left = refractedOffset(4, 60, 240, 120, options);
  const right = refractedOffset(236, 60, 240, 120, options);
  assert.ok(left.x > 0 && right.x < 0);
  assert.ok(Math.abs(left.x + right.x) < 1e-10);
  assert.equal(left.y, 0);
  assert.deepEqual(refractedOffset(120, 60, 240, 120, options), { x: 0, y: 0 });
  assert.deepEqual(refractedOffset(-3, 60, 240, 120, options), { x: 0, y: 0 });
});

test('lens magnification affects the interior without moving the optical center', () => {
  const offset = refractedOffset(70, 50, 200, 100, { magnification: .12 });
  assert.ok(Math.abs(offset.x - 3.6) < 1e-10);
  assert.equal(offset.y, 0);
  assert.deepEqual(refractedOffset(100, 50, 200, 100, { magnification: .12 }), { x: 0, y: 0 });
});

test('displacement texture bounds memory and encodes physical offsets accurately', () => {
  const width = 900, height = 400;
  const options = { maxSize: 320, padding: 32, radius: 22, thickness: 20, bevel: 15 };
  const map = buildRefractionMap(width, height, options);
  assert.equal(map.pixelWidth, 320);
  assert.ok(map.pixelHeight <= 320);
  assert.equal(map.pixels.length, map.pixelWidth * map.pixelHeight * 4);
  assert.ok(Number.isFinite(map.scale) && map.scale > 0 && map.maximum < 100);
  for (let y = 0; y < map.pixelHeight; y += 7) {
    for (let x = 0; x < map.pixelWidth; x += 7) {
      const actual = refractedOffset((x + .5) / map.pixelWidth * (width + 64) - 32, (y + .5) / map.pixelHeight * (height + 64) - 32, width, height, options);
      const i = (y * map.pixelWidth + x) * 4;
      const quantization = map.scale / 255 / 2 + .00001;
      assert.ok(Math.abs(map.scale * (map.pixels[i] / 255 - .5) - actual.x) <= quantization);
      assert.ok(Math.abs(map.scale * (map.pixels[i + 1] / 255 - .5) - actual.y) <= quantization);
      assert.equal(map.pixels[i + 3], 255);
    }
  }
});

test('very small surfaces remain finite and generate valid textures', () => {
  const map = buildRefractionMap(12, 8, { radius: 40, bevel: 40, thickness: 25 });
  assert.ok(Number.isFinite(map.scale));
  assert.ok(map.maximum < 100);
  assert.equal(map.pixels.length, map.pixelWidth * map.pixelHeight * 4);
});
