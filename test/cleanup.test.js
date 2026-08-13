import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pruneOldRuns } from '../src/cleanup.js';

async function mkRun(id, name, date) {
  const dir = path.join('runs', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify({ runId: id, name, date }));
  await fs.writeFile(path.join(dir, 'demo.mp4'), 'x');
  return dir;
}

test('keeps newest 2 runs per demo, deletes older, leaves other demos alone', async t => {
  const ids = ['t-a1', 't-a2', 't-a3', 't-b1'];
  await mkRun('t-a1', 'CleanupDemoA', '2026-08-10T00:00:00Z');
  await mkRun('t-a2', 'CleanupDemoA', '2026-08-11T00:00:00Z');
  await mkRun('t-a3', 'CleanupDemoA', '2026-08-12T00:00:00Z');
  await mkRun('t-b1', 'CleanupDemoB', '2026-08-01T00:00:00Z');
  t.after(async () => { for (const id of ids) await fs.rm(path.join('runs', id), { recursive: true, force: true }); });

  const { deleted } = await pruneOldRuns({ keepPerDemo: 2 });
  assert.ok(deleted >= 1);
  await assert.rejects(fs.stat('runs/t-a1'));               // oldest A gone
  assert.ok(await fs.stat('runs/t-a2'));                    // newest two A kept
  assert.ok(await fs.stat('runs/t-a3'));
  assert.ok(await fs.stat('runs/t-b1'));                    // sole B run kept
});
