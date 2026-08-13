import { chromium } from 'playwright';
import ffmpegStatic from 'ffmpeg-static';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrameioUrl, parseDropboxUrl, isDropboxUrl } from '../parse.js';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { grayPixels, pixelDiff, luminanceProfile, bestProfileShift } from '../imghash.js';

const run = promisify(execFile);

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; }
  catch { return ffmpegStatic; }
}
export const ffmpegPath = resolveFfmpeg();

// Accepts Frame.io share links (incl. f.io short links) and Dropbox share links.
export async function downloadVideo(url, runDir, onProgress = () => {}) {
  if (isDropboxUrl(url)) return downloadDropboxVideo(url, runDir, onProgress);
  return downloadFrameioVideo(url, runDir, onProgress);
}

async function downloadDropboxVideo(url, runDir, onProgress = () => {}) {
  const { directUrl, filename } = parseDropboxUrl(url);
  await fs.mkdir(runDir, { recursive: true });
  onProgress('Downloading from Dropbox…');
  const res = await fetch(directUrl, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error('DROPBOX_DOWNLOAD_FAILED');
  const out = path.join(runDir, 'demo.mp4');
  await streamPipeline(Readable.fromWeb(res.body), createWriteStream(out));
  return { videoPath: out, title: filename };
}

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
    // Poll up to 30s for a stream request, nudging the player along the way.
    // Handles slow loads and folder-style share links (click into the asset).
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && streams.length === 0) {
      await page.waitForTimeout(1500);
      if (streams.length) break;
      const assetTile = page.locator('a[href*="/view/"]').first();
      if (await assetTile.isVisible().catch(() => false)) {
        await assetTile.click().catch(() => {});
        await page.waitForTimeout(2000);
        continue;
      }
      for (const sel of ['button[aria-label*="lay"]', '[data-testid*="play"]', 'video']) {
        const el = page.locator(sel).first();
        if (await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); break; }
      }
    }
    if (streams.length === 0) {
      onProgress(`Frame.io page: "${(await page.title().catch(() => '?')).slice(0, 80)}" — no stream request seen in 30s`);
      throw new Error('FRAMEIO_NO_STREAM');
    }

    // Prefer HLS master (ffmpeg picks the highest rendition); upgrade mp4 rendition as fallback.
    const hls = streams.find(s => s.url.includes('.m3u8'));
    let pick = hls ?? streams[streams.length - 1];
    if (!hls && /video_h264_\d+\.mp4/.test(pick.url)) {
      for (const res of [2160, 1080, 720, 540, 360]) {
        const candidate = pick.url.replace(/video_h264_\d+\.mp4/, `video_h264_${res}.mp4`);
        const ok = await fetch(candidate, { method: 'HEAD' }).then(r => r.ok).catch(() => false);
        if (ok) { pick = { ...pick, url: candidate }; break; }
      }
    }
    const rawTitle = await page.title().catch(() => '');
    // Page title is "filename.mp4 - project name" — keep the filename part.
    const title = rawTitle.split(/\s+[-|·]\s+/)[0].replace(/\.(mp4|mov)$/i, '').trim() || null;
    onProgress(`Downloading ${hls ? 'HLS stream' : 'mp4'}…`);
    const out = path.join(runDir, 'demo.mp4');
    const headerArg = Object.entries(pick.headers)
      .filter(([k]) => ['referer', 'user-agent', 'cookie', 'authorization'].includes(k.toLowerCase()))
      .map(([k, v]) => `${k}: ${v}`).join('\r\n');
    const args = ['-y'];
    if (headerArg) args.push('-headers', headerArg + '\r\n');
    args.push('-i', pick.url, '-c', 'copy', out);
    await run(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 });
    return { videoPath: out, title };
  } finally {
    await browser.close();
  }
}

// Motion-aware sampling: classify what happens between consecutive samples
// (still / scroll / pan / content change), group frames into "beats" (one beat
// = one UI state, possibly scrolled or panned through), and return one
// representative frame per beat. The full annotated timeline is written to
// <runDir>/frames.json for the reviewer UI.
export async function extractFrames(videoPath, runDir, onProgress = () => {}) {
  const dir = path.join(runDir, 'video');
  await fs.mkdir(dir, { recursive: true });
  onProgress('Extracting frames at 2fps…');
  await run(ffmpegPath, ['-y', '-i', videoPath, '-vf', 'fps=2', path.join(dir, '%05d.png')],
    { maxBuffer: 1024 * 1024 * 64 });
  const files = (await fs.readdir(dir)).filter(f => /^\d+\.png$/.test(f)).sort();
  const all = files.map(f => ({ timestamp: (parseInt(f, 10) - 1) / 2, pngPath: path.join(dir, f) }));
  if (all.length === 0) return [];

  onProgress(`Analyzing motion across ${all.length} frames…`);
  const px = [];
  for (const fr of all) px.push(await grayPixels(fr.pngPath));

  // Classify each transition between consecutive samples.
  const motions = ['start'];
  for (let i = 1; i < all.length; i++) {
    const diff = pixelDiff(px[i - 1], px[i]);
    if (diff < 0.005) { motions.push('still'); continue; }
    const v = bestProfileShift(luminanceProfile(px[i - 1], 128, 'row'), luminanceProfile(px[i], 128, 'row'));
    const h = bestProfileShift(luminanceProfile(px[i - 1], 128, 'col'), luminanceProfile(px[i], 128, 'col'));
    const cand = [
      { kind: 'scroll', ...v },
      { kind: 'pan', ...h },
    ].filter(m => Math.abs(m.shift) >= 2 && m.residual < m.baseline * 0.5);
    if (cand.length) {
      cand.sort((a, b) => a.residual - b.residual);
      motions.push(cand[0].kind);
    } else {
      motions.push('change');
    }
  }

  // Group into beats: a 'change' transition starts a new beat…
  let beats = [];
  for (let i = 0; i < all.length; i++) {
    if (i === 0 || motions[i] === 'change') beats.push([]);
    beats.at(-1).push({ ...all[i], motion: motions[i] });
  }
  // …then attach transition runs to the plateau that follows: demos animate →
  // settle → animate. Consecutive single-frame beats are mid-fade/mid-zoom
  // frames, so they merge forward into the next beat.
  const merged = [];
  let carry = [];
  for (const beat of beats) {
    if (beat.length === 1) { carry.push(...beat); continue; }
    merged.push([...carry, ...beat]);
    carry = [];
  }
  if (carry.length) {
    if (merged.length) merged.at(-1).push(...carry);
    else merged.push(carry);
  }
  beats = merged;

  // Representative per beat: the last 'still' frame (settled state) or the
  // beat's last frame. For scrolled beats also keep first + middle frames so
  // long pages keep coverage of top/middle/bottom content.
  const reps = [];
  for (let b = 0; b < beats.length; b++) {
    const beat = beats[b];
    for (const f of beat) f.beat = b;
    const lastStill = [...beat].reverse().find(f => f.motion === 'still');
    const rep = lastStill ?? beat.at(-1);
    rep.rep = true;
    reps.push(rep);
    const scrolled = beat.some(f => f.motion === 'scroll' || f.motion === 'pan');
    if (scrolled && beat.length >= 3) {
      for (const extra of [beat[0], beat[Math.floor(beat.length / 2)]]) {
        if (!extra.rep) { extra.rep = true; reps.push(extra); }
      }
    }
  }
  reps.sort((a, b) => a.timestamp - b.timestamp);

  await fs.writeFile(path.join(runDir, 'frames.json'), JSON.stringify(
    all.map((f, i) => ({ timestamp: f.timestamp, png: f.pngPath, beat: f.beat ?? 0, motion: motions[i], rep: !!f.rep })), null, 1));
  onProgress(`${beats.length} beats found, ${reps.length} representative frames kept`);
  return reps.map(({ timestamp, pngPath }) => ({ timestamp, pngPath }));
}
