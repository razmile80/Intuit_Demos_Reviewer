import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFigmaUrl } from '../parse.js';
import { grayPixels, pixelDiff } from '../imghash.js';

const safe = s => s.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60) || 'screen';

// Verified against the real file (2026-08-12, via live DOM inspection):
// - Figma may show an "Opened in Figma app — Open here instead" interstitial.
// - Layer rows carry data-testid="<node:id>-layers-panel-row".
// - Navigating to ?node-id=X selects/zooms that node; Shift+2 = zoom to selection.
// - Layer-panel order is NOT storyboard order; storyboard order is canvas
//   left-to-right, recovered visually via the section overview (orderByOverview).
export async function captureFigmaFrames(url, runDir, onProgress = () => {}) {
  parseFigmaUrl(url); // validates
  const dir = path.join(runDir, 'figma');
  await fs.mkdir(dir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  try {
    onProgress('Opening Figma…');
    await gotoAndSettle(page, url);
    if (!(await waitForCanvas(page, 30000))) {
      await debugDump(page, runDir);
      if (await page.locator('text=/log in|sign up|create account|verify|need access|request access/i').first().isVisible().catch(() => false)) {
        throw new Error('FIGMA_PRIVATE');
      }
      throw new Error('FIGMA_NO_FRAMES');
    }

    // Overview screenshot of the target node (section) for later ordering.
    await page.keyboard.press('Shift+2');
    await page.waitForTimeout(1200);
    const overviewRaw = await page.locator('canvas').first().screenshot();
    const overviewPath = path.join(dir, '_overview.png');
    await sharp(overviewRaw).trim({ threshold: 12 }).toFile(overviewPath);

    // Enumerate child frames: click canvas center (selects section), Enter drills
    // into first child, Tab cycles siblings; node-id read from the URL.
    let frames = await tabCycleCapture(page, dir, onProgress);

    if (frames.length === 0) {
      onProgress('Keyboard enumeration failed — using section split fallback');
      frames = await sectionSplit(overviewPath, dir);
    }
    if (frames.length === 0) {
      await debugDump(page, runDir);
      throw new Error('FIGMA_NO_FRAMES');
    }
    return await orderByOverview(frames, overviewPath, onProgress);
  } finally {
    await browser.close();
  }
}

async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  // "Opened in Figma app" interstitial → click "Open here instead"
  const openHere = page.locator('a, button', { hasText: /open here/i }).first();
  if (await openHere.isVisible().catch(() => false)) {
    await openHere.click().catch(() => {});
    await page.waitForTimeout(3000);
  }
}

async function waitForCanvas(page, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.locator('canvas').first().isVisible().catch(() => false)) return true;
    const openHere = page.locator('a, button', { hasText: /open here/i }).first();
    if (await openHere.isVisible().catch(() => false)) await openHere.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  return false;
}

function urlNodeId(page) {
  const m = page.url().match(/node-id=([0-9]+)[-:]([0-9]+)/);
  return m ? `${m[1]}:${m[2]}` : null;
}

async function tabCycleCapture(page, dir, onProgress) {
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter'); // drill into first child
  await page.waitForTimeout(900);

  const seen = new Set();
  const frames = [];
  for (let i = 0; i < 60; i++) {
    const nodeId = urlNodeId(page);
    if (!nodeId || seen.has(nodeId)) break;
    seen.add(nodeId);
    await page.keyboard.press('Shift+2');
    await page.waitForTimeout(900);
    const raw = await canvas.screenshot();
    const pngPath = path.join(dir, `${String(frames.length + 1).padStart(2, '0')}-${safe(nodeId)}.png`);
    await extractCenterBand(raw, pngPath);
    frames.push({ index: frames.length, name: `Screen ${frames.length + 1}`, nodeId, pngPath });
    onProgress(`Captured frame ${frames.length} (${nodeId})`);
    await page.keyboard.press('Tab'); // next sibling
    await page.waitForTimeout(700);
  }
  return frames;
}

// After Shift+2 the selected frame fills the viewport center but neighbors peek
// in from the sides. Split by background columns and keep the band containing
// the horizontal center.
async function extractCenterBand(rawPng, outPath) {
  const trimmed = await sharp(rawPng).trim({ threshold: 12 }).toBuffer();
  const { width, height } = await sharp(trimmed).metadata();
  const bands = await inkBands(trimmed, width, height);
  const center = width / 2;
  const band = bands.find(([l, r]) => l <= center && center <= r);
  if (band && band[1] - band[0] > width * 0.1) {
    await sharp(trimmed).extract({ left: band[0], top: 0, width: band[1] - band[0], height }).toFile(outPath);
  } else {
    await fs.writeFile(outPath, trimmed);
  }
  return outPath;
}

async function inkBands(buf, width, height) {
  const px = await sharp(buf).grayscale().raw().toBuffer();
  const bg = px[0];
  const colHasInk = new Array(width).fill(false);
  for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) {
    if (Math.abs(px[y * width + x] - bg) > 20) { colHasInk[x] = true; break; }
  }
  const bands = [];
  let start = null;
  for (let x = 0; x <= width; x++) {
    if (x < width && colHasInk[x]) { if (start === null) start = x; }
    else if (start !== null) { if (x - start > 8) bands.push([start, x]); start = null; }
  }
  return bands;
}

async function sectionSplit(overviewPath, dir) {
  const buf = await fs.readFile(overviewPath);
  const { width, height } = await sharp(buf).metadata();
  const bands = (await inkBands(buf, width, height)).filter(([l, r]) => r - l > width * 0.02);
  const frames = [];
  for (let i = 0; i < bands.length; i++) {
    const [l, r] = bands[i];
    const pngPath = path.join(dir, `${String(i + 1).padStart(2, '0')}-band.png`);
    await sharp(buf).extract({ left: l, top: 0, width: r - l, height }).toFile(pngPath);
    frames.push({ index: i, name: `Screen ${i + 1}`, nodeId: null, pngPath });
  }
  return frames;
}

// Storyboard order = canvas left-to-right. Match each captured frame to its
// column in the section overview via pixel diff and sort by column position.
export async function orderByOverview(frames, overviewPath, onProgress = () => {}) {
  if (frames.length < 2) return frames;
  try {
    const buf = await fs.readFile(overviewPath);
    const { width, height } = await sharp(buf).metadata();
    const bands = (await inkBands(buf, width, height)).filter(([l, r]) => r - l > width * 0.02);
    if (bands.length < 2) return frames;
    const bandPx = [];
    for (const [l, r] of bands) {
      bandPx.push(await grayPixels(await sharp(buf).extract({ left: l, top: 0, width: r - l, height }).png().toBuffer()));
    }
    const placed = [];
    for (const f of frames) {
      const fp = await grayPixels(f.pngPath);
      let best = 0, bestDiff = Infinity;
      for (let b = 0; b < bandPx.length; b++) {
        const d = pixelDiff(fp, bandPx[b]);
        if (d < bestDiff) { bestDiff = d; best = b; }
      }
      placed.push({ ...f, band: best });
    }
    const distinct = new Set(placed.map(p => p.band));
    if (distinct.size < frames.length * 0.7) {
      onProgress('Overview ordering ambiguous — keeping capture order');
      return frames;
    }
    placed.sort((a, b) => a.band - b.band || a.index - b.index);
    return placed.map((f, i) => ({ index: i, name: `Screen ${String(i + 1).padStart(2, '0')}`, nodeId: f.nodeId, pngPath: f.pngPath }));
  } catch {
    return frames;
  }
}

async function debugDump(page, runDir) {
  try {
    await page.screenshot({ path: path.join(runDir, 'figma-debug.png'), fullPage: false });
    const text = await page.locator('body').innerText().catch(() => '');
    await fs.writeFile(path.join(runDir, 'figma-debug.txt'),
      `URL: ${page.url()}\n\nBODY TEXT (first 2000 chars):\n${text.slice(0, 2000)}`);
  } catch { /* best effort */ }
}
