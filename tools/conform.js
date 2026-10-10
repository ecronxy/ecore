#!/usr/bin/env node
// Сверка ядра с rlottie (движок Telegram) без браузера: eCore рисует кадры на процессоре (Soft),
// rlottie рисует те же кадры, считается PSNR. Так проверяются сразу сотни файлов.
// usage: node tools/conform.js <папка|файл.tgs|файл.svg>[,ещё...] [размер=128]
//   FRAMES=4      сколько кадров на файл (равномерно по длине)
//   WORST=12      сколько худших файлов перечислить
//   DUMP=8        сохранить картинки худших в build/conform (слева rlottie, в середине eCore, справа разница ×4)
//   MIN=30        порог PSNR в дБ: файл ниже порога считается несошедшимся
//   LIST=путь     записать построчно результат по каждому файлу (JSON)
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'build', 'conform');
const { compileLottie } = require('../src/ecr.js'), { compileSource, forTgs } = require('../src/source.js'), { Scene, Soft } = require('../src/ecore.js');
const size = +(process.argv[3] || 128), NF = +(process.env.FRAMES || 4), WORST = +(process.env.WORST || 12), DUMP = +(process.env.DUMP || 0), MIN = +(process.env.MIN || 30);
const files = [];
for (const a of (process.argv[2] || '').split(',').filter(Boolean)) {
  if (fs.statSync(a).isDirectory()) (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.tgs$/i.test(p)) files.push(p); } })(a);
  else files.push(a);
}
if (!files.length) { console.error('usage: node tools/conform.js <папка|файл>[,ещё...] [размер=128]'); process.exit(1); }
const fonts = {}; for (const f of fs.readdirSync(path.join(ROOT, 'fonts'))) if (/\.ttf$/i.test(f)) fonts[f] = fs.readFileSync(path.join(ROOT, 'fonts', f));

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const RL = path.join(ROOT, 'vendor', 'rlottie'), wasm = fs.readFileSync(path.join(RL, 'rlottie.wasm'));
  const mod = await require(path.join(RL, 'rlottie.js'))({ instantiateWasm: (info, cb) => { WebAssembly.instantiate(wasm, info).then((r) => cb(r.instance)); return {}; } });
  const soft = new Soft(), res = [], t0 = Date.now();
  let tSoft = 0, nSoft = 0, tComp = 0, tgsBytes = 0, ecrBytes = 0;
  for (const file of files) {
    const r = { file, name: path.relative(process.cwd(), file) };
    try {
      let raw = fs.readFileSync(file); const disk = raw.length; if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
      const text = raw.toString('utf8'), isJson = /^\s*\{/.test(text), lottie = isJson ? JSON.parse(text) : compileSource(text, { fonts }).lottie;
      const json = isJson ? text : forTgs(lottie).json;
      let t = process.hrtime.bigint(); const c = compileLottie(lottie); tComp += Number(process.hrtime.bigint() - t) / 1e6;
      r.ecr = c.bin.length; r.tgs = isJson && disk !== raw.length ? disk : zlib.gzipSync(Buffer.from(json), { level: 9 }).length; tgsBytes += r.tgs; ecrBytes += r.ecr;
      r.miss = Object.keys(c.unsupported);
      const sc = new Scene(c.bin);
      const n = mod.lengthBytesUTF8(json) + 1, p = mod._malloc(n); mod.stringToUTF8(json, p, n);
      const h = mod._rl_new(p, size, size); mod._free(p);
      if (!h) throw new Error('rlottie не принял файл');
      const total = Math.min(mod._rl_frames(h), sc.frames), list = []; for (let k = 0; k < NF; k++) list.push(Math.min(total - 1, Math.floor((k + 0.37) * total / NF)));
      r.psnr = []; r.strips = [];
      for (const i of list) {
        const ptr = mod._rl_render(h, i), a = mod.HEAPU8.subarray(ptr, ptr + size * size * 4);
        t = process.hrtime.bigint(); const img = soft.render(sc, i, size), b = img.data; tSoft += Number(process.hrtime.bigint() - t) / 1e6; nSoft++;
        let se = 0; const W = size * 3, strip = DUMP ? Buffer.alloc(W * size * 4) : null;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const q = (y * size + x) * 4, ra = a[q + 3] / 255, oa = b[q + 3] / 255;
          for (let ch = 0; ch < 3; ch++) { const rv = a[q + ch] * ra + 128 * (1 - ra), ov = b[q + ch] * oa + 128 * (1 - oa), d = rv - ov; se += d * d; if (strip) { strip[(y * W + x) * 4 + ch] = rv; strip[(y * W + size + x) * 4 + ch] = ov; strip[(y * W + 2 * size + x) * 4 + ch] = Math.min(255, Math.abs(d) * 4); } }
          if (strip) strip[(y * W + x) * 4 + 3] = strip[(y * W + size + x) * 4 + 3] = strip[(y * W + 2 * size + x) * 4 + 3] = 255;
        }
        const mse = se / (size * size * 3); r.psnr.push(+(mse ? 10 * Math.log10(65025 / mse) : 99).toFixed(1));
        if (strip) r.strips.push(strip);
      }
      r.frames = list; r.min = Math.min(...r.psnr);
      mod._rl_free(h);
    } catch (e) { r.error = String(e && e.message || e).slice(0, 200); r.min = -1; }
    res.push(r);
  }
  res.sort((a, b) => a.min - b.min);
  const ok = res.filter((r) => r.min >= MIN), err = res.filter((r) => r.error), mins = res.filter((r) => !r.error).map((r) => r.min).sort((a, b) => a - b);
  const pct = (q) => (mins.length ? mins[Math.min(mins.length - 1, Math.floor(mins.length * q))] : 0);
  console.log(`файлов ${res.length}, размер ${size}, кадров на файл ${NF}, ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  console.log(`сошлись с rlottie (худший кадр не ниже ${MIN} дБ): ${ok.length} из ${res.length} (${(ok.length / res.length * 100).toFixed(1)}%), ошибок ${err.length}`);
  console.log(`худший кадр файла, дБ: минимум ${pct(0)}, 5% ${pct(0.05)}, медиана ${pct(0.5)}, 95% ${pct(0.95)}`);
  console.log(`размер: .tgs ${(tgsBytes / 1024).toFixed(0)} КБ, .ecr ${(ecrBytes / 1024).toFixed(0)} КБ (${(ecrBytes / tgsBytes * 100).toFixed(1)}%), файлов, где .ecr больше .tgs: ${res.filter((r) => r.ecr > r.tgs).length}`);
  console.log(`время: сборка .ecr ${(tComp / res.length).toFixed(1)} мс на файл, кадр на процессоре ${(tSoft / Math.max(1, nSoft)).toFixed(1)} мс`);
  const miss = {}; for (const r of res) for (const m of r.miss || []) miss[m] = (miss[m] || 0) + 1;
  if (Object.keys(miss).length) console.log('замечания компилятора: ' + Object.entries(miss).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(', '));
  console.log('--- худшие:');
  for (const r of res.slice(0, WORST)) console.log((r.error ? 'ОШИБКА ' + r.error : r.psnr.join(' ')).padEnd(26), r.name, (r.miss && r.miss.length ? '[' + r.miss.join('; ') + ']' : ''));
  if (DUMP) {
    fs.mkdirSync(OUT, { recursive: true });
    for (const r of res.filter((x) => x.strips && x.strips.length).slice(0, DUMP)) { const f = path.join(OUT, path.basename(r.file).replace(/\.[^.]+$/, '') + '.png'); fs.writeFileSync(f, png(size * 3, size * r.strips.length, Buffer.concat(r.strips))); console.log('картинка: ' + f + '  кадры ' + r.frames.join(', ')); }
  }
  if (process.env.LIST) fs.writeFileSync(process.env.LIST, res.map((r) => JSON.stringify({ name: r.name, min: r.min, psnr: r.psnr, miss: r.miss, error: r.error, ecr: r.ecr, tgs: r.tgs })).join('\n') + '\n');
  process.exit(ok.length === res.length ? 0 : 3);
})().catch((e) => { console.error(e); process.exit(1); });
