import { captureFigmaFrames } from '../src/capture/figma.js';
const url = process.argv[2];
const frames = await captureFigmaFrames(url, 'runs/smoke', console.log);
console.table(frames.map(f => ({ name: f.name, nodeId: f.nodeId, png: f.pngPath })));
