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

// Which screens are genuinely out of place, given the storyboard order they
// come in and the video moment each one matched?
//
// The obvious scan — walk the list, remember the latest timestamp seen, flag
// anything that goes backwards — blames the WRONG screens. One screen paired
// to a much later moment drags the running maximum forward with it, so every
// correctly-ordered screen that follows looks like a jump backwards: a single
// bad pairing smears "out of order" across all its innocent neighbours, and
// the producer is asked to dismiss screens that were never the problem while
// the actual culprit sits there unflagged.
//
// So instead of a running maximum, find the longest run of screens that DO
// read in order and treat only the screens left out of it as violations. One
// displaced screen among twenty tidy ones then reports exactly one violation
// — the displaced screen — instead of everything downstream of it.
//
// O(n²) over screens (tens per demo, so irrelevant). Note the tolerance
// comparison is not transitive, which is why this is a longest-chain DP and
// not a textbook longest-increasing-subsequence: what's guaranteed is that
// each CONSECUTIVE pair in the chain reads in order, which is exactly what
// "these screens play in storyboard order" means here.
export function findOrderViolations(items, { tolerance = ORDER_TOLERANCE } = {}) {
  const n = items.length;
  if (n < 2) return [];
  const readsInOrder = (prev, next) => next.timestamp >= prev.timestamp - tolerance;
  const len = new Array(n).fill(1), parent = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (readsInOrder(items[j], items[i]) && len[j] + 1 > len[i]) { len[i] = len[j] + 1; parent[i] = j; }
    }
  }
  // Anchor on the FIRST index achieving the longest run: when a two-screen
  // demo jumps backwards, the second screen is the odd one out, not the first.
  let end = 0;
  for (let i = 1; i < n; i++) if (len[i] > len[end]) end = i;
  const inOrder = new Set();
  for (let i = end; i !== -1; i = parent[i]) inOrder.add(i);

  const violations = [];
  for (let i = 0; i < n; i++) {
    if (inOrder.has(i)) continue;
    // Report the last in-order screen before this one as what it should have
    // followed — that's the pairing a producer compares it against.
    let prev = -1;
    for (let j = i - 1; j >= 0; j--) if (inOrder.has(j)) { prev = j; break; }
    violations.push({
      screenName: items[i].name,
      timestamp: items[i].timestamp,
      prevTimestamp: prev === -1 ? null : items[prev].timestamp,
    });
  }
  return violations;
}

export function sequenceCheck(judged, opts) {
  const items = judged
    .filter(j => j.matchedFrame && j.matchedFrame.timestamp != null)
    .map(j => ({ name: j.screen.name, timestamp: j.matchedFrame.timestamp }));
  const violations = findOrderViolations(items, opts);
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
