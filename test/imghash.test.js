import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { dhash, hamming, histogram, histSimilarity, similarity, blurScore } from '../src/imghash.js';

const solid = (r, g, b) => sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } }).png().toBuffer();
async function checker(cell = 8) {
  const svg = `<svg width="64" height="64"><rect width="64" height="64" fill="white"/>${Array.from({ length: 64 }, (_, i) => {
    const x = (i % 8) * cell, y = Math.floor(i / 8) * cell;
    return (i + Math.floor(i / 8)) % 2 ? `<rect x="${x}" y="${y}" width="${cell}" height="${cell}"/>` : '';
  }).join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

test('identical images: hamming 0, similarity ~1', async () => {
  const a = await checker();
  assert.equal(hamming(await dhash(a), await dhash(a)), 0);
  assert.ok(await similarity(a, a) > 0.95);
});
test('different images score lower than identical', async () => {
  const a = await checker(), b = await solid(255, 0, 0);
  assert.ok(await similarity(a, b) < await similarity(a, a));
});
test('histogram similarity: same color 1, opposite lower', async () => {
  const red = await histogram(await solid(255, 0, 0));
  const blue = await histogram(await solid(0, 0, 255));
  assert.ok(histSimilarity(red, red) > 0.99);
  assert.ok(histSimilarity(red, blue) < 0.5); // opposite colors still share zeroed channels
});
test('blur: checkerboard sharper than solid', async () => {
  assert.ok(await blurScore(await checker()) > await blurScore(await solid(128, 128, 128)));
});
