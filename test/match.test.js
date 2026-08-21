import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { matchScreens, sequenceCheck, findExtras } from '../src/compare/match.js';

const img = (r, g, b, txt) => sharp(Buffer.from(
  `<svg width="200" height="400"><rect width="200" height="400" fill="rgb(${r},${g},${b})"/><text x="20" y="200" font-size="30">${txt}</text></svg>`
)).png().toBuffer();

test('matchScreens pairs each screen with its lookalike frame', async () => {
  const a = await img(255, 255, 255, 'Hello'), b = await img(20, 40, 200, 'Refund');
  const figma = [{ index: 0, name: 'A', pngPath: a }, { index: 1, name: 'B', pngPath: b }];
  const video = [{ timestamp: 1, pngPath: b }, { timestamp: 5, pngPath: a }];
  const m = await matchScreens(figma, video);
  assert.equal(m[0].candidates[0].frame.timestamp, 5);
  assert.equal(m[1].candidates[0].frame.timestamp, 1);
});

test('sequenceCheck tolerates small backward jitter', () => {
  const judged = [
    { screen: { name: 'S1' }, matchedFrame: { timestamp: 10 } },
    { screen: { name: 'S2' }, matchedFrame: { timestamp: 8.5 } }, // within tolerance
  ];
  assert.equal(sequenceCheck(judged).ok, true);
});

test('sequenceCheck flags a real jump backwards', () => {
  const judged = [
    { screen: { name: 'S1' }, matchedFrame: { timestamp: 10 } },
    { screen: { name: 'S2' }, matchedFrame: { timestamp: 4 } },
  ];
  const r = sequenceCheck(judged);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].screenName, 'S2');
});

test('findExtras returns frames far from any matched moment', async () => {
  const a = await img(255, 255, 255, 'X');
  const orphan = { timestamp: 9, pngPath: await img(0, 255, 0, 'ORPHAN') };
  const judged = [{ screen: {}, matchedFrame: { timestamp: 1 }, verdict: 'match', differences: [] }];
  const extras = findExtras([{ timestamp: 1, pngPath: a }, { timestamp: 3, pngPath: a }, orphan], judged, { slack: 5 });
  assert.deepEqual(extras.map(f => f.timestamp), [9]);
});
