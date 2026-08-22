import test from 'node:test';
import assert from 'node:assert/strict';
import { findOrderViolations } from '../src/compare/match.js';
import { recount } from '../src/server.js';

const items = pairs => pairs.map(([name, timestamp]) => ({ name, timestamp }));
const names = v => v.map(x => x.screenName);

test('one displaced screen is the only violation — its innocent neighbours are not flagged', () => {
  // The bug this replaces: a running-max scan sees D jump to 63.5 and then
  // flags E/F/G (which are perfectly in order) as "out of order", while D —
  // the actual outlier — passes clean.
  const v = findOrderViolations(items([
    ['A', 10], ['B', 20], ['C', 30],
    ['D', 63.5], // displaced: sits between 30 and 40 in the storyboard
    ['E', 40], ['F', 50], ['G', 60],
  ]));
  assert.deepEqual(names(v), ['D']);
});

test('replays the real 02_Business Intelligence scan: 1 violation, not 7', () => {
  // Verbatim timestamps from runs/2026-08-21-c00eaa (dismissed screens already
  // excluded). Frame 2147262478 @63.5s is the single displaced screen; the old
  // running-max scan blamed 7 screens, five of which were in perfect order.
  const v = findOrderViolations(items([
    ['Dashboard and Companion', 3.5], ['Immersive - FTU', 11], ['Frame 2147262472', 20],
    ['Frame 2147262474', 26.5], ['Frame 2147262475', 35.5], ['Frame 2147262476', 41.5],
    ['Frame 2147262479', 48], ['Frame 2147262477', 48],
    ['Frame 2147262478', 63.5], // <- the actual outlier
    ['screen', 56], ['screen (2)', 60], ['Workflow', 61.5], ['Workflow (2)', 63.5],
    ['Workflow (3)', 71], ['Workflow (4)', 78], ['Workflow (5)', 78], ['Workflow (6)', 83],
    ['1442', 86], ['Placeholder', 89], ['Placeholder (2)', 91.5],
    ['Onboarding Flow Screen 659', 91.5], ['Draw cash', 91.5],
  ]));
  assert.deepEqual(names(v), ['Frame 2147262478']);
});

test('a screen genuinely swapped with its neighbour is still caught', () => {
  // The user's stated rule: "if screen B is before screen A that represents a
  // broken order" — this must keep working, tolerance notwithstanding.
  const v = findOrderViolations(items([['A', 30], ['B', 10], ['C', 40], ['D', 50]]));
  assert.deepEqual(names(v), ['B']);
});

test('a screen landing between two others out of position is caught', () => {
  // "If screen D is between B and C, that's a broken order."
  const v = findOrderViolations(items([['A', 10], ['B', 20], ['D', 90], ['C', 30], ['E', 40]]));
  assert.deepEqual(names(v), ['D']);
});

test('ties, jitter within tolerance, and a single screen are all in order', () => {
  assert.deepEqual(findOrderViolations(items([['A', 10], ['B', 10], ['C', 8]])), []);
  assert.deepEqual(findOrderViolations(items([['A', 10]])), []);
  assert.deepEqual(findOrderViolations(items([])), []);
});

test('violation reports the in-order screen it should have followed', () => {
  const v = findOrderViolations(items([['A', 10], ['B', 20], ['C', 5]]));
  assert.equal(v.length, 1);
  assert.equal(v[0].screenName, 'C');
  assert.equal(v[0].timestamp, 5);
  assert.equal(v[0].prevTimestamp, 20, 'points at B, the last screen that read in order before it');
});

test('recount: dismissing the one displaced screen clears the order status entirely', () => {
  // End-to-end version of the user's workflow: the demo reads "order broken"
  // because of exactly one screen; dismissing that screen — a human override —
  // must leave the demo clean, with no leftover violations.
  const report = {
    screens: [
      { name: 'A', verdict: 'match', dismissed: false, timestamp: 10 },
      { name: 'B', verdict: 'match', dismissed: false, timestamp: 20 },
      { name: 'Bad', verdict: 'mismatch', dismissed: false, timestamp: 90 },
      { name: 'C', verdict: 'match', dismissed: false, timestamp: 30 },
      { name: 'D', verdict: 'match', dismissed: false, timestamp: 40 },
    ],
    extras: [], summary: {},
  };
  recount(report);
  assert.equal(report.summary.orderOk, false);
  assert.deepEqual(names(report.sequence.violations), ['Bad'], 'blames the displaced screen, not C and D');

  report.screens.find(s => s.name === 'Bad').dismissed = true;
  recount(report);
  assert.equal(report.summary.orderOk, true);
  assert.deepEqual(report.sequence.violations, []);
  assert.equal(report.summary.mismatch, 0, 'dismissed screen drops out of the mismatch count too');
});

test('recount ignores dismissed screens when deciding order, wherever they sit', () => {
  // A dismissed screen parked at a wild timestamp must not drag the check
  // around — this is what kept 02_Business Intelligence reading "broken".
  const report = {
    screens: [
      { name: 'A', verdict: 'match', dismissed: false, timestamp: 10 },
      { name: 'Dismissed', verdict: 'mismatch', dismissed: true, timestamp: 61.5 },
      { name: 'B', verdict: 'match', dismissed: false, timestamp: 20 },
      { name: 'C', verdict: 'match', dismissed: false, timestamp: 30 },
    ],
    extras: [], summary: {},
  };
  recount(report);
  assert.equal(report.summary.orderOk, true);
  assert.deepEqual(report.sequence.violations, []);
});

test('GET /api/report recomputes derived numbers so an order-logic fix reaches old reports without a rescan', async () => {
  // A report.json written by an earlier version of the order check: it claims
  // 2 violations (the running-max scan's answer) and blames the wrong screens.
  // Reading it back must yield the current algorithm's answer.
  const { app } = await import('../src/server.js');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const runId = `test-order-read-${process.pid}`;
  const dir = path.join('runs', runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify({
    runId,
    screens: [
      { name: 'A', verdict: 'match', dismissed: false, timestamp: 10 },
      { name: 'Displaced', verdict: 'match', dismissed: false, timestamp: 90 },
      { name: 'B', verdict: 'match', dismissed: false, timestamp: 20 },
      { name: 'C', verdict: 'match', dismissed: false, timestamp: 30 },
    ],
    extras: [],
    summary: { total: 4, match: 4, mismatch: 0, missing: 0, extras: 0, orderOk: false },
    sequence: { ok: false, violations: [{ screenName: 'B' }, { screenName: 'C' }] },
  }));

  const srv = app.listen(0);
  const body = await fetch(`http://localhost:${srv.address().port}/api/report/${runId}`).then(r => r.json());
  srv.close();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  assert.deepEqual(names(body.sequence.violations), ['Displaced'],
    'the stale on-disk violations (B, C) must be replaced by the real culprit');
  assert.equal(body.summary.orderOk, false);
});
