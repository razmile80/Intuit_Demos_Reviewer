import sharp from 'sharp';

async function gray(input, w, h) {
  return sharp(input).resize(w, h, { fit: 'fill' }).grayscale().raw().toBuffer();
}

export async function dhash(input, size = 8) {
  const px = await gray(input, size + 1, size);
  let bits = 0n;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    bits = (bits << 1n) | (px[y * (size + 1) + x] > px[y * (size + 1) + x + 1] ? 1n : 0n);
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
  return bins.map(v => v / total / 3); // three channels, identical-image intersection sums to 1
}

export function histSimilarity(h1, h2) {
  let s = 0;
  for (let i = 0; i < h1.length; i++) s += Math.min(h1[i], h2[i]);
  return s;
}

export async function similarity(a, b) {
  // 16x16 dhash (256-bit): same-layout screens with different text still differ measurably
  const [ha, hb, ga, gb] = await Promise.all([dhash(a, 16), dhash(b, 16), histogram(a), histogram(b)]);
  return 0.6 * (1 - hamming(ha, hb) / 256) + 0.4 * histSimilarity(ga, gb);
}

export async function grayPixels(input, size = 128) {
  return gray(input, size, size);
}

export function pixelDiff(pxA, pxB, threshold = 12) {
  let changed = 0;
  for (let i = 0; i < pxA.length; i++) if (Math.abs(pxA[i] - pxB[i]) > threshold) changed++;
  return changed / pxA.length;
}

// Mean-luminance profile per row (or per column when axis = 'col') of a
// square grayscale pixel buffer. Used to detect scroll/pan between frames:
// scrolling shifts the row profile, panning shifts the column profile.
export function luminanceProfile(px, size = 128, axis = 'row') {
  const out = new Array(size).fill(0);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    out[axis === 'row' ? y : x] += px[y * size + x];
  }
  return out.map(v => v / size);
}

// Finds the shift that best aligns profile b onto profile a.
// Returns { shift, residual, baseline } where residual is the mean abs
// difference at the best shift and baseline the difference at shift 0.
export function bestProfileShift(a, b, maxShift = 64) {
  const n = a.length;
  let best = { shift: 0, residual: Infinity };
  for (let s = -maxShift; s <= maxShift; s++) {
    let sum = 0, count = 0;
    for (let i = 0; i < n; i++) {
      const j = i + s;
      if (j < 0 || j >= n) continue;
      sum += Math.abs(a[i] - b[j]);
      count++;
    }
    if (count < n / 2) continue;
    const r = sum / count;
    if (r < best.residual) best = { shift: s, residual: r };
  }
  let base = 0;
  for (let i = 0; i < n; i++) base += Math.abs(a[i] - b[i]);
  return { ...best, baseline: base / n };
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
