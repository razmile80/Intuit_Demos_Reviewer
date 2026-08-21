import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFigmaUrl } from '../parse.js';

const API = 'https://api.figma.com/v1';

// Storyboards use "::::" frames as separators, but clients also leave REAL
// screens named ":::" — and dropping a real screen is invisible to the
// producer, while an extra one is a single click to dismiss. So only treat a
// punctuation-only name as decoration when the frame is small or empty.
export const isAnnotation = n => /^[:.\s]+$/.test(n.name ?? '')
  && ((n.absoluteBoundingBox?.height ?? 0) < 500 || !(n.children?.length));
export const CONTAINER_TYPES = ['FRAME', 'COMPONENT', 'INSTANCE', 'SECTION', 'GROUP'];
export const isVisibleContainer = n => CONTAINER_TYPES.includes(n.type) && !isAnnotation(n) && n.absoluteBoundingBox?.height > 100;
// A demo screen can be mobile (portrait ~393x852) or desktop (landscape ~1440x1024+).
// Screens are the LARGE frames; headers/labels/VO boxes are short (<500px) and
// storyboard strips are ultra-wide.
export const isScreen = n => n.absoluteBoundingBox.height >= 500 && n.absoluteBoundingBox.width / n.absoluteBoundingBox.height <= 3;
export const isStrip = n => !isScreen(n) && n.absoluteBoundingBox.width > n.absoluteBoundingBox.height * 2; // ultra-wide = storyboard strip

// Reading order for a set of SIBLING nodes: rows top-to-bottom, each row
// left-to-right — the layout clients use when a storyboard is broken into
// several named sections stacked vertically, each itself a horizontal strip
// (e.g. "Business Health" / "Benchmarking" / "Pre-Qualified Line of Credit",
// each its own row of screens). Two nodes share a row when their vertical
// extents overlap by more than half the shorter one's height. That overlap
// test isn't transitive once rows have different heights (A~B and B~C same
// row doesn't guarantee A~C), so a plain (y, x) Array.sort comparator can't
// be trusted — rows are built by an explicit sweep instead: sort by top
// edge, then greedily bucket each node into the last row if it still
// overlaps, otherwise start a new row.
export function readingOrder(nodes) {
  const sorted = [...nodes].sort((a, b) => a.absoluteBoundingBox.y - b.absoluteBoundingBox.y);
  const rows = [];
  for (const n of sorted) {
    const { y, height } = n.absoluteBoundingBox;
    const bottom = y + height;
    const row = rows[rows.length - 1];
    const overlap = row ? Math.min(row.bottom, bottom) - Math.max(row.top, y) : -Infinity;
    if (row && overlap > 0.5 * Math.min(row.minHeight, height)) {
      row.items.push(n);
      row.top = Math.min(row.top, y);
      row.bottom = Math.max(row.bottom, bottom);
      row.minHeight = Math.min(row.minHeight, height);
    } else {
      rows.push({ items: [n], top: y, bottom, minHeight: height });
    }
  }
  return rows.flatMap(row => row.items.sort((a, b) => a.absoluteBoundingBox.x - b.absoluteBoundingBox.x));
}

// Screens may be nested inside groups/wrapper frames (clients paste new
// screens into groups, or split a storyboard into named sections). Recurse
// into non-screen containers, but never into a screen itself (its inner
// frames are UI parts, not separate screens).
//
// Reading order is applied to each container's children BEFORE recursing,
// so a named section's boundary is never crossed by the row-clustering: a
// section's own screens are fully resolved, in order, as one contiguous
// block before its sibling section is even looked at. Geometry only ever
// clusters rows *within* one container — it can't merge or interleave two
// different sections' screens, no matter how their y-ranges compare.
export function collectScreens(nodes, depth = 0, out = []) {
  const candidates = nodes.filter(n => CONTAINER_TYPES.includes(n.type) && !isAnnotation(n) && n.absoluteBoundingBox);
  for (const n of readingOrder(candidates)) {
    // Washed-out screens (opacity < 90%) are the client's way of marking
    // them "out" — skip them and everything inside them.
    if ((n.opacity ?? 1) < 0.9 || n.visible === false) continue;
    // Once a node is screen-shaped it IS the screen — never look inside it.
    // Every real 1440x900 desktop screen is full of children that are
    // themselves "screen-shaped" under any size/ratio test: a 69x834 icon
    // rail, a 1360x1279 content column, a 1736x1046 background texture
    // bleeding past the frame edge. Descending into a screen on the strength
    // of its children — an earlier attempt at recognising section wrappers —
    // turned one storyboard's 17 real screens into 46 fragments named
    // "texture", "Background" and "Group 2147237080". Shape alone genuinely
    // cannot tell a wrapper-of-screens from a screen-full-of-panels, so
    // trust whichever node matches first and stop there. A wrapper that does
    // hold screens is therefore rendered fused (visibly wrong, one glance to
    // spot) rather than exploded into parts (silently wrong, 46 rows deep).
    if (isScreen(n)) out.push(n);
    else if (depth < 2 && n.children?.length && !isStrip(n)) collectScreens(n.children, depth + 1, out);
  }
  return out;
}

// The page-wide "loose screen" sweep (below) finds screens Figma never made
// children of the storyboard host — they need to be merged into the already
// section-ordered `ordered` list without disturbing any section's boundary.
// Appending them and re-sorting the whole thing by x is exactly what breaks
// a multi-section storyboard (that's the bug being fixed here), so instead:
// find the row `extra` visually belongs to (by the same vertical-overlap
// test as readingOrder) and splice it in at the right x position within
// that row; if it overlaps no existing row, splice it in before the first
// row that sits below it, preserving top-to-bottom section order.
export function insertLooseScreen(ordered, extra) {
  const { y, height } = extra.absoluteBoundingBox;
  const bottom = y + height;
  let rowStart = -1, rowEnd = -1;
  for (let i = 0; i < ordered.length; i++) {
    const b = ordered[i].absoluteBoundingBox;
    const overlap = Math.min(bottom, b.y + b.height) - Math.max(y, b.y);
    if (overlap > 0.5 * Math.min(height, b.height)) {
      if (rowStart === -1) rowStart = i;
      rowEnd = i;
    } else if (rowStart !== -1) {
      break; // a row is a contiguous run in `ordered` — stop once it ends
    }
  }
  if (rowStart === -1) {
    const idx = ordered.findIndex(n => n.absoluteBoundingBox.y > y);
    ordered.splice(idx === -1 ? ordered.length : idx, 0, extra);
    return ordered;
  }
  let j = rowStart;
  while (j <= rowEnd && ordered[j].absoluteBoundingBox.x < extra.absoluteBoundingBox.x) j++;
  ordered.splice(j, 0, extra);
  return ordered;
}

// Capture via the official Figma REST API (requires FIGMA_TOKEN in .env).
// Far more reliable than headless browsing: exact frame names, true canvas
// positions (= storyboard reading order), and clean server-side PNG renders.
export async function captureFigmaFramesApi(url, runDir, onProgress = () => {}) {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const token = process.env.FIGMA_TOKEN;
  const headers = { 'X-Figma-Token': token };
  const dir = path.join(runDir, 'figma');
  await fs.mkdir(dir, { recursive: true });

  onProgress('Reading file structure from Figma API…');
  let root;
  if (nodeId) {
    const r = await api(`${API}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=3`, headers);
    root = r.nodes[nodeId]?.document;
    if (!root) throw new Error('FIGMA_NODE_NOT_FOUND');
  } else {
    const r = await api(`${API}/files/${fileKey}?depth=3`, headers);
    root = r.document.children[0]; // first page
  }

  // The pasted link may point at the storyboard strip itself (phone frames as
  // direct children, possibly alongside header/label frames) or one level above
  // it (a page holding one strip per demo). If 2+ phone-shaped frames are right
  // here, use them; only otherwise descend into a single storyboard strip.
  let children = (root.children ?? []).filter(isVisibleContainer);
  let host = root; // the storyboard node whose canvas area defines the demo
  // Descend only when the link points at a PAGE (which may hold one strip per
  // demo). A direct link to a storyboard frame IS the host, even when its
  // screens are loose page siblings — the sweep below finds them by position.
  if (root.type === 'CANVAS' && children.filter(isScreen).length < 2) {
    const strips = children.filter(isStrip);
    if (strips.length === 1) {
      onProgress(`Descending into "${strips[0].name}"…`);
      const r = await api(`${API}/files/${fileKey}/nodes?ids=${encodeURIComponent(strips[0].id)}&depth=3`, headers);
      host = r.nodes[strips[0].id]?.document ?? strips[0];
      children = (host.children ?? []).filter(isVisibleContainer);
    } else if (strips.length > 1) {
      throw new Error('FIGMA_AMBIGUOUS: ' + strips.map(s => s.name).join(' | '));
    }
  }

  let frames = collectScreens(children);

  // Clients often drop NEW screens visually onto the storyboard without them
  // becoming children of the strip frame (they land as loose page siblings or
  // stray groups). Sweep the whole page for screens whose center sits inside
  // the storyboard's canvas area and merge them in.
  const hostBox = host.absoluteBoundingBox;
  if (hostBox) {
    try {
      // Fully inside the storyboard (small slack): overlapping frames from
      // NEIGHBORING demos have centers inside but poke far out of bounds.
      const mx = hostBox.width * 0.02, my = hostBox.height * 0.02;
      const centerInside = b => b && b.x >= hostBox.x - mx && b.x + b.width <= hostBox.x + hostBox.width + mx
        && b.y >= hostBox.y - my && b.y + b.height <= hostBox.y + hostBox.height + my;
      const file = await api(`${API}/files/${fileKey}?depth=3`, headers);
      // Every Figma PAGE has its own coordinate space — sweep ONLY the page
      // that contains the storyboard, or frames from unrelated pages that
      // happen to share coordinates get scooped up.
      const containsHost = n => n.id === host.id || (n.children ?? []).some(containsHost);
      const hostPage = (file.document.children ?? []).find(containsHost);
      const seen = new Set(frames.map(f => f.id));
      for (const n of collectScreens((hostPage?.children ?? []).filter(v => v.id !== host.id && isVisibleContainer(v)))) {
        if (!seen.has(n.id) && centerInside(n.absoluteBoundingBox)) {
          onProgress(`Found loose screen on storyboard: ${n.name}`);
          insertLooseScreen(frames, n);
          seen.add(n.id);
        }
      }
    } catch (e) {
      onProgress(`Loose-screen sweep skipped: ${e.message}`);
    }
  }

  if (frames.length === 0) throw new Error('FIGMA_NO_FRAMES');

  // Duplicate frame names (clients leave screens named "--" or "Frame 123")
  // break everything keyed by name: anchors, dismissals, scripts. Suffix
  // duplicates by storyboard position so each screen keys uniquely.
  const counts = new Map();
  for (const f of frames) {
    const base = (f.name ?? 'screen').trim() || 'screen';
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    f.name = n === 1 ? base : `${base} (${n})`;
  }
  onProgress(`Found ${frames.length} frames, rendering…`);

  const out = [];
  const BATCH = 8;
  for (let i = 0; i < frames.length; i += BATCH) {
    const batch = frames.slice(i, i + BATCH);
    const ids = batch.map(f => f.id).join(',');
    const r = await api(`${API}/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=png&scale=2`, headers);
    for (const f of batch) {
      const imgUrl = r.images[f.id];
      if (!imgUrl) { onProgress(`No render for ${f.name} — skipping`); continue; }
      const png = Buffer.from(await (await fetch(imgUrl)).arrayBuffer());
      const pngPath = path.join(dir, `${String(out.length + 1).padStart(2, '0')}-${safe(f.name)}.png`);
      await fs.writeFile(pngPath, png);
      out.push({ index: out.length, name: f.name, nodeId: f.id, pngPath });
      onProgress(`Rendered ${out.length}/${frames.length}: ${f.name}`);
    }
  }
  if (out.length === 0) throw new Error('FIGMA_NO_FRAMES');
  return out;
}

const safe = s => (s ?? '').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60) || 'screen';

// Figma's API throws transient 5xx errors, especially on large files during
// busy hours — retry with backoff before giving up. 429s honor Retry-After.
async function api(url, headers, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 403) throw new Error('FIGMA_TOKEN_INVALID');
    if (res.status === 404) throw new Error('FIGMA_NODE_NOT_FOUND');
    if (res.ok) return res.json();
    if (attempt >= tries) throw new Error(`FIGMA_API_${res.status}`);
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    await new Promise(r => setTimeout(r, Math.max(retryAfter * 1000, 1500 * attempt)));
  }
}
