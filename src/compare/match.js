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

// Screens matched a moment or two "early" are pairing noise (two screens can
// legitimately land on the same beat), not a re-edited storyboard. Only a
// meaningful jump backwards counts as a real order problem.
export const ORDER_TOLERANCE = 3;
export function sequenceCheck(judged, { tolerance = ORDER_TOLERANCE } = {}) {
  const violations = [];
  let prev = -Infinity;
  for (const { screen, matchedFrame } of judged) {
    if (!matchedFrame) continue;
    if (matchedFrame.timestamp < prev - tolerance) {
      violations.push({ screenName: screen.name, timestamp: matchedFrame.timestamp, prevTimestamp: prev });
    }
    prev = Math.max(prev, matchedFrame.timestamp);
  }
  return { ok: violations.length === 0, violations };
}

// A frame is "extra" when it sits nowhere near any screen's matched moment —
// scroll/zoom frames around a matched timestamp are part of that screen's beat.
// Collapse consecutive extras that show the same shot: the sampler keeps a
// frame per beat, so one held shot (a card reveal, a loading screen) can yield
// several near-identical extras. Keep one representative per shot.
export async function dedupeExtras(extras, { maxGap = 6, sameShot = 0.04 } = {}) {
  const { grayPixels, pixelDiff } = await import('../imghash.js');
  const out = [];
  let lastPx = null, lastT = -Infinity;
  for (const f of extras) {
    let px = null;
    try { px = await grayPixels(f.croppedPath ?? f.pngPath); } catch { /* unreadable frame */ }
    const sameAsPrevious = px && lastPx && f.timestamp - lastT <= maxGap && pixelDiff(px, lastPx) <= sameShot;
    if (!sameAsPrevious) out.push(f);
    lastPx = px ?? lastPx;
    lastT = f.timestamp;
  }
  return out;
}

export function findExtras(videoFrames, judged, { slack = 5 } = {}) {
  const matchedTs = judged.filter(j => j.matchedFrame).map(j => j.matchedFrame.timestamp);
  return videoFrames.filter(f => !matchedTs.some(t => Math.abs(t - f.timestamp) <= slack));
}
