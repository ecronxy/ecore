// Страница eCore. Примеры уже внутри страницы (исходник и готовый .ecr), поэтому переключение
// не ждёт ни сети, ни компилятора. Компилятор и шрифты докачиваются в фоне и нужны, когда правят текст.
// Цвет и перенос элемента меняются без пересборки: ECore.Animation.set() сразу действует на кадр.
(function () {
  'use strict';
  const D = window.ECORE, $ = (id) => document.getElementById(id);
  const stage = $('stage'), tabs = $('tabs'), slot = $('slot'), slotRow = $('slot-row'), src = $('source'), stat = $('stat');
  const elements = $('elements'), list = $('element-list'), tools = $('element-tools'), color = $('element-color'), reset = $('element-reset');
  const byId = Object.fromEntries(D.examples.map((e) => [e.id, e]));
  const bytes = (b64) => { const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
  const kb = (n) => (n / 1024).toFixed(1).replace('.', ',') + ' КБ';

  ECore.setBackend(new URLSearchParams(location.search).get('backend'));   // ?backend=2d или gl: сравнить способы рисования
  const first = D.examples[0];
  const anim = ECore.mount(stage, bytes(first.ecr));
  const state = { id: first.id, text: Object.fromEntries(D.examples.map((e) => [e.id, e.svg])), slots: {}, last: null, tgs: null, sel: null, drag: null, over: {} };
  const fonts = {};
  let compiler = null, seq = 0, queued = false, statBase = '';
  // чем сейчас рисуется сцена; если видеокарта нарисовала кадр неверно, плеер сам уходит на canvas 2d и говорит, что было не так
  const how = () => { const f = ECore.glFault ? ECore.glFault() : ''; return (anim.used === 'gl' ? 'видеокарта' : anim.used === '2d' ? 'canvas 2d' : '…') + (f ? ' (видеокарта ошиблась: ' + f + ')' : ''); };
  const setStat = (base) => { statBase = base; stat.textContent = base + ' · ' + how(); };
  setInterval(() => { if (statBase) stat.textContent = statBase + ' · ' + how(); }, 1000);

  const script = (url) => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = url; s.onload = ok; s.onerror = () => bad(new Error('не загрузился ' + url)); document.head.appendChild(s); });
  const ensureCompiler = () => compiler || (compiler = script('ecore-compiler.js'));
  const loadFont = (k) => (fonts[k] ? Promise.resolve() : fetch(D.fonts[k]).then((r) => { if (!r.ok) throw new Error('шрифт не загрузился: ' + D.fonts[k]); return r.arrayBuffer(); }).then((b) => { fonts[k] = b; }));
  // шрифты докачиваются по именам из исходника
  function needFonts(text) {
    const want = new Set(), re = /font-family\s*[:=]\s*["']?([^;"<>]+)/g; let m;
    while ((m = re.exec(text))) for (const f of m[1].split(',')) { const k = f.trim().replace(/^['"]|['"]$/g, '').toLowerCase(); if (D.fonts[k]) want.add(k); }
    if (!want.size && /<text[\s>]/.test(text)) want.add(Object.keys(D.fonts)[0]);
    return Promise.all([...want].map(loadFont));
  }
  const gzip = (text) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  function show(id, text) { const box = $(id); box.hidden = !text; $(id + '-text').textContent = text || ''; }
  const overOf = (name) => state.over[name] || (state.over[name] = {});
  // смещения и цвета, которые видит пользователь, уходят и в скачиваемый .ecr
  const overrides = () => { const o = {}; for (const [n, v] of Object.entries(state.over)) { const e = {}; if (v.x) e.x = v.x; if (v.y) e.y = v.y; if (v.color) e.color = v.color; if (Object.keys(e).length) o[n] = e; } return o; };

  // собрать исходник из поля: нужно при правке текста и для скачивания
  async function build(text, id) {
    await ensureCompiler();
    await needFonts(text);
    return ECore.build(text, { fonts, slots: state.slots[id] || {}, over: overrides() });
  }

  async function rebuild() {
    const my = ++seq, text = src.value, id = state.id;
    try {
      const t = performance.now(), r = await build(text, id);
      if (my !== seq) return;
      const ms = performance.now() - t;
      state.last = r; state.tgs = null;
      const shown = anim.setSource(r.ecr).then(renderElements);
      const s = r.slots[0];
      slotRow.hidden = !s;
      if (s && document.activeElement !== slot) slot.value = s.text;
      show('error', ''); show('notes', r.warnings.join('\n'));
      const head = 'собрано за ' + ms.toFixed(1).replace('.', ',') + ' мс · .ecr ' + kb(r.ecr.length);
      setStat(head);
      await shown;
      const t2 = ECore.forTgs(r.lottie), gz = await gzip(t2.json);
      if (my !== seq) return;
      state.tgs = gz;
      setStat(head + ' · .tgs ' + kb(gz.byteLength));
      const tg = t2.problems.concat(gz.byteLength > 65536 ? ['файл больше 64 КБ'] : []);
      if (tg.length) show('notes', r.warnings.concat(tg.map((p) => 'для telegram: ' + p)).join('\n'));
    } catch (e) {
      if (my !== seq) return;
      show('notes', ''); show('error', e && e.message ? e.message : String(e));
    }
  }
  const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; rebuild(); }); };

  // готовый пример: без компилятора, сразу
  function showPrebuilt(ex) {
    state.last = null; state.tgs = null;
    anim.setSource(bytes(ex.ecr)).then(renderElements);
    slotRow.hidden = !ex.slots.length;
    if (ex.slots.length) slot.value = ex.slots[0].text;
    show('error', ''); show('notes', ex.warnings.join('\n'));
    setStat('.ecr ' + kb(bytes(ex.ecr).length) + ' · готово');
  }

  async function pick(id) {
    const ex = byId[id]; if (!ex) return;
    seq++;
    // правки прежнего примера не переносятся на новый
    for (const name of Object.keys(state.over)) anim.reset(name);
    state.over = {}; state.id = id; state.sel = null;
    for (const b of tabs.children) { const on = b.dataset.id === id; b.dataset.selected = on; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; if (on) b.appendChild(tabs.querySelector('.tabs__indicator')); }
    src.value = state.text[id]; slot.value = '';
    if (state.slots[id] || state.text[id] !== ex.svg) rebuild(); else showPrebuilt(ex);
  }

  tabs.addEventListener('click', (e) => { const b = e.target.closest('.tabs__tab'); if (b) pick(b.dataset.id); });
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const list = [...tabs.children], i = list.findIndex((b) => b.dataset.id === state.id), n = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
    n.focus(); pick(n.dataset.id); e.preventDefault();
  });
  src.addEventListener('input', () => { state.text[state.id] = src.value; later(); });
  slot.addEventListener('input', () => { const s = (state.last ? state.last.slots : byId[state.id].slots)[0]; if (!s) return; (state.slots[state.id] || (state.slots[state.id] = {}))[s.name] = slot.value; later(); });

  // элементы сцены: имена из исходника (id), кнопки выбирают элемент
  function renderElements() {
    const els = anim.names();
    elements.hidden = !els.length;
    list.replaceChildren(...els.map((e) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'button button--secondary element'; b.dataset.name = e.name; b.textContent = e.name;
      b.setAttribute('aria-pressed', e.name === state.sel);
      b.addEventListener('click', () => selectEl(state.sel === e.name ? null : e.name));
      return b;
    }));
    if (state.sel && !els.some((e) => e.name === state.sel)) state.sel = null;
    selectEl(state.sel);
  }
  function selectEl(name) {
    state.sel = name;
    for (const b of list.children) b.setAttribute('aria-pressed', b.dataset.name === name);
    const e = name && anim.names().find((x) => x.name === name);
    tools.hidden = !e;
    stage.style.touchAction = e ? 'none' : '';   // на сцене с выбранным элементом тянем его, а не страницу
    if (e) { color.disabled = !e.paint; color.value = (state.over[name] && state.over[name].color) || e.color || '#000000'; }
  }
  color.addEventListener('input', () => { if (!state.sel) return; overOf(state.sel).color = color.value; anim.set(state.sel, { color: color.value }); });
  reset.addEventListener('click', () => { if (!state.sel) return; const n = state.sel; delete state.over[n]; anim.reset(n); selectEl(n); });

  // перенос: тянем выбранный элемент по сцене; пиксели переводятся в единицы исходника
  stage.addEventListener('pointerdown', (e) => {
    if (!state.sel || e.button > 0) return;
    const o = overOf(state.sel);
    state.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: o.x || 0, oy: o.y || 0 };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    const d = state.drag; if (!d || e.pointerId !== d.id) return;
    const k = ((anim.player && anim.player.scene.h.w) || 512) / (stage.clientWidth || 1), o = overOf(state.sel);
    o.x = Math.round((d.ox + (e.clientX - d.x) * k) * 10) / 10; o.y = Math.round((d.oy + (e.clientY - d.y) * k) * 10) / 10;
    anim.set(state.sel, { x: o.x, y: o.y });
  });
  const endDrag = (e) => { if (state.drag && e.pointerId === state.drag.id) state.drag = null; };
  stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);

  function save(data, name) {
    const a = document.createElement('a'), url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('get-tgs').addEventListener('click', async () => {
    const r = await build(src.value, state.id);
    save(await gzip(ECore.forTgs(r.lottie).json), state.id + '.tgs');
  });
  $('get-ecr').addEventListener('click', async (e) => {
    e.preventDefault();
    const r = await build(src.value, state.id);
    save(r.ecr, state.id + '.ecr');
  });

  // пока страница свободна: компилятор (28 КБ), чтобы первая правка текста была быстрой
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1200));
  window.addEventListener('load', () => idle(() => ensureCompiler().catch(() => {})));   // шрифты (470 КБ) докачиваются только при правке текста

  // первый пример уже собран в разметке: показываем его исходник и элементы, когда сцена готова
  src.value = state.text[state.id];
  setStat('.ecr ' + kb(bytes(first.ecr).length) + ' · готово');
  anim.ready.then(renderElements);
})();
