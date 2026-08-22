import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreScreenDismissals } from '../src/pipeline.js';

test('restores a dismissed screen regardless of its current verdict, including match', () => {
  // The bug: order violations only ever land on a 'match' screen, so a
  // dismissal meant to silence one has to survive a 'match' verdict on
  // rescan, or the order-broken status keeps coming back no matter how many
  // times it's dismissed.
  const judged = [
    { screen: { name: 'Placeholder' }, verdict: 'match', dismissed: false },
    { screen: { name: 'Other' }, verdict: 'mismatch', dismissed: false },
    { screen: { name: 'Untouched' }, verdict: 'match', dismissed: false },
  ];
  restoreScreenDismissals(judged, { Placeholder: [], Other: ['some accepted difference'] });
  assert.equal(judged[0].dismissed, true, 'a dismissed match-verdict screen must stay dismissed across rescans');
  assert.equal(judged[1].dismissed, true, 'a dismissed mismatch must still be restored (pre-existing behavior)');
  assert.equal(judged[2].dismissed, false, 'a screen never dismissed stays untouched');
});

test('a screen with no prior dismissal entry is left alone', () => {
  const judged = [{ screen: { name: 'Fresh' }, verdict: 'match', dismissed: false }];
  restoreScreenDismissals(judged, {});
  assert.equal(judged[0].dismissed, false);
});
