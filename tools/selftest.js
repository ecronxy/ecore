#!/usr/bin/env node
// Самопроверка переопределений без пересборки, оба пути рисования (2d и gl):
//  1) смещение через Animation.set({x}) даёт ту же картинку, что такое же смещение, записанное в исходнике (transform);
//  2) цвет через Animation.set({color}) перекрашивает заливку, reset() возвращает кадр к исходному.
// usage: node tools/selftest.js [examples/nick.svg]
//   PLAYWRIGHT=путь к playwright-core, CHROME=путь к chrome-headless-shell, CHROME_LIBS=папка с библиотеками,
//   CHROME_ARGS=свои флаги браузера через пробел (при малом запасе памяти: --disable-gpu)
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const { compileSource } = require('../src/source.js'), { compileLottie } = require('../src/ecr.js');
const file = process.argv[2] || 'examples/nick.svg', FRAME = 60, SHIFT = 60;
const CHROME = process.env.CHROME || path.join(process.env.HOME, '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');
const fonts = {}; for (const f of fs.readdirSync(path.join(ROOT, 'fonts'))) if (/\.ttf$/i.test(f)) fonts[f] = fs.readFileSync(path.join(ROOT, 'fonts', f));
const svg = fs.readFileSync(path.join(ROOT, file), 'utf8');
const enc = (text) => Buffer.from(compileLottie(compileSource(text, { fonts }).lottie).bin).toString('base64');
// первый элемент с id без собственного transform: его сдвигаем и в исходнике, и переопределением
// статичный элемент (без анимации по id и по классу): у анимированного перенос через transform в исходнике
// и перенос группы переопределением ведут себя по-разному (атрибут transform уходит внутрь поворота), сравнивать нельзя
const animated = (tag, body) => { const id = (tag.match(/ id="([^"]+)"/) || [])[1], cls = ((tag.match(/ class="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean); return (id && new RegExp('#' + id + '\\b[^{}]*\\{[^}]*animation').test(body)) || cls.some((c) => new RegExp('\\.' + c + '\\b[^{}]*\\{[^}]*animation').test(body)); };
const tags = [...svg.matchAll(/<(polygon|polyline|path|circle|ellipse|rect|line|g) [^>]*id="[^"]+"[^>]*>/g)].map((m) => m[0]).filter((t) => !/transform=/.test(t));
const pick = tags.find((t) => !animated(t, svg));
const id = pick && (pick.match(/ id="([^"]+)"/) || [])[1];
if (!id) { console.log(file + ': нет статичного элемента с id, сверка переноса с исходником пропущена'); process.exit(0); }
const movedSvg = svg.replace(new RegExp('<(polygon|polyline|path|circle|ellipse|rect|line|g) id="' + id + '"'), '<$1 id="' + id + '" transform="translate(' + SHIFT + ' 0)"');
const original = enc(svg), shiftedInSource = enc(movedSvg);
const playerSrc = fs.readFileSync(path.join(ROOT, 'src', 'ecore.js'), 'utf8');

// выполняется в браузере
function scenario({ original, shiftedInSource, backend, id, frame, shift }) {
  return (async () => {
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const mount = async (b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const an = ECore.mount(document.body.appendChild(document.createElement('div')), bin, { autoplay: false, size: 256, backend });
      await an.ready;
      if (backend === 'gl') { let w = 0; while (!ECore.gl().ready() && w++ < 600) await raf(); if (!ECore.gl().ready()) throw new Error('WebGL не готов'); }
      return an;
    };
    const shot = (an) => { an.seek(Math.min(frame, an.frames - 1)); return an.canvas.getContext('2d').getImageData(0, 0, an.canvas.width, an.canvas.height).data.slice(); };
    const count = (a, b, t) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) > t) n++; return n; };
    // элемент в этом кадре может быть полупрозрачным, поэтому порог по альфе низкий
    const greenish = (d) => { let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40 && d[i + 1] > 200 && d[i] < 80 && d[i + 2] < 80) n++; return n; };

    const a = await mount(shiftedInSource), inSource = shot(a);
    const b = await mount(original), base = shot(b);
    b.set(id, { x: shift });
    const byOverride = shot(b);
    const opaque = inSource.filter((v, i) => i % 4 === 3 && v > 128).length, diffs = count(inSource, byOverride, 64);
    b.set(id, { color: '#00ff00' }); const painted = shot(b);
    b.reset(id); const back = shot(b);
    return {
      used: b.used, element: id, frame, elements: b.names().length,
      moveSameAsSource: { pixelsDiffOver64: diffs, opaquePixels: opaque, ok: diffs <= Math.max(60, opaque * 0.02) },
      colorPaints: greenish(painted) > 0, greenPixels: greenish(painted),
      // первый кадр браузер мог нарисовать видеокартой, а после чтения пикселей перейти на процессор: края отличаются на доли тона
      resetRestoresBase: count(base, back, 48) === 0,
    };
  })();
}

(async () => {
  const { chromium } = require(process.env.PLAYWRIGHT || 'playwright-core');
  const env = Object.assign({}, process.env); if (process.env.CHROME_LIBS) env.LD_LIBRARY_PATH = process.env.CHROME_LIBS;
  const browser = await chromium.launch({ executablePath: CHROME, env, args: process.env.CHROME_ARGS ? ['--no-sandbox', '--disable-dev-shm-usage'].concat(process.env.CHROME_ARGS.split(/\s+/).filter(Boolean)) : ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  await page.setContent('<!doctype html><meta charset="utf-8"><body style="margin:0"></body>');
  await page.addScriptTag({ content: playerSrc });
  for (const backend of ['2d', 'gl']) {
    const r = await page.evaluate(scenario, { original, shiftedInSource, backend, id, frame: FRAME, shift: SHIFT });
    console.log(file, backend, JSON.stringify(r));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
