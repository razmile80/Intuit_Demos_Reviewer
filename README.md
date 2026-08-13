# Figma ↔ Video QA

Compares Figma storyboard screens against a Frame.io demo video and reports, per screen, whether the content matches 1:1 — copy, layout, colors. Zooms, pans, and animation style are ignored; only what's inside the phone screen counts.

## Setup (one time)

```bash
npm install
npx playwright install chromium
```

Put your keys in `.env` at the project root:

```
ANTHROPIC_API_KEY=sk-ant-…
FIGMA_TOKEN=figd_…
```

**FIGMA_TOKEN is required in practice.** Figma's bot protection blocks headless browsers, and client files usually aren't public anyway. Create a token at figma.com → your avatar → Settings → Security → Personal access tokens (read-only "File content" scope is enough). The API path also gives exact frame names and true storyboard order.

ffmpeg: the bundled `ffmpeg-static` is used automatically; if you have ffmpeg installed (`brew install ffmpeg`), the system one is preferred.

## Run

```bash
npm start
```

Open http://localhost:3000, paste:

1. the Figma storyboard link (link sharing must be on: "Anyone with the link → can view"),
2. the Frame.io share link,

hit **Compare**. Progress streams live; the result is a filmstrip — Figma screens on top, matched video frames below, Match/Mismatch under each column. Click a column to see the pair enlarged with the judge's list of differences.

- A standalone copy of every report is saved to `reports/<run-id>.html` (shareable, images embedded).
- All captured images are kept in `runs/<run-id>/` for auditing.
- If Frame.io stream sniffing fails, the UI offers a manual .mp4 upload.

## How it works

1. **Figma capture** — the Figma REST API lists the storyboard section's frames (sorted by canvas x = storyboard order) and renders each as PNG at 2x. (A headless-browser fallback exists for token-less use, but Figma's bot protection usually blocks it.)
2. **Video capture** — sniffs the HLS stream from the Frame.io share page, downloads it, samples at 2 fps, dedupes to distinct screen states via pixel-diff (survives slow zooms; a text-only change counts as distinct).
3. **Pairing** — a numbered contact sheet of all distinct video frames goes to Claude vision with each Figma screen: "which frame shows this screen?" Perceptual similarity provides fallback candidates.
4. **Judging** — Claude vision compares each pair at full resolution: match / mismatch with concrete differences ("Price shows $99 in Figma but $89 in video"). Zoomed views compare only the visible region; transition blurs are skipped.
5. **Findings** — per-screen verdicts, missing screens, extra video screens, and storyboard-order violations.

## Tests

```bash
npm test
```

## Smoke scripts (real links)

```bash
node scripts/smoke-figma.js "<figma-url>"     # capture only
node scripts/smoke-video.js "<frameio-url>"   # download + frame extraction only
```
