#!/usr/bin/env node
// Сверка компилятора с браузером: Chromium сам проигрывает исходник (это обычный SVG с CSS-анимацией),
// рядом тот же кадр рисует плеер eCore. Картинки рядом кладутся в build/native/, в консоль идёт PSNR.
// Побуквенное движение и data-fit браузер не знает, поэтому для сверки эти атрибуты убираются с обеих сторон.
// usage: node tools/native.js <файл.svg>[,ещё...] [размер=256]     FRAMES=0_45_90   PLAYWRIGHT=путь к модулю, CHROME, CHROME_LIBS
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'build', 'native');
const { compileLottie } = require('../src/ecr.js'), { compileSource, parseFont } = require('../src/source.js');
const { chromium } = require(process.env.PLAYWRIGHT || path.join(process.env.HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const CHROME = process.env.CHROME || path.join(process.env.HOME, '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');
const files = (process.argv[2] || '').split(',').filter(Boolean), size = +(process.argv[3] || 256);
if (!files.length) { console.error('usage: node tools/native.js <файл.svg>[,ещё...] [размер=256]'); process.exit(1); }

function unpng(buf) {   // PNG 8 бит RGB/RGBA без чересстрочности -> { w, h, bpp, data }
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8); if (type === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); ct = buf[p + 17]; } else if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len)); p += 12 + len; }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), st = w * bpp, data = Buffer.alloc(st * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (st + 1)], src = y * (st + 1) + 1, dst = y * st;
    for (let x = 0; x < st; x++) {
      const a = x >= bpp ? data[dst + x - bpp] : 0, b = y ? data[dst - st + x] : 0, c = x >= bpp && y ? data[dst - st + x - bpp] : 0, v = raw[src + x];
      let pr = 0; if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1; else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      data[dst + x] = (v + pr) & 255;
    }
  }
  return { w, h, bpp, data };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const fonts = {}, faces = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'fonts'))) if (/\.ttf$/i.test(f)) { const b = fs.readFileSync(path.join(ROOT, 'fonts', f)); fonts[f] = b; faces.push(`@font-face{font-family:'${parseFont(b).family}';src:url(data:font/ttf;base64,${b.toString('base64')})}`); }
  const env = Object.assign({}, process.env); if (process.env.CHROME_LIBS) env.LD_LIBRARY_PATH = process.env.CHROME_LIBS;
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-font-subpixel-positioning', '--font-render-hinting=none'], env });
  for (const file of files) {
    const name = path.basename(file).replace(/\.[^.]+$/, '');
    const src = fs.readFileSync(file, 'utf8').replace(/\sdata-(letters|stagger|fit)="[^"]*"/g, '');
    const r = compileSource(src, { fonts }), ecr = Buffer.from(compileLottie(r.lottie).bin).toString('base64');
    const page = await browser.newPage({ viewport: { width: size * 2, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>${faces.join('')}html,body{margin:0;background:#808080;overflow:hidden}svg,canvas{position:absolute;top:0;left:0;width:${size}px;height:${size}px}canvas{left:${size}px}</style>${src}<canvas width="${size}" height="${size}"></canvas><script>${fs.readFileSync(path.join(ROOT, 'src', 'ecore.js'), 'utf8')}</script>`);
    await page.evaluate(async (b64) => { await document.fonts.ready; for (const f of document.fonts) await f.load().catch(() => {}); const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); window.pl = new ECore.Player(document.querySelector('canvas'), u8, { backend: '2d' }); }, ecr);
    const list = process.env.FRAMES ? process.env.FRAMES.split('_').map(Number) : [0, 0.2, 0.4, 0.6, 0.8].map((u) => Math.round(u * r.frames)), psnr = {}, rows = [];
    for (const f of list) {
      await page.evaluate(({ f, fps }) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = f / fps * 1000; } window.pl.render(f); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }, { f, fps: r.fps });
      const shot = await page.screenshot({ type: 'png' }), img = unpng(shot); let se = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < 3; c++) { const d = img.data[(y * img.w + x) * img.bpp + c] - img.data[(y * img.w + x + size) * img.bpp + c]; se += d * d; }
      const mse = se / (size * size * 3); psnr[f] = +(mse ? 10 * Math.log10(65025 / mse) : 99).toFixed(1);
      fs.writeFileSync(path.join(OUT, `${name}_${f}.png`), shot); rows.push(f);
    }
    console.log(name, JSON.stringify({ psnr, warnings: r.warnings }));
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
