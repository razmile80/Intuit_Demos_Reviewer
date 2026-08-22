import test from 'node:test';
import assert from 'node:assert/strict';
import { recount } from '../src/server.js';

function baseReport(screens, extras = []) {
  return { screens, extras, summary: {} };
}

test('recount flags a real order violation and names the screen', () => {
  const report = baseReport([
    { name: 'A', verdict: 'match', dismissed: false, timestamp: 10 },
    { name: 'B', verdict: 'match', dismissed: false, timestamp: 20 },
    { name: 'C', verdict: 'match', dismissed: false, timestamp: 30 },
    // Figma says D comes last, but it plays before C in the video — a real
    // ~20s reversal, well past the 3s tolerance.
    { name: 'D', verdict: 'match', dismissed: false, timestamp: 12 },
  ]);
  recount(report);
  assert.equal(report.summary.orderOk, false);
  assert.equal(report.summary.match, 4);
  assert.deepEqual(report.sequence.violations.map(v => v.screenName), ['D']);
});

test('dismissing the violating screen clears both orderOk and sequence.violations', () => {
  // This is the exact scenario the user hit: all screens still "match", the
  // violation is entirely about one screen's position, and dismissing it —
  // a human override — must make the order status (and not just the count)
  // reflect that, not leave a stale violations list around.
  const report = baseReport([
    { name: 'A', verdict: 'match', dismissed: false, timestamp: 10 },
    { name: 'B', verdict: 'match', dismissed: false, timestamp: 20 },
    { name: 'C', verdict: 'match', dismissed: false, timestamp: 30 },
    { name: 'D', verdict: 'match', dismissed: false, timestamp: 12 },
  ]);
  recount(report);
  assert.equal(report.summary.orderOk, false);

  report.screens.find(s => s.name === 'D').dismissed = true;
  recount(report);
  assert.equal(report.summary.orderOk, true);
  assert.deepEqual(report.sequence.violations, []);
  assert.equal(report.summary.match, 3, 'the dismissed screen should drop out of the match count too');
});

test('recount finds every violation, not just the first', () => {
  const report = baseReport([
    { name: 'A', verdict: 'match', dismissed: false, timestamp: 10 },
    { name: 'B', verdict: 'match', dismissed: false, timestamp: 5 }, // violation #1
    { name: 'C', verdict: 'match', dismissed: false, timestamp: 30 },
    { name: 'D', verdict: 'match', dismissed: false, timestamp: 1 }, // violation #2
  ]);
  recount(report);
  assert.deepEqual(report.sequence.violations.map(v => v.screenName), ['B', 'D']);
});

test('ties and small forward gaps within tolerance are not violations', () => {
  const report = baseReport([
    { name: 'A', verdict: 'match', dismissed: false, timestamp: 10 },
    { name: 'B', verdict: 'match', dismissed: false, timestamp: 10 }, // same beat, fine
    { name: 'C', verdict: 'match', dismissed: false, timestamp: 8 }, // within 3s tolerance of 10
  ]);
  recount(report);
  assert.equal(report.summary.orderOk, true);
  assert.deepEqual(report.sequence.violations, []);
});
