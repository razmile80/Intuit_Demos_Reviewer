import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.use(express.json());

// ---- Team password gate (active only when APP_PASSWORD is set) ----
const PASSWORD = process.env.APP_PASSWORD;
if (PASSWORD) {
  const token = crypto.createHash('sha256').update(PASSWORD + '::qa-tool').digest('hex');
  app.use((req, res, next) => {
    if ((req.headers.cookie ?? '').includes(`qa_auth=${token}`)) return next();
    if (req.method === 'POST' && req.path === '/login') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const pw = decodeURIComponent((body.match(/password=([^&]*)/) ?? [])[1] ?? '').replace(/\+/g, ' ');
        if (pw === PASSWORD) {
          res.setHeader('Set-Cookie', `qa_auth=${token}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`);
          return res.redirect('/');
        }
        res.redirect('/login?bad=1');
      });
      return;
    }
    if (req.path === '/login') {
      return res.send(`<!doctype html><meta charset="utf-8"><title>Figma ↔ Video QA</title>
<body style="background:#141414;color:#eee;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<form method="POST" action="/login" style="text-align:center">
  <h1 style="font-weight:600">Figma ↔ Video QA</h1>
  ${req.query.bad ? '<div style="color:#f87171;margin-bottom:12px">Wrong password</div>' : ''}
  <input type="password" name="password" placeholder="Team password" autofocus
    style="padding:10px 14px;border-radius:8px;border:1px solid #333;background:#1e1e1e;color:#eee;width:240px">
  <button style="padding:10px 20px;border-radius:8px;border:0;background:#236CFF;color:#fff;font-weight:600;cursor:pointer;margin-left:8px">Enter</button>
</form></body>`);
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    res.redirect('/login');
  });
}
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/runs', express.static(path.join(__dirname, '..', 'runs')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.ANTHROPIC_API_KEY) });
});

app.get('/api/report/:runId', async (req, res) => {
  try {
    const safe = req.params.runId.replace(/[^a-z0-9-]/gi, '');
    res.json(JSON.parse(await fs.readFile(path.join('runs', safe, 'report.json'), 'utf8')));
  } catch {
    res.status(404).json({ error: 'Report not found' });
  }
});

app.get('/api/runs', async (req, res) => {
  const out = [];
  try {
    for (const id of await fs.readdir('runs')) {
      try {
        const r = JSON.parse(await fs.readFile(path.join('runs', id, 'report.json'), 'utf8'));
        out.push({ runId: r.runId, name: r.name ?? r.runId, date: r.date ?? null, figmaUrl: r.figmaUrl ?? null, frameioUrl: r.frameioUrl ?? null, summary: r.summary });
      } catch { /* not a finished run */ }
    }
  } catch { /* no runs yet */ }
  out.sort((a, b) => (b.date ?? b.runId).localeCompare(a.date ?? a.runId));
  res.json(out.slice(0, 100));
});

app.patch('/api/report/:runId', async (req, res) => {
  try {
    const safe = req.params.runId.replace(/[^a-z0-9-]/gi, '');
    const file = path.join('runs', safe, 'report.json');
    const r = JSON.parse(await fs.readFile(file, 'utf8'));
    if (typeof req.body.name === 'string' && req.body.name.trim()) r.name = req.body.name.trim();
    for (const key of ['figmaUrl', 'frameioUrl']) {
      if (typeof req.body[key] === 'string' && /^https?:\/\//.test(req.body[key].trim())) r[key] = req.body[key].trim();
    }
    await fs.writeFile(file, JSON.stringify(r, null, 2));
    res.json({ ok: true, name: r.name, figmaUrl: r.figmaUrl ?? null, frameioUrl: r.frameioUrl ?? null });
  } catch {
    res.status(404).json({ error: 'Report not found' });
  }
});

// ---- VO / script versions (stored per demo name, independent of runs) ----
import { loadScripts, addScriptVersion } from './scripts.js';

app.get('/api/scripts-status', async (req, res) => {
  const all = await loadScripts();
  const out = {};
  for (const [name, versions] of Object.entries(all)) {
    if (versions.length) out[name] = { versions: versions.length, date: versions.at(-1).date };
  }
  res.json(out);
});

app.get('/api/script', async (req, res) => {
  const all = await loadScripts();
  const versions = all[req.query.name] ?? [];
  res.json({ versions: versions.map((v, i) => ({ version: i + 1, date: v.date, chars: v.text.length })), latest: versions.at(-1) ?? null });
});

app.post('/api/script', async (req, res) => {
  const { name, text } = req.body;
  if (!name || !text?.trim()) return res.status(400).json({ error: 'name and text required' });
  res.json({ ok: true, ...(await addScriptVersion(name, text.trim(), 'manual')) });
});

// ---- Batch rescan: queue every demo, run a few at a time ----
const CONCURRENCY = 2;
const batch = []; // { demoName, figmaUrl, frameioUrl, state: queued|running|done|failed, runId, error }

async function latestRunsPerDemo() {
  const out = new Map();
  try {
    for (const id of await fs.readdir('runs')) {
      try {
        const r = JSON.parse(await fs.readFile(path.join('runs', id, 'report.json'), 'utf8'));
        const key = r.name ?? r.runId;
        if (!out.has(key) || (r.date ?? '') > (out.get(key).date ?? '')) out.set(key, r);
      } catch { /* unfinished run */ }
    }
  } catch { /* no runs */ }
  return [...out.values()];
}

function pumpBatch() {
  const running = batch.filter(b => b.state === 'running').length;
  for (const item of batch.filter(b => b.state === 'queued').slice(0, Math.max(0, CONCURRENCY - running))) {
    item.state = 'running';
    item.runId = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(3).toString('hex');
    runPipeline({
      figmaUrl: item.figmaUrl, frameioUrl: item.frameioUrl, demoName: item.demoName,
      runId: item.runId, onProgress: () => {},
    }).then(report => { item.state = 'done'; item.demoName ??= report.name; })
      .catch(e => { item.state = 'failed'; item.error = friendly(e.message); })
      .finally(pumpBatch);
  }
}

app.post('/api/rescan-all', async (req, res) => {
  if (batch.some(b => b.state === 'queued' || b.state === 'running')) {
    return res.status(409).json({ error: 'A batch is already running' });
  }
  batch.length = 0;
  const demos = await latestRunsPerDemo();
  const skipped = [];
  for (const r of demos) {
    if (r.figmaUrl && r.frameioUrl) batch.push({ demoName: r.name, label: r.name, figmaUrl: r.figmaUrl, frameioUrl: r.frameioUrl, state: 'queued' });
    else skipped.push(r.name);
  }
  pumpBatch();
  res.json({ queued: batch.length, skipped });
});

// Batch import: queue fresh (figmaUrl, videoUrl) pairs — new demos welcome.
app.post('/api/import-batch', (req, res) => {
  if (batch.some(b => b.state === 'queued' || b.state === 'running')) {
    return res.status(409).json({ error: 'A batch is already running — wait for it to finish' });
  }
  const items = (req.body.items ?? []).filter(i => i.figmaUrl && i.frameioUrl);
  if (!items.length) return res.status(400).json({ error: 'No valid pairs' });
  batch.length = 0;
  for (const i of items) {
    const nodeId = i.figmaUrl.match(/node-id=([\d-]+)/)?.[1];
    const label = i.frameioUrl.replace(/^https?:\/\//, '').slice(0, 44) + (nodeId ? ` · figma node ${nodeId}` : '');
    batch.push({ figmaUrl: i.figmaUrl, frameioUrl: i.frameioUrl, label, state: 'queued' });
  }
  pumpBatch();
  res.json({ queued: batch.length });
});

app.get('/api/batch', (req, res) => {
  res.json(batch.map(({ demoName, label, state, runId, error }) => ({ demoName: demoName ?? null, label: label ?? demoName, state, runId, error })));
});

// Dismiss a mismatch (or undo): marks it reviewed-and-accepted, and remembers
// the accepted differences per demo so future rescans stop reporting them.
app.post('/api/dismiss', async (req, res) => {
  try {
    const { runId, screenName, undo } = req.body;
    const safe = runId.replace(/[^a-z0-9-]/gi, '');
    const file = path.join('runs', safe, 'report.json');
    const report = JSON.parse(await fs.readFile(file, 'utf8'));
    const entry = report.screens.find(s => s.name === screenName);
    if (!entry) return res.status(404).json({ error: 'Screen not found' });
    entry.dismissed = !undo;
    report.summary.mismatch = report.screens.filter(s => s.verdict === 'mismatch' && !s.dismissed).length;
    report.summary.missing = report.screens.filter(s => s.verdict === 'not_found' && !s.dismissed).length;
    await fs.writeFile(file, JSON.stringify(report, null, 2));

    let dismissals = {};
    try { dismissals = JSON.parse(await fs.readFile(path.join('data', 'dismissals.json'), 'utf8')); } catch { /* none */ }
    const demo = dismissals[report.name] ?? {};
    if (undo) delete demo[screenName];
    else demo[screenName] = entry.differences;
    dismissals[report.name] = demo;
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile(path.join('data', 'dismissals.json'), JSON.stringify(dismissals, null, 2));

    res.json({ ok: true, screen: entry, summary: report.summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reviewer timeline: pin a Figma screen to a video timestamp and re-judge it.
app.post('/api/rejudge', async (req, res) => {
  try {
    const { runId, screenName, timestamp } = req.body;
    const safe = runId.replace(/[^a-z0-9-]/gi, '');
    const runDir = path.join('runs', safe);
    const file = path.join(runDir, 'report.json');
    const report = JSON.parse(await fs.readFile(file, 'utf8'));
    const entry = report.screens.find(s => s.name === screenName);
    if (!entry) return res.status(404).json({ error: 'Screen not found in report' });
    const ts = Math.max(0, Number(timestamp));

    // Extract the exact frame at that timestamp and judge against it.
    const { ffmpegPath } = await import('./capture/video.js');
    const { cropContentRegion } = await import('./imghash.js');
    const { judgeAll } = await import('./compare/judge.js');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const framePath = path.join(runDir, 'video', `anchor-${String(ts).replace('.', '_')}.png`);
    const videoFsPath = report.video.slice(1); // strip leading /
    await promisify(execFile)(ffmpegPath, ['-y', '-ss', String(ts), '-i', videoFsPath, '-frames:v', '1', framePath], { maxBuffer: 1024 * 1024 * 16 });
    const cropped = await cropContentRegion(framePath, framePath.replace(/\.png$/, '.crop.png'));

    const figmaFsPath = entry.figmaPng.slice(1);
    const judged = await judgeAll(
      [{ screen: { name: screenName, pngPath: figmaFsPath }, candidates: [{ frame: { timestamp: ts, pngPath: framePath, croppedPath: cropped }, score: 1 }] }],
      { onProgress: () => {} },
    );
    const j = judged[0];
    Object.assign(entry, {
      verdict: j.verdict === 'not_found' ? 'mismatch' : j.verdict,
      differences: j.differences,
      timestamp: ts,
      videoPng: '/' + cropped.split(path.sep).join('/'),
      anchored: true,
    });
    report.summary.match = report.screens.filter(s => s.verdict === 'match').length;
    report.summary.mismatch = report.screens.filter(s => s.verdict === 'mismatch').length;
    report.summary.missing = report.screens.filter(s => s.verdict === 'not_found').length;
    await fs.writeFile(file, JSON.stringify(report, null, 2));

    // Persist the anchor per demo so future rescans start from it.
    let anchors = {};
    try { anchors = JSON.parse(await fs.readFile(path.join('data', 'anchors.json'), 'utf8')); } catch { /* none */ }
    anchors[report.name] = { ...(anchors[report.name] ?? {}), [screenName]: ts };
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile(path.join('data', 'anchors.json'), JSON.stringify(anchors, null, 2));

    res.json({ ok: true, screen: entry, summary: report.summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/report/:runId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'report.html'));
});

// Stable per-demo permalink: /demo/<slug> always redirects to the demo's
// LATEST report, so shared links never go stale across rescans.
export const slugify = s => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
app.get('/demo/:slug', async (req, res) => {
  const demos = await latestRunsPerDemo();
  const hit = demos.find(d => slugify(d.name) === req.params.slug);
  if (!hit) return res.status(404).send('No report for this demo (it may have been renamed).');
  res.redirect('/report/' + hit.runId);
});

app.get('/project', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'project.html'));
});

const upload = multer({ dest: 'runs/uploads/' });
const channels = new Map(); // runId -> Set<res>
const activeRuns = new Map(); // runId -> { demoName, startedAt } — survives page reloads

function emit(runId, event, data) {
  for (const res of channels.get(runId) ?? []) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

app.get('/api/progress/:runId', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const set = channels.get(req.params.runId) ?? new Set();
  set.add(res);
  channels.set(req.params.runId, set);
  req.on('close', () => set.delete(res));
});

app.post('/api/upload', upload.single('video'), (req, res) => {
  res.json({ videoPath: req.file.path, name: (req.file.originalname ?? '').replace(/\.(mp4|mov)$/i, '') || null });
});

app.post('/api/compare', (req, res) => {
  const { figmaUrl, frameioUrl, videoPath, demoName, script } = req.body;
  if (!figmaUrl || (!frameioUrl && !videoPath)) {
    return res.status(400).json({ error: 'figmaUrl and frameioUrl (or an uploaded video) are required' });
  }
  const runId = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(3).toString('hex');
  res.json({ runId });
  activeRuns.set(runId, { demoName: demoName ?? null, startedAt: Date.now() });
  setTimeout(async () => {
    try {
      const report = await runPipeline({ figmaUrl, frameioUrl, videoPath, demoName, script, runId, onProgress: m => emit(runId, 'progress', m), onScreen: s => emit(runId, 'screen', s) });
      emit(runId, 'done', report);
    } catch (e) {
      emit(runId, 'fail', { code: e.message, message: friendly(e.message) });
    } finally {
      activeRuns.delete(runId);
    }
  }, 300);
});

app.get('/api/active', (req, res) => {
  res.json([...activeRuns.entries()].map(([runId, a]) => ({ runId, ...a })));
});

function friendly(code) {
  if (code.startsWith('FIGMA_AMBIGUOUS')) {
    return `That link contains several storyboards (${code.split(': ')[1]}). In Figma, click the one storyboard you want, right-click → Copy link to selection, and paste that instead.`;
  }
  return {
    FIGMA_PRIVATE: 'This Figma file is not publicly viewable. Add a FIGMA_TOKEN to .env (recommended) or enable public link sharing.',
    FIGMA_NO_FRAMES: 'Could not find any frames in the Figma file. Paste a link that points at the storyboard page or section. Check runs/<id>/figma-debug.png for what the browser saw.',
    FIGMA_TOKEN_INVALID: 'The FIGMA_TOKEN in .env was rejected by Figma. Generate a new personal access token (figma.com → Settings → Security → Personal access tokens).',
    FIGMA_NODE_NOT_FOUND: 'Figma could not find that node. Paste the link to the storyboard section (right-click the section → Copy link to selection).',
    FRAMEIO_NO_STREAM: 'Could not sniff the video stream from Frame.io. Upload the .mp4 manually below.',
    DROPBOX_DOWNLOAD_FAILED: 'Could not download the video from Dropbox. Check that the share link is accessible ("Anyone with the link").',
    'Not a Frame.io share link': 'That does not look like a Frame.io or Dropbox video link.',
    'Not a Figma design link': 'That does not look like a Figma design link.',
    'Not a Frame.io share link': 'That does not look like a Frame.io share link.',
  }[code] ?? `Unexpected error: ${code}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Figma↔Video QA on http://localhost:${port}`));
}
