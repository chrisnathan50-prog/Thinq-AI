// Usage: node render.mjs <out.mp4|sheetdir> [fps] [scale] [--sheet t1,t2,...]
// Every frame is renderAt(i/fps): a pure function of time, so no clock patching is needed.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const [out, fpsArg='30', scaleArg='1'] = process.argv.slice(2);
const sheetIdx = process.argv.indexOf('--sheet');
const fps = +fpsArg, scale = +scaleArg;
const url = 'file://' + path.resolve('scene.html') + '?render';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: scale });
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => window.ready);
const fallback = await page.evaluate(() => [...document.fonts].filter(f => f.status !== 'loaded' && f.family.includes('Geist')).length);
if (fallback) console.warn('WARNING: Geist faces not loaded:', fallback);
const dur = await page.evaluate(() => window.DURATION);
if (sheetIdx > 0) {
  mkdirSync(out, { recursive: true });
  const times = process.argv[sheetIdx + 1].split(',').map(Number);
  for (const [i, t] of times.entries()) {
    await page.evaluate(t => window.renderAt(t), t);
    await page.screenshot({ path: `${out}/f${String(i).padStart(3, '0')}.png` });
  }
} else {
  const n = Math.round(dur * fps);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let i = 0; i < n; i++) {
    await page.evaluate(t => window.renderAt(t), i / fps);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 60 === 0) process.stdout.write(`frame ${i}/${n}\n`);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
}
await browser.close();
