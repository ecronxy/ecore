#!/usr/bin/env node
// Проверки правок без браузера: стек попаданий, патч поворота/масштаба/прозрачности/стопов, матрица и рамка узла.
// Эталон патча — тот же файл, где правка записана прямо в JSON: пиксели обязаны совпасть.
// usage: node tools/editcheck.js
'use strict';
const assert = require('assert');
const { compileLottie } = require('../src/ecr.js'), { Scene, Soft } = require('../src/ecore.js');

const K = (v) => ({ a: 0, k: v });
const rect = (cx, cy, w, h) => ({ ty: 'rc', d: 1, p: K([cx, cy]), s: K([w, h]), r: K(0), nm: 'r' });
const ell = (cx, cy, w, h) => ({ ty: 'el', d: 1, p: K([cx, cy]), s: K([w, h]), nm: 'e' });
const tr = (p = [0, 0], r = 0, s = [100, 100], o = 100) => ({ ty: 'tr', p: K(p), a: K([0, 0]), s: K(s), r: K(r), o: K(o), sk: K(0), sa: K(0) });
const fill = (c, nm = 'f') => ({ ty: 'fl', c: K(c), o: K(100), r: 1, nm });
const grad = (nm = 'g') => ({ ty: 'gf', o: K(100), r: 1, t: 1, nm, s: K([0, 0]), e: K([512, 0]), g: { p: 3, k: K([0, 1, 0, 0, 0.5, 0, 1, 0, 1, 0, 0, 1]) } });
const layer = (shapes, extra = {}) => Object.assign({ ddd: 0, ind: 1, ty: 4, nm: 'L', sr: 1, ao: 0, ip: 0, op: 60, st: 0, bm: 0,
  ks: { o: K(100), r: K(0), p: K([0, 0]), a: K([0, 0]), s: K([100, 100]) }, shapes }, extra);
const doc = (layers) => ({ v: '5.7.4', fr: 60, ip: 0, op: 60, w: 512, h: 512, nm: 't', ddd: 0, assets: [], layers });

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('ok  ' + name); };
const frameOf = (sc, size = 128) => new Soft().render(sc, 0, size).data;
const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d; };
const build = (j) => new Scene(compileLottie(j, { raw: true, src: true }).bin);
// патч обязан менять картинку (иначе совпадение с эталоном ничего не доказывает) и совпасть с правкой в JSON
const patchMatches = (sc, base, edited) => {
  assert.ok(diff(frameOf(build(base)), frameOf(build(edited))) > 20, 'правка должна менять картинку');
  const d = diff(frameOf(sc), frameOf(build(edited)));
  assert.ok(d <= 2, 'расхождение пикселей ' + d);
};

// 1. стек попаданий: сверху вниз, с группами
ok('pickAll: сверху вниз и группы', () => {
  const j = doc([layer([
    { ty: 'gr', nm: 'внешняя', np: 2, it: [
      { ty: 'gr', nm: 'внутренняя', np: 2, it: [ell(256, 256, 300, 300), fill([0, 0, 1, 1], 'синяя'), tr([0, 0])] },
      rect(256, 256, 200, 200), fill([1, 0, 0, 1], 'красная'), tr([0, 0])] },
  ])]);
  const sc = build(j);
  const hits = sc.pickAll(0, 512, 256, 256);
  assert.ok(hits.length >= 2, 'в точке два стиля: ' + hits.length);
  // верхний стиль — тот, чей цвет видно в центре кадра; имя заливки берётся у ближайшей именованной группы
  const px = frameOf(sc, 512), c = (256 * 512 + 256) * 4, top = hits[0].name === 'внутренняя' ? [0, 0, 255] : [255, 0, 0];
  assert.ok(px[c + 2] === top[2] && px[c] === top[0], 'в центре виден ' + hits[0].name + ': ' + px.slice(c, c + 3));
  assert.ok(hits.every((h, i, a) => a.findIndex((x) => x.uid === h.uid) === i), 'без повторов');
  assert.strictEqual(sc.pick(0, 512, 256, 256).uid, hits[0].uid, 'pick совпадает с первым из pickAll');
  assert.ok(Array.isArray(hits[0].groups) && hits[0].groups.length >= 1, 'у попадания есть группы');
});

// 2. патч поворота и масштаба слоя = правка ks в JSON
ok('patch слоя: поворот, масштаб, прозрачность как в JSON', () => {
  const base = doc([layer([{ ty: 'gr', nm: 'g', np: 2, it: [rect(0, 0, 160, 80), fill([0.2, 0.7, 0.3, 1]), tr([256, 256])] }])]);
  const sc = build(base);
  sc.patch('layers/0', { rotate: 30, scale: [1.5, 0.8], opacity: 0.6 });
  const edited = JSON.parse(JSON.stringify(base));
  edited.layers[0].ks = { o: K(60), r: K(30), p: K([0, 0]), a: K([0, 0]), s: K([150, 80]) };
  patchMatches(sc, base, edited);
});

// 3. патч группы: поворот вокруг точки привязки = правка в JSON
ok('patch группы: поворот как в JSON', () => {
  const grp = (r) => ({ ty: 'gr', nm: 'группа', np: 2, it: [rect(0, 0, 200, 60), fill([0.9, 0.2, 0.2, 1]), tr([256, 256], r)] });
  const base = doc([layer([grp(0)])]);
  const sc = build(base);
  // группа в исходнике — её список items: layers/0/shapes/0/it (трансформ группы лежит в нём последним)
  const gsrc = 'layers/0/shapes/0/it';
  assert.ok(sc.nodes.has(gsrc), 'группа есть в узлах: ' + [...sc.nodes.keys()].join(' '));
  sc.patch(gsrc, { rotate: 45 });
  patchMatches(sc, base, doc([layer([grp(45)])]));
});

// 4. стопы градиента: перекраска без пересборки = градиент с другими цветами в JSON
ok('patch стопов градиента как в JSON', () => {
  // стопы: позиция и rgb по порядку (жёлтый, голубой, пурпурный), прозрачности нет
  const gradK = (cols) => [0, cols[0], cols[1], cols[2], 0.5, cols[3], cols[4], cols[5], 1, cols[6], cols[7], cols[8]];
  const base = doc([layer([{ ty: 'gr', nm: 'g', np: 2, it: [rect(256, 256, 400, 400), grad(), tr([0, 0])] }])]);
  base.layers[0].shapes[0].it[1].g.k = K(gradK([1, 1, 0, 0, 1, 1, 1, 0, 1]));
  const sc = build(base);
  const gs = [...sc.nodes.entries()].find(([k, v]) => v.style && v.style.g);
  assert.ok(gs, 'градиентный стиль найден');
  sc.patch(gs[0], { stops: ['#ff0000', '#00ff00', '#0000ff'] });
  const edited = JSON.parse(JSON.stringify(base));
  edited.layers[0].shapes[0].it[1].g.k = K(gradK([1, 0, 0, 0, 1, 0, 0, 0, 1]));
  patchMatches(sc, base, edited);
});

// 5. мировая матрица узла и рамка
ok('worldAt и nodeBounds', () => {
  const j = doc([layer([{ ty: 'gr', nm: 'g', np: 2, it: [rect(0, 0, 100, 60), fill([1, 1, 1, 1]), tr([200, 150])] }], { ks: { o: K(100), r: K(0), p: K([100, 80]), a: K([0, 0]), s: K([100, 100]) } })]);
  const sc = build(j);
  const w = sc.worldAt('layers/0', 0);
  assert.ok(w, 'слой виден');
  assert.ok(Math.abs(w.m[4] - 100) < 1e-3 && Math.abs(w.m[5] - 80) < 1e-3, 'сдвиг слоя ' + w.m.slice(4));
  assert.ok(Math.abs(w.m[0] - 1) < 1e-6 && Math.abs(w.m[3] - 1) < 1e-6, 'масштаб 100%');
  const b = sc.nodeBounds('layers/0', 0, 512);
  assert.ok(b, 'рамка есть');
  // прямоугольник 100x60 с центром в (100+200, 80+150) = (300, 230)
  assert.ok(Math.abs((b[0] + b[2]) / 2 - 300) < 1.5 && Math.abs((b[1] + b[3]) / 2 - 230) < 1.5, 'центр рамки ' + b);
  assert.ok(Math.abs((b[2] - b[0]) - 100) < 2 && Math.abs((b[3] - b[1]) - 60) < 2, 'размер рамки ' + b);
  assert.strictEqual(sc.worldAt('layers/9', 0), null, 'неизвестный узел — null');
});

// 6. маски: инверсия, непрозрачность, расширение и вычитание по пикселям (lottie-web SVG — эталон семантики)
const maskPath = (x0, y0, x1, y1) => ({ c: true, v: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]] });
const maskOf = (mode, path, extra = {}) => Object.assign({ inv: false, mode, nm: 'm', o: K(100), x: K(0), pt: K(path) }, extra);
const fullLayer = (masks, hasMask = true) => layer([{ ty: 'gr', nm: 'g', np: 2, it: [rect(256, 256, 512, 512), fill([0, 0.8, 0.2, 1]), tr([0, 0])] }],
  Object.assign({ masksProperties: masks }, hasMask === null ? {} : { hasMask }));
// альфа в точке кадра 128 px (единицы сцены 512 → 1 px = 4 единицы)
const alphaAt = (sc, x, y) => frameOf(sc, 128)[(y * 128 + x) * 4 + 3];
const check = (name, masks, points, hasMask) => ok(name, () => {
  const sc = build(doc([fullLayer(masks, hasMask)]));
  for (const [x, y, want, tol] of points) {
    const got = alphaAt(sc, x, y);
    assert.ok(Math.abs(got - want) <= tol, name + ': в точке (' + x + ',' + y + ') альфа ' + got + ', ждали ' + want);
  }
});
check('маска: квадрант добавляется', [maskOf('a', maskPath(0, 0, 256, 256))], [[32, 32, 255, 2], [96, 96, 0, 2]], true);
check('маска: инверсия закрывает квадрант и открывает остальное', [maskOf('a', maskPath(0, 0, 256, 256), { inv: true })], [[32, 32, 0, 2], [96, 96, 255, 2]], true);
check('маска: непрозрачность 50% даёт половину альфы', [maskOf('a', maskPath(0, 0, 256, 256), { o: K(50) })], [[32, 32, 128, 3], [96, 96, 0, 2]], true);
check('маска: расширение +30 расширяет контур', [maskOf('a', maskPath(128, 128, 384, 384), { x: K(30) })], [[28, 64, 255, 2], [20, 64, 0, 2]], true);
check('маска: расширение -40 сужает контур', [maskOf('a', maskPath(64, 64, 448, 448), { x: K(-40) })], [[30, 64, 255, 2], [20, 64, 0, 2]], true);
check('маска: вычитание вырезает квадрант', [maskOf('a', maskPath(0, 0, 512, 512)), maskOf('s', maskPath(0, 0, 256, 256))], [[32, 32, 0, 2], [100, 100, 255, 2]], true);
check('маска без hasMask не применяется', [maskOf('a', maskPath(0, 0, 256, 256))], [[96, 96, 255, 2]], false);

// 7. контуры для подсветки совпадают с попаданиями: точка внутри контура попадает в его стиль, кадр не пересчитывается дважды
ok('outlines: контур стиля содержит точку попадания', () => {
  const j = doc([layer([{ ty: 'gr', nm: 'g', np: 2, it: [rect(256, 256, 200, 200), fill([1, 0, 0, 1], 'кр'), tr([0, 0])] }])]);
  const sc = build(j);
  const hit = sc.pickAll(0, 512, 256, 256);
  assert.ok(hit.length >= 1, 'попадание в центре есть');
  const outs = sc.outlines([hit[0].uid], 0, 512);
  assert.ok(outs.length >= 1 && outs[0].pts.length >= 8, 'контур есть: ' + outs.length);
  // прямоугольник 200×200 в центре 512-холста: вершины на 156 и 356
  const xs = Array.from(outs[0].pts).filter((_, i) => i % 2 === 0), ys = Array.from(outs[0].pts).filter((_, i) => i % 2 === 1);
  assert.ok(Math.min(...xs) > 150 && Math.max(...xs) < 362 && Math.min(...ys) > 150 && Math.max(...ys) < 362, 'контур в нужных пределах');
  const again = sc.pickAll(0, 512, 260, 260);
  assert.ok(again.length === hit.length, 'повторный пикер на том же кадре даёт то же');
});

console.log('\n' + pass + ' проверок прошли');
