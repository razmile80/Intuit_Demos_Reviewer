import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

export const MODEL = 'claude-sonnet-5';

const SYSTEM = `You are a meticulous content-QA reviewer for animated product demos.
You compare an approved Figma design screen (image 1) with a frame captured from the animated video (image 2).
ONLY the content inside the phone screen matters: text copy (exact wording, numbers, prices), layout structure, element presence, and colors.
IGNORE completely: zoom level, cropping caused by zoom framing, device frame/chrome, status bar, background outside the phone, motion blur at edges, video compression artifacts, minor anti-aliasing.
The video intentionally zooms in on portions of the screen. When the video frame is a zoomed view, compare ONLY the content visible in the frame against the corresponding region of the Figma design. NEVER report elements as missing when they are merely outside the zoomed framing (e.g. status bar, header, nav icons, bottom bar).
SCROLLING PAGES: the Figma design often shows the FULL page, while the video frame shows only the browser/app viewport at one scroll position. First locate which region of the Figma design the frame corresponds to, then compare ONLY that region. Content that sits above or below the visible scroll window is NOT missing. The pair is a "match" when everything visible in the frame matches its corresponding Figma region 1:1.
Verdict rules:
- "match": every piece of content visible in the video frame matches the Figma design (wording, numbers, option labels, selected states, colors of UI elements).
- "mismatch": some visible content genuinely differs (different wording, different numbers, different options, different card, different colors).
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
      await toImageBlock(screen.pngPath),
      await toImageBlock(candidate.frame.croppedPath ?? candidate.frame.pngPath),
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
