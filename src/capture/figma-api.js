import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFigmaUrl } from '../parse.js';

const API = 'https://api.figma.com/v1';

// Capture via the official Figma REST API (requires FIGMA_TOKEN in .env).
// Far more reliable than headless browsing: exact frame names, true canvas
// x-positions (= storyboard order), and clean server-side PNG renders.
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

  // Storyboards use "::::" frames as separators, but clients also leave REAL
  // screens named ":::" — and dropping a real screen is invisible to the
  // producer, while an extra one is a single click to dismiss. So only treat a
  // punctuation-only name as decoration when the frame is small or empty.
  const isAnnotation = n => /^[:.\s]+$/.test(n.name ?? '')
    && ((n.absoluteBoundingBox?.height ?? 0) < 500 || !(n.children?.length));
  const containers = ['FRAME', 'COMPONENT', 'INSTANCE', 'SECTION', 'GROUP'];
  const visible = n => containers.includes(n.type) && !isAnnotation(n) && n.absoluteBoundingBox?.height > 100;
  // A demo screen can be mobile (portrait ~393x852) or desktop (landscape ~1440x1024+).
  // Screens are the LARGE frames; headers/labels/VO boxes are short (<500px) and
  // storyboard strips are ultra-wide.
  const isScreen = n => n.absoluteBoundingBox.height >= 500 && n.absoluteBoundingBox.width / n.absoluteBoundingBox.height <= 3;
  const isStrip = n => !isScreen(n) && n.absoluteBoundingBox.width > n.absoluteBoundingBox.height * 2; // ultra-wide = storyboard strip

  // The pasted link may point at the storyboard strip itself (phone frames as
  // direct children, possibly alongside header/label frames) or one level above
  // it (a page holding one strip per demo). If 2+ phone-shaped frames are right
  // here, use them; only otherwise descend into a single storyboard strip.
  let children = (root.children ?? []).filter(visible);
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
      children = (host.children ?? []).filter(visible);
    } else if (strips.length > 1) {
      throw new Error('FIGMA_AMBIGUOUS: ' + strips.map(s => s.name).join(' | '));
    }
  }

  // Screens may be nested inside groups/wrapper frames (clients paste new
  // screens into groups). Recurse into non-screen containers, but never into
  // a screen itself (its inner frames are UI parts, not separate screens).
  const collectScreens = (nodes, depth = 0, out = []) => {
    for (const n of nodes) {
      if (!containers.includes(n.type) || isAnnotation(n) || !n.absoluteBoundingBox) continue;
      // Washed-out screens (opacity < 90%) are the client's way of marking
      // them "out" — skip them and everything inside them.
      if ((n.opacity ?? 1) < 0.9 || n.visible === false) continue;
      if (isScreen(n)) out.push(n);
      else if (depth < 2 && n.children?.length && !isStrip(n)) collectScreens(n.children, depth + 1, out);
    }
    return out;
  };
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
      for (const n of collectScreens((hostPage?.children ?? []).filter(v => v.id !== host.id && visible(v)))) {
        if (!seen.has(n.id) && centerInside(n.absoluteBoundingBox)) {
          onProgress(`Found loose screen on storyboard: ${n.name}`);
          frames.push(n);
          seen.add(n.id);
        }
      }
    } catch (e) {
      onProgress(`Loose-screen sweep skipped: ${e.message}`);
    }
  }

  frames = frames.sort((a, b) => a.absoluteBoundingBox.x - b.absoluteBoundingBox.x);
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
