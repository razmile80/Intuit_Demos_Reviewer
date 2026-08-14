import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { judgeAll } from '../src/compare/judge.js';

const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
const mockClient = replies => {
  let i = 0;
  return { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(replies[Math.min(i++, replies.length - 1)]) }] }) } };
};

test('match verdict passes through with differences', async () => {
  const matches = [{ screen: { name: 'S1', pngPath: await png() }, candidates: [{ frame: { timestamp: 2, pngPath: await png(), croppedPath: await png() }, score: 0.9 }] }];
  const out = await judgeAll(matches, { client: mockClient([{ verdict: 'mismatch', differences: ['price differs'] }]) });
  assert.equal(out[0].verdict, 'mismatch');
  assert.deepEqual(out[0].differences, [{ text: 'price differs' }]); // strings normalize to objects
  assert.equal(out[0].matchedFrame.timestamp, 2);
});

test('partial_screen advances to next candidate', async () => {
  const matches = [{ screen: { name: 'S1', pngPath: await png() }, candidates: [
    { frame: { timestamp: 1, pngPath: await png(), croppedPath: await png() }, score: 0.9 },
    { frame: { timestamp: 7, pngPath: await png(), croppedPath: await png() }, score: 0.8 },
  ] }];
  const out = await judgeAll(matches, { client: mockClient([{ verdict: 'partial_screen', differences: [] }, { verdict: 'match', differences: [] }]) });
  assert.equal(out[0].verdict, 'match');
  assert.equal(out[0].matchedFrame.timestamp, 7);
});

test('no candidates → not_found', async () => {
  const out = await judgeAll([{ screen: { name: 'S1', pngPath: await png() }, candidates: [] }], { client: mockClient([]) });
  assert.equal(out[0].verdict, 'not_found');
});
