#!/usr/bin/env node
// Сверка плеера eCore с rlottie (движок Telegram) в headless Chromium: PSNR по кадрам, картинки рядом
// (слева rlottie, в середине eCore, справа разница ×4) и время процессора на кадр.
// usage: node tools/check.js <файл.svg|файл.tgs>[,ещё...] [размер=256]
//   BACKEND=gl|2d|soft (по умолчанию 2d), FRAMES=0_45_90_135, QUICK=1 (без замера времени), CHROME=путь, CHROME_LIBS=папка с библиотеками, если их нет в системе
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'build', 'cmp');
const { compileLottie } = require('../src/ecr.js'), { compileSource, forTgs } = require('../src/source.js');
const files = (process.argv[2] || '').split(',').filter(Boolean), size = +(process.argv[3] || 256), backend = process.env.BACKEND || '2d';
if (!files.length) { console.error('usage: node tools/check.js <файл.svg|файл.tgs>[,ещё...] [размер=256]'); process.exit(1); }
const CHROME = process.env.CHROME || path.join(process.env.HOME, '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');
const fonts = {}; for (const f of fs.readdirSync(path.join(ROOT, 'fonts'))) if (/\.ttf$/i.test(f)) fonts[f] = fs.readFileSync(path.join(ROOT, 'fonts', f));

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#888"><script src="/ecore.js"></script><script>
const P = new URLSearchParams(location.search), N = +P.get('n'), SIZE = +P.get('s'), B = P.get('b'), raf = () => new Promise((r) => requestAnimationFrame(r)), r3 = (x) => Math.round(x * 1000) / 1000;
(async () => {
  const out = {};
  for (let n = 0; n < N; n++) {
    const o = out[n] = {};
    try {
      const buf = await (await fetch('/ecr/' + n)).arrayBuffer(); o.bytes = buf.byteLength;
      { const cv = document.createElement('canvas'); cv.width = cv.height = SIZE; const t = performance.now(); const p0 = new ECore.Player(cv, buf, { backend: '2d' }); o.decodeMs = r3(performance.now() - t); p0.render(0); cv.getContext('2d').getImageData(0, 0, 1, 1); o.firstFrameMs = r3(performance.now() - t); }
      const cv = document.createElement('canvas'); cv.width = cv.height = SIZE; document.body.appendChild(cv);
      const pl = new ECore.Player(cv, buf, { backend: B }), ctx = cv.getContext('2d');
      if (B === 'gl') { pl.render(0); const g = ECore.gl(); let w = 0; while (!g.ready() && w++ < 600) await raf(); if (!g.ready()) throw new Error('WebGL не готов'); }
      const list = P.get('f') ? P.get('f').split('_').map(Number) : [0, 0.25, 0.5, 0.75].map((u) => Math.round(u * pl.frames));
      for (const i of list) { if (i >= pl.frames) continue; pl.render(i); await fetch('/frame?n=' + n + '&i=' + i, { method: 'POST', body: ctx.getImageData(0, 0, SIZE, SIZE).data }); }
      o.used = pl.used;
      o.frames = pl.frames; o.styles = pl.scene.inst;
      if (!P.get('q')) {   // QUICK=1: только сверка картинки, без замера времени
        for (let i = 0; i < pl.frames; i++) pl.render(i);
        const times = []; for (let pass = 0; pass < 3; pass++) for (let i = 0; i < pl.frames; i++) { const a = performance.now(); pl.render(i); times.push(performance.now() - a); }
        times.sort((a, b) => a - b); o.frameAvgMs = r3(times.reduce((a, b) => a + b, 0) / times.length); o.frameP95Ms = r3(times[Math.floor(times.length * 0.95)]);
      }
      cv.remove();
    } catch (e) { o.error = String(e && e.stack || e).slice(0, 600); }
  }
  await fetch('/result', { method: 'POST', body: JSON.stringify(out) });
})();
</script>`;

(async () => {
  const RL = path.join(ROOT, 'vendor', 'rlottie'), wasm = fs.readFileSync(path.join(RL, 'rlottie.wasm'));
  const mod = await require(path.join(RL, 'rlottie.js'))({ instantiateWasm: (info, cb) => { WebAssembly.instantiate(wasm, info).then((r) => cb(r.instance)); return {}; } });
  const items = files.map((file) => {
    let raw = fs.readFileSync(file); if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
    const text = raw.toString('utf8'), lottie = /^\s*\{/.test(text) ? JSON.parse(text) : compileSource(text, { fonts }).lottie;
    const json = /^\s*\{/.test(text) ? text : forTgs(lottie).json, n = mod.lengthBytesUTF8(json) + 1, p = mod._malloc(n); mod.stringToUTF8(json, p, n);
    const h = mod._rl_new(p, size, size); mod._free(p);
    return { name: path.basename(file).replace(/\.[^.]+$/, ''), ecr: Buffer.from(compileLottie(lottie).bin), h, strips: [], psnr: {} };
  });
  fs.mkdirSync(OUT, { recursive: true });
  let child;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST') {
      const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => {
        const body = Buffer.concat(parts);
        if (u.pathname === '/frame') {
          const it = items[+u.searchParams.get('n')], i = +u.searchParams.get('i'), ptr = mod._rl_render(it.h, i), r = mod.HEAPU8.subarray(ptr, ptr + size * size * 4), W = size * 3, img = Buffer.alloc(W * size * 4); let se = 0;
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const a = (y * size + x) * 4, ra = r[a + 3] / 255, oa = body[a + 3] / 255;
            for (let c = 0; c < 3; c++) { const rv = r[a + c] * ra + 128 * (1 - ra), ov = body[a + c] * oa + 128 * (1 - oa), d = rv - ov; se += d * d; img[(y * W + x) * 4 + c] = rv; img[(y * W + size + x) * 4 + c] = ov; img[(y * W + 2 * size + x) * 4 + c] = Math.min(255, Math.abs(d) * 4); }
            img[(y * W + x) * 4 + 3] = img[(y * W + size + x) * 4 + 3] = img[(y * W + 2 * size + x) * 4 + 3] = 255;
          }
          const mse = se / (size * size * 3); it.psnr[i] = +(mse ? 10 * Math.log10(65025 / mse) : 99).toFixed(1); it.strips.push(img);
          return res.end('ok');
        }
        const out = JSON.parse(body.toString());
        items.forEach((it, n) => {
          if (it.strips.length) fs.writeFileSync(path.join(OUT, `${it.name}_${backend}_${size}.png`), png(size * 3, size * it.strips.length, Buffer.concat(it.strips)));
          console.log(it.name, JSON.stringify(Object.assign(out[n] || {}, { psnr: it.psnr })));
        });
        res.end('ok'); if (child) child.kill('SIGKILL'); srv.close(); setTimeout(() => process.exit(0), 200);
      });
      return;
    }
    if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
    if (u.pathname === '/ecore.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(ROOT, 'src', 'ecore.js'))); }
    if (u.pathname.startsWith('/ecr/')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(items[+u.pathname.slice(5)].ecr); }
    res.statusCode = 404; res.end('nf');
  });
  srv.listen(0, '127.0.0.1', () => {
    const env = Object.assign({}, process.env); if (process.env.CHROME_LIBS) env.LD_LIBRARY_PATH = process.env.CHROME_LIBS;
    const log = fs.openSync(path.join(OUT, 'chrome.log'), 'w');
    child = spawn(CHROME, ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-logging=stderr', '--user-data-dir=' + path.join(OUT, 'profile'), `http://127.0.0.1:${srv.address().port}/?n=${items.length}&s=${size}&b=${backend}${process.env.FRAMES ? '&f=' + process.env.FRAMES : ''}${process.env.QUICK ? '&q=1' : ''}`], { stdio: ['ignore', log, log], env });
    child.on('error', (e) => { console.error('Chromium не запустился: ' + e.message); process.exit(2); });
    setTimeout(() => { console.log('TIMEOUT: смотрите ' + path.join(OUT, 'chrome.log')); child.kill('SIGKILL'); process.exit(2); }, 170000);
  });
})();
