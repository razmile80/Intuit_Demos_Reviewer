import fs from 'node:fs/promises';
import path from 'node:path';
import { captureFigmaFrames } from './capture/figma.js';
import { captureFigmaFramesApi } from './capture/figma-api.js';
import { downloadVideo, extractFrames } from './capture/video.js';
import Anthropic from '@anthropic-ai/sdk';
import { matchScreens, sequenceCheck, findExtras } from './compare/match.js';
import { selectAndJudge } from './compare/select.js';
import { MODEL } from './compare/judge.js';
import { addScriptVersion } from './scripts.js';
import { transcribeVideo } from './transcribe.js';

export async function runPipeline({ figmaUrl, frameioUrl, videoPath, demoName, script, deep = false, runId, onProgress = () => {}, onScreen = () => {} }) {
  const triggeredAt = new Date().toISOString(); // scan/rescan trigger time, not completion
  const runDir = path.join('runs', runId);
  await fs.mkdir(runDir, { recursive: true });

  const captureFigma = process.env.FIGMA_TOKEN ? captureFigmaFramesApi : captureFigmaFrames;
  if (!process.env.FIGMA_TOKEN) onProgress('[figma] No FIGMA_TOKEN set — falling back to headless browser capture (requires public link sharing)');
  const [figmaFrames, dl] = await Promise.all([
    captureFigma(figmaUrl, runDir, m => onProgress(`[figma] ${m}`)),
    videoPath ? Promise.resolve({ videoPath, title: null }) : downloadVideo(frameioUrl, runDir, m => onProgress(`[video] ${m}`)),
  ]);
  const name = demoName ?? dl.title ?? runId;

  // Human-set anchors from previous reviews of this demo guide the pairing.
  let anchors = {};
  try { anchors = JSON.parse(await fs.readFile(path.join('data', 'anchors.json'), 'utf8'))[name] ?? {}; } catch { /* none */ }

  // Producer-dismissed screens: mismatch dismissals feed the judge as accepted
  // differences; not-found dismissals (e.g. placeholder frames) auto-dismiss.
  let dismissals = {};
  try { dismissals = JSON.parse(await fs.readFile(path.join('data', 'dismissals.json'), 'utf8'))[name] ?? {}; } catch { /* none */ }
  for (const f of figmaFrames) if (dismissals[f.name]?.length) f.accepted = dismissals[f.name];

  // VO script: pasted text wins; otherwise auto-transcribe the video's audio.
  const scriptPromise = (async () => {
    try {
      if (script?.trim()) {
        onProgress('[vo] Saving pasted script…');
        return { ...(await addScriptVersion(name, script.trim(), 'manual')), source: 'manual' };
      }
      if (process.env.OPENAI_API_KEY) {
        onProgress('[vo] No script pasted — transcribing video audio…');
        const text = await transcribeVideo(dl.videoPath, runDir);
        return { ...(await addScriptVersion(name, text, 'transcript')), source: 'transcript' };
      }
    } catch (e) {
      onProgress(`[vo] Script step failed: ${e.message} (continuing)`);
      return { error: e.message };
    }
    return null;
  })();

  const videoFrames = await extractFrames(dl.videoPath, runDir, m => onProgress(`[video] ${m}`));

  onProgress(`Matching ${figmaFrames.length} screens against ${videoFrames.length} frames…`);
  const client = new Anthropic();
  // Perceptual pre-pass crops phone regions and narrows to top candidates;
  // the vision model picks the best pairing from a per-screen mini contact
  // sheet; the judge self-heals across remaining candidates.
  const simMatches = await matchScreens(figmaFrames, videoFrames, { topK: 999, minScore: 0.3 });
  const web = p => p ? '/' + p.split(path.sep).join('/') : null;
  const judged = await selectAndJudge(simMatches, {
    client, model: MODEL, runDir, anchors, deep, onProgress,
    onScreen: (j, index, total) => onScreen({
      index, total,
      name: j.screen.name, verdict: j.verdict, differences: j.differences,
      anchored: j.anchored ?? false, dismissed: false,
      figmaPng: web(j.screen.pngPath),
      videoPng: web(j.matchedFrame?.croppedPath ?? j.matchedFrame?.pngPath),
      timestamp: j.matchedFrame?.timestamp ?? null,
    }),
  });
  for (const j of judged) {
    if (j.verdict === 'not_found' && j.screen.name in dismissals) j.dismissed = true;
  }
  const sequence = sequenceCheck(judged.filter(j => j.verdict === 'match' || j.verdict === 'mismatch'));
  const extras = findExtras(videoFrames, judged);

  // Health check: many screens landing on the same moment means the pairing
  // collapsed (usually a bad first match dragging the rest along). Surface it
  // rather than reporting a wall of false mismatches as if they were real.
  const stamps = judged.filter(j => j.matchedFrame).map(j => j.matchedFrame.timestamp);
  const worst = Math.max(0, ...Object.values(stamps.reduce((acc, t) => (acc[t] = (acc[t] ?? 0) + 1, acc), {})));
  const collapsed = stamps.length >= 5 && worst >= Math.max(3, stamps.length * 0.3);
  if (collapsed) onProgress(`⚠ Pairing looks unreliable: ${worst} screens matched the same moment — drag a thumbnail to the correct time and rescan.`);

  let timeline = [];
  try {
    timeline = JSON.parse(await fs.readFile(path.join(runDir, 'frames.json'), 'utf8'))
      .map(f => ({ t: f.timestamp, png: web(f.png), beat: f.beat, motion: f.motion, rep: f.rep }));
  } catch { /* no timeline data */ }
  const report = {
    runId,
    name,
    video: web(dl.videoPath),
    timeline,
    date: triggeredAt,
    figmaUrl,
    frameioUrl: frameioUrl ?? null,
    summary: {
      total: judged.length,
      match: judged.filter(j => j.verdict === 'match').length,
      mismatch: judged.filter(j => j.verdict === 'mismatch' && !j.dismissed).length,
      missing: judged.filter(j => j.verdict === 'not_found' && !j.dismissed).length,
      errors: judged.filter(j => j.verdict === 'error').length,
      orderOk: sequence.ok,
      collapsed,
    },
    screens: judged.map(j => ({
      name: j.screen.name, verdict: j.verdict, differences: j.differences, anchored: j.anchored ?? false, dismissed: j.dismissed ?? false,
      figmaPng: web(j.screen.pngPath),
      videoPng: web(j.matchedFrame?.croppedPath ?? j.matchedFrame?.pngPath),
      timestamp: j.matchedFrame?.timestamp ?? null,
    })),
    extras: extras.slice(0, 12).map(f => ({ videoPng: web(f.croppedPath ?? f.pngPath), timestamp: f.timestamp })),
    sequence,
    script: await scriptPromise,
  };
  // Manual reviewer notes persist across rescans and override the AI verdict.
  try {
    const notes = JSON.parse(await fs.readFile(path.join('data', 'notes.json'), 'utf8'))[name] ?? {};
    const { applyNotes, noteKey, recount } = await import('./server.js');
    report.screens.forEach((s, i) => {
      const list = notes[noteKey(report.screens, i)];
      if (list?.length) applyNotes(s, list);
    });
    recount(report);
  } catch { /* no notes yet */ }

  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  await saveStandaloneReport(report, runDir);
  // Disk hygiene: prune superseded runs so the volume doesn't fill up.
  try {
    const { pruneOldRuns } = await import('./cleanup.js');
    await pruneOldRuns({ onProgress });
  } catch (e) {
    onProgress(`Cleanup skipped: ${e.message}`);
  }
  return report;
}

async function saveStandaloneReport(report) {
  await fs.mkdir('reports', { recursive: true });
  const inline = async p => {
    if (!p) return '';
    try { return `data:image/png;base64,${(await fs.readFile(p.slice(1))).toString('base64')}`; }
    catch { return ''; }
  };
  const screens = await Promise.all(report.screens.map(async s => ({
    ...s, figmaPng: await inline(s.figmaPng), videoPng: await inline(s.videoPng),
  })));
  const html = `<!doctype html><meta charset="utf-8"><title>QA ${report.runId}</title>
<body style="background:#141414;color:#eee;font-family:sans-serif;padding:24px">
<h2>${report.summary.total} screens · ${report.summary.match} match · ${report.summary.mismatch} mismatch · ${report.summary.missing} missing · order ${report.summary.orderOk ? 'OK' : 'BROKEN'}</h2>
<div style="display:flex;gap:16px;overflow-x:auto">${screens.map(s => `
<div style="min-width:180px;text-align:center">
  <img src="${s.figmaPng}" style="width:170px;display:block;margin:0 auto 8px">
  ${s.videoPng ? `<img src="${s.videoPng}" style="width:170px;display:block;margin:0 auto">` : '<div style="width:170px;height:300px;border:2px dashed #555;display:flex;align-items:center;justify-content:center;margin:0 auto">Not found</div>'}
  <div style="color:${s.verdict === 'match' ? '#4ade80' : '#f87171'};font-weight:bold;margin-top:6px">${s.verdict}</div>
  ${s.differences.map(d => `<div style="font-size:11px;color:#f99">${d}</div>`).join('')}
</div>`).join('')}</div></body>`;
  await fs.writeFile(path.join('reports', `${report.runId}.html`), html);
}
