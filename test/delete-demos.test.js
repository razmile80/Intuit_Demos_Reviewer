import test from 'node:test';
import assert from 'node:assert/strict';
import { scanningDemoNames } from '../src/server.js';

const active = entries => new Map(entries.map(([runId, demoName]) => [runId, { demoName, startedAt: 0 }]));

test('only demos with an in-flight scan are off limits', () => {
  const batch = [
    { demoName: 'Running one', state: 'running' },
    { demoName: 'Queued one', state: 'queued' },
    { demoName: 'Finished one', state: 'done' },
    { demoName: 'Failed one', state: 'failed' },
  ];
  const s = scanningDemoNames(batch, active([]));
  assert.deepEqual([...s], ['Running one']);
  assert.equal(s.has('Queued one'), false, 'a queued scan has not started — deleting is safe and cancels it');
  assert.equal(s.has('Finished one'), false);
  assert.equal(s.has('Failed one'), false);
});

test('individual Rescan runs (activeRuns) also protect their demo', () => {
  const s = scanningDemoNames([], active([['2026-08-22-aaa', 'Solo rescan']]));
  assert.deepEqual([...s], ['Solo rescan']);
});

test('an ad-hoc compare with no demo name blocks nothing', () => {
  // /api/compare registers an activeRun with demoName null — it must not
  // become a blanket block on deleting unrelated demos.
  const s = scanningDemoNames([], active([['2026-08-22-bbb', null]]));
  assert.equal(s.size, 0);
});

test('batch and activeRuns are merged, without duplicates', () => {
  const s = scanningDemoNames(
    [{ demoName: 'Both', state: 'running' }, { demoName: 'BatchOnly', state: 'running' }],
    active([['r1', 'Both'], ['r2', 'ActiveOnly']]),
  );
  assert.deepEqual([...s].sort(), ['ActiveOnly', 'BatchOnly', 'Both']);
});

test('nothing running means nothing is off limits', () => {
  assert.equal(scanningDemoNames([], active([])).size, 0);
  assert.equal(scanningDemoNames([{ demoName: 'x', state: 'done' }], active([])).size, 0);
});

test('deleting while another demo scans: the idle demo goes, the scanning one stays', async (t) => {
  const { app } = await import('../src/server.js');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  // Some sandboxes mount the project read-only for deletes (the endpoint
  // swallows the EPERM as "unfinished run"). The classification is the new
  // logic and is always checked; the on-disk assertions only run where files
  // can actually be removed.
  let canDelete = true;
  try {
    const probe = path.join('runs', `.probe-${process.pid}`);
    await fs.mkdir(probe, { recursive: true });
    await fs.rm(probe, { recursive: true });
  } catch { canDelete = false; }

  const tag = `del-${process.pid}`;
  const idle = `Idle demo ${tag}`, busy = `Busy demo ${tag}`;
  const mk = async (runId, name) => {
    await fs.mkdir(path.join('runs', runId), { recursive: true });
    await fs.writeFile(path.join('runs', runId, 'report.json'),
      JSON.stringify({ runId, name, screens: [], extras: [], summary: { total: 0 } }));
  };
  await mk(`${tag}-idle`, idle);
  await mk(`${tag}-busy`, busy);

  // Register a live scan for the busy demo, exactly as /api/rescan does.
  const { activeRunsForTest } = await import('../src/server.js');
  activeRunsForTest.set(`${tag}-live`, { demoName: busy, startedAt: Date.now() });

  const srv = app.listen(0);
  const port = srv.address().port;
  try {
    const r = await fetch(`http://localhost:${port}/api/delete-demos`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names: [idle, busy] }),
    }).then(x => x.json());

    assert.equal(r.ok, true, 'the request must succeed, not 409 the whole batch');
    assert.deepEqual(r.deleted, [idle]);
    assert.deepEqual(r.skipped, [busy]);
    const left = await fs.readdir('runs');
    assert.equal(left.includes(`${tag}-busy`), true, 'scanning demo untouched');
    if (canDelete) {
      assert.equal(r.deletedRuns, 1);
      assert.equal(left.includes(`${tag}-idle`), false, 'idle demo run deleted');
    } else {
      t.diagnostic('filesystem deletes not permitted here — on-disk assertions skipped');
    }

    // Asking for ONLY the scanning demo still refuses, with a reason.
    const r2 = await fetch(`http://localhost:${port}/api/delete-demos`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names: [busy] }),
    }).then(x => x.json());
    assert.match(r2.error, /Still scanning/);
    assert.deepEqual(r2.skipped, [busy]);
  } finally {
    srv.close();
    activeRunsForTest.delete(`${tag}-live`);
    await fs.rm(path.join('runs', `${tag}-idle`), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join('runs', `${tag}-busy`), { recursive: true, force: true }).catch(() => {});
  }
});
