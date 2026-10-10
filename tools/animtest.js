#!/usr/bin/env node
// Проверка верхнего уровня плеера без браузера: Animation, общий цикл кадров, бюджет времени, очередь, правки на лету.
// Холст, requestAnimationFrame и наблюдатели подменены, код плеера настоящий.
// usage: node tools/animtest.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const { compileLottie } = require('../src/ecr.js'), { compileSource } = require('../src/source.js');
let now = 0, rafQ = [], draws = 0;
const ctx2d = (canvas) => { const g = { addColorStop() {} }; return { canvas, save() {}, restore() {}, clip() {}, rect() {}, setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() { draws++; }, stroke() { draws++; }, drawImage() {}, putImageData() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), createLinearGradient: () => g, createRadialGradient: () => g, globalAlpha: 1, globalCompositeOperation: 'source-over' }; };
class HTMLCanvasElement { constructor() { this.width = 300; this.height = 150; this.clientWidth = 160; this.style = {}; this._ctx = null; } getContext(t) { return t === '2d' ? (this._ctx || (this._ctx = ctx2d(this))) : null; } getBoundingClientRect() { return { left: 10, top: 20, width: this.clientWidth, height: this.clientWidth }; } remove() {} addEventListener() {} }
const observers = [];
const win = {
  HTMLCanvasElement, devicePixelRatio: 2, performance: { now: () => now }, console, setTimeout: (f) => { f(); return 0; }, TextDecoder, Float32Array, Float64Array, Int32Array, Uint8Array, Uint16Array, Uint8ClampedArray, Math, Array, Object, Promise, Map, Set, Error, String, Number, isFinite, parseInt,
  matchMedia: () => ({ matches: false }), requestAnimationFrame: (f) => { rafQ.push(f); return rafQ.length; },
  OffscreenCanvas: function (w, h) { const c = new HTMLCanvasElement(); c.width = w; c.height = h; return c; },
  IntersectionObserver: function (cb) { this.observe = () => { observers.push(cb); cb([{ isIntersecting: true }]); }; this.disconnect = () => {}; },
  ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  document: { createElement: () => new HTMLCanvasElement() }, addEventListener() {},
  fetch: (url) => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(fs.readFileSync(path.join(ROOT, url))) }),
};
win.window = win; win.globalThis = win;
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'ecore.js'), 'utf8'), win, { filename: 'ecore.js' });
const E = win.ECore, fails = [];
const ok = (cond, name, extra) => { console.log((cond ? 'ok   ' : 'СБОЙ ') + name + (extra ? '  ' + extra : '')); if (!cond) fails.push(name); };
// один кадр экрана: время идёт на dt мс, все ждущие обработчики вызываются
const frame = (dt) => { now += dt; const q = rafQ; rafQ = []; for (const f of q) f(now); };
// сцены для проверки: четыре своих примера из examples/
const FONTS = {}; for (const f of fs.readdirSync(path.join(ROOT, 'fonts'))) if (/\.ttf$/i.test(f)) FONTS[f] = fs.readFileSync(path.join(ROOT, 'fonts', f));
const built = new Map();
const gift = (n) => { if (!built.has(n)) built.set(n, compileLottie(compileSource(fs.readFileSync(path.join(ROOT, 'examples', n), 'utf8'), { fonts: FONTS }).lottie).bin); return built.get(n); };

(async () => {
  const names = fs.readdirSync(path.join(ROOT, 'examples')).filter((f) => f.endsWith('.svg')).sort();
  E.setBackend('2d');
  // 1. одна анимация: загрузка, размер холста, кадры идут по времени
  const a = E.mount(new HTMLCanvasElement(), gift(names[0]));
  await a.ready;
  ok(a.frames > 1 && a.fps > 0, 'анимация загрузилась', a.frames + ' кадров, ' + a.fps + ' к/с');
  ok(a.canvas.width === 320, 'холст подогнан под размер и плотность экрана', 'ширина ' + a.canvas.width);
  ok(a.playing, 'играет сама');
  for (let i = 0; i < 30; i++) frame(16.7);
  ok(Math.abs(a.frame - 29 * 16.7 * a.fps / 1000) < 1.5, 'кадр соответствует прошедшему времени', 'кадр ' + a.frame.toFixed(1));
  // 2. экран 120 Гц: один и тот же кадр файла второй раз не рисуется
  let d0 = draws; const f0 = Math.floor(a.frame);
  for (let i = 0; i < 24; i++) frame(8.33);
  const perFrame = (draws - d0) / Math.max(1, Math.floor(a.frame) - f0), stylesPerFrame = a.scene.inst;
  ok(perFrame < stylesPerFrame * 1.3, 'на экране 120 Гц кадр файла рисуется один раз', 'рисований на кадр ' + perFrame.toFixed(0) + ', стилей в кадре ' + stylesPerFrame);
  // 3. пауза, перемотка, конец без повтора
  a.pause(); d0 = draws; for (let i = 0; i < 5; i++) frame(16.7);
  ok(draws === d0, 'на паузе не рисует');
  a.seek(10); ok(Math.floor(a.frame) === 10 && draws > d0, 'перемотка рисует нужный кадр');
  let done = 0; const once = E.mount(new HTMLCanvasElement(), gift(names[1]), { loop: false, onComplete: () => done++ });
  await once.ready; for (let i = 0; i < 400 && !done; i++) frame(16.7);
  ok(done === 1 && !once.playing && Math.floor(once.frame) === once.frames - 1, 'без повтора останавливается на последнем кадре и сообщает');
  once.destroy(); a.destroy();
  // 4. очередь: одновременно играет не больше maxLive
  E.setMaxLive(3);
  const many = []; for (let i = 0; i < 6; i++) { const m = E.mount(new HTMLCanvasElement(), gift(names[i % names.length])); await m.ready; many.push(m); }
  const before = many.map((m) => m.frame); for (let i = 0; i < 20; i++) frame(16.7);
  const moved = many.filter((m, i) => m.frame !== before[i]).length;
  ok(moved === 3, 'из шести играют три, остальные ждут', 'идут ' + moved);
  many[0].pause(); for (let i = 0; i < 5; i++) frame(16.7);
  ok(many.filter((m) => m.playing && m.frame !== 0).length >= 3, 'освободившееся место занимает ждущая анимация');
  // очередь по кругу: доигравшая анимация уступает место, поэтому за несколько кругов играют все восемь, а не первые три
  for (const m of many) m.destroy();
  many.length = 0; E.setMaxLive(3);
  for (let i = 0; i < 8; i++) { const m = E.mount(new HTMLCanvasElement(), gift(names[i % names.length])); await m.ready; many.push(m); }
  const played = new Set(); let liveMax = 0;
  for (let i = 0; i < 1400; i++) { const fb = many.map((m) => m.frame); frame(16.7); let moving = 0; many.forEach((m, k) => { if (m.frame !== fb[k]) { played.add(k); moving++; } }); if (moving > liveMax) liveMax = moving; }
  ok(played.size === 8 && liveMax <= 3, 'очередь идёт по кругу: играют все восемь, одновременно не больше трёх', 'играли ' + played.size + ' из 8, одновременно до ' + liveMax);
  ok(rafQ.length === 1, 'цикл кадров один, сколько бы раз анимации ни менялись местами', 'заказано циклов: ' + rafQ.length);
  for (const m of many) m.destroy();
  many.length = 0;
  for (let i = 0; i < 6; i++) { const m = E.mount(new HTMLCanvasElement(), gift(names[i % names.length])); await m.ready; many.push(m); }
  // 5. бюджет: если кадры дорогие, за один кадр экрана рисуются не все, но по кругу доходит очередь до каждой
  E.setMaxLive(6); E.setBudget(4, 2);
  const cost = 3; const real = win.performance.now; let extra = 0; win.performance.now = () => now + extra;
  for (const m of many) { const p = m.player, r = p.render.bind(p); p.render = (i) => { extra += cost; return r(i); }; m.play(); }
  for (let i = 0; i < 3; i++) frame(16.7);
  const fb = many.map((m) => m.frame); extra = 0; frame(16.7);
  const stepped = many.filter((m, i) => m.frame !== fb[i]).length;
  ok(stepped >= 1 && stepped < 6, 'дорогие кадры: за один кадр экрана рисуется часть анимаций', stepped + ' из 6 при цене ' + cost + ' мс и бюджете 4 мс');
  const seen = new Set(); for (let k = 0; k < 8; k++) { const fb2 = many.map((m) => m.frame); extra = 0; frame(16.7); many.forEach((m, i) => { if (m.frame !== fb2[i]) seen.add(i); }); }
  ok(seen.size === 6, 'никто не голодает: за несколько кадров экрана очередь дошла до всех', seen.size + ' из 6');
  win.performance.now = real;
  for (const m of many) m.destroy();
  for (let i = 0; i < 3; i++) frame(16.7);
  ok(rafQ.length === 0, 'после destroy цикл кадров остановлен');
  // 6. правки на лету по имени и по пути узла, выбор и рамка
  require('../src/source.js');
  const fonts = {}; for (const f of fs.readdirSync(path.join(ROOT, 'fonts'))) if (/\.ttf$/i.test(f)) fonts[f] = fs.readFileSync(path.join(ROOT, 'fonts', f));
  const built = require('../src/source.js').build(fs.readFileSync(path.join(ROOT, 'examples', 'heart.svg'), 'utf8'), { fonts });
  const h = E.mount(new HTMLCanvasElement(), built.ecr, { autoplay: false }); await h.ready;
  const els = h.names(); ok(els.length > 0 && els.some((e) => e.paint), 'у примера есть именованные элементы', els.map((e) => e.name).join(', '));
  const el = els.find((e) => e.paint && e.move) || els.find((e) => e.paint);
  d0 = draws; h.set(el.name, { color: '#00ff00', x: 12 }); ok(draws > d0, 'set() сразу перерисовывает кадр на паузе');
  const b = h.bounds(el.name); ok(b && b.right > b.left && b.bottom > b.top, 'bounds() даёт рамку элемента в координатах экрана', b ? [b.left, b.top, b.right, b.bottom].map((v) => v.toFixed(0)).join(',') : 'нет');
  const hit = b ? h.pick((b.left + b.right) / 2, (b.top + b.bottom) / 2) : null; ok(!!hit, 'pick() находит элемент под точкой', hit ? hit.name : 'ничего');
  h.reset(el.name); h.destroy();
  console.log(fails.length ? '\nСБОЕВ: ' + fails.length : '\nвсё прошло');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
