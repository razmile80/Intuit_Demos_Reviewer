import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const THUMB_W = 360, THUMB_H = 640, COLS = 4;

// Builds a small numbered contact sheet of candidate frames for ONE screen.
// Kept ≤ ~1300px so the vision API doesn't downscale it into unreadability.
export async function buildMiniSheet(candidates, outPath) {
  const rows = Math.ceil(candidates.length / COLS);
  const composites = [];
  for (let i = 0; i < candidates.length; i++) {
    const x = (i % COLS) * THUMB_W, y = Math.floor(i / COLS) * THUMB_H;
    const src = candidates[i].frame.croppedPath ?? candidates[i].frame.pngPath;
    const thumb = await sharp(src).resize(THUMB_W, THUMB_H - 36, { fit: 'contain', background: '#222' }).png().toBuffer();
    composites.push({ input: thumb, left: x, top: y + 36 });
    composites.push({
      input: Buffer.from(`<svg width="${THUMB_W}" height="36"><rect width="${THUMB_W}" height="36" fill="#000"/><text x="10" y="26" font-size="24" font-family="sans-serif" fill="#fff" font-weight="bold">#${i + 1}</text></svg>`),
      left: x, top: y,
    });
  }
  await sharp({ create: { width: COLS * THUMB_W, height: rows * THUMB_H, channels: 3, background: '#222' } })
    .composite(composites).png().toFile(outPath);
  return outPath;
}

const PAIR_SYSTEM = `You are a content-QA reviewer for animated product demos. Image 1 is an approved Figma design screen. Image 2 is a numbered contact sheet of candidate video frames (#number badge top-left).
Task: (1) pick the candidate frame showing the SAME screen/page as the Figma design, then (2) judge whether its visible content matches the design 1:1.
Picking rules:
- A frame matches if it shows ANY scroll position or zoom of this page. Prefer the frame whose visible STATE (labels, badges, checkmarks, values) agrees with the design.
- Use null only if no candidate shows this page at all.
Judging rules — ONLY content matters (text copy, numbers, option labels, element states, colors):
- IGNORE zoom level, scroll position, cropping by the viewport, device chrome, background, compression artifacts.
- The design may show the FULL page while the frame shows one scroll window: compare ONLY the visible region against the corresponding design region. Content above/below the scroll window is NOT missing.
- "mismatch" only when visible content genuinely differs (different wording, numbers, states, colors).
Respond with JSON only: {"frame": <number> | null, "verdict": "match" | "mismatch", "differences": ["concrete difference with exact wording", ...]}
Empty differences array for match.`;

// One call per screen: pick + judge from the mini sheet. Screens the model
// suspects of mismatch get confirmed at full resolution by the judge.
export async function selectAndJudge(simMatches, { client, model, runDir, anchors = {}, onProgress = () => {} }) {
  const { judgeAll } = await import('./judge.js');
  const results = [];
  let lastTs = -Infinity; // temporal prior: screens follow storyboard order
  for (const [i, m] of simMatches.entries()) {
    const { screen } = m;
    // Human anchor: a reviewer pinned this screen to a timestamp — try the
    // nearest frame first. But anchors go stale when the video is re-edited,
    // so a non-match falls through to the normal full search instead of
    // giving up.
    if (anchors[screen.name] != null && m.candidates.length) {
      const target = anchors[screen.name];
      const nearest = [...m.candidates].sort((a, b) => Math.abs(a.frame.timestamp - target) - Math.abs(b.frame.timestamp - target))[0];
      onProgress(`Screen ${i + 1}/${simMatches.length}: ${screen.name} (anchored at ${target}s)`);
      const confirmed = await judgeAll([{ screen, candidates: [nearest] }], { client, onProgress: () => {} });
      if (confirmed[0].verdict === 'match') {
        lastTs = Math.max(lastTs, confirmed[0].matchedFrame.timestamp);
        results.push({ ...confirmed[0], anchored: true });
        continue;
      }
      onProgress(`Anchor at ${target}s no longer matches "${screen.name}" — searching the whole video instead`);
    }
    // Time-window shortlist: screens follow storyboard order, so only consider
    // frames at/after the previous screen's matched moment (2s slack). Within
    // that window, similarity ranking has few look-alike competitors, so the
    // true frame reliably makes the shortlist (global similarity ranking does
    // not — every scroll position of a desktop page looks alike).
    let candidates = m.candidates.filter(c => c.frame.timestamp >= lastTs - 2);
    if (candidates.length === 0) candidates = m.candidates;
    candidates = candidates.slice(0, 12);
    if (candidates.length === 0) {
      results.push({ screen, matchedFrame: null, verdict: 'not_found', differences: [] });
      continue;
    }
    onProgress(`Screen ${i + 1}/${simMatches.length}: ${screen.name}`);
    let r = {};
    try {
      const sheetPath = path.join(runDir, `sheet-${i}.png`);
      await buildMiniSheet(candidates, sheetPath);
      const msg = await client.messages.create({
        model, max_tokens: 1024, system: PAIR_SYSTEM,
        messages: [{ role: 'user', content: [
          await toImageBlock(screen.pngPath),
          await toImageBlock(sheetPath, 1400),
          { type: 'text', text: `Figma screen name: "${screen.name}". Pick and judge.${acceptedNote(screen)}` },
        ] }],
      });
      const text = msg.content.find(b => b.type === 'text')?.text ?? '';
      r = JSON.parse((text.match(/\{[\s\S]*\}/) ?? ['{}'])[0]);
    } catch (e) {
      onProgress(`Pairing failed for ${screen.name}: ${e.message}`);
    }
    const pick = r.frame >= 1 && r.frame <= candidates.length ? candidates[r.frame - 1] : null;
    if (!pick) {
      // Never trust "not found" at sheet resolution alone — confirm at full res.
      onProgress(`No pick from sheet — confirming at full resolution: ${screen.name}`);
      const confirmed = await judgeAll([{ screen, candidates: candidates.slice(0, 3) }], { client, onProgress: () => {} });
      if (confirmed[0].matchedFrame) lastTs = Math.max(lastTs, confirmed[0].matchedFrame.timestamp);
      results.push(confirmed[0]);
      continue;
    }
    if (r.verdict === 'match') {
      lastTs = Math.max(lastTs, pick.frame.timestamp);
      results.push({ screen, matchedFrame: pick.frame, verdict: 'match', differences: [] });
      continue;
    }
    // Suspected mismatch → confirm at full resolution across top candidates.
    onProgress(`Confirming possible mismatch: ${screen.name}`);
    const others = candidates.filter(c => c !== pick);
    const confirmed = await judgeAll([{ screen, candidates: [pick, ...others].slice(0, 3) }], { client, onProgress: () => {} });
    if (confirmed[0].matchedFrame) lastTs = Math.max(lastTs, confirmed[0].matchedFrame.timestamp);
    results.push(confirmed[0]);
  }
  return results;
}

const SELECT_SYSTEM = `You match an approved Figma design screen to video frames from an animated demo.
Image 1 is the Figma design. Image 2 is a numbered contact sheet of candidate video frames (#number badge top-left).
Pick the frame that shows the SAME screen state: same question/headline/card content. Prefer frames showing the complete screen over zoomed-in partial views of the same state.
For long/scrolling pages the video shows viewport-sized scroll windows: a candidate matches if it shows ANY scroll position of this Figma page. Prefer the frame showing the TOP of the page.
Rendering differences (zoom, scroll position, device chrome, background) do not matter — match on CONTENT, especially headline/question wording.
Respond with JSON only: {"frame": <number> | null}. Use null if no candidate shows this screen's content.`;

import { toImageBlock, acceptedNote } from './judge.js';

// simMatches: output of matchScreens with topK ~6. Returns matches where the
// LLM-picked candidate leads and remaining similarity candidates follow (the
// judge self-heals across them).
export async function selectFrames(simMatches, { client, model, runDir, onProgress = () => {} }) {
  const results = [];
  for (const [i, m] of simMatches.entries()) {
    const { screen, candidates } = m;
    if (candidates.length === 0) { results.push({ screen, candidates: [] }); continue; }
    onProgress(`Locating screen ${i + 1}/${simMatches.length}: ${screen.name}`);
    let pickIdx = -1;
    try {
      const sheetPath = path.join(runDir, `sheet-${i}.png`);
      await buildMiniSheet(candidates, sheetPath);
      const msg = await client.messages.create({
        model, max_tokens: 64, system: SELECT_SYSTEM,
        messages: [{ role: 'user', content: [
          await toImageBlock(screen.pngPath),
          await toImageBlock(sheetPath),
          { type: 'text', text: `Figma screen name: "${screen.name}". Which candidate matches?` },
        ] }],
      });
      const text = msg.content.find(b => b.type === 'text')?.text ?? '';
      const json = JSON.parse((text.match(/\{[\s\S]*\}/) ?? ['{}'])[0]);
      if (json.frame >= 1 && json.frame <= candidates.length) pickIdx = json.frame - 1;
    } catch (e) {
      onProgress(`Frame selection failed for ${screen.name}: ${e.message}`);
    }
    const ordered = pickIdx >= 0
      ? [candidates[pickIdx], ...candidates.filter((_, j) => j !== pickIdx)]
      : candidates;
    results.push({ screen, candidates: ordered });
  }
  return results;
}
