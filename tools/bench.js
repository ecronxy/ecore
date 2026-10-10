#!/usr/bin/env node
// Честный замер плеера eCore: мс на кадр с принудительной синхронизацией видеокарты.
// Каждый кадр закрывается readPixels, поэтому асинхронная работа GPU входит в время (check.js этого не делает).
// usage: node tools/bench.js <файл.svg|файл.tgs|файл.ecr>[,ещё...] [размер=256]
//   BACKEND=gl|2d (по умолчанию gl), FRAMES=90, CHROME=путь, CHROME_LIBS=папка с библиотеками, PLAYER=путь к ecore.js
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { compileLottie } = require('../src/ecr.js'), { compileSource } = require('../src/source.js');
const files = (process.argv[2] || '').split(',').filter(Boolean), size = +(process.argv[3] || 256);
const backend = process.env.BACKEND || 'gl', frames = +(process.env.FRAMES || 90);
const PLAYER = process.env.PLAYER || path.join(ROOT, 'src', 'ecore.js');
if (!files.length) { console.error('usage: node tools/bench.js <файл>[,ещё...] [размер=256]'); process.exit(1); }
const CHROME = process.env.CHROME || path.join(process.env.HOME, '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');
const fonts = {}; for (const f of fs.readdirSync(path.join(ROOT, 'fonts'))) if (/\.ttf$/i.test(f)) fonts[f] = fs.readFileSync(path.join(ROOT, 'fonts', f));

const items = files.map((file) => {
  let raw = fs.readFileSync(file);
  if (/\.ecr$/i.test(file)) return { name: path.basename(file), ecr: raw };
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
  const text = raw.toString('utf8');
  const lottie = /^\s*\{/.test(text) ? JSON.parse(text) : compileSource(text, { fonts }).lottie;
  return { name: path.basename(file).replace(/\.[^.]+$/, ''), ecr: Buffer.from(compileLottie(lottie).bin) };
});

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#888"><script src="/player.js"></script><script>
const SIZE = ${size}, FRAMES = ${frames}, BACKEND = ${JSON.stringify(backend)}, raf = () => new Promise((r) => requestAnimationFrame(r));
(async () => {
  const out = {};
  for (let n = 0; n < ${items.length}; n++) {
    const o = out[n] = {};
    try {
      const buf = await (await fetch('/ecr/' + n)).arrayBuffer(); o.bytes = buf.byteLength;
      const cv = document.createElement('canvas'); cv.width = cv.height = SIZE; document.body.appendChild(cv);
      const pl = new ECore.Player(cv, buf, { backend: BACKEND });
      pl.render(0);
      const g = ECore.gl(); let w = 0;
      if (BACKEND === 'gl') { while (!g.ready() && w++ < 600) { await raf(); } if (!g.ready()) throw new Error('WebGL не готов'); }
      const px = new Uint8Array(4), sync = () => { if (g && g.gl) g.gl.readPixels(0, 0, 1, 1, g.gl.RGBA, g.gl.UNSIGNED_BYTE, px); };
      for (let i = 0; i < 10; i++) { pl.render(i); sync(); }
      const t0 = performance.now(); for (let i = 0; i < FRAMES; i++) { pl.render(i % pl.frames); sync(); }
      o.msPerFrame = Math.round((performance.now() - t0) / FRAMES * 100) / 100; o.used = pl.used; o.instances = pl.scene.inst; o.segs = pl.scene.segs;
      o.bins = pl.scene.nb; cv.remove();
    } catch (e) { o.error = String(e && e.stack || e).slice(0, 400); }
  }
  await fetch('/result', { method: 'POST', body: JSON.stringify(out) });
})();
</script>`;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST') {
    const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => {
      const out = JSON.parse(Buffer.concat(parts).toString());
      items.forEach((it, n) => console.log(it.name.padEnd(28), JSON.stringify(Object.assign({ backend, size }, out[n] || {}))));
      res.end('ok'); child.kill('SIGKILL'); srv.close(); setTimeout(() => process.exit(0), 200);
    });
    return;
  }
  if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
  if (u.pathname === '/player.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(PLAYER)); }
  if (u.pathname.startsWith('/ecr/')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(items[+u.pathname.slice(5)].ecr); }
  res.statusCode = 404; res.end('nf');
});
let child;
srv.listen(0, '127.0.0.1', () => {
  const env = Object.assign({}, process.env); if (process.env.CHROME_LIBS) env.LD_LIBRARY_PATH = process.env.CHROME_LIBS;
  const profile = path.join(ROOT, 'build', 'bench-profile');
  child = spawn(CHROME, ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--user-data-dir=' + profile, `http://127.0.0.1:${srv.address().port}/`], { env, stdio: 'ignore' });
  child.on('error', (e) => { console.error('Chromium не запустился: ' + e.message); process.exit(2); });
  setTimeout(() => { console.log('TIMEOUT'); child.kill('SIGKILL'); process.exit(2); }, 170000);
});
