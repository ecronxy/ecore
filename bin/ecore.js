#!/usr/bin/env node
// eCore: командная строка.
//   ecore build  <исходник.svg> [-o папка] [--set слот=текст ...] [--still]   исходник -> .ecr и .tgs
//   ecore import <файл.tgs|.json> [-o файл.ecr] [--still]                      готовый tgs -> .ecr
//   ecore render <исходник.svg|файл.tgs> [-o лист.png] [--frames 0,45,90,135] [--size 256] [--set ...]
//                                                                             контактный лист кадров: так анимацию покажет Telegram (rlottie)
//   ecore frame  <файл.ecr|.tgs|.svg> [-o кадр.png] [--frame 0] [--size 512]   один кадр своим ядром, без браузера и без rlottie
//   ecore info   <файл.ecr>
//   ecore serve  [порт]                                                        студия и демо на 127.0.0.1
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const { compileLottie } = require('../src/ecr.js'), { compileSource, forTgs, ECoreError } = require('../src/source.js'), { Scene, renderRGBA } = require('../src/ecore.js');

const argv = process.argv.slice(2), cmd = argv.shift();
const flags = {}, sets = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--set') { const v = argv[++i] || '', c = v.indexOf('='); if (c > 0) sets[v.slice(0, c)] = v.slice(c + 1); }
  else if (a === '-o') flags.o = argv[++i];
  else if (a.startsWith('--')) { const next = argv[i + 1]; if (next !== undefined && !next.startsWith('-')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true; }
  else pos.push(a);
}
const die = (m) => { console.error(m); process.exit(1); };
const kb = (n) => (n / 1024).toFixed(1) + ' КБ';

function loadFonts() {
  const dir = path.join(ROOT, 'fonts'), out = {};
  for (const f of fs.readdirSync(dir)) if (/\.ttf$/i.test(f)) out[f] = fs.readFileSync(path.join(dir, f));
  return out;
}
// файл -> { lottie, warnings, slots }
function sceneOf(file) {
  let raw = fs.readFileSync(file);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
  const text = raw.toString('utf8');
  if (/^\s*\{/.test(text)) return { lottie: JSON.parse(text), warnings: [], slots: [] };
  return compileSource(text, { fonts: loadFonts(), slots: sets, name: path.basename(file).replace(/\..*$/, '') });
}
const gzipTgs = (lottie) => { const t = forTgs(lottie), gz = zlib.gzipSync(Buffer.from(t.json), { level: 9 }); if (gz.length > 64 * 1024) t.problems.push('файл ' + kb(gz.length) + ', Telegram принимает до 64 КБ'); return { gz, problems: t.problems }; };

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// кадры через rlottie (тот же движок, что в приложениях Telegram), на шахматной подложке
async function renderSheet(lottie, list, size) {
  const RL = path.join(ROOT, 'vendor', 'rlottie'), wasm = fs.readFileSync(path.join(RL, 'rlottie.wasm'));
  const mod = await require(path.join(RL, 'rlottie.js'))({ instantiateWasm: (info, cb) => { WebAssembly.instantiate(wasm, info).then((r) => cb(r.instance)); return {}; } });
  const json = forTgs(lottie).json, n = mod.lengthBytesUTF8(json) + 1, p = mod._malloc(n); mod.stringToUTF8(json, p, n);
  const h = mod._rl_new(p, size, size); mod._free(p);
  if (!h) throw new Error('rlottie не принял сцену');
  const total = mod._rl_frames(h), out = Buffer.alloc(size * list.length * size * 4);
  list.forEach((f, k) => {
    const ptr = mod._rl_render(h, Math.max(0, Math.min(total - 1, f))), px = mod.HEAPU8.subarray(ptr, ptr + size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = (y * size * list.length + k * size + x) * 4, a = px[s + 3] / 255, bg = ((x >> 4) + (y >> 4)) & 1 ? 44 : 56;
      out[d] = px[s] * a + bg * (1 - a); out[d + 1] = px[s + 1] * a + bg * (1 - a); out[d + 2] = px[s + 2] * a + bg * (1 - a); out[d + 3] = 255;
    }
  });
  mod._rl_free(h);
  return png(size * list.length, size, out);
}

(async () => {
  if (cmd === 'build') {
    if (!pos[0]) die('usage: ecore build <исходник.svg> [-o папка] [--set слот=текст] [--still]');
    const r = sceneOf(pos[0]), base = path.join(flags.o || path.dirname(pos[0]), path.basename(pos[0]).replace(/(\.ecore)?\.svg$/i, ''));
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const c = compileLottie(r.lottie), t = gzipTgs(r.lottie);
    fs.writeFileSync(base + '.ecr', c.bin); fs.writeFileSync(base + '.tgs', t.gz);
    if (flags.still) fs.writeFileSync(base + '.still.ecr', compileLottie(r.lottie, { still: true }).bin);
    for (const k in c.unsupported) r.warnings.push(k);
    console.log(`${base}.ecr  ${kb(c.bin.length)}`);
    console.log(`${base}.tgs  ${kb(t.gz.length)}`);
    console.log(`${r.w}×${r.h}, ${r.frames} кадров, ${r.fps} к/с` + (r.slots.length ? ', слоты: ' + r.slots.map((s) => s.name + '=«' + s.text + '»').join(', ') : ''));
    for (const w of r.warnings) console.log('замечание: ' + w);
    for (const w of t.problems) console.log('для Telegram: ' + w);
  } else if (cmd === 'import') {
    if (!pos[0]) die('usage: ecore import <файл.tgs> [-o файл.ecr] [--still]');
    const r = sceneOf(pos[0]), out = flags.o || pos[0].replace(/\.[^.]+$/, '') + (flags.still ? '.still.ecr' : '.ecr'), c = compileLottie(r.lottie, { still: !!flags.still });
    fs.writeFileSync(out, c.bin);
    console.log(`${out}  ${kb(c.bin.length)}, исходный файл ${kb(fs.statSync(pos[0]).size)}`);
    for (const k in c.unsupported) console.log('замечание: ' + k + ' (' + c.unsupported[k] + ')');
  } else if (cmd === 'render') {
    if (!pos[0]) die('usage: ecore render <исходник.svg|файл.tgs> [-o лист.png] [--frames 0,45,90] [--size 256]');
    const r = sceneOf(pos[0]), total = r.lottie.op - r.lottie.ip, size = +flags.size || 256;
    const list = flags.frames ? String(flags.frames).split(',').map(Number) : [0, 0.2, 0.4, 0.6, 0.8].map((u) => Math.round(u * total));
    const out = flags.o || pos[0].replace(/\.[^.]+$/, '') + '.png';
    fs.writeFileSync(out, await renderSheet(r.lottie, list, size));
    console.log(`${out}  кадры ${list.join(', ')} из ${total}`);
    for (const w of r.warnings) console.log('замечание: ' + w);
  } else if (cmd === 'frame') {
    if (!pos[0]) die('usage: ecore frame <файл.ecr|.tgs|.svg> [-o кадр.png] [--frame 0] [--size 512]');
    const bin = /\.ecr$/i.test(pos[0]) ? fs.readFileSync(pos[0]) : compileLottie(sceneOf(pos[0]).lottie).bin, sc = new Scene(bin);
    const i = Math.max(0, Math.min(sc.frames - 1, +flags.frame || 0)), img = renderRGBA(sc, i, +flags.size || 512), out = flags.o || pos[0].replace(/\.[^.]+$/, '') + '.png';
    fs.writeFileSync(out, png(img.width, img.height, Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length)));
    console.log(`${out}  кадр ${i} из ${sc.frames}, ${img.width}×${img.height}`);
  } else if (cmd === 'info') {
    if (!pos[0]) die('usage: ecore info <файл.ecr>');
    const u8 = fs.readFileSync(pos[0]), sc = new Scene(u8), h = sc.h, layers = sc.comps.reduce((n, c) => n + c.layers.length, 0);
    console.log(`${h.w}×${h.h}, ${sc.frames} кадров, ${h.fr} к/с, композиций ${sc.comps.length}, слоёв ${layers}, стилей ${sc.styles.length}, градиентов ${h.ng || 0}` + (sc.names.length ? ', элементы: ' + sc.names.join(', ') : ''));
    console.log(`файл ${kb(u8.length)}` + (u8[4] & 1 ? ', сжат' : ', без сжатия'));
  } else if (cmd === 'serve') {
    require('../tools/serve.js')(+pos[0] || 8080);
  } else die('eCore: build | import | render | frame | info | serve. Подробности в README.md');
})().catch((e) => die(e instanceof ECoreError ? 'ошибка в исходнике: ' + e.message : e.stack || String(e)));
