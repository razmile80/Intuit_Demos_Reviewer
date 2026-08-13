import { downloadFrameioVideo, extractFrames } from '../src/capture/video.js';
const { videoPath, title } = await downloadFrameioVideo(process.argv[2], 'runs/smoke', console.log);
console.log('title:', title);
const frames = await extractFrames(videoPath, 'runs/smoke', console.log);
console.log(frames.length, 'frames;', frames.slice(0, 5));
