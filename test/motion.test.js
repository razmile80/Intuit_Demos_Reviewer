import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { grayPixels, luminanceProfile, bestProfileShift } from '../src/imghash.js';

// A page with horizontal stripes at a given vertical offset — scrolling moves the stripes up.
const rows = [0, 55, 90, 150, 210]; // irregular spacing — no periodic aliasing
const heights = [10, 24, 8, 30, 14];
const stripes = offset => sharp(Buffer.from(
  `<svg width="256" height="256"><rect width="256" height="256" fill="white"/>${
    rows.map((y, i) => `<rect x="20" y="${offset + y}" width="216" height="${heights[i]}" fill="#333"/>`).join('')
  }</svg>`
)).png().toBuffer();

test('scroll is detected as a clean vertical profile shift', async () => {
  const a = await grayPixels(await stripes(30));
  const b = await grayPixels(await stripes(10)); // scrolled up by 20px (=10 rows at 128)
  const v = bestProfileShift(luminanceProfile(a, 128, 'row'), luminanceProfile(b, 128, 'row'));
  assert.ok(Math.abs(v.shift) >= 6 && Math.abs(v.shift) <= 14, `shift was ${v.shift}`);
  assert.ok(v.residual < v.baseline * 0.5, `residual ${v.residual} vs baseline ${v.baseline}`);
});

test('content change is NOT explainable by a shift', async () => {
  const a = await grayPixels(await stripes(30));
  const changed = await grayPixels(await sharp(Buffer.from(
    '<svg width="256" height="256"><rect width="256" height="256" fill="white"/><circle cx="128" cy="128" r="80" fill="#333"/></svg>'
  )).png().toBuffer());
  const v = bestProfileShift(luminanceProfile(a, 128, 'row'), luminanceProfile(changed, 128, 'row'));
  assert.ok(v.residual > v.baseline * 0.5, `residual ${v.residual} should stay near baseline ${v.baseline}`);
});
