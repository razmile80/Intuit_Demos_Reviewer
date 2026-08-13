import fs from 'node:fs/promises';
import path from 'node:path';

// Retention: keep the newest N complete runs per demo, delete older ones
// (videos + frames are regenerable via Rescan; the latest reports are what
// the team shares). Also removes crashed runs (no report.json) older than a
// day and stale manual uploads.
export async function pruneOldRuns({ keepPerDemo = 2, onProgress = () => {} } = {}) {
  let dirs = [];
  try { dirs = await fs.readdir('runs'); } catch { return { deleted: 0 }; }

  const byDemo = new Map();
  const crashed = [];
  for (const id of dirs) {
    if (id === 'uploads') continue;
    const dir = path.join('runs', id);
    try {
      const r = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
      const key = r.name ?? id;
      byDemo.set(key, [...(byDemo.get(key) ?? []), { dir, date: r.date ?? '' }]);
    } catch {
      try {
        const age = Date.now() - (await fs.stat(dir)).mtimeMs;
        if (age > 24 * 3600 * 1000) crashed.push(dir);
      } catch { /* vanished */ }
    }
  }

  let deleted = 0;
  for (const runs of byDemo.values()) {
    runs.sort((a, b) => b.date.localeCompare(a.date));
    for (const old of runs.slice(keepPerDemo)) {
      await fs.rm(old.dir, { recursive: true, force: true });
      deleted++;
    }
  }
  for (const dir of crashed) {
    await fs.rm(dir, { recursive: true, force: true });
    deleted++;
  }
  // Manual mp4 uploads older than a day
  try {
    for (const f of await fs.readdir(path.join('runs', 'uploads'))) {
      const p = path.join('runs', 'uploads', f);
      if (Date.now() - (await fs.stat(p)).mtimeMs > 24 * 3600 * 1000) {
        await fs.rm(p, { force: true });
      }
    }
  } catch { /* no uploads dir */ }

  if (deleted) onProgress(`Cleanup: removed ${deleted} old run${deleted > 1 ? 's' : ''} (keeping latest ${keepPerDemo} per demo)`);
  return { deleted };
}
