import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

export const MODEL = 'claude-sonnet-5';

const SYSTEM = `You are a meticulous content-QA reviewer for animated product demos.
You compare an approved Figma design screen (image 1) with a frame captured from the animated video (image 2).
ONLY the content inside the phone screen matters: text copy (exact wording, numbers, prices), layout structure, element presence, and colors.
IGNORE completely: zoom level, cropping caused by zoom framing, device frame/chrome, status bar, background outside the phone, motion blur at edges, video compression artifacts, minor anti-aliasing.
IGNORE TRANSIENT INTERACTION STATES. The video captures a live demo, so a button or control may be caught mid-interaction: pressed/active/hover highlight, focus ring, ripple, a cursor or tap indicator, a menu mid-open, a partially played animation. These are momentary states of the SAME element, not content changes — never report them. Only report a control if its LABEL, position, or presence differs.
The video intentionally zooms in on portions of the screen. When the video frame is a zoomed view, compare ONLY the content visible in the frame against the corresponding region of the Figma design. NEVER report elements as missing when they are merely outside the zoomed framing (e.g. status bar, header, nav icons, bottom bar).
SCROLLING PAGES: the Figma design often shows the FULL page, while the video frame shows only the browser/app viewport at one scroll position. First locate which region of the Figma design the frame corresponds to, then compare ONLY that region. Content that sits above or below the visible scroll window is NOT missing. The pair is a "match" when everything visible in the frame matches its corresponding Figma region 1:1.
ILLUSTRATIONS, ICONS AND IMAGES ARE CONTENT. A redrawn, mirrored/flipped, recolored, resized or recomposed illustration is a MISMATCH even when every surrounding word is identical. Compare artwork element by element: orientation (which way does a character/object face?), key shapes, added or removed details, colors.
INPUT FIELDS AND SEARCH BARS: placeholder or label text present in one image and absent in the other is a MISMATCH (an empty bar vs a bar reading "Ask anything" differ). Check the contents of every field, bar and pill.
METHOD — do this before answering: sweep the visible screen region by region (top/search bar → each card → each illustration → buttons → bottom nav) and verify each region individually against the design. Only answer "match" if EVERY region checks out. Being lenient about a real difference is a serious error; the producer relies on you to catch subtle edits.
Verdict rules:
- "match": every piece of content visible in the video frame matches the Figma design (wording, numbers, option labels, selected states, colors, illustrations).
- "mismatch": some visible content genuinely differs (different wording, different numbers, different options, different card, different colors, different artwork, missing placeholder text).
- "partial_screen": ONLY for frames where no meaningful comparison is possible — mid-transition blur, unreadable content, or only a sliver of the screen visible.
Respond with JSON only:
{"verdict": "match" | "mismatch" | "partial_screen", "differences": [{"text": "...", "figmaBox": {"x":0-100,"y":0-100,"w":0-100,"h":0-100}, "videoBox": {"x":0-100,"y":0-100,"w":0-100,"h":0-100}}]}
"text" must be concrete and specific, e.g. "Price shows $99 in Figma but $89 in video". Empty differences array for match.
"figmaBox"/"videoBox" locate the differing element as percentages of image 1 / image 2 respectively — make them tight around the element; omit a box if the element is not localizable (e.g. something entirely absent).`;

// Downscale before upload: the API resizes big images anyway; sending 2880px
// desktop renders just wastes upload time and tokens.
export async function toImageBlock(input, maxWidth = 1200) {
  let img = sharp(input);
  const { width } = await img.metadata();
  if (width > maxWidth) img = img.resize(maxWidth);
  const data = await img.png().toBuffer();
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } };
}

async function judgePair(client, screen, candidate) {
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 1024, system: SYSTEM,
    messages: [{ role: 'user', content: [
      await toImageBlock(screen.pngPath, 1450),
      await toImageBlock(candidate.frame.croppedPath ?? candidate.frame.pngPath, 1450),
      { type: 'text', text: `Figma screen name: "${screen.name}". Compare content 1:1.${acceptedNote(screen)}` },
    ] }],
  });
  const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
  const json = text.match(/\{[\s\S]*\}/);
  const r = JSON.parse(json ? json[0] : '{}');
  // Normalize: differences may be strings (old prompts) or {text, boxes} objects.
  r.differences = (r.differences ?? []).map(d => typeof d === 'string' ? { text: d } : d);
  return r;
}

// Differences the producer has explicitly dismissed as intentional.
export function acceptedNote(screen) {
  return screen.accepted?.length
    ? `\nThe producer reviewed and APPROVED these differences as intentional — do NOT report them or anything equivalent:\n- ${screen.accepted.map(a => a?.text ?? a).join('\n- ')}`
    : '';
}

// Deep scan: whole-screen comparison skims small artwork, so re-compare in
// overlapping horizontal bands at full resolution — fewer elements per look
// means genuine attention on each. Returns extra differences found.
// Overlapping thirds: any element sits fully inside at least one band.
const BANDS = [[0, 0.45], [0.28, 0.72], [0.55, 1]];
export async function bandSweep(client, screen, frame) {
  const sharp = (await import('sharp')).default;
  const band = async (src, [a, b]) => {
    const img = sharp(src);
    const { width, height } = await img.metadata();
    return img.extract({ left: 0, top: Math.round(height * a), width, height: Math.round(height * (b - a)) }).png().toBuffer();
  };
  const src2 = frame.croppedPath ?? frame.pngPath;
  const found = [];
  for (const [i, b] of BANDS.entries()) {
    try {
      const msg = await client.messages.create({
        model: MODEL, max_tokens: 1000,
        system: `${SYSTEM}\nYou are given a matching horizontal BAND of each screen (image 1 = design band, image 2 = video band) so you can inspect fine detail. Report only differences you can see INSIDE this band; ignore elements more than half cut off by the band edges. The two bands may be offset slightly — align them by their content, not by pixel position.`,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: (await band(screen.pngPath, b)).toString('base64') } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: (await band(src2, b)).toString('base64') } },
          { type: 'text', text: `Band ${i + 1} of ${BANDS.length} for screen "${screen.name}". Inspect artwork, icons, field placeholders and copy closely.${acceptedNote(screen)}` },
        ] }],
      });
      const text = msg.content.filter(x => x.type === 'text').map(x => x.text).join(' ');
      const json = JSON.parse((text.match(/\{[\s\S]*\}/) ?? ['{}'])[0]);
      if (json.verdict === 'mismatch') {
        for (const d of json.differences ?? []) {
          const o = typeof d === 'string' ? { text: d } : d;
          // Map band-local box coordinates back to whole-image percentages.
          const remap = box => box && box.y != null ? { ...box, y: b[0] * 100 + box.y * (b[1] - b[0]), h: (box.h ?? 2) * (b[1] - b[0]) } : box;
          found.push({ ...o, figmaBox: remap(o.figmaBox), videoBox: remap(o.videoBox), deep: true });
        }
      }
    } catch { /* a failed band shouldn't sink the screen */ }
  }
  // Bands are cut by pixel position while the two images are framed differently,
  // so a slice can make an element look "missing" when it merely sits outside
  // that slice. ABSENCE claims are therefore unreliable and get verified against
  // the full images. Detail claims (wording, artwork, colour) keep their
  // band-level sensitivity — verifying those at full-image scale would undo the
  // very perception advantage the band sweep exists to provide.
  const ABSENCE = /\b(missing|absent|not (present|shown|visible|displayed)|no longer|removed|does ?n[o']t (appear|show)|lacks)\b/i;
  const suspect = found.filter(d => ABSENCE.test(d.text ?? ''));
  if (!suspect.length) return found;
  const confirmed = await verifyClaims(client, screen, frame, suspect);
  const keep = new Set(confirmed.map(c => c.text));
  return found.filter(d => !ABSENCE.test(d.text ?? '') || keep.has(d.text));
}

async function verifyClaims(client, screen, frame, claims) {
  try {
    const msg = await client.messages.create({
      model: MODEL, max_tokens: 900,
      system: `You are verifying claimed differences between an approved design (image 1) and a video frame of the animated build (image 2).
Someone inspected narrow slices of these screens and produced the claims below. Slice-based inspection produces FALSE claims when an element sits outside the slice — especially claims that something is "missing".
For EACH claim, look at the FULL images and decide: is it TRUE of these two images?
Reject a claim if the element actually appears in both (anywhere in the image), if it is only cut off by framing/scroll/zoom, or if it describes a momentary interaction state (pressed/hover/focus).
Accept only differences you can see with certainty in both full images.
Respond with JSON only: {"verdict":[{"index":0,"real":true|false,"reason":"short"}]}`,
      messages: [{ role: 'user', content: [
        await toImageBlock(screen.pngPath, 1450),
        await toImageBlock(frame.croppedPath ?? frame.pngPath, 1450),
        { type: 'text', text: `Claims:\n${claims.map((c, i) => `${i}. ${c.text}`).join('\n')}` },
      ] }],
    });
    const text = msg.content.filter(x => x.type === 'text').map(x => x.text).join(' ');
    const json = JSON.parse((text.match(/\{[\s\S]*\}/) ?? ['{}'])[0]);
    const keep = new Set((json.verdict ?? []).filter(v => v.real).map(v => v.index));
    return claims.filter((_, i) => keep.has(i));
  } catch {
    return []; // if verification fails, prefer silence over false alarms
  }
}

async function withRetry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries - 1) throw e; await new Promise(r => setTimeout(r, 1000 * 2 ** i)); }
  }
}

export async function judgeAll(matches, { client, onProgress = () => {} } = {}) {
  client ??= new Anthropic();
  const out = [];
  for (const [i, m] of matches.entries()) {
    onProgress(`Judging ${i + 1}/${matches.length}: ${m.screen.name}`);
    if (m.candidates.length === 0) {
      out.push({ screen: m.screen, matchedFrame: null, verdict: 'not_found', differences: [] });
      continue;
    }
    // Self-healing pairing: a "mismatch" against one candidate may just be a
    // wrong pairing, so keep trying other candidates and prefer any match.
    // A genuine content error still surfaces — no candidate will match.
    let matchResult = null, firstMismatch = null, errorResult = null;
    for (const candidate of m.candidates.slice(0, 4)) {
      try {
        const r = await withRetry(() => judgePair(client, m.screen, candidate));
        if (r.verdict === 'partial_screen') continue;
        if (r.verdict === 'match') {
          matchResult = { screen: m.screen, matchedFrame: candidate.frame, verdict: 'match', differences: [] };
          break;
        }
        firstMismatch ??= { screen: m.screen, matchedFrame: candidate.frame, verdict: 'mismatch', differences: r.differences ?? [] };
      } catch (e) {
        errorResult = { screen: m.screen, matchedFrame: candidate.frame, verdict: 'error', differences: [`Judge failed: ${e.message}`] };
      }
    }
    out.push(matchResult ?? firstMismatch ?? errorResult
      ?? { screen: m.screen, matchedFrame: null, verdict: 'not_found', differences: ['No usable video frame found for this screen'] });
  }
  return out;
}
