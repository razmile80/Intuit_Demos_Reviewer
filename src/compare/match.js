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
  let prev = -Infinity;
  for (const { screen, matchedFrame } of judged) {
    if (!matchedFrame) continue;
    if (matchedFrame.timestamp < prev) {
      violations.push({ screenName: screen.name, timestamp: matchedFrame.timestamp, prevTimestamp: prev });
    }
    prev = Math.max(prev, matchedFrame.timestamp);
  }
  return { ok: violations.length === 0, violations };
}

// A frame is "extra" when it sits nowhere near any screen's matched moment —
// scroll/zoom frames around a matched timestamp are part of that screen's beat.
export function findExtras(videoFrames, judged, { slack = 5 } = {}) {
  const matchedTs = judged.filter(j => j.matchedFrame).map(j => j.matchedFrame.timestamp);
  return videoFrames.filter(f => !matchedTs.some(t => Math.abs(t - f.timestamp) <= slack));
}
