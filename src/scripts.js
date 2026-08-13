import fs from 'node:fs/promises';
import path from 'node:path';

// VO script versions, stored per demo name (independent of runs).
const SCRIPTS_FILE = path.join('data', 'scripts.json');

export async function loadScripts() {
  try { return JSON.parse(await fs.readFile(SCRIPTS_FILE, 'utf8')); } catch { return {}; }
}

async function saveScripts(all) {
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(SCRIPTS_FILE, JSON.stringify(all, null, 2));
}

// Serialize read-modify-write cycles so concurrent batch scans can't clobber
// each other's script versions.
let lock = Promise.resolve();
export function addScriptVersion(name, text, source = 'manual') {
  const p = lock.then(() => addScriptVersionUnlocked(name, text, source));
  lock = p.catch(() => {});
  return p;
}

// Saves a new version (unless identical to the latest) and returns an AI
// summary of what changed vs the previous version.
async function addScriptVersionUnlocked(name, text, source = 'manual') {
  const all = await loadScripts();
  const versions = all[name] ?? [];
  const prev = versions.at(-1);
  if (prev && prev.text.trim() === text.trim()) {
    return { version: versions.length, changes: 'No changes — identical to the stored version.', unchanged: true };
  }
  let changes = null;
  if (prev) {
    try { changes = await compareScripts(prev.text, text); }
    catch (e) { changes = `AI comparison failed (${e.message}) — version saved anyway.`; }
  }
  versions.push({ date: new Date().toISOString(), text, source });
  all[name] = versions;
  await saveScripts(all);
  return { version: versions.length, changes: changes ?? 'First version saved — nothing to compare against yet.', source };
}

async function compareScripts(oldText, newText) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { MODEL } = await import('./compare/judge.js');
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 2000,
    system: `You compare two versions of a voice-over script for a product demo video and report what changed, for the producer and VO artist.
List every change concretely, quoting exact wording: rewritten lines ("was: … → now: …"), added lines, removed lines, and small word/number edits.
Group under headings "Edited", "Added", "Removed" (omit empty groups). Be complete but concise — no commentary about style or quality.
One version may be an automatic audio transcript: ignore pure punctuation/casing/formatting differences in that case and focus on WORDING changes.
If there are no meaningful wording changes, say so in one line. Plain text output, one change per line.`,
    messages: [{ role: 'user', content: `PREVIOUS SCRIPT:\n${oldText}\n\n---\n\nNEW SCRIPT:\n${newText}` }],
  });
  return msg.content.find(b => b.type === 'text')?.text ?? '';
}
