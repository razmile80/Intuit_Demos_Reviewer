import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpegPath } from './capture/video.js';

const run = promisify(execFile);

// Extracts the audio track and transcribes it with OpenAI Whisper.
// Requires OPENAI_API_KEY in .env.
export async function transcribeVideo(videoPath, runDir) {
  if (!process.env.OPENAI_API_KEY) throw new Error('NO_OPENAI_KEY');
  const audioPath = path.join(runDir, 'audio.mp3');
  await run(ffmpegPath, ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', audioPath],
    { maxBuffer: 1024 * 1024 * 16 });
  const fd = new FormData();
  fd.append('file', new Blob([await fs.readFile(audioPath)], { type: 'audio/mpeg' }), 'audio.mp3');
  fd.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`TRANSCRIBE_FAILED_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { text } = await res.json();
  if (!text?.trim()) throw new Error('TRANSCRIBE_EMPTY');
  return text.trim();
}
