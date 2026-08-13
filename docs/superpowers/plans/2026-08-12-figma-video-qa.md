# Figma ↔ Frame.io Content QA Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local web app that compares Figma storyboard screens against a Frame.io demo video and reports per-screen Match/Mismatch verdicts (copy, layout, colors), plus missing/extra/order findings.

**Architecture:** Express server + Playwright capture (Figma anonymous viewer, Frame.io stream sniffing) + ffmpeg frame extraction + perceptual-hash matching + Claude vision judging. Filmstrip report UI (vanilla JS) with SSE progress.

**Tech Stack:** Node.js ≥ 20 (ES modules, `node:test`), express, playwright (chromium), ffmpeg-static, sharp, @anthropic-ai/sdk, multer, dotenv.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-figma-video-qa-design.md`.
- ES modules everywhere (`"type": "module"`).
- `.env` holds `ANTHROPIC_API_KEY` (already present at project root, gitignored). Never log or commit the key.
- Judge model string: `claude-sonnet-5`.
- All run artifacts under `runs/<runId>/` (gitignored); reports under `reports/` (gitignored).
- Zoom/pan/scale/device-chrome differences are NEVER mismatches; only content inside the phone screen counts.
- Sandbox note: if `git commit` fails with a stale `.lock` error, skip the commit step and continue; locks can only be removed from the user's machine.

---

### Task 1: Scaffold + server skeleton

**Files:**
- Create: `package.json`, `src/server.js`, `public/index.html` (placeholder), `test/server.test.js`

**Interfaces:**
- Produces: express `app` exported from `src/server.js` (listening only when run directly); `GET /api/health` → `{ ok: true, hasKey: boolean }`.

- [ ] **Step 1: Scaffold**

```bash
npm init -y
npm pkg set type=module scripts.start="node src/server.js" scripts.test="node --test test/"
npm i express dotenv multer @anthropic-ai/sdk sharp ffmpeg-static playwright
npx playwright install chromium
```

- [ ] **Step 2: Write the failing test** — `test/server.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
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
```

- [ ] **Step 3: Run test, expect FAIL** — `node --test test/` → "Cannot find module '../src/server.js'"

- [ ] **Step 4: Implement** — `src/server.js`

```js
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/runs', express.static(path.join(__dirname, '..', 'runs')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.ANTHROPIC_API_KEY) });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Figma↔Video QA on http://localhost:${port}`));
}
```

`public/index.html` placeholder: `<h1>Figma ↔ Video QA</h1>` (replaced in Task 8).

- [ ] **Step 5: Run test, expect PASS**; **commit** `feat: scaffold express server with health check`

---

### Task 2: URL parsers

**Files:**
- Create: `src/parse.js`, `test/parse.test.js`

**Interfaces:**
- Produces: `parseFigmaUrl(url) → { fileKey, nodeId|null }` (nodeId normalized `1234:5678`), throws `Error('Not a Figma design link')`; `parseFrameioUrl(url) → { shareId, assetId|null }`, throws `Error('Not a Frame.io share link')`.

- [ ] **Step 1: Write failing tests** — `test/parse.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFigmaUrl, parseFrameioUrl } from '../src/parse.js';

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
test('rejects non-frameio', () => {
  assert.throws(() => parseFrameioUrl('https://vimeo.com/1'), /Not a Frame\.io/);
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing)

- [ ] **Step 3: Implement** — `src/parse.js`

```js
export function parseFigmaUrl(url) {
  const m = url.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('Not a Figma design link');
  const n = url.match(/node-id=([0-9]+)[-:]([0-9]+)/);
  return { fileKey: m[1], nodeId: n ? `${n[1]}:${n[2]}` : null };
}

export function parseFrameioUrl(url) {
  const m = url.match(/frame\.io\/share\/([0-9a-f-]{36})(?:\/view\/([0-9a-f-]{36}))?/);
  if (!m) throw new Error('Not a Frame.io share link');
  return { shareId: m[1], assetId: m[2] ?? null };
}
```

- [ ] **Step 4: Run, expect PASS**; **commit** `feat: figma and frame.io url parsers`

---

### Task 3: Image utilities (hashing, similarity, crop)

**Files:**
- Create: `src/imghash.js`, `test/imghash.test.js`

**Interfaces:**
- Produces:
  - `dhash(pngPathOrBuffer) → Promise<bigint>` (64-bit difference hash)
  - `hamming(a: bigint, b: bigint) → number`
  - `histogram(pngPathOrBuffer) → Promise<number[]>` (48-bin RGB, normalized)
  - `histSimilarity(h1, h2) → number` (0..1, intersection)
  - `similarity(imgA, imgB) → Promise<number>` (0..1; `0.6 * (1 - hamming/64) + 0.4 * histSim`)
  - `cropContentRegion(pngPath, outPath) → Promise<string>` (crops to the phone-screen content via luminance-edge row/column profiles; falls back to original path if detection fails)
  - `blurScore(pngPathOrBuffer) → Promise<number>` (variance of Laplacian; low = blurry)

- [ ] **Step 1: Write failing tests** — `test/imghash.test.js` (fixtures generated with sharp in the test itself)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { dhash, hamming, histogram, histSimilarity, similarity, blurScore } from '../src/imghash.js';

const solid = (r, g, b) => sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } }).png().toBuffer();
async function checker(cell = 8) {
  const svg = `<svg width="64" height="64">${Array.from({ length: 64 }, (_, i) => {
    const x = (i % 8) * cell, y = Math.floor(i / 8) * cell;
    return (i + Math.floor(i / 8)) % 2 ? `<rect x="${x}" y="${y}" width="${cell}" height="${cell}"/>` : '';
  }).join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

test('identical images: hamming 0, similarity ~1', async () => {
  const a = await checker();
  assert.equal(hamming(await dhash(a), await dhash(a)), 0);
  assert.ok(await similarity(a, a) > 0.95);
});
test('different images score lower than identical', async () => {
  const a = await checker(), b = await solid(255, 0, 0);
  assert.ok(await similarity(a, b) < await similarity(a, a));
});
test('histogram similarity: same color 1, opposite lower', async () => {
  const red = await histogram(await solid(255, 0, 0));
  const blue = await histogram(await solid(0, 0, 255));
  assert.ok(histSimilarity(red, red) > 0.99);
  assert.ok(histSimilarity(red, blue) < 0.2);
});
test('blur: checkerboard sharper than solid', async () => {
  assert.ok(await blurScore(await checker()) > await blurScore(await solid(128, 128, 128)));
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** — `src/imghash.js`

```js
import sharp from 'sharp';

async function gray(input, w, h) {
  return sharp(input).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer();
}

export async function dhash(input) {
  const px = await gray(input, 9, 8);
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  }
  return bits;
}

export function hamming(a, b) {
  let x = a ^ b, n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

export async function histogram(input) {
  const buf = await sharp(input).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const bins = new Array(48).fill(0);
  for (let i = 0; i < buf.length; i += 3) {
    bins[Math.min(15, buf[i] >> 4)]++;
    bins[16 + Math.min(15, buf[i + 1] >> 4)]++;
    bins[32 + Math.min(15, buf[i + 2] >> 4)]++;
  }
  const total = buf.length / 3;
  return bins.map(v => v / total / 3);
}

export function histSimilarity(h1, h2) {
  let s = 0;
  for (let i = 0; i < h1.length; i++) s += Math.min(h1[i], h2[i]);
  return s * 3 / 1; // three channels each sum to 1/3
}

export async function similarity(a, b) {
  const [ha, hb, ga, gb] = await Promise.all([dhash(a), dhash(b), histogram(a), histogram(b)]);
  return 0.6 * (1 - hamming(ha, hb) / 64) + 0.4 * histSimilarity(ga, gb);
}

export async function blurScore(input) {
  const w = 128, h = 128;
  const px = await gray(input, w, h);
  const vals = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    vals.push(4 * px[i] - px[i - 1] - px[i + 1] - px[i - w] - px[i + w]);
  }
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
}

export async function cropContentRegion(pngPath, outPath) {
  try {
    const img = sharp(pngPath);
    const { width, height } = await img.metadata();
    const px = await img.clone().grayscale().raw().toBuffer();
    const colE = new Array(width).fill(0), rowE = new Array(height).fill(0);
    for (let y = 0; y < height; y++) for (let x = 1; x < width; x++) {
      const d = Math.abs(px[y * width + x] - px[y * width + x - 1]);
      if (d > 24) { colE[x]++; rowE[y]++; }
    }
    const thC = height * 0.04, thR = width * 0.04;
    const l = colE.findIndex(v => v > thC), r = colE.findLastIndex(v => v > thC);
    const t = rowE.findIndex(v => v > thR), b = rowE.findLastIndex(v => v > thR);
    if (l < 0 || r - l < width * 0.15 || b - t < height * 0.3) return pngPath;
    await sharp(pngPath).extract({ left: l, top: t, width: r - l + 1, height: b - t + 1 }).toFile(outPath);
    return outPath;
  } catch {
    return pngPath;
  }
}
```

- [ ] **Step 4: Run, expect PASS**; **commit** `feat: perceptual hash, histogram, blur, crop utilities`

---

### Task 4: Figma capturer

**Files:**
- Create: `src/capture/figma.js`, `scripts/smoke-figma.js`

**Interfaces:**
- Consumes: `parseFigmaUrl` (Task 2).
- Produces: `captureFigmaFrames(url, runDir, onProgress) → Promise<Array<{ index, name, nodeId, pngPath }>>` in storyboard (canvas left→right) order. `onProgress(msg: string)` optional. Throws `Error('FIGMA_PRIVATE')` when the file requires login.

**Approach (share-link only, no API):** Playwright chromium opens the link anonymously. In Figma's view-only UI, the left sidebar lists top-level frames of the current page. Strategy, in order of preference:
1. Wait for canvas; open layers sidebar if collapsed. Collect layer rows (`[data-testid*="layer-row"], .object_row`, fall back to `aria-label` heuristics); clicking a row selects the frame and pushes `node-id` into the URL.
2. For each frame: click row → keyboard `Shift+2` (zoom to selection) → wait 800 ms → screenshot the canvas element → `sharp(...).trim()` to strip surrounding canvas background → save `runs/<id>/figma/NN-<safe-name>.png`.
3. If sidebar scraping yields zero rows, fall back: if the pasted URL has a `node-id`, treat it as a section — select it, read its child frames via the right-click "select children" flow is unreliable anonymously, so instead: screenshot the whole section zoomed (`Shift+2`), and split into columns by vertical whitespace gaps (luminance column profile from Task 3's approach) — each column = one screen.
4. If a login wall appears (`text=Log in` overlay), throw `FIGMA_PRIVATE`.

Frame order: sort selected frames by their canvas x-position — obtained by reading the selection's URL node-ids after clicking, and ordering by the sidebar's row order (Figma sidebar lists frames in canvas order for tidy files); sidebar order is the primary sort, name-prefix numerals (`01`, `02`…) override when present.

- [ ] **Step 1: Implement** — `src/capture/figma.js`

```js
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFigmaUrl } from '../parse.js';

const safe = s => s.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60);

export async function captureFigmaFrames(url, runDir, onProgress = () => {}) {
  parseFigmaUrl(url); // validates
  const dir = path.join(runDir, 'figma');
  await fs.mkdir(dir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  try {
    onProgress('Opening Figma…');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000); // canvas boot
    if (await page.locator('text=/log in|sign up/i').first().isVisible().catch(() => false)) {
      const canvas = await page.locator('canvas').first().isVisible().catch(() => false);
      if (!canvas) throw new Error('FIGMA_PRIVATE');
    }
    const rows = await collectLayerRows(page);
    onProgress(`Found ${rows.length} frames in sidebar`);
    const frames = [];
    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i++) {
        const { name } = rows[i];
        await rows[i].locator.click();
        await page.keyboard.press('Shift+2');
        await page.waitForTimeout(900);
        const nodeId = (page.url().match(/node-id=([0-9]+)[-:]([0-9]+)/) || []).slice(1).join(':') || null;
        const raw = await page.locator('canvas').first().screenshot();
        const pngPath = path.join(dir, `${String(i + 1).padStart(2, '0')}-${safe(name)}.png`);
        await sharp(raw).trim({ threshold: 12 }).toFile(pngPath);
        frames.push({ index: i, name, nodeId, pngPath });
        onProgress(`Captured ${i + 1}/${rows.length}: ${name}`);
      }
    } else {
      onProgress('Sidebar empty — falling back to section split');
      frames.push(...await sectionSplitFallback(page, dir));
    }
    if (frames.length === 0) throw new Error('FIGMA_NO_FRAMES');
    return sortByNamePrefix(frames);
  } finally {
    await browser.close();
  }
}

async function collectLayerRows(page) {
  const selectors = ['[data-testid="layer-row"]', '[class*="object_row"]', '[data-testid*="layers"] [role="treeitem"]'];
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    if (n > 0) {
      const rows = [];
      for (let i = 0; i < n; i++) {
        const name = (await loc.nth(i).innerText().catch(() => '')).trim().split('\n')[0];
        if (name) rows.push({ name, locator: loc.nth(i) });
      }
      return rows;
    }
  }
  return [];
}

async function sectionSplitFallback(page, dir) {
  await page.keyboard.press('Shift+1'); // zoom to fit
  await page.waitForTimeout(900);
  const raw = await page.locator('canvas').first().screenshot();
  const trimmed = await sharp(raw).trim({ threshold: 12 }).toBuffer();
  const { width, height } = await sharp(trimmed).metadata();
  const px = await sharp(trimmed).grayscale().raw().toBuffer();
  const colHasInk = new Array(width).fill(false);
  for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) {
    if (Math.abs(px[y * width + x] - px[0]) > 20) { colHasInk[x] = true; break; }
  }
  const bands = [];
  let start = null;
  for (let x = 0; x <= width; x++) {
    if (x < width && colHasInk[x]) { if (start === null) start = x; }
    else if (start !== null) { if (x - start > width * 0.03) bands.push([start, x]); start = null; }
  }
  const frames = [];
  for (let i = 0; i < bands.length; i++) {
    const [l, r] = bands[i];
    const pngPath = path.join(dir, `${String(i + 1).padStart(2, '0')}-section.png`);
    await sharp(trimmed).extract({ left: l, top: 0, width: r - l, height }).toFile(pngPath);
    frames.push({ index: i, name: `Screen ${i + 1}`, nodeId: null, pngPath });
  }
  return frames;
}

function sortByNamePrefix(frames) {
  const num = f => { const m = f.name.match(/^(\d{1,3})\b/); return m ? Number(m[1]) : null; };
  if (frames.every(f => num(f) !== null)) frames.sort((a, b) => num(a) - num(b));
  return frames.map((f, i) => ({ ...f, index: i }));
}
```

- [ ] **Step 2: Smoke script** — `scripts/smoke-figma.js`

```js
import { captureFigmaFrames } from '../src/capture/figma.js';
const url = process.argv[2];
const frames = await captureFigmaFrames(url, 'runs/smoke', console.log);
console.table(frames.map(f => ({ name: f.name, nodeId: f.nodeId, png: f.pngPath })));
```

- [ ] **Step 3: Run smoke against the real storyboard link**; verify PNGs visually (Read the images). Expect the phone screens captured whole. Iterate selectors here if Figma's DOM differs — this step is expected to need live debugging.

- [ ] **Step 4: Commit** `feat: figma anonymous frame capturer with section-split fallback`

---

### Task 5: Video capturer

**Files:**
- Create: `src/capture/video.js`, `scripts/smoke-video.js`

**Interfaces:**
- Consumes: `parseFrameioUrl` (Task 2); `dhash`, `hamming`, `blurScore` (Task 3).
- Produces:
  - `downloadFrameioVideo(url, runDir, onProgress) → Promise<string>` (local mp4 path). Throws `Error('FRAMEIO_NO_STREAM')` if no stream URL sniffed.
  - `extractFrames(videoPath, runDir, onProgress) → Promise<Array<{ timestamp, pngPath }>>` — 2 fps uniform sampling → blur filter (drop bottom quartile by blurScore when frame count > 40) → dHash dedupe (hamming ≤ 6 against previous kept frame).

- [ ] **Step 1: Implement** — `src/capture/video.js`

```js
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrameioUrl } from '../parse.js';
import { dhash, hamming, blurScore } from '../imghash.js';

const run = promisify(execFile);

export async function downloadFrameioVideo(url, runDir, onProgress = () => {}) {
  parseFrameioUrl(url);
  await fs.mkdir(runDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const streams = [];
  page.on('request', req => {
    const u = req.url();
    if (/\.m3u8|\.mp4/.test(u)) streams.push({ url: u, headers: req.headers() });
  });
  try {
    onProgress('Opening Frame.io…');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const play = page.locator('button[aria-label*="lay"], [data-testid*="play"]').first();
    if (await play.isVisible().catch(() => false)) await play.click().catch(() => {});
    await page.waitForTimeout(6000);
    if (streams.length === 0) throw new Error('FRAMEIO_NO_STREAM');
    const pick = streams.find(s => s.url.includes('.mp4')) ?? streams[streams.length - 1];
    onProgress('Downloading stream…');
    const out = path.join(runDir, 'demo.mp4');
    const headerArg = Object.entries(pick.headers)
      .filter(([k]) => ['referer', 'user-agent', 'cookie', 'authorization'].includes(k.toLowerCase()))
      .map(([k, v]) => `${k}: ${v}`).join('\r\n');
    const args = ['-y'];
    if (headerArg) args.push('-headers', headerArg + '\r\n');
    args.push('-i', pick.url, '-c', 'copy', out);
    await run(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 });
    return out;
  } finally {
    await browser.close();
  }
}

export async function extractFrames(videoPath, runDir, onProgress = () => {}) {
  const dir = path.join(runDir, 'video');
  await fs.mkdir(dir, { recursive: true });
  onProgress('Extracting frames at 2fps…');
  await run(ffmpegPath, ['-y', '-i', videoPath, '-vf', 'fps=2', path.join(dir, '%05d.png')],
    { maxBuffer: 1024 * 1024 * 64 });
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.png')).sort();
  const all = files.map((f, i) => ({ timestamp: i / 2, pngPath: path.join(dir, f) }));

  let candidates = all;
  if (all.length > 40) {
    const scored = await Promise.all(all.map(async fr => ({ ...fr, blur: await blurScore(fr.pngPath) })));
    const sorted = [...scored].sort((a, b) => a.blur - b.blur);
    const cutoff = sorted[Math.floor(sorted.length / 4)].blur;
    candidates = scored.filter(f => f.blur > cutoff);
  }

  onProgress(`Deduping ${candidates.length} frames…`);
  const kept = [];
  let prevHash = null;
  for (const fr of candidates) {
    const h = await dhash(fr.pngPath);
    if (prevHash === null || hamming(h, prevHash) > 6) kept.push(fr);
    prevHash = h;
  }
  onProgress(`${kept.length} distinct frames kept`);
  return kept.map(({ timestamp, pngPath }) => ({ timestamp, pngPath }));
}
```

- [ ] **Step 2: Smoke script** — `scripts/smoke-video.js`

```js
import { downloadFrameioVideo, extractFrames } from '../src/capture/video.js';
const mp4 = await downloadFrameioVideo(process.argv[2], 'runs/smoke', console.log);
const frames = await extractFrames(mp4, 'runs/smoke', console.log);
console.log(frames.length, 'frames;', frames.slice(0, 5));
```

- [ ] **Step 3: Run smoke against the real share link**; view a few extracted PNGs. If HLS download fails with 403, revisit header forwarding (expected live-debug point). Verify dedupe keeps ~1 frame per distinct screen state.

- [ ] **Step 4: Commit** `feat: frame.io stream download and keyframe extraction`

---

### Task 6: Matcher + sequence check

**Files:**
- Create: `src/compare/match.js`, `test/match.test.js`

**Interfaces:**
- Consumes: `similarity`, `cropContentRegion` (Task 3).
- Produces:
  - `matchScreens(figmaFrames, videoFrames, { topK = 3, minScore = 0.55 } = {}) → Promise<Array<{ screen, candidates: Array<{ frame, score }> }>>` — `screen` is a Figma frame object, `candidates` sorted desc by score, empty when nothing ≥ minScore; video frames pre-cropped via `cropContentRegion` (cropped path cached on the frame object as `croppedPath`).
  - `sequenceCheck(matches) → { ok: boolean, violations: Array<{ screenName, timestamp, prevTimestamp }> }` — uses each screen's best *judged-match* frame timestamp (call after judging, passing only screens with verdict `match`/`mismatch`).
  - `findExtras(videoFrames, matches, { minScore = 0.55 }) → frame[]` — frames that are no screen's candidate.

- [ ] **Step 1: Write failing tests** — `test/match.test.js` (sequence + extras logic is pure; matching tested with sharp fixtures)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { matchScreens, sequenceCheck, findExtras } from '../src/compare/match.js';

const img = (r, g, b, txt) => sharp(Buffer.from(
  `<svg width="200" height="400"><rect width="200" height="400" fill="rgb(${r},${g},${b})"/><text x="20" y="200" font-size="30">${txt}</text></svg>`
)).png().toBuffer();

test('matchScreens pairs each screen with its lookalike frame', async () => {
  const a = await img(255, 255, 255, 'Hello'), b = await img(20, 40, 200, 'Refund');
  const figma = [{ index: 0, name: 'A', pngPath: a }, { index: 1, name: 'B', pngPath: b }];
  const video = [{ timestamp: 1, pngPath: b }, { timestamp: 5, pngPath: a }];
  const m = await matchScreens(figma, video);
  assert.equal(m[0].candidates[0].frame.timestamp, 5);
  assert.equal(m[1].candidates[0].frame.timestamp, 1);
});

test('sequenceCheck flags decreasing timestamps', () => {
  const judged = [
    { screen: { name: 'S1' }, matchedFrame: { timestamp: 10 } },
    { screen: { name: 'S2' }, matchedFrame: { timestamp: 4 } },
  ];
  const r = sequenceCheck(judged);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].screenName, 'S2');
});

test('findExtras returns frames used by no screen', async () => {
  const a = await img(255, 255, 255, 'X');
  const orphan = { timestamp: 9, pngPath: await img(0, 255, 0, 'ORPHAN') };
  const matches = [{ screen: {}, candidates: [{ frame: { timestamp: 1, pngPath: a }, score: 0.9 }] }];
  const extras = findExtras([{ timestamp: 1, pngPath: a }, orphan], matches);
  assert.deepEqual(extras.map(f => f.timestamp), [9]);
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** — `src/compare/match.js`

```js
import { similarity, cropContentRegion } from '../imghash.js';

export async function matchScreens(figmaFrames, videoFrames, { topK = 3, minScore = 0.55 } = {}) {
  for (const vf of videoFrames) {
    if (!vf.croppedPath) {
      vf.croppedPath = typeof vf.pngPath === 'string'
        ? await cropContentRegion(vf.pngPath, vf.pngPath.replace(/\.png$/, '.crop.png'))
        : vf.pngPath;
    }
  }
  const results = [];
  for (const screen of figmaFrames) {
    const scored = await Promise.all(videoFrames.map(async frame => ({
      frame, score: await similarity(screen.pngPath, frame.croppedPath),
    })));
    scored.sort((a, b) => b.score - a.score);
    results.push({ screen, candidates: scored.filter(c => c.score >= minScore).slice(0, topK) });
  }
  return results;
}

export function sequenceCheck(judged) {
  const violations = [];
  let prev = -Infinity, prevName = null;
  for (const { screen, matchedFrame } of judged) {
    if (!matchedFrame) continue;
    if (matchedFrame.timestamp < prev) {
      violations.push({ screenName: screen.name, timestamp: matchedFrame.timestamp, prevTimestamp: prev });
    }
    prev = Math.max(prev, matchedFrame.timestamp);
    prevName = screen.name;
  }
  return { ok: violations.length === 0, violations };
}

export function findExtras(videoFrames, matches) {
  const used = new Set();
  for (const m of matches) for (const c of m.candidates) used.add(c.frame.timestamp);
  return videoFrames.filter(f => !used.has(f.timestamp));
}
```

- [ ] **Step 4: Run, expect PASS**; **commit** `feat: perceptual matcher, sequence check, extras detection`

---

### Task 7: Claude vision judge

**Files:**
- Create: `src/compare/judge.js`, `test/judge.test.js`

**Interfaces:**
- Consumes: match results (Task 6).
- Produces: `judgeAll(matches, { client, onProgress }) → Promise<Array<Judged>>` where `Judged = { screen, matchedFrame|null, verdict: 'match'|'mismatch'|'not_found'|'error', differences: string[] }`. `client` injectable for tests (defaults to real Anthropic client). Per-pair retry 3× with exponential backoff; a screen that still fails gets `verdict: 'error'`, never dropped. If the judge answers `partial_screen` for a candidate, the next candidate is tried.

- [ ] **Step 1: Write failing tests** — `test/judge.test.js` (mock client)

```js
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
  assert.deepEqual(out[0].differences, ['price differs']);
  assert.equal(out[0].matchedFrame.timestamp, 2);
});

test('partial_screen advances to next candidate', async () => {
  const frame = ts => ({ timestamp: ts, pngPath: null, croppedPath: null });
  const matches = [{ screen: { name: 'S1', pngPath: await png() }, candidates: [
    { frame: { ...frame(1), pngPath: await png(), croppedPath: await png() }, score: 0.9 },
    { frame: { ...frame(7), pngPath: await png(), croppedPath: await png() }, score: 0.8 },
  ] }];
  const out = await judgeAll(matches, { client: mockClient([{ verdict: 'partial_screen', differences: [] }, { verdict: 'match', differences: [] }]) });
  assert.equal(out[0].verdict, 'match');
  assert.equal(out[0].matchedFrame.timestamp, 7);
});

test('no candidates → not_found', async () => {
  const out = await judgeAll([{ screen: { name: 'S1', pngPath: await png() }, candidates: [] }], { client: mockClient([]) });
  assert.equal(out[0].verdict, 'not_found');
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** — `src/compare/judge.js`

```js
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs/promises';

const MODEL = 'claude-sonnet-5';

const SYSTEM = `You are a meticulous content-QA reviewer for animated product demos.
You compare an approved Figma design screen (image 1) with a frame captured from the animated video (image 2).
ONLY the content inside the phone screen matters: text copy (exact wording, numbers, prices), layout structure, element presence, and colors.
IGNORE completely: zoom level, cropping of surroundings, device frame/chrome, background outside the phone, motion blur at edges, video compression artifacts, minor anti-aliasing.
Respond with JSON only: {"verdict": "match" | "mismatch" | "partial_screen", "differences": ["..."]}
Use "partial_screen" when image 2 does not show the complete phone screen (mid-zoom or cropped), so a fair comparison is impossible.
"differences" must be concrete and specific, e.g. "Price shows $99 in Figma but $89 in video". Empty array for match.`;

async function toImageBlock(input) {
  const data = typeof input === 'string' ? await fs.readFile(input) : input;
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } };
}

async function judgePair(client, screen, candidate) {
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 1024, system: SYSTEM,
    messages: [{ role: 'user', content: [
      await toImageBlock(screen.pngPath),
      await toImageBlock(candidate.frame.croppedPath ?? candidate.frame.pngPath),
      { type: 'text', text: `Figma screen name: "${screen.name}". Compare content 1:1.` },
    ] }],
  });
  const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
  const json = text.match(/\{[\s\S]*\}/);
  return JSON.parse(json ? json[0] : '{}');
}

async function withRetry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries - 1) throw e; await new Promise(r => setTimeout(r, 1000 * 2 ** i)); }
  }
}

export async function judgeAll(matches, { client, onProgress = () => {} } = {}) {
  client ??= new Anthropic();
  const out = [];
  for (const [i, m] of matches.entries()) {
    onProgress(`Judging ${i + 1}/${matches.length}: ${m.screen.name}`);
    if (m.candidates.length === 0) {
      out.push({ screen: m.screen, matchedFrame: null, verdict: 'not_found', differences: [] });
      continue;
    }
    let result = null;
    for (const candidate of m.candidates) {
      try {
        const r = await withRetry(() => judgePair(client, m.screen, candidate));
        if (r.verdict === 'partial_screen') continue;
        result = { screen: m.screen, matchedFrame: candidate.frame, verdict: r.verdict === 'match' ? 'match' : 'mismatch', differences: r.differences ?? [] };
        break;
      } catch (e) {
        result = { screen: m.screen, matchedFrame: candidate.frame, verdict: 'error', differences: [`Judge failed: ${e.message}`] };
      }
    }
    out.push(result ?? { screen: m.screen, matchedFrame: null, verdict: 'not_found', differences: ['All candidates showed partial screens'] });
  }
  return out;
}
```

- [ ] **Step 4: Run, expect PASS**; **commit** `feat: claude vision judge with retry and partial-screen fallback`

---

### Task 8: Pipeline orchestrator + API + frontend

**Files:**
- Create: `src/pipeline.js`
- Modify: `src/server.js` (add `/api/compare`, `/api/upload`, SSE `/api/progress/:runId`)
- Replace: `public/index.html` (full UI)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `runPipeline({ figmaUrl, frameioUrl|videoPath, runId, onProgress }) → Promise<Report>` where `Report = { runId, summary: { total, match, mismatch, missing, errors, orderOk }, screens: Judged[] (paths rewritten web-relative), extras: frame[], sequence }`.
  - `POST /api/compare` `{ figmaUrl, frameioUrl }` → `{ runId }` (kicks off async run); progress via SSE `GET /api/progress/:runId` (events: `progress` = text, `done` = report JSON, `error` = message with `code` for FIGMA_PRIVATE / FRAMEIO_NO_STREAM).
  - `POST /api/upload` (multer, field `video`) → `{ videoPath }` for the manual mp4 fallback; `POST /api/compare` also accepts `{ figmaUrl, videoPath }`.
  - Standalone report saved to `reports/<runId>.html` (same markup as UI, images inlined base64).

- [ ] **Step 1: Implement `src/pipeline.js`**

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { captureFigmaFrames } from './capture/figma.js';
import { downloadFrameioVideo, extractFrames } from './capture/video.js';
import { matchScreens, sequenceCheck, findExtras } from './compare/match.js';
import { judgeAll } from './compare/judge.js';

export async function runPipeline({ figmaUrl, frameioUrl, videoPath, runId, onProgress = () => {} }) {
  const runDir = path.join('runs', runId);
  await fs.mkdir(runDir, { recursive: true });

  const [figmaFrames, mp4] = await Promise.all([
    captureFigmaFrames(figmaUrl, runDir, m => onProgress(`[figma] ${m}`)),
    videoPath ? Promise.resolve(videoPath) : downloadFrameioVideo(frameioUrl, runDir, m => onProgress(`[video] ${m}`)),
  ]);
  const videoFrames = await extractFrames(mp4, runDir, m => onProgress(`[video] ${m}`));

  onProgress(`Matching ${figmaFrames.length} screens against ${videoFrames.length} frames…`);
  const matches = await matchScreens(figmaFrames, videoFrames);
  const judged = await judgeAll(matches, { onProgress });
  const sequence = sequenceCheck(judged.filter(j => j.verdict === 'match' || j.verdict === 'mismatch'));
  const extras = findExtras(videoFrames, matches);

  const web = p => p ? '/' + p.split(path.sep).join('/') : null;
  const report = {
    runId,
    summary: {
      total: judged.length,
      match: judged.filter(j => j.verdict === 'match').length,
      mismatch: judged.filter(j => j.verdict === 'mismatch').length,
      missing: judged.filter(j => j.verdict === 'not_found').length,
      errors: judged.filter(j => j.verdict === 'error').length,
      orderOk: sequence.ok,
    },
    screens: judged.map(j => ({
      name: j.screen.name, verdict: j.verdict, differences: j.differences,
      figmaPng: web(j.screen.pngPath),
      videoPng: web(j.matchedFrame?.croppedPath ?? j.matchedFrame?.pngPath),
      timestamp: j.matchedFrame?.timestamp ?? null,
    })),
    extras: extras.slice(0, 12).map(f => ({ videoPng: web(f.croppedPath ?? f.pngPath), timestamp: f.timestamp })),
    sequence,
  };
  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  await saveStandaloneReport(report, runDir);
  return report;
}

async function saveStandaloneReport(report, runDir) {
  await fs.mkdir('reports', { recursive: true });
  const inline = async p => {
    if (!p) return '';
    try { return `data:image/png;base64,${(await fs.readFile(p.slice(1))).toString('base64')}`; }
    catch { return ''; }
  };
  const screens = await Promise.all(report.screens.map(async s => ({
    ...s, figmaPng: await inline(s.figmaPng), videoPng: await inline(s.videoPng),
  })));
  const html = `<!doctype html><meta charset="utf-8"><title>QA ${report.runId}</title>
<body style="background:#111;color:#eee;font-family:sans-serif;padding:24px">
<h2>${report.summary.total} screens · ${report.summary.match} match · ${report.summary.mismatch} mismatch · ${report.summary.missing} missing · order ${report.summary.orderOk ? 'OK' : 'BROKEN'}</h2>
<div style="display:flex;gap:16px;overflow-x:auto">${screens.map(s => `
<div style="min-width:180px;text-align:center">
  <img src="${s.figmaPng}" style="width:170px;display:block;margin-bottom:8px">
  ${s.videoPng ? `<img src="${s.videoPng}" style="width:170px;display:block">` : '<div style="width:170px;height:300px;border:2px dashed #555;display:flex;align-items:center;justify-content:center">Not found</div>'}
  <div style="color:${s.verdict === 'match' ? '#3f6' : '#f44'};font-weight:bold;margin-top:6px">${s.verdict}</div>
  ${s.differences.map(d => `<div style="font-size:11px;color:#f99">${d}</div>`).join('')}
</div>`).join('')}</div></body>`;
  await fs.writeFile(path.join('reports', `${report.runId}.html`), html);
}
```

- [ ] **Step 2: Extend `src/server.js`** — add below the health route:

```js
import multer from 'multer';
import crypto from 'node:crypto';
import { runPipeline } from './pipeline.js';

const upload = multer({ dest: 'runs/uploads/' });
const channels = new Map(); // runId -> Set<res>

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
  res.json({ videoPath: req.file.path });
});

app.post('/api/compare', (req, res) => {
  const { figmaUrl, frameioUrl, videoPath } = req.body;
  if (!figmaUrl || (!frameioUrl && !videoPath)) return res.status(400).json({ error: 'figmaUrl and frameioUrl (or videoPath) required' });
  const runId = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(3).toString('hex');
  res.json({ runId });
  setTimeout(async () => {
    try {
      const report = await runPipeline({ figmaUrl, frameioUrl, videoPath, runId, onProgress: m => emit(runId, 'progress', m) });
      emit(runId, 'done', report);
    } catch (e) {
      emit(runId, 'error', { code: e.message, message: friendly(e.message) });
    }
  }, 300);
});

function friendly(code) {
  return {
    FIGMA_PRIVATE: 'This Figma file is not publicly viewable. Enable link sharing ("Anyone with the link → can view") and retry.',
    FIGMA_NO_FRAMES: 'Could not find any frames in the Figma file. Paste a link that points at the storyboard page or section.',
    FRAMEIO_NO_STREAM: 'Could not sniff the video stream from Frame.io. Upload the .mp4 manually below.',
  }[code] ?? `Unexpected error: ${code}`;
}
```

- [ ] **Step 3: Frontend `public/index.html`** — filmstrip UI per spec:

```html
<!doctype html><html><head><meta charset="utf-8"><title>Figma ↔ Video QA</title>
<style>
  body { background: #141414; color: #eee; font-family: -apple-system, sans-serif; margin: 0; padding: 32px; }
  input[type=url] { width: 480px; padding: 10px; border-radius: 8px; border: 1px solid #333; background: #1e1e1e; color: #eee; }
  button.go { padding: 10px 24px; border-radius: 8px; border: 0; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; }
  #log { font: 12px monospace; color: #8a8; white-space: pre-wrap; margin: 16px 0; max-height: 160px; overflow-y: auto; }
  #summary { font-size: 18px; font-weight: 600; margin: 16px 0; }
  #strip { display: flex; gap: 20px; overflow-x: auto; padding-bottom: 16px; }
  .col { min-width: 190px; text-align: center; cursor: pointer; }
  .col img { width: 180px; border-radius: 8px; display: block; margin: 0 auto 10px; }
  .verdict { font-weight: 700; margin-top: 6px; text-transform: capitalize; }
  .match { color: #4ade80; } .mismatch { color: #f87171; } .not_found, .error { color: #fbbf24; }
  .ghost { width: 180px; height: 320px; border: 2px dashed #444; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #666; margin: 0 auto; }
  #detail { display: none; position: sticky; bottom: 0; background: #1c1c1c; border-top: 1px solid #333; padding: 20px; }
  #detail .imgs { display: flex; gap: 24px; } #detail img { max-height: 480px; border-radius: 8px; }
  #detail ul { color: #f99; }
  .extra { opacity: 0.5; }
  #fallback { display: none; margin-top: 12px; }
</style></head><body>
<h1>Figma ↔ Video QA</h1>
<div>
  <input type="url" id="figma" placeholder="Figma storyboard link"><br><br>
  <input type="url" id="frameio" placeholder="Frame.io share link"><br><br>
  <button class="go" id="go">Compare</button>
  <div id="fallback">Stream sniffing failed — upload the mp4: <input type="file" id="mp4" accept="video/mp4"></div>
</div>
<div id="log"></div>
<div id="summary"></div>
<div id="strip"></div>
<div id="detail"><div class="imgs"><img id="dFigma"><img id="dVideo"></div><ul id="dDiffs"></ul></div>
<script>
const $ = id => document.getElementById(id);
let uploadedPath = null;

$('mp4').onchange = async e => {
  const fd = new FormData(); fd.append('video', e.target.files[0]);
  const r = await fetch('/api/upload', { method: 'POST', body: fd }).then(r => r.json());
  uploadedPath = r.videoPath;
  $('go').click();
};

$('go').onclick = async () => {
  $('log').textContent = ''; $('strip').innerHTML = ''; $('summary').textContent = '';
  const body = { figmaUrl: $('figma').value, frameioUrl: $('frameio').value, videoPath: uploadedPath };
  const { runId, error } = await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  if (error) return $('log').textContent = error;
  const es = new EventSource('/api/progress/' + runId);
  es.addEventListener('progress', e => { $('log').textContent += JSON.parse(e.data) + '\n'; $('log').scrollTop = 1e9; });
  es.addEventListener('error', e => { if (!e.data) return; const d = JSON.parse(e.data); $('log').textContent += '❌ ' + d.message + '\n'; if (d.code === 'FRAMEIO_NO_STREAM') $('fallback').style.display = 'block'; es.close(); });
  es.addEventListener('done', e => { render(JSON.parse(e.data)); es.close(); });
};

function render(r) {
  const s = r.summary;
  $('summary').textContent = `${s.total} screens · ${s.match} match · ${s.mismatch} mismatch · ${s.missing} missing` + (s.errors ? ` · ${s.errors} errors` : '') + ` · order ${s.orderOk ? 'OK ✓' : 'BROKEN ✗'}`;
  $('strip').innerHTML = r.screens.map((sc, i) => `
    <div class="col" onclick="detail(${i})">
      <img src="${sc.figmaPng}">
      ${sc.videoPng ? `<img src="${sc.videoPng}">` : '<div class="ghost">Not found</div>'}
      <div class="verdict ${sc.verdict}">${sc.verdict.replace('_', ' ')}</div>
      <div style="font-size:11px;color:#888">${sc.name}${sc.timestamp !== null ? ' · ' + sc.timestamp.toFixed(1) + 's' : ''}</div>
    </div>`).join('') + r.extras.map(x => `
    <div class="col extra"><div class="ghost">no Figma source</div><img src="${x.videoPng}"><div class="verdict">extra · ${x.timestamp.toFixed(1)}s</div></div>`).join('');
  window._report = r;
}

function detail(i) {
  const sc = window._report.screens[i];
  $('dFigma').src = sc.figmaPng; $('dVideo').src = sc.videoPng || '';
  $('dDiffs').innerHTML = sc.differences.map(d => `<li>${d}</li>`).join('') || '<li style="color:#4ade80">No differences found</li>';
  $('detail').style.display = 'block';
}
</script></body></html>
```

- [ ] **Step 4: Manual verification** — `npm start`, open localhost:3000, confirm form renders and `/api/health` returns `hasKey: true`.

- [ ] **Step 5: Commit** `feat: pipeline orchestrator, compare API with SSE, filmstrip UI`

---

### Task 9: End-to-end smoke against real project links

**Files:** none new (fixes land wherever the smoke reveals problems).

- [ ] **Step 1:** Run full pipeline with the real storyboard link (`https://www.figma.com/design/PwDmcW6cyeOA8EvuarRC5Z/...?node-id=2489-28000`) and the real demo (`https://next.frame.io/share/0b8a767b-.../view/4f98f69c-...`) via the web UI.
- [ ] **Step 2:** Inspect `runs/<id>/figma/` and `runs/<id>/video/` images directly (Read tool) — verify whole phone screens, sensible dedupe, sensible crops.
- [ ] **Step 3:** Review the report against the actual video by eye: verdicts plausible? partial-screen frames excluded? order check correct? Fix the weakest link (likely Figma sidebar selectors or Frame.io headers) and re-run.
- [ ] **Step 4:** Run `node --test test/` — all green.
- [ ] **Step 5:** Write `README.md` (setup: `npm i`, `npx playwright install chromium`, `.env` key, `npm start`) and commit `docs: readme + e2e fixes`.

---

## Self-Review Notes

- Spec coverage: capture (T4/T5), filtering (T5 blur + T7 partial_screen), matching + order + extras (T6), judging (T7), filmstrip report + expand + summary + missing/extra + standalone HTML + upload fallback + friendly errors (T8), audit folders (runs/<id>, T8), e2e (T9). One deliberate deviation from spec: the "is a complete phone screen visible" LLM confirmation is folded into the judge (`partial_screen` verdict) instead of a separate pre-filter pass — fewer API calls, same outcome.
- Types consistent: `{ index, name, nodeId, pngPath }` (Figma), `{ timestamp, pngPath, croppedPath? }` (video), `Judged` shape used by pipeline and UI.
- No placeholders; all code complete.
