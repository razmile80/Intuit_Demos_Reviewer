# Figma ↔ Frame.io Content QA Tool — Design

**Date:** 2026-08-12
**Project:** Intuit Investors Reviewer
**Goal:** Automate the producer's review that verifies animated demo videos (Frame.io) show the same content as the approved UI screens (Figma), 1:1 — copy, layout, colors. Animation style, zooms, pans, and transitions are explicitly out of scope.

## Context

Workflow: client updates UI screens in Figma → animators animate them → producer reviews Figma vs Frame.io video for content parity. Demos are 8–20 screens each. Inputs are share links only (no Figma/Frame.io API tokens). Videos contain zoom-ins/outs and slides; frames showing partial screens must be skipped — only complete phone screens are compared.

## Approach (chosen: Hybrid)

Algorithmic matching pairs each Figma screen with its best video frame (cheap, fast); Claude's vision API renders the verdict and describes differences (robust). Rejected alternatives: pure-LLM on all frame pairs (more expensive, unnecessary), pure algorithmic OCR/diff (too noisy with video compression, zooms, device chrome).

## Architecture

Local web app: Node.js server + Playwright, at `http://localhost:3000`. User pastes a Figma link and a Frame.io share link, hits Compare, watches progress, gets a report.

### Components

1. **Figma capturer** (`src/capture/figma.js`)
   - Playwright opens the share link anonymously (link sharing must be enabled).
   - Enumerates frames on the target page (or uses node-ids from the pasted URL), navigates to each frame's URL, screenshots at full resolution.
   - Output: ordered list `{ index, name, nodeId, pngPath }`. Order = Figma canvas order, left→right (matches storyboard numbering 01, 02, …).
   - Error: link not publicly viewable → clear UI message asking to enable link sharing.

2. **Video capturer** (`src/capture/video.js`)
   - Playwright opens the Frame.io share page, sniffs the HLS/mp4 stream URL from network requests, downloads via ffmpeg.
   - ffmpeg scene-change detection extracts keyframe candidates (~1 per visual change; typically 30–80 for a 60–90s demo). Perceptual-hash dedupe removes near-identical neighbors.
   - **Unusable-frame filter:** discard mid-transition blurs and zoom-ins showing partial screens. Heuristic pass first (detect complete phone outline via edge detection); borderline cases confirmed by Claude in cheap batched calls ("is a complete phone screen visible?").
   - Output: list `{ timestamp, pngPath }`.
   - Fallback: if the stream can't be sniffed, UI offers manual .mp4 upload.

3. **Matcher + judge** (`src/compare/`)
   - **Match (revised again for desktop/scroll demos):** desktop demos show tall pages through a scrolling viewport, so (a) the judge compares only the visible scroll window against the corresponding Figma region, (b) candidate shortlists are built from a forward time-window (screens follow storyboard order) with similarity ranking only within that window, (c) selection+judging happen in ONE vision call per screen from a mini contact sheet, with full-resolution confirmation only for suspected mismatches or null picks — "not found" and "mismatch" verdicts always get a full-res second opinion.
   - **Match (revised during implementation):** perceptual hashing proved unable to distinguish same-layout screens that differ only in text (all "white cards on blue"). Pairing: perceptual similarity narrows to the top ~9 candidates per screen, Claude vision picks the true frame from a per-screen **mini contact sheet** (kept small so the API doesn't downscale it), and the judge **self-heals** — on a mismatch verdict it tries remaining candidates and prefers any match, so wrong pairings can't produce false mismatches while genuine content errors (which match no frame) still surface. Video-frame dedupe uses direct pixel-diff (>0.5% changed pixels at 128×128) rather than hashes. Validated on the real GEO Search demo: 14/14 screens correctly matched in order; a doctored screen was correctly flagged with an exact difference description.
   - **Figma capture (revised):** headless-browser capture is blocked by Figma's CloudFront bot protection and by non-public files; the primary path is the Figma REST API via `FIGMA_TOKEN` (`figma-api.js`) — exact names, true x-order, 2x PNG renders, auto-descent from page links into a single storyboard strip.
   - **Judge:** Claude vision (structured JSON output) per pair: `match | mismatch | not_found` + concrete differences (copy, layout/visual, color). Prompt explicitly instructs to ignore zoom/pan/scale/device chrome — only content inside the phone counts.
   - **Sequence check:** matched frame timestamps must increase in storyboard order; violations flagged.
   - Derived findings: missing screens (Figma screen never matched), extra screens (video frames matching no Figma screen), order violations.

4. **Report UI** (`src/server.js` + `public/`)
   - **Filmstrip layout** (matches the team's storyboard reading habit): one column per Figma screen, horizontally scrollable. Top row = Figma screens in storyboard order; bottom row = matched video frame (with timestamp); under each column a verdict word — "Match" (green) / "Mismatch" (red).
   - Clicking a column expands the pair side-by-side, enlarged, with the judge's bulleted differences.
   - Missing screen → video slot shows a dashed "Not found" placeholder. Extra video screens append at the end, grayed.
   - Summary line top-left: "14 screens · 12 match · 1 mismatch · 1 missing · order OK".
   - Saved as standalone `reports/<demo-name>-<date>.html` for sharing.
   - Every run keeps captured images in `runs/<run-id>/` for audit.

## Mismatch categories (report taxonomy)

Maps 1:1 to requirements: **copy differs**, **screen missing/extra**, **visual/layout/color differs**, **order differs**.

## Configuration

- `.env` at project root: `ANTHROPIC_API_KEY`. Gitignored.
- No other persistent config; links pasted per run.

## Data flow

Figma link + Frame.io link → capture (parallel) → keyframe extraction + filtering → perceptual matching → LLM judging → sequence check → report (HTML page + saved file).

## Error handling

- Figma link private → actionable message (enable link sharing).
- Frame.io stream unsniffable → manual .mp4 upload fallback.
- LLM/API errors → per-screen retry (3×, backoff); a failed screen is reported as "could not judge", never silently dropped.
- ffmpeg/Playwright missing → startup check with install instructions.

## Testing

- Unit: URL parsing (Figma node-ids, Frame.io share ids), pHash dedupe, sequence-check logic (pure functions, fixture images).
- Integration: capture modules against the real sample links provided (FY27 Consumer Platform storyboard + shared demo video) as a smoke test.
- Judge: fixture pairs (known match, known copy diff, known missing card) asserting verdict categories.

## Out of scope (YAGNI)

- Animation style/timing review.
- Figma/Frame.io API integrations (share links only).
- Multi-user/hosted deployment; auth; database. Runs on one machine, filesystem only.
- Auto-commenting back into Frame.io.
