#!/usr/bin/env node
// Собирает dist/: страницу-студию. Всё, что нужно для первого показа и переключения примеров,
// уже внутри index.html: плеер, исходники и готовые .ecr примеров, первый кадр каждого подарка (постер).
// Компилятор и шрифты докачиваются в фоне, когда страница свободна, и нужны только при правке исходника.
// Раздел «готовые tgs» собирается из папки gifts/, если она есть: сами tgs в репозиторий не входят, положите туда свои.
// usage: node tools/build-site.js
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'dist'), P = (...a) => path.join(ROOT, ...a);
const { compileLottie } = require('../src/ecr.js'), { compileSource, parseFont } = require('../src/source.js');
const EXAMPLES = [['nick', 'ник'], ['heart', 'сердце'], ['pop', 'привет'], ['done', 'готово']];
const kb = (n) => (n / 1024).toFixed(1).replace('.', ',');
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true }); fs.copyFileSync(from, path.join(OUT, to)); };
// JSON внутри <script>: '<' экранируем, чтобы текст исходника не закрыл тег
const inline = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const fontBufs = {}, fonts = {};
for (const f of fs.readdirSync(P('fonts'))) if (/\.ttf$/i.test(f)) { const b = fs.readFileSync(P('fonts', f)); fontBufs[f] = b; fonts[parseFont(b).family.toLowerCase()] = 'fonts/' + f; copy(P('fonts', f), 'fonts/' + f); }

// примеры собираются здесь, а не в браузере: страница открывается уже с готовым стикером
const examples = EXAMPLES.map(([id, title]) => {
  const svg = fs.readFileSync(P('examples', id + '.svg'), 'utf8');
  const r = compileSource(svg, { fonts: fontBufs });
  if (r.warnings.length) console.log(id + ': ' + r.warnings.join('; '));
  copy(P('examples', id + '.svg'), 'examples/' + id + '.svg');
  const ecr = Buffer.from(compileLottie(r.lottie).bin);
  fs.writeFileSync(path.join(OUT, 'examples', id + '.ecr'), ecr);
  return { id, title, svg, ecr: ecr.toString('base64'), slots: r.slots, warnings: r.warnings, w: r.lottie.w };
});
const tabs = EXAMPLES.map(([id, title], i) => `<button class="tabs__tab" role="tab" type="button" data-id="${id}" data-selected="${!i}" aria-selected="${!i}" tabindex="${i ? -1 : 0}">${title}${i ? '' : '<span class="tabs__indicator"></span>'}</button>`).join('');

fs.mkdirSync(path.join(OUT, 'gifts'), { recursive: true });
const gifts = (fs.existsSync(P('gifts')) ? fs.readdirSync(P('gifts')) : []).filter((f) => /\.tgs$/.test(f)).sort().map((f) => {
  const raw = fs.readFileSync(P('gifts', f)), name = f.replace(/\.tgs$/, ''), j = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  const c = compileLottie(j), still = compileLottie(j, { still: true });
  if (Object.keys(c.unsupported).length) console.log(name + ': ' + Object.keys(c.unsupported).join(', '));
  fs.writeFileSync(path.join(OUT, 'gifts', name + '.ecr'), c.bin);
  fs.writeFileSync(path.join(OUT, 'gifts', name + '.still.ecr'), still.bin);
  const title = name.split('__')[0].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return `<figure><div class="card lg-tile tile"><e-core src="gifts/${name}.ecr" still="gifts/${name}.still.ecr"></e-core></div><figcaption>${title}<span>${kb(c.bin.length)} КБ<i>, в tgs ${kb(raw.length)}</i></span></figcaption></figure>`;
}).join('\n      ');

const player = fs.readFileSync(P('src', 'ecore.js'), 'utf8');
fs.writeFileSync(path.join(OUT, 'ecore.js'), player);
fs.writeFileSync(path.join(OUT, 'ecore-compiler.js'), fs.readFileSync(P('src', 'ecr.js'), 'utf8') + '\n' + fs.readFileSync(P('src', 'source.js'), 'utf8'));
for (const f of ['site.css', 'app.js', 'tier-glass.css', 'heroui.min.css']) copy(P('site', f), f);
const data = inline({ examples, fonts });
// без готовых tgs раздел с ними и подпись под ним убираются целиком
const page = fs.readFileSync(P('site', 'index.html'), 'utf8'), shell = gifts ? page.replace(/[ \t]*<!--\/?TGS-->\n/g, '') : page.replace(/[ \t]*<!--TGS-->[\s\S]*?<!--\/TGS-->\n/g, '');
const html = shell.replace('/*TABS*/', () => tabs).replace('/*GIFTS*/', () => gifts).replace('/*PLAYER*/', () => player).replace('/*DATA*/', () => data);
fs.writeFileSync(path.join(OUT, 'index.html'), html);
const gz = (f) => zlib.gzipSync(fs.readFileSync(path.join(OUT, f)), { level: 9 }).length;
console.log(`dist/index.html ${kb(html.length)} КБ (gzip ${kb(gz('index.html'))}), плеер gzip ${kb(gz('ecore.js'))}, компилятор gzip ${kb(gz('ecore-compiler.js'))}`);
