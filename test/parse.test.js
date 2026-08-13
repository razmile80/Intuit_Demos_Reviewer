import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFigmaUrl, parseFrameioUrl, parseDropboxUrl, isDropboxUrl } from '../src/parse.js';

test('dropbox share link converts to direct download', () => {
  const r = parseDropboxUrl('https://www.dropbox.com/scl/fi/abc123xyz/0584_17_GEO%20Search.mp4?rlkey=k9&dl=0');
  assert.ok(r.directUrl.includes('dl=1'));
  assert.equal(r.filename, '0584_17_GEO Search');
});
test('isDropboxUrl distinguishes sources', () => {
  assert.equal(isDropboxUrl('https://www.dropbox.com/s/ab12/demo.mp4?dl=0'), true);
  assert.equal(isDropboxUrl('https://next.frame.io/share/0b8a767b-1ae5-402f-b150-e51cd74cc788'), false);
});

test('parses figma design url with node-id', () => {
  const r = parseFigmaUrl('https://www.figma.com/design/PwDmcW6cyeOA8EvuarRC5Z/FY27-Investor-Day?node-id=2489-28000&t=x-1');
  assert.deepEqual(r, { fileKey: 'PwDmcW6cyeOA8EvuarRC5Z', nodeId: '2489:28000' });
});
test('figma url without node-id', () => {
  assert.equal(parseFigmaUrl('https://www.figma.com/design/abc123/Name').nodeId, null);
});
test('rejects non-figma', () => {
  assert.throws(() => parseFigmaUrl('https://example.com/x'), /Not a Figma/);
});
test('parses frameio share url', () => {
  const r = parseFrameioUrl('https://next.frame.io/share/0b8a767b-1ae5-402f-b150-e51cd74cc788/view/4f98f69c-4ac0-4d68-b7ef-8afcedee7a64');
  assert.deepEqual(r, { shareId: '0b8a767b-1ae5-402f-b150-e51cd74cc788', assetId: '4f98f69c-4ac0-4d68-b7ef-8afcedee7a64' });
});
test('accepts f.io short links', () => {
  const r = parseFrameioUrl('https://f.io/ScfJ5Nse');
  assert.equal(r.shareId, 'ScfJ5Nse');
  assert.equal(r.short, true);
});
test('accepts f.io short links with underscores and hyphens', () => {
  assert.equal(parseFrameioUrl('https://f.io/fHd_fH-s').shareId, 'fHd_fH-s');
});
test('rejects non-frameio', () => {
  assert.throws(() => parseFrameioUrl('https://vimeo.com/1'), /Not a Frame\.io/);
  assert.throws(() => parseFrameioUrl('https://f.io/'), /Not a Frame\.io/);
});
