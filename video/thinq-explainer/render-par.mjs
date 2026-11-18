// Parallel renderer: node render-par.mjs <out.mp4> <audio.wav> [fps=120] [workers=4] [blend=4]
// Splits the timeline across browser workers, joins the chunks, then blends every <blend>
// frames into one (a 360° shutter at fps/blend) for real motion blur.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);

if (args[0] === '--worker') {
  const [, a, b, fps, out] = args;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.goto('file://' + path.resolve('scene.html') + '?render', { waitUntil: 'networkidle' });
  await page.evaluate(() => window.ready);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', fps, '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-pix_fmt', 'yuv444p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let i = +a; i < +b; i++) {
    await page.evaluate(t => window.renderAt(t), i / +fps);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r)); await browser.close();
  process.exit(0);
}

const [out, audio, fps = '120', workers = '4', blend = '4'] = args;
const { chromium } = require('playwright');
const b = await chromium.launch(); const p = await b.newPage();
await p.goto('file://' + path.resolve('scene.html') + '?render'); const dur = await p.evaluate(() => window.DURATION); await b.close();
const n = Math.round(dur * +fps), W = +workers, tmp = '.chunks'; rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp);
const t0 = Date.now();
await Promise.all([...Array(W)].map((_, k) => new Promise((res, rej) => {
  const a = Math.floor(n * k / W), e = Math.floor(n * (k + 1) / W);
  const c = spawn(process.execPath, [process.argv[1], '--worker', a, e, fps, `${tmp}/c${k}.mp4`], { stdio: 'inherit' });
  c.on('close', code => code ? rej(new Error('worker ' + k)) : res());
})));
console.log(`rendered ${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
writeFileSync(`${tmp}/list.txt`, [...Array(W)].map((_, k) => `file 'c${k}.mp4'`).join('\n'));
const wts = Array(+blend).fill(1).join(' ');
await new Promise((res, rej) => spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${tmp}/list.txt`, '-i', audio,
  '-filter_complex', `[0:v]tmix=frames=${blend}:weights='${wts}',framestep=${blend},setpts=N/${+fps / +blend}/TB,format=yuv420p[v]`,
  '-map', '[v]', '-map', '1:a', '-r', String(+fps / +blend), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '192k',
  '-shortest', '-movflags', '+faststart', out], { stdio: 'inherit' }).on('close', c => c ? rej(new Error('ffmpeg')) : res()));
rmSync(tmp, { recursive: true, force: true });
console.log('done', out);
