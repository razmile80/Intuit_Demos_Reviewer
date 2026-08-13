export function parseFigmaUrl(url) {
  const m = url.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('Not a Figma design link');
  const n = url.match(/node-id=([0-9]+)[-:]([0-9]+)/);
  return { fileKey: m[1], nodeId: n ? `${n[1]}:${n[2]}` : null };
}

export function parseDropboxUrl(url) {
  if (!/^https?:\/\/(www\.)?dropbox\.com\/(s|sh|scl\/fi)\//.test(url)) throw new Error('Not a Dropbox link');
  const u = new URL(url);
  u.searchParams.set('dl', '1'); // share link → direct download
  const filename = decodeURIComponent(u.pathname.split('/').pop() ?? '').replace(/\.(mp4|mov)$/i, '');
  return { directUrl: u.toString(), filename: filename || null };
}

export function isDropboxUrl(url) {
  try { parseDropboxUrl(url); return true; } catch { return false; }
}

export function parseFrameioUrl(url) {
  const m = url.match(/frame\.io\/share\/([0-9a-f-]{36})(?:\/view\/([0-9a-f-]{36}))?/);
  if (m) return { shareId: m[1], assetId: m[2] ?? null };
  const short = url.match(/^https?:\/\/f\.io\/([A-Za-z0-9_-]+)\/?$/);
  if (short) return { shareId: short[1], assetId: null, short: true }; // f.io redirects to the full share URL
  throw new Error('Not a Frame.io share link');
}
