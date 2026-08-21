import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from '../src/server.js';

test('health endpoint reports ok and key presence', async () => {
  const srv = app.listen(0);
  const port = srv.address().port;
  const res = await fetch(`http://localhost:${port}/api/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.hasKey, 'boolean');
  srv.close();
});

test('dismissing an extra recomputes the whole summary via recount(), not a bare field patch', async () => {
  // Regression test: /api/dismiss-extra used to only patch summary.extras
  // directly, so it could silently drift out of sync with the rest of the
  // summary (match/mismatch/missing/orderOk) whenever something else had left
  // them stale — unlike /api/dismiss and /api/note, which both call recount().
  // Seed summary.match with an obviously-wrong value; only a real recount()
  // call would correct it back to what report.screens actually says.
  const runId = `test-dismiss-extra-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const dir = path.join('runs', runId);
  await fs.mkdir(dir, { recursive: true });
  const report = {
    runId, name: 'Test Demo',
    screens: [{ name: 'A', verdict: 'match', dismissed: false, timestamp: 1 }],
    extras: [{ timestamp: 5, dismissed: false, videoPng: 'x.png' }],
    summary: { total: 1, match: 999, mismatch: 999, missing: 999, extras: 999, orderOk: false },
  };
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report));

  try {
    const srv = app.listen(0);
    const port = srv.address().port;
    const res = await fetch(`http://localhost:${port}/api/dismiss-extra`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, timestamp: 5 }),
    });
    const body = await res.json();
    srv.close();

    assert.equal(body.ok, true);
    assert.equal(body.summary.extras, 0, 'the dismissed extra should no longer count');
    assert.equal(body.summary.match, 1, 'recount() should have corrected the stale match count from report.screens');
    assert.equal(body.summary.mismatch, 0, 'recount() should have corrected the stale mismatch count');
    assert.equal(body.summary.orderOk, true, 'recount() should have recomputed order from the single non-dismissed screen');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
