// eCore. Copyright (c) 2026 ecronx. Лицензия CPAL 1.0, полный текст в файле LICENSE. Пользоваться можно бесплатно,
// если в интерфейсе продукта видна надпись «Rendered with eCore» со ссылкой на https://tier.guru/ecore/.
// eCore: исходник -> сцена.
// Исходник это обычный SVG с CSS-анимацией (@keyframes + animation). Текст в нём остаётся текстом:
// <text> превращается в кривые здесь, по таблице глифов шрифта, поэтому слово меняется одной строкой.
// На выходе сцена в раскладке Lottie: из неё ecr.js делает .ecr для плеера, а gzip даёт обычный .tgs.
// Работает и в Node, и в браузере, без зависимостей. Правила формата: SPEC.md.
(function (G) {
  'use strict';

  class ECoreError extends Error { constructor(msg, line) { super(line ? 'строка ' + line + ': ' + msg : msg); this.name = 'ECoreError'; this.line = line || 0; } }

  // ───────── числа и матрицы ─────────
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const I = [1, 0, 0, 1, 0, 0];
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const T = (x, y) => [1, 0, 0, 1, x, y];
  const R = (deg) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
  const S = (x, y) => [x, 0, 0, y, 0, 0];
  const pt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const isI = (m) => Math.abs(m[0] - 1) + Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[3] - 1) + Math.abs(m[4]) + Math.abs(m[5]) < 1e-9;
  const TRS = (o, t, r, s) => mul(mul(mul(mul(T(o[0], o[1]), T(t[0], t[1])), R(r[0])), S(s[0], s[1])), T(-o[0], -o[1]));
  const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  const lerp = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);

  // ───────── разбор значений ─────────
  const len = (s) => { const v = parseFloat(s); return isFinite(v) ? v : 0; };
  const time = (s) => (/ms$/.test(s) ? parseFloat(s) / 1000 : parseFloat(s));
  const ang = (s) => { const v = parseFloat(s); return /rad$/.test(s) ? v * 180 / Math.PI : /grad$/.test(s) ? v * 0.9 : /turn$/.test(s) ? v * 360 : v; };
  const frac = (s) => (/%$/.test(s) ? parseFloat(s) / 100 : parseFloat(s));
  // делит строку по разделителю, не заходя в скобки и кавычки; sep ' ' значит любые пробелы
  function splitTop(s, sep) {
    const out = []; let d = 0, q = '', cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(') d++; else if (c === ')') d--;
      if (d === 0 && (sep === ' ' ? c <= ' ' : c === sep)) { if (sep !== ' ' || cur) out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (sep !== ' ' || cur) out.push(cur);
    return out;
  }

  const NAMED = { black: '#000', white: '#fff', red: '#f00', green: '#008000', blue: '#00f', yellow: '#ff0', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', gray: '#808080', grey: '#808080', silver: '#c0c0c0', gold: '#ffd700', cyan: '#0ff', aqua: '#0ff', magenta: '#f0f', fuchsia: '#f0f', lime: '#0f0', navy: '#000080', teal: '#008080', maroon: '#800000', olive: '#808000', brown: '#a52a2a', coral: '#ff7f50', salmon: '#fa8072', tomato: '#ff6347', crimson: '#dc143c', indigo: '#4b0082', violet: '#ee82ee', orchid: '#da70d6', plum: '#dda0dd', khaki: '#f0e68c', beige: '#f5f5dc', ivory: '#fffff0', lavender: '#e6e6fa', turquoise: '#40e0d0', skyblue: '#87ceeb', royalblue: '#4169e1', steelblue: '#4682b4', slategray: '#708090', dimgray: '#696969', darkgray: '#a9a9a9', lightgray: '#d3d3d3', whitesmoke: '#f5f5f5', hotpink: '#ff69b4', deeppink: '#ff1493', limegreen: '#32cd32', forestgreen: '#228b22', seagreen: '#2e8b57', darkgreen: '#006400', darkblue: '#00008b', midnightblue: '#191970', dodgerblue: '#1e90ff', deepskyblue: '#00bfff', lightblue: '#add8e6', orangered: '#ff4500', darkorange: '#ff8c00', goldenrod: '#daa520', chocolate: '#d2691e', sienna: '#a0522d', tan: '#d2b48c', wheat: '#f5deb3', firebrick: '#b22222', darkred: '#8b0000', rebeccapurple: '#639' };
  // -> [r,g,b,a] в долях, null для none, undefined если не разобрано
  function parseColor(s) {
    s = String(s).trim().toLowerCase();
    if (s === 'none') return null;
    if (s === 'transparent') return [0, 0, 0, 0];
    if (s[0] === '#') {
      const h = s.slice(1);
      if (/^[0-9a-f]{3,4}$/.test(h)) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16) / 255).concat(h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1);
      if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255).concat(h.length === 8 ? parseInt(h.substr(6, 2), 16) / 255 : 1);
      return undefined;
    }
    let m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean); if (p.length < 3) return undefined; return p.slice(0, 3).map((v) => clamp01(/%$/.test(v) ? parseFloat(v) / 100 : parseFloat(v) / 255)).concat(p[3] !== undefined ? clamp01(frac(p[3])) : 1); }
    m = /^hsla?\(([^)]+)\)$/.exec(s);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean); if (p.length < 3) return undefined;
      const h = ((parseFloat(p[0]) % 360) + 360) % 360 / 360, sa = clamp01(parseFloat(p[1]) / 100), l = clamp01(parseFloat(p[2]) / 100), q = l < 0.5 ? l * (1 + sa) : l + sa - l * sa, pp = 2 * l - q;
      const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? pp + (q - pp) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? pp + (q - pp) * (2 / 3 - t) * 6 : pp; };
      return [f(h + 1 / 3), f(h), f(h - 1 / 3), p[3] !== undefined ? clamp01(frac(p[3])) : 1];
    }
    return NAMED[s] ? parseColor(NAMED[s]) : undefined;
  }

  // ───────── XML ─────────
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function parseXML(src) {
    const root = { tag: '#root', attrs: {}, kids: [], text: '', line: 1 }, stack = [root];
    let ln = 1, lp = 0, i = 0;
    const lineAt = (p) => { for (; lp < p; lp++) if (src.charCodeAt(lp) === 10) ln++; return ln; };
    const ent = (s) => (s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] !== undefined ? ENT[e] : m)));
    const reTag = /<([A-Za-z_][\w:.-]*)/y, reAttr = /\s+([^\s=\/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y, reEnd = /\s*(\/?)>/y;
    while (i < src.length) {
      const top = stack[stack.length - 1], lt = src.indexOf('<', i);
      if (lt < 0) { top.text += ent(src.slice(i)); break; }
      if (lt > i) top.text += ent(src.slice(i, lt));
      if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); if (e < 0) throw new ECoreError('комментарий не закрыт', lineAt(lt)); i = e + 3; continue; }
      if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); if (e < 0) throw new ECoreError('CDATA не закрыт', lineAt(lt)); top.text += src.slice(lt + 9, e); i = e + 3; continue; }
      if (src[lt + 1] === '?' || src[lt + 1] === '!') { const e = src.indexOf('>', lt); if (e < 0) throw new ECoreError('тег не закрыт', lineAt(lt)); i = e + 1; continue; }
      if (src[lt + 1] === '/') {
        const e = src.indexOf('>', lt), name = e < 0 ? '' : src.slice(lt + 2, e).trim().replace(/^svg:/, '');
        if (e < 0 || top.tag !== name) throw new ECoreError('закрывающий тег </' + name + '> не совпадает с <' + top.tag + '>', lineAt(lt));
        stack.pop(); i = e + 1; continue;
      }
      reTag.lastIndex = lt; const m = reTag.exec(src);
      if (!m) throw new ECoreError('лишний символ «<»', lineAt(lt));
      const node = { tag: m[1].replace(/^svg:/, ''), attrs: {}, kids: [], text: '', line: lineAt(lt) };
      let p = reTag.lastIndex;
      for (;;) { reAttr.lastIndex = p; const a = reAttr.exec(src); if (!a) break; node.attrs[a[1]] = ent(a[2] !== undefined ? a[2] : a[3]); p = reAttr.lastIndex; }
      reEnd.lastIndex = p; const e = reEnd.exec(src);
      if (!e) throw new ECoreError('тег <' + node.tag + '> записан с ошибкой', node.line);
      top.kids.push(node); if (!e[1]) stack.push(node); i = reEnd.lastIndex;
    }
    if (stack.length > 1) throw new ECoreError('тег <' + stack[stack.length - 1].tag + '> не закрыт', stack[stack.length - 1].line);
    return root;
  }
  const textOf = (n) => n.text + n.kids.map(textOf).join('');

  // ───────── CSS ─────────
  function parseDecls(body) {
    const out = [];
    for (const part of splitTop(body, ';')) { const c = part.indexOf(':'); if (c < 0) continue; const k = part.slice(0, c).trim(); out.push([k.startsWith('--') ? k : k.toLowerCase(), part.slice(c + 1).trim().replace(/\s*!important$/, '')]); }
    return out;
  }
  function parseCSS(css, warn) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [], keyframes = {};
    let i = 0;
    while (i < css.length) {
      const b = css.indexOf('{', i); if (b < 0) break;
      const head = css.slice(i, b).trim();
      let d = 0, e = b; for (; e < css.length; e++) { if (css[e] === '{') d++; else if (css[e] === '}' && --d === 0) break; }
      if (e >= css.length) throw new ECoreError('в <style> не закрыта фигурная скобка после «' + head.slice(0, 40) + '»');
      const body = css.slice(b + 1, e); i = e + 1;
      if (head[0] === '@') {
        const m = /^@(?:-webkit-)?keyframes\s+([\w-]+)$/.exec(head);
        if (m) {
          const frames = []; let p = 0;
          for (;;) {
            const kb = body.indexOf('{', p); if (kb < 0) break; const ke = body.indexOf('}', kb); if (ke < 0) throw new ECoreError('@keyframes ' + m[1] + ': не закрыта скобка');
            const decls = parseDecls(body.slice(kb + 1, ke));
            for (const s of body.slice(p, kb).split(',')) { const k = s.trim(), off = k === 'from' ? 0 : k === 'to' ? 1 : parseFloat(k) / 100; if (!(off >= 0 && off <= 1)) throw new ECoreError('@keyframes ' + m[1] + ': непонятная отметка «' + k + '»'); frames.push({ off, decls }); }
            p = ke + 1;
          }
          keyframes[m[1]] = frames.map((f, n) => [f, n]).sort((a, b) => a[0].off - b[0].off || a[1] - b[1]).map((x) => x[0]);
        } else if (!/^@font-face/.test(head)) warn('правило ' + head.split(/\s/)[0] + ' в <style> пропущено');
        continue;
      }
      const decls = parseDecls(body);
      for (const s of head.split(',')) {
        const sel = s.trim(), m = /^(\*|[a-zA-Z][\w-]*)?((?:[#.][\w-]+)*)$/.exec(sel);
        if (!m || !sel) { warn('селектор «' + sel + '» не поддержан: годятся #id, .класс и имя тега'); continue; }
        const ids = [], cls = []; (m[2].match(/[#.][\w-]+/g) || []).forEach((t) => (t[0] === '#' ? ids : cls).push(t.slice(1)));
        const tag = m[1] && m[1] !== '*' ? m[1] : null;
        rules.push({ tag, ids, cls, spec: ids.length * 100 + cls.length * 10 + (tag ? 1 : 0), order: rules.length, decls });
      }
    }
    rules.sort((a, b) => a.spec - b.spec || a.order - b.order);
    return { rules, keyframes };
  }

  const INHERIT = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'paint-order', 'visibility', 'color'];
  const PRES = new Set(INHERIT.concat(['opacity', 'display', 'transform', 'transform-origin', 'transform-box']));
  const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
  const BOXES = new Set(['svg', 'g', 'a', 'switch']);
  const SILENT = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'linearGradient', 'radialGradient', 'stop', 'symbol', 'tspan']);

  // ───────── easing и анимации ─────────
  const EASE = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };
  function parseEasing(s) {
    s = s.trim();
    if (EASE[s]) return EASE[s];
    let m = /^cubic-bezier\(([^)]+)\)$/.exec(s);
    if (m) { const a = m[1].split(/[\s,]+/).filter(Boolean).map(Number); return a.length === 4 && a.every(isFinite) ? a : null; }
    if (s === 'step-end') return { steps: 1, start: false };
    if (s === 'step-start') return { steps: 1, start: true };
    m = /^steps\(\s*(\d+)\s*(?:,\s*([\w-]+))?\s*\)$/.exec(s);
    return m && +m[1] > 0 ? { steps: +m[1], start: /start/.test(m[2] || '') } : null;
  }
  function bez(e, u) {   // значение cubic-bezier(e) в точке u
    if (e[0] === e[1] && e[2] === e[3]) return u;
    let lo = 0, hi = 1, t = u;
    for (let i = 0; i < 40; i++) { const mt = 1 - t, x = 3 * mt * mt * t * e[0] + 3 * mt * t * t * e[2] + t * t * t; if (Math.abs(x - u) < 1e-7) break; if (x < u) lo = t; else hi = t; t = (lo + hi) / 2; }
    const mt = 1 - t; return 3 * mt * mt * t * e[1] + 3 * mt * t * t * e[3] + t * t * t;
  }
  const DIRS = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']), FILLS = new Set(['none', 'forwards', 'backwards', 'both']);
  function parseAnimations(st, warn) {
    const mk = () => ({ name: null, dur: 0, delay: 0, ease: EASE.ease, count: 1, dir: 'normal', fill: 'none' });
    let list = [];
    if (st.animation && st.animation !== 'none') for (const part of splitTop(st.animation, ',')) {
      const a = mk(); let times = 0;
      for (const tok of splitTop(part.trim(), ' ')) {
        if (/^[-+]?[\d.]+m?s$/.test(tok)) { if (times++ === 0) a.dur = time(tok); else a.delay = time(tok); }
        else if (tok === 'infinite') a.count = Infinity;
        else if (/^[\d.]+$/.test(tok)) a.count = +tok;
        else if (DIRS.has(tok)) a.dir = tok;
        else if (FILLS.has(tok)) a.fill = tok;
        else if (tok === 'running' || tok === 'paused') continue;
        else { const e = parseEasing(tok); if (e) a.ease = e; else if (/^[\w-]+\(/.test(tok)) warn('кривая «' + tok + '» не поддержана, взята linear'); else a.name = tok; }
      }
      list.push(a);
    }
    const L = (k) => (st[k] !== undefined ? splitTop(st[k], ',').map((s) => s.trim()) : null);
    const names = L('animation-name');
    if (names) list = names.map((nm, i) => Object.assign(list[i] || mk(), { name: nm }));
    const set = (k, fn) => { const v = L(k); if (v) list.forEach((a, i) => fn(a, v[i % v.length])); };
    set('animation-duration', (a, v) => { a.dur = time(v); });
    set('animation-delay', (a, v) => { a.delay = time(v); });
    set('animation-timing-function', (a, v) => { a.ease = parseEasing(v) || EASE.linear; });
    set('animation-iteration-count', (a, v) => { a.count = v === 'infinite' ? Infinity : +v; });
    set('animation-direction', (a, v) => { if (DIRS.has(v)) a.dir = v; });
    set('animation-fill-mode', (a, v) => { if (FILLS.has(v)) a.fill = v; });
    return list.filter((a) => a.name && a.name !== 'none');
  }

  // ───────── transform ─────────
  function parseTransform(s) { const out = [], re = /([a-zA-Z]+)\s*\(([^)]*)\)/g; let m; while ((m = re.exec(s))) out.push({ fn: m[1], a: m[2].split(/[\s,]+/).filter(Boolean) }); return out; }
  function listMatrix(list, warn) {
    let m = I;
    for (const { fn, a } of list) {
      const n = a.map(len);
      switch (fn) {
        case 'matrix': if (n.length === 6) m = mul(m, n); break;
        case 'translate': m = mul(m, T(n[0] || 0, n[1] || 0)); break;
        case 'translateX': m = mul(m, T(n[0] || 0, 0)); break;
        case 'translateY': m = mul(m, T(0, n[0] || 0)); break;
        case 'scale': m = mul(m, S(frac(a[0]), a[1] !== undefined ? frac(a[1]) : frac(a[0]))); break;
        case 'scaleX': m = mul(m, S(frac(a[0]), 1)); break;
        case 'scaleY': m = mul(m, S(1, frac(a[0]))); break;
        case 'rotate': m = a.length >= 3 ? mul(mul(mul(m, T(n[1], n[2])), R(ang(a[0]))), T(-n[1], -n[2])) : mul(m, R(ang(a[0] || '0'))); break;
        case 'skewX': m = mul(m, [1, 0, Math.tan(ang(a[0]) * Math.PI / 180), 1, 0, 0]); break;
        case 'skewY': m = mul(m, [1, Math.tan(ang(a[0]) * Math.PI / 180), 0, 1, 0, 0]); break;
        default: warn('функция ' + fn + '() в transform не поддержана');
      }
    }
    return m;
  }
  // список функций в порядке translate -> rotate -> scale раскладывается на три канала; иначе null
  function listChannels(list) {
    const c = { t: [0, 0], r: [0], s: [1, 1] }; let stage = 0;
    for (const { fn, a } of list) {
      const st = /^translate/.test(fn) ? 0 : fn === 'rotate' ? 1 : /^scale/.test(fn) ? 2 : -1;
      if (st < stage || (fn === 'rotate' && a.length > 1)) return null;
      stage = st;
      if (fn === 'translate') { c.t[0] += len(a[0] || '0'); c.t[1] += len(a[1] || '0'); } else if (fn === 'translateX') c.t[0] += len(a[0]); else if (fn === 'translateY') c.t[1] += len(a[0]);
      else if (fn === 'rotate') c.r[0] += ang(a[0]);
      else if (fn === 'scale') { const x = frac(a[0]); c.s[0] *= x; c.s[1] *= a[1] !== undefined ? frac(a[1]) : x; } else if (fn === 'scaleX') c.s[0] *= frac(a[0]); else if (fn === 'scaleY') c.s[1] *= frac(a[0]);
    }
    return c;
  }
  const VAL = {
    opacity: (v) => [clamp01(frac(v))],
    translate: (v) => { if (v === 'none') return [0, 0]; const p = splitTop(v, ' '); return [len(p[0]), len(p[1] || '0')]; },
    rotate: (v) => { if (v === 'none') return [0]; const p = splitTop(v, ' '); return [ang(p[p.length - 1])]; },
    scale: (v) => { if (v === 'none') return [1, 1]; const p = splitTop(v, ' '), x = frac(p[0]); return [x, p[1] !== undefined ? frac(p[1]) : x]; },
    fill: (v) => parseColor(v), stroke: (v) => parseColor(v),
    'stroke-width': (v) => [len(v)], 'stroke-dashoffset': (v) => [len(v)],
  };

  // ───────── геометрия ─────────
  const K = 0.5522847498;
  class PB {
    constructor() { this.subs = []; this.cur = null; }
    move(x, y) { this.cur = { v: [[x, y]], i: [[0, 0]], o: [[0, 0]], c: false }; this.subs.push(this.cur); }
    line(x, y) { const s = this.cur; s.v.push([x, y]); s.i.push([0, 0]); s.o.push([0, 0]); }
    cubic(x1, y1, x2, y2, x, y) { const s = this.cur, p = s.v[s.v.length - 1]; s.o[s.o.length - 1] = [x1 - p[0], y1 - p[1]]; s.v.push([x, y]); s.i.push([x2 - x, y2 - y]); s.o.push([0, 0]); }
    close() { const s = this.cur; if (!s || s.c) return; s.c = true; const n = s.v.length - 1; if (n > 0 && Math.abs(s.v[n][0] - s.v[0][0]) < 1e-6 && Math.abs(s.v[n][1] - s.v[0][1]) < 1e-6) { s.i[0] = s.i[n]; s.v.pop(); s.i.pop(); s.o.pop(); } }
  }
  function arc(b, x0, y0, rx, ry, phi, large, sweep, x, y) {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (x0 === x && y0 === y) return;
    if (!rx || !ry) return b.line(x, y);
    const ph = phi * Math.PI / 180, cp = Math.cos(ph), sp = Math.sin(ph), dx = (x0 - x) / 2, dy = (y0 - y) / 2, x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
    let l = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry); if (l > 1) { l = Math.sqrt(l); rx *= l; ry *= l; }
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1, co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - den) / den));
    const cxp = co * rx * y1 / ry, cyp = -co * ry * x1 / rx, cx = cp * cxp - sp * cyp + (x0 + x) / 2, cy = sp * cxp + cp * cyp + (y0 + y) / 2;
    const a1 = Math.atan2((y1 - cyp) / ry, (x1 - cxp) / rx); let da = Math.atan2((-y1 - cyp) / ry, (-x1 - cxp) / rx) - a1;
    if (sweep && da < 0) da += 2 * Math.PI; else if (!sweep && da > 0) da -= 2 * Math.PI;
    const n = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / 2) - 1e-9)), st = da / n, k = 4 / 3 * Math.tan(st / 4);
    const P = (ux, uy) => [cx + cp * rx * ux - sp * ry * uy, cy + sp * rx * ux + cp * ry * uy];
    let a = a1, px = Math.cos(a), py = Math.sin(a);
    for (let i = 0; i < n; i++) { const a2 = a + st, qx = Math.cos(a2), qy = Math.sin(a2), c1 = P(px - k * py, py + k * px), c2 = P(qx + k * qy, qy - k * qx), e = i === n - 1 ? [x, y] : P(qx, qy); b.cubic(c1[0], c1[1], c2[0], c2[1], e[0], e[1]); a = a2; px = qx; py = qy; }
  }
  function parsePath(d, b, line) {
    const n = d.length, reNum = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
    let i = 0, x = 0, y = 0, sx = 0, sy = 0, px = 0, py = 0, prev = '', fresh = false;   // fresh: после Z нужен новый подпуть
    const bad = () => { throw new ECoreError('путь d записан с ошибкой около «' + d.slice(Math.max(0, i - 12), i + 12) + '»', line); };
    const ws = () => { while (i < n && (d.charCodeAt(i) <= 32 || d[i] === ',')) i++; };
    const num = () => { ws(); reNum.lastIndex = i; const m = reNum.exec(d); if (!m) bad(); i = reNum.lastIndex; return +m[0]; };
    const flag = () => { ws(); const c = d[i]; if (c !== '0' && c !== '1') bad(); i++; return c === '1'; };
    const more = () => { ws(); return i < n && /[-+.\d]/.test(d[i]); };
    const need = () => { if (!b.cur) bad(); if (fresh) { b.move(x, y); fresh = false; } };
    for (;;) {
      ws(); if (i >= n) break;
      const c = d[i]; if (!/[a-zA-Z]/.test(c)) bad(); i++;
      const C = c.toUpperCase(), rel = c !== C; let first = true;
      do {
        const ox = rel ? x : 0, oy = rel ? y : 0;
        switch (C) {
          case 'M': x = num() + ox; y = num() + oy; if (first) { b.move(x, y); sx = x; sy = y; fresh = false; } else b.line(x, y); break;
          case 'L': need(); x = num() + ox; y = num() + oy; b.line(x, y); break;
          case 'H': need(); x = num() + ox; b.line(x, y); break;
          case 'V': need(); y = num() + oy; b.line(x, y); break;
          case 'C': { need(); const x1 = num() + ox, y1 = num() + oy, x2 = num() + ox, y2 = num() + oy; x = num() + ox; y = num() + oy; b.cubic(x1, y1, x2, y2, x, y); px = x2; py = y2; break; }
          case 'S': { need(); const x1 = prev === 'C' || prev === 'S' ? 2 * x - px : x, y1 = prev === 'C' || prev === 'S' ? 2 * y - py : y, x2 = num() + ox, y2 = num() + oy; x = num() + ox; y = num() + oy; b.cubic(x1, y1, x2, y2, x, y); px = x2; py = y2; break; }
          case 'Q': { need(); const qx = num() + ox, qy = num() + oy, x0 = x, y0 = y; x = num() + ox; y = num() + oy; b.cubic(x0 + 2 / 3 * (qx - x0), y0 + 2 / 3 * (qy - y0), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y); px = qx; py = qy; break; }
          case 'T': { need(); const qx = prev === 'Q' || prev === 'T' ? 2 * x - px : x, qy = prev === 'Q' || prev === 'T' ? 2 * y - py : y, x0 = x, y0 = y; x = num() + ox; y = num() + oy; b.cubic(x0 + 2 / 3 * (qx - x0), y0 + 2 / 3 * (qy - y0), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y); px = qx; py = qy; break; }
          case 'A': { need(); const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag(), x0 = x, y0 = y; x = num() + ox; y = num() + oy; arc(b, x0, y0, rx, ry, rot, large, sweep, x, y); break; }
          case 'Z': if (b.cur) b.close(); x = sx; y = sy; fresh = true; break;
          default: bad();
        }
        prev = C; first = false;
      } while (C !== 'Z' && more());
    }
  }
  function shapeSubs(n) {
    const a = n.attrs, N = (k) => (a[k] !== undefined ? len(a[k]) : 0), b = new PB();
    switch (n.tag) {
      case 'rect': {
        const x = N('x'), y = N('y'), w = N('width'), h = N('height'); if (!(w > 0 && h > 0)) break;
        let rx = a.rx !== undefined ? N('rx') : N('ry'), ry = a.ry !== undefined ? N('ry') : rx; rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
        if (!(rx > 0 && ry > 0)) { b.move(x, y); b.line(x + w, y); b.line(x + w, y + h); b.line(x, y + h); b.close(); break; }
        const kx = rx * (1 - K), ky = ry * (1 - K);
        b.move(x + rx, y); b.line(x + w - rx, y); b.cubic(x + w - kx, y, x + w, y + ky, x + w, y + ry); b.line(x + w, y + h - ry); b.cubic(x + w, y + h - ky, x + w - kx, y + h, x + w - rx, y + h);
        b.line(x + rx, y + h); b.cubic(x + kx, y + h, x, y + h - ky, x, y + h - ry); b.line(x, y + ry); b.cubic(x, y + ky, x + kx, y, x + rx, y); b.close(); break;
      }
      case 'circle': case 'ellipse': {
        const cx = N('cx'), cy = N('cy'), rx = n.tag === 'circle' ? N('r') : N('rx'), ry = n.tag === 'circle' ? rx : N('ry'); if (!(rx > 0 && ry > 0)) break;
        const kx = rx * K, ky = ry * K;
        b.move(cx + rx, cy); b.cubic(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry); b.cubic(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy); b.cubic(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry); b.cubic(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy); b.close(); break;
      }
      case 'line': b.move(N('x1'), N('y1')); b.line(N('x2'), N('y2')); break;
      case 'polyline': case 'polygon': { const p = (a.points || '').trim().split(/[\s,]+/).filter(Boolean).map(Number); for (let i = 0; i + 1 < p.length; i += 2) { if (i) b.line(p[i], p[i + 1]); else b.move(p[i], p[i + 1]); } if (n.tag === 'polygon' && b.cur) b.close(); break; }
      case 'path': parsePath(a.d || '', b, n.line); break;
    }
    return b.subs.filter((s) => s.v.length > 1);
  }
  const mapSubs = (subs, m) => (isI(m) ? subs : subs.map((s) => ({ c: s.c, v: s.v.map((p) => pt(m, p[0], p[1])), i: s.i.map((p) => [m[0] * p[0] + m[2] * p[1], m[1] * p[0] + m[3] * p[1]]), o: s.o.map((p) => [m[0] * p[0] + m[2] * p[1], m[1] * p[0] + m[3] * p[1]]) })));
  // перебор кубических отрезков подпути
  function eachSeg(s, fn) { const n = s.v.length, m = s.c ? n : n - 1; for (let k = 0; k < m; k++) { const a = s.v[k], b = s.v[(k + 1) % n]; fn(a[0], a[1], a[0] + s.o[k][0], a[1] + s.o[k][1], b[0] + s.i[(k + 1) % n][0], b[1] + s.i[(k + 1) % n][1], b[0], b[1]); } }
  function bboxOf(subs) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    const ext = (p0, p1, p2, p3, cb) => { const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0, ts = []; if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) ts.push(-c / b); } else { const D = b * b - 4 * a * c; if (D >= 0) { const q = Math.sqrt(D); ts.push((-b + q) / (2 * a), (-b - q) / (2 * a)); } } for (const t of ts) if (t > 0 && t < 1) cb(t); };
    const at = (p0, p1, p2, p3, t) => { const m = 1 - t; return m * m * m * p0 + 3 * m * m * t * p1 + 3 * m * t * t * p2 + t * t * t * p3; };
    for (const s of subs) { add(s.v[0][0], s.v[0][1]); eachSeg(s, (ax, ay, bx, by, cx, cy, dx, dy) => { add(dx, dy); ext(ax, bx, cx, dx, (t) => add(at(ax, bx, cx, dx, t), at(ay, by, cy, dy, t))); ext(ay, by, cy, dy, (t) => add(at(ax, bx, cx, dx, t), at(ay, by, cy, dy, t))); }); }
    return x0 <= x1 ? [x0, y0, x1, y1] : null;
  }
  function pathLen(subs) { let L = 0; for (const s of subs) eachSeg(s, (ax, ay, bx, by, cx, cy, dx, dy) => { let px = ax, py = ay; for (let k = 1; k <= 24; k++) { const t = k / 24, m = 1 - t, x = m * m * m * ax + 3 * m * m * t * bx + 3 * m * t * t * cx + t * t * t * dx, y = m * m * m * ay + 3 * m * m * t * by + 3 * m * t * t * cy + t * t * t * dy; L += Math.hypot(x - px, y - py); px = x; py = y; } }); return L; }
  const uni = (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  const boxBy = (m, b) => { if (!b) return null; const p = [pt(m, b[0], b[1]), pt(m, b[2], b[1]), pt(m, b[2], b[3]), pt(m, b[0], b[3])]; return [Math.min(p[0][0], p[1][0], p[2][0], p[3][0]), Math.min(p[0][1], p[1][1], p[2][1], p[3][1]), Math.max(p[0][0], p[1][0], p[2][0], p[3][0]), Math.max(p[0][1], p[1][1], p[2][1], p[3][1])]; };

  // ───────── шрифт: TrueType (glyf), cmap 4/12, кернинг из GPOS ─────────
  const fontCache = new WeakMap();
  function parseFont(buf) {
    const key = buf.buffer || buf; if (fontCache.has(key)) return fontCache.get(key);
    const d = buf instanceof ArrayBuffer ? new DataView(buf) : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const u8 = (o) => d.getUint8(o), u16 = (o) => d.getUint16(o), i16 = (o) => d.getInt16(o), u32 = (o) => d.getUint32(o);
    const tag = (o) => String.fromCharCode(u8(o), u8(o + 1), u8(o + 2), u8(o + 3));
    const tabs = {}; for (let i = 0, n = u16(4); i < n; i++) tabs[tag(12 + 16 * i)] = u32(12 + 16 * i + 8);
    if (!tabs.glyf || !tabs.loca || !tabs.cmap || !tabs.head || !tabs.hmtx) throw new ECoreError('шрифт не подходит: нужен TrueType (.ttf) с таблицей glyf');
    const upm = u16(tabs.head + 18), longLoca = i16(tabs.head + 50) === 1, nHM = u16(tabs.hhea + 34);
    const os2 = tabs['OS/2'], xHeight = os2 && u16(os2) >= 2 && i16(os2 + 86) > 0 ? i16(os2 + 86) : upm * 0.5;
    let family = '';
    if (tabs.name) { const nt = tabs.name, cnt = u16(nt + 2), so = nt + u16(nt + 4); let rank = 0; for (let i = 0; i < cnt; i++) { const r = nt + 6 + 12 * i, pid = u16(r), nid = u16(r + 6), ln = u16(r + 8), off = so + u16(r + 10), rk = (nid === 16 ? 2 : nid === 1 ? 1 : 0) * 2 + (pid === 3 ? 1 : 0); if (rk <= rank || (nid !== 1 && nid !== 16)) continue; let s = ''; if (pid === 1) for (let k = 0; k < ln; k++) s += String.fromCharCode(u8(off + k)); else for (let k = 0; k + 1 < ln; k += 2) s += String.fromCharCode(u16(off + k)); family = s; rank = rk; } }
    // cmap
    let cm = 0, fmt = 0;
    for (let i = 0, n = u16(tabs.cmap + 2); i < n; i++) { const r = tabs.cmap + 4 + 8 * i, pid = u16(r), eid = u16(r + 2), off = tabs.cmap + u32(r + 4), f = u16(off); if (f === 12 && fmt !== 12) { cm = off; fmt = 12; } else if (f === 4 && !fmt && (pid === 0 || (pid === 3 && eid === 1))) { cm = off; fmt = 4; } }
    if (!fmt) throw new ECoreError('шрифт не подходит: нет таблицы символов (cmap 4 или 12)');
    const idxCache = new Map();
    const index = (cp) => {
      let g = idxCache.get(cp); if (g !== undefined) return g; g = 0;
      if (fmt === 4) {
        if (cp <= 0xffff) { const sx2 = u16(cm + 6), endO = cm + 14, startO = endO + sx2 + 2, deltaO = startO + sx2, rangeO = deltaO + sx2; for (let s = 0; s < sx2; s += 2) if (u16(endO + s) >= cp) { const st = u16(startO + s); if (st <= cp) { const ro = u16(rangeO + s); if (!ro) g = (cp + u16(deltaO + s)) & 0xffff; else { const v = u16(rangeO + s + ro + 2 * (cp - st)); g = v ? (v + u16(deltaO + s)) & 0xffff : 0; } } break; } }
      } else { let lo = 0, hi = u32(cm + 12) - 1; while (lo <= hi) { const mid = (lo + hi) >> 1, r = cm + 16 + 12 * mid; if (cp < u32(r)) hi = mid - 1; else if (cp > u32(r + 4)) lo = mid + 1; else { g = u32(r + 8) + cp - u32(r); break; } } }
      idxCache.set(cp, g); return g;
    };
    const adv = (g) => u16(tabs.hmtx + 4 * Math.min(g, nHM - 1));
    const loca = (g) => (longLoca ? u32(tabs.loca + 4 * g) : u16(tabs.loca + 2 * g) * 2);
    function points(g, depth) {   // контуры глифа: [[{x,y,on}]]
      const o0 = loca(g), o1 = loca(g + 1); if (o1 <= o0) return [];
      const o = tabs.glyf + o0, nc = i16(o);
      if (nc >= 0) {
        const ends = []; for (let i = 0; i < nc; i++) ends.push(u16(o + 10 + 2 * i));
        const np = nc ? ends[nc - 1] + 1 : 0; let p = o + 10 + 2 * nc; p += 2 + u16(p);
        const fl = new Uint8Array(np);
        for (let i = 0; i < np;) { const f = u8(p++); fl[i++] = f; if (f & 8) { let r = u8(p++); while (r-- > 0 && i < np) fl[i++] = f; } }
        const xs = new Array(np), ys = new Array(np); let v = 0;
        for (let i = 0; i < np; i++) { const f = fl[i]; if (f & 2) { const q = u8(p++); v += f & 16 ? q : -q; } else if (!(f & 16)) { v += i16(p); p += 2; } xs[i] = v; }
        v = 0;
        for (let i = 0; i < np; i++) { const f = fl[i]; if (f & 4) { const q = u8(p++); v += f & 32 ? q : -q; } else if (!(f & 32)) { v += i16(p); p += 2; } ys[i] = v; }
        const out = []; let s = 0; for (const e of ends) { const c = []; for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: !!(fl[i] & 1) }); out.push(c); s = e + 1; }
        return out;
      }
      if (depth > 8) return [];
      const out = []; let p = o + 10, f;
      do {   // составной глиф
        f = u16(p); const gi = u16(p + 2); p += 4; let dx, dy;
        if (f & 1) { dx = i16(p); dy = i16(p + 2); p += 4; } else { dx = d.getInt8(p); dy = d.getInt8(p + 1); p += 2; }
        let a = 1, b = 0, c = 0, e = 1;
        if (f & 8) { a = e = i16(p) / 16384; p += 2; } else if (f & 0x40) { a = i16(p) / 16384; e = i16(p + 2) / 16384; p += 4; } else if (f & 0x80) { a = i16(p) / 16384; b = i16(p + 2) / 16384; c = i16(p + 4) / 16384; e = i16(p + 6) / 16384; p += 8; }
        if (!(f & 2)) { dx = 0; dy = 0; }
        for (const ct of points(gi, depth + 1)) out.push(ct.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + e * q.y + dy, on: q.on })));
      } while (f & 0x20);
      return out;
    }
    const subCache = new Map();
    function subs(g) {   // контуры в кубических кривых, единицы шрифта, ось Y вверх
      let r = subCache.get(g); if (r) return r;
      const b = new PB();
      for (const pts of points(g, 0)) {
        const n = pts.length; if (n < 2) continue;
        let q = pts; const k = q.findIndex((p) => p.on);
        if (k < 0) q = [{ x: (q[0].x + q[n - 1].x) / 2, y: (q[0].y + q[n - 1].y) / 2, on: true }].concat(q); else if (k > 0) q = q.slice(k).concat(q.slice(0, k));
        const m = q.length; b.move(q[0].x, q[0].y); let cx = q[0].x, cy = q[0].y;
        for (let i = 1; i <= m; i++) {
          const p = q[i % m];
          if (p.on) { if (i < m) b.line(p.x, p.y); cx = p.x; cy = p.y; continue; }
          const nx = q[(i + 1) % m], ex = nx.on ? nx.x : (p.x + nx.x) / 2, ey = nx.on ? nx.y : (p.y + nx.y) / 2;
          b.cubic(cx + 2 / 3 * (p.x - cx), cy + 2 / 3 * (p.y - cy), ex + 2 / 3 * (p.x - ex), ey + 2 / 3 * (p.y - ey), ex, ey); cx = ex; cy = ey; if (nx.on) i++;
        }
        b.close();
      }
      r = b.subs.filter((s) => s.v.length > 1); subCache.set(g, r); return r;
    }
    // кернинг: пары из GPOS (фича kern, lookup типа 2), значение XAdvance первой буквы пары
    let lookups = [];
    if (tabs.GPOS) {
      const gp = tabs.GPOS, fl = gp + u16(gp + 6), ll = gp + u16(gp + 8), want = new Set();
      for (let i = 0, n = u16(fl); i < n; i++) if (tag(fl + 2 + 6 * i) === 'kern') { const f = fl + u16(fl + 6 + 6 * i); for (let k = 0, m = u16(f + 2); k < m; k++) want.add(u16(f + 4 + 2 * k)); }
      for (const li of [...want].sort((a, b) => a - b)) { if (li >= u16(ll)) continue; const L = ll + u16(ll + 2 + 2 * li), type = u16(L), list = []; for (let k = 0, m = u16(L + 4); k < m; k++) { let s = L + u16(L + 6 + 2 * k), t = type; if (t === 9) { t = u16(s + 2); s += u32(s + 4); } if (t === 2) list.push(s); } if (list.length) lookups.push(list); }
    }
    const vsize = (f) => { let n = 0; for (let b = f; b; b >>= 1) n += b & 1; return n * 2; };
    const xadv = (o, f) => (f & 4 ? i16(o + (f & 1 ? 2 : 0) + (f & 2 ? 2 : 0)) : 0);
    const cover = (c, g) => { const f = u16(c); let lo = 0, hi = u16(c + 2) - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (f === 1) { const v = u16(c + 4 + 2 * mid); if (g < v) hi = mid - 1; else if (g > v) lo = mid + 1; else return mid; } else { const r = c + 4 + 6 * mid; if (g < u16(r)) hi = mid - 1; else if (g > u16(r + 2)) lo = mid + 1; else return u16(r + 4) + g - u16(r); } } return -1; };
    const klass = (c, g) => { if (u16(c) === 1) { const st = u16(c + 2); return g >= st && g < st + u16(c + 4) ? u16(c + 6 + 2 * (g - st)) : 0; } let lo = 0, hi = u16(c + 2) - 1; while (lo <= hi) { const mid = (lo + hi) >> 1, r = c + 4 + 6 * mid; if (g < u16(r)) hi = mid - 1; else if (g > u16(r + 2)) lo = mid + 1; else return u16(r + 4); } return 0; };
    const kernCache = new Map();
    const kern = (g1, g2) => {
      if (!lookups.length) return 0;
      const key = g1 * 65536 + g2; let v = kernCache.get(key); if (v !== undefined) return v; v = 0;
      for (const list of lookups) for (const s of list) {
        const ci = cover(s + u16(s + 2), g1); if (ci < 0) continue;
        const f1 = u16(s + 4), f2 = u16(s + 6), rec = vsize(f1) + vsize(f2);
        if (u16(s) === 1) { const ps = s + u16(s + 10 + 2 * ci); let lo = 0, hi = u16(ps) - 1, hit = false; while (lo <= hi) { const mid = (lo + hi) >> 1, r = ps + 2 + mid * (2 + rec), sg = u16(r); if (g2 < sg) hi = mid - 1; else if (g2 > sg) lo = mid + 1; else { v += xadv(r + 2, f1); hit = true; break; } } if (hit) break; }
        else { const c1 = klass(s + u16(s + 8), g1), c2 = klass(s + u16(s + 10), g2), n2 = u16(s + 14); if (c1 < u16(s + 12) && c2 < n2) v += xadv(s + 16 + (c1 * n2 + c2) * rec, f1); break; }
      }
      kernCache.set(key, v); return v;
    };
    const font = { family, upm, asc: i16(tabs.hhea + 4), desc: i16(tabs.hhea + 6), xHeight, index, adv, subs, kern };
    fontCache.set(key, font); return font;
  }

  // ───────── компилятор ─────────
  // src: текст исходника. opts.fonts: { 'имя семейства': ArrayBuffer | Uint8Array }, opts.slots: { имя: 'текст' }
  function compileSource(src, opts) {
    opts = opts || {};
    const warnings = [], seen = new Set();
    const warn = (m) => { if (!seen.has(m)) { seen.add(m); warnings.push(m); } };
    const doc = parseXML(String(src)), root = doc.kids.find((k) => k.tag === 'svg');
    if (!root) throw new ECoreError('в файле нет корневого тега <svg>');

    // размер и время
    const vb = (root.attrs.viewBox || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
    const vbox = vb.length === 4 && vb.every(isFinite) ? vb : [0, 0, len(root.attrs.width || '512') || 512, len(root.attrs.height || '512') || 512];
    const W = vbox[2], H = vbox[3];
    if (!(W > 0 && H > 0)) throw new ECoreError('у <svg> нулевой размер: задайте viewBox="0 0 512 512"', root.line);
    const fps = +(root.attrs['data-fps'] || 60) || 60;

    // ссылки и <use>
    const ids = {};
    (function scan(n) { if (n.attrs.id) ids[n.attrs.id] = n; n.kids.forEach(scan); })(root);
    const href = (n) => (n.attrs.href || n.attrs['xlink:href'] || '').replace(/^#/, '');
    const clone = (n) => ({ tag: n.tag, attrs: Object.assign({}, n.attrs), kids: n.kids.map(clone), text: n.text, line: n.line });
    (function expand(n, depth) {
      n.kids = n.kids.map((k) => {
        if (k.tag !== 'use') return k;
        const ref = ids[href(k)];
        if (!ref || depth > 16) { warn('<use> ссылается на «' + href(k) + '», такого id нет'); return { tag: 'g', attrs: {}, kids: [], text: '', line: k.line }; }
        const a = Object.assign({}, k.attrs), x = len(a.x || '0'), y = len(a.y || '0'); delete a.href; delete a['xlink:href']; delete a.x; delete a.y;
        // x и y у <use> дописываются в конец его transform (так делает браузер), поэтому точка опоры fill-box их не учитывает
        if (x || y) a.transform = ((a.transform || '') + ' translate(' + x + ' ' + y + ')').trim();
        const c = clone(ref); if (c.tag === 'symbol') c.tag = 'g';
        return { tag: 'g', attrs: a, kids: [c], text: '', line: k.line };
      });
      n.kids.forEach((k) => expand(k, depth + 1));
    })(root, 0);

    // стили
    let cssText = '';
    (function scan(n) { if (n.tag === 'style') cssText += textOf(n) + '\n'; n.kids.forEach(scan); })(root);
    const css = parseCSS(cssText, warn);
    const slots = [], slotVals = opts.slots || {};
    (function cascade(n, parent, hidden) {
      if (SILENT.has(n.tag) && n !== root) { if (n.tag === 'defs' || n.tag === 'symbol') return; if (n.tag !== 'tspan') return; }
      const st = {}, cls = (n.attrs.class || '').split(/\s+/).filter(Boolean);
      for (const k of INHERIT) if (parent[k] !== undefined) st[k] = parent[k];
      for (const k in n.attrs) if (PRES.has(k)) st[k] = n.attrs[k];
      for (const r of css.rules) if ((!r.tag || r.tag === n.tag) && r.ids.every((x) => x === n.attrs.id) && r.cls.every((x) => cls.includes(x))) for (const [k, v] of r.decls) st[k] = v;
      if (n.attrs.style) for (const [k, v] of parseDecls(n.attrs.style)) st[k] = v;
      for (const k of INHERIT) if (st[k] === 'inherit') { if (parent[k] !== undefined) st[k] = parent[k]; else delete st[k]; }
      for (const k of ['filter', 'mask', 'clip-path', 'mix-blend-mode']) if ((st[k] || n.attrs[k]) && (st[k] || n.attrs[k]) !== 'none') warn('свойство ' + k + ' не поддержано и пропущено');
      const off = hidden || st.display === 'none';
      if (SHAPES.has(n.tag) || BOXES.has(n.tag) || n.tag === 'text') { if (!off && st.visibility !== 'hidden') n.st = st; }
      else if (!SILENT.has(n.tag)) { warn(n.tag === 'animate' || n.tag === 'animateTransform' || n.tag === 'animateMotion' || n.tag === 'set' ? 'SMIL-анимация (<' + n.tag + '>) не поддержана: движение задаётся через CSS @keyframes' : 'тег <' + n.tag + '> не поддержан и пропущен'); return; }
      if (n.tag === 'text') {
        const slot = n.attrs['data-slot'];
        if (slot) { const def = textOf(n).replace(/\s+/g, ' ').trim(); if (slotVals[slot] !== undefined) { n.text = String(slotVals[slot]); n.kids = []; } slots.push({ name: slot, value: def, text: textOf(n).replace(/\s+/g, ' ').trim(), font: st['font-family'] || '' }); }
        return;
      }
      for (const k of n.kids) cascade(k, st, off);
    })(root, {}, false);

    // длительность: data-duration, иначе по самой длинной анимации
    let D = root.attrs['data-duration'] ? time(root.attrs['data-duration']) : 0;
    const animsOf = (n) => n.an || (n.an = parseAnimations(n.st, warn).filter((a) => { if (css.keyframes[a.name]) return true; warn('нет @keyframes с именем «' + a.name + '»'); return false; }));
    if (!(D > 0)) {
      (function scan(n) { if (n.st) for (const a of animsOf(n)) D = Math.max(D, a.count === Infinity ? a.dur * (a.dir.startsWith('alternate') ? 2 : 1) + Math.max(0, a.delay) : a.delay + a.dur * a.count); if (n.tag === 'text' && n.attrs['data-letters']) D = Math.max(D, 1); n.kids.forEach(scan); })(root);
      if (!(D > 0)) D = 3;
      warn('у <svg> нет data-duration, длительность взята ' + r3(D) + ' с');
    }
    const frames = Math.max(1, Math.round(D * fps));

    // шрифты
    const fonts = {};
    for (const k in opts.fonts || {}) { const f = parseFont(opts.fonts[k]); fonts[k.toLowerCase()] = f; if (f.family) fonts[f.family.toLowerCase()] = f; }
    function pickFont(list, n) {
      const names = splitTop(list || '', ',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      for (const nm of names) if (fonts[nm.toLowerCase()]) return fonts[nm.toLowerCase()];
      const any = Object.keys(fonts)[0];
      if (!any) throw new ECoreError('для <text> нужен шрифт, а ни одного не подключено', n.line);
      warn('шрифт «' + (names[0] || '') + '» не подключён, взят «' + fonts[any].family + '»');
      return fonts[any];
    }

    // текст -> глифы в локальных координатах
    function layout(n) {
      if (n.lay) return n.lay;
      const st = n.st, a = n.attrs, str = textOf(n).replace(/\s+/g, ' ').trim(), font = pickFont(st['font-family'], n);
      const size = len(st['font-size'] || '16'), ls = st['letter-spacing'] && st['letter-spacing'] !== 'normal' ? len(st['letter-spacing']) : 0;
      let k = size / font.upm, pen = 0, prev = -1; const items = [];
      for (const ch of str) { const g = font.index(ch.codePointAt(0)); if (!g && ch !== ' ') warn('в шрифте «' + font.family + '» нет символа «' + ch + '»'); if (prev >= 0) pen += font.kern(prev, g); items.push({ ch, g, x: pen }); pen += font.adv(g) + ls / k; prev = g; }
      let width = pen * k, fitK = 1; const fitW = a['data-fit'] !== undefined ? len(a['data-fit']) : 0;
      if (fitW > 0 && width > fitW) { fitK = fitW / width; k *= fitK; width = fitW; }
      const anchor = st['text-anchor'] || 'start', x0 = len(a.x || '0') - (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0);
      const asc = font.asc * k, desc = font.desc * k, bl = st['dominant-baseline'] || 'auto'; let by = len(a.y || '0');
      if (bl === 'middle') by += font.xHeight * k / 2; else if (bl === 'central') by += (asc + desc) / 2; else if (bl === 'hanging') by += asc * 0.8; else if (bl === 'text-before-edge' || bl === 'text-top') by += asc; else if (bl === 'text-after-edge' || bl === 'text-bottom' || bl === 'ideographic') by += desc; else if (bl !== 'auto' && bl !== 'alphabetic') warn('dominant-baseline="' + bl + '" не поддержан');
      const m = [k, 0, 0, -k, x0, by], glyphs = [];
      for (const it of items) { if (!it.g) continue; const subs = mapSubs(font.subs(it.g), mul(m, T(it.x, 0))); if (subs.length) glyphs.push({ ch: it.ch, subs, box: bboxOf(subs) }); }
      return (n.lay = { glyphs, box: [x0, by - asc, x0 + width, by - desc], fitK });   // fitK: во сколько раз текст ужат под data-fit
    }
    const geom = (n) => n.geo || (n.geo = shapeSubs(n));

    // коробка элемента в его же координатах (для transform-box: fill-box)
    function bbox(n) {
      if (n.bb !== undefined) return n.bb;
      let b = null;
      if (SHAPES.has(n.tag)) b = bboxOf(geom(n));
      else if (n.tag === 'text') b = layout(n).box;
      else for (const k of n.kids) if (k.st) b = uni(b, boxBy(xf(k).Ms, bbox(k)));
      return (n.bb = b);
    }

    // дорожка свойства: список отрезков { t0, t1, v0, v1, e (cubic-bezier) | hold } в секундах
    function expand(ks, a, base) {
      const segs = [];
      const seg = (t0, t1, v0, v1, e) => {
        if (t1 - t0 < 1e-6 || t1 <= 0 || t0 >= D) return;
        if (e && e.steps) { for (let k = 0; k < e.steps; k++) { const v = lerp(v0, v1, (e.start ? k + 1 : k) / e.steps); seg(t0 + (t1 - t0) * k / e.steps, t0 + (t1 - t0) * (k + 1) / e.steps, v, v); } return; }
        if (same(v0, v1)) return void segs.push({ t0: Math.max(0, t0), t1, v0, v1, hold: true });
        e = e || EASE.linear;
        if (t0 < 0) {
          // отрезок начался до нулевого кадра (отрицательная задержка): режем его в нуле. Ключи с отрицательным
          // временем rlottie, а значит и Telegram, играет неверно. Хвост кривой Безье после разреза остаётся кривой Безье.
          const u = -t0 / (t1 - t0); let lo = 0, hi = 1, q = u;
          for (let i = 0; i < 40; i++) { const m = 1 - q, x = 3 * m * m * q * e[0] + 3 * m * q * q * e[2] + q * q * q; if (Math.abs(x - u) < 1e-7) break; if (x < u) lo = q; else hi = q; q = (lo + hi) / 2; }
          const L = (a, b) => [a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q], A = L([0, 0], [e[0], e[1]]), B = L([e[0], e[1]], [e[2], e[3]]), C = L([e[2], e[3]], [1, 1]), E2 = L(B, C), F = L(L(A, B), E2);
          const nx = (x) => (x - F[0]) / (1 - F[0] || 1), ny = (y) => (Math.abs(1 - F[1]) < 1e-9 ? nx(y) : (y - F[1]) / (1 - F[1]));
          v0 = lerp(v0, v1, F[1]); e = [nx(E2[0]), ny(E2[1]), nx(C[0]), ny(C[1])]; t0 = 0;
          if (same(v0, v1)) return void segs.push({ t0, t1, v0, v1, hold: true });
        }
        segs.push({ t0, t1, v0, v1, e });
      };
      const rev0 = a.dir === 'reverse' || a.dir === 'alternate-reverse', last = ks.length - 1;
      if (!(a.dur > 0)) return [];
      if (a.delay > 0) { const v = a.fill === 'backwards' || a.fill === 'both' ? ks[rev0 ? last : 0].val : base; seg(0, a.delay, v, v); }
      let endVal = base;
      for (let it = 0; it < a.count; it++) {
        const t0 = a.delay + it * a.dur; if (t0 >= D) break;
        const rev = a.dir === 'reverse' || (a.dir === 'alternate' && it % 2 === 1) || (a.dir === 'alternate-reverse' && it % 2 === 0);
        if (!rev) for (let k = 0; k < last; k++) seg(t0 + ks[k].off * a.dur, t0 + ks[k + 1].off * a.dur, ks[k].val, ks[k + 1].val, ks[k].ease);
        else for (let k = last; k > 0; k--) { const e = ks[k - 1].ease; seg(t0 + (1 - ks[k].off) * a.dur, t0 + (1 - ks[k - 1].off) * a.dur, ks[k].val, ks[k - 1].val, e && !e.steps ? [1 - e[2], 1 - e[3], 1 - e[0], 1 - e[1]] : e); }
        endVal = ks[rev ? 0 : last].val;
      }
      const end = a.delay + a.count * a.dur;
      if (end < D) { const v = a.fill === 'forwards' || a.fill === 'both' ? endVal : base; seg(Math.max(0, end), D, v, v); }
      return segs;
    }
    const keysOf = (segs, map) => {
      // скачок значения (стык повторов) записывается концом отрезка «e». rlottie, а значит и Telegram, верит ему,
      // только когда «e» стоит у каждого ключа дорожки, поэтому либо у всех, либо ни у одного.
      const out = [], jump = segs.some((s, n) => !s.hold && segs[n + 1] && !same(s.v1, segs[n + 1].v0));
      for (const s of segs) {
        const key = { t: r3(s.t0 * fps), s: map(s.v0) };
        if (s.hold) key.h = 1; else { key.o = { x: [r3(s.e[0])], y: [r3(s.e[1])] }; key.i = { x: [r3(s.e[2])], y: [r3(s.e[3])] }; }
        if (jump) key.e = map(s.hold ? s.v0 : s.v1);
        out.push(key);
      }
      const z = segs[segs.length - 1], end = map(z.hold ? z.v0 : z.v1); out.push(jump ? { t: r3(z.t1 * fps), s: end, e: end } : { t: r3(z.t1 * fps), s: end });
      return out;
    };
    const evalSegs = (segs, t) => { let s = segs[0]; for (const q of segs) { if (q.t0 > t) break; s = q; } if (s.hold || t <= s.t0) return s.v0; if (t >= s.t1) return s.v1; return lerp(s.v0, s.v1, bez(s.e, (t - s.t0) / (s.t1 - s.t0))); };
    const P = (segs, map, still) => (segs && segs.length ? { a: 1, k: keysOf(segs, map) } : { a: 0, k: still });

    // все дорожки элемента: { свойство: отрезки }. base(свойство) даёт значение вне анимации.
    function tracksOf(n, anims, base, extraDelay) {
      const out = {};
      for (const a0 of anims) {
        const a = extraDelay ? Object.assign({}, a0, { delay: a0.delay + extraDelay }) : a0, per = {};
        for (const f of css.keyframes[a.name]) {
          const tf = f.decls.find((d) => d[0] === 'animation-timing-function'), e = tf ? parseEasing(tf[1]) || EASE.linear : a.ease;
          const put = (p, val) => { const l = per[p] || (per[p] = []); if (l.length && l[l.length - 1].off === f.off) l.pop(); l.push({ off: f.off, val, ease: e }); };
          for (const [p, v] of f.decls) {
            if (p === 'animation-timing-function') continue;
            if (p === 'transform') {
              const c = v === 'none' ? listChannels([]) : listChannels(parseTransform(v));
              if (!c) throw new ECoreError('@keyframes ' + a.name + ': transform «' + v + '» не раскладывается. Порядок функций должен быть translate, rotate, scale; для другого порядка вложите элемент в <g>', n.line);
              put('t.translate', c.t); put('t.rotate', c.r); put('t.scale', c.s); continue;
            }
            if (!VAL[p]) { if (p !== 'transform-origin' && p !== 'transform-box') warn('свойство ' + p + ' в @keyframes не анимируется: годятся transform, translate, rotate, scale, opacity, fill, stroke, stroke-width, stroke-dashoffset'); continue; }
            const val = VAL[p](v);
            if (!val) { warn('@keyframes ' + a.name + ': значение «' + v + '» у ' + p + ' не разобрано'); continue; }
            put(p, val);
          }
        }
        for (const p in per) {
          const ks = per[p]; let b = base(p);
          if (!b) b = ks[0].val;
          if (ks[0].off > 0) ks.unshift({ off: 0, val: b, ease: a.ease });
          if (ks[ks.length - 1].off < 1) ks.push({ off: 1, val: b, ease: a.ease });
          const segs = expand(ks, a, b);
          if (segs.length) { if (out[p]) warn('свойство ' + p + ' анимируют две анимации сразу, взята последняя'); out[p] = segs; }
        }
      }
      return out;
    }

    // преобразование элемента: точка опоры, статичная матрица, дорожки
    function xf(n) {
      if (n.xf) return n.xf;
      const st = n.st, list = st.transform && st.transform !== 'none' ? parseTransform(st.transform) : [];
      const ch = listChannels(list) || { t: [0, 0], r: [0], s: [1, 1] };
      const ind = { t: st.translate ? VAL.translate(st.translate) : [0, 0], r: st.rotate ? VAL.rotate(st.rotate) : [0], s: st.scale ? VAL.scale(st.scale) : [1, 1] };
      const opacity = st.opacity !== undefined ? clamp01(frac(st.opacity)) : 1;
      const col = (k, d) => { const v = st[k] === undefined ? d : st[k]; if (!v || /^url\(/.test(v)) return null; const c = parseColor(v === 'currentColor' ? st.color || 'black' : v); return c || null; };
      const base = (p) => (p === 'opacity' ? [opacity] : p === 'translate' ? ind.t : p === 'rotate' ? ind.r : p === 'scale' ? ind.s : p === 't.translate' ? ch.t : p === 't.rotate' ? ch.r : p === 't.scale' ? ch.s : p === 'fill' ? col('fill', 'black') : p === 'stroke' ? col('stroke', 'none') : p === 'stroke-width' ? [len(st['stroke-width'] || '1')] : p === 'stroke-dashoffset' ? [len(st['stroke-dashoffset'] || '0')] : null);
      const tracks = tracksOf(n, animsOf(n), base, 0);
      const dynA = !!(tracks['t.translate'] || tracks['t.rotate'] || tracks['t.scale']);
      if (dynA && list.length && !listChannels(list)) warn('у элемента ' + (n.attrs.id ? '#' + n.attrs.id : '<' + n.tag + '>') + ' анимируется transform, а статичный transform не раскладывается: он не учтён');
      const x = (n.xf = { tracks, ind, ch, opacity, dynA, dynT: !!(tracks.translate || tracks.rotate || tracks.scale), A: dynA ? I : listMatrix(list, warn), o: [0, 0], Ms: I });
      // точка опоры: transform-origin относительно transform-box (по умолчанию view-box и 0 0, как в браузере)
      const to = st['transform-origin'];
      if (to) {
        const fill = /fill-box|content-box|stroke-box|border-box/.test(st['transform-box'] || ''), bx = fill ? bbox(n) || [0, 0, 0, 0] : [vbox[0], vbox[1], vbox[0] + W, vbox[1] + H];
        const p = splitTop(to.trim(), ' '), KW = { left: 0, center: 0.5, right: 1, top: 0, bottom: 1 };
        let px = p[0], py = p[1];
        if (py === undefined) { if (px === 'top' || px === 'bottom') { py = px; px = 'center'; } else py = 'center'; } else if (px === 'top' || px === 'bottom' || py === 'left' || py === 'right') { const t = px; px = py; py = t; }
        const one = (v, lo, hi) => (KW[v] !== undefined ? lo + (hi - lo) * KW[v] : /%$/.test(v) ? lo + (hi - lo) * parseFloat(v) / 100 : lo + len(v));
        x.o = [one(px, bx[0], bx[2]), one(py, bx[1], bx[3])];
      }
      x.Ms = mul(mul(TRS(x.o, ind.t, ind.r, ind.s), mul(mul(T(x.o[0], x.o[1]), dynA ? TRS([0, 0], ch.t, ch.r, ch.s) : x.A), T(-x.o[0], -x.o[1]))), I);
      if ((x.dynT || x.dynA) && !to && (tracks.rotate || tracks.scale || tracks['t.rotate'] || tracks['t.scale'])) warn('элемент ' + (n.attrs.id ? '#' + n.attrs.id : '<' + n.tag + '>') + ' вращается или растягивается вокруг точки 0 0: чтобы вокруг своего центра, добавьте transform-box: fill-box; transform-origin: center');
      return x;
    }

    // ───────── сборка сцены ─────────
    const num = (v) => ({ a: 0, k: v });
    const trItem = (a, p, s, r, o) => ({ ty: 'tr', a: a || num([0, 0]), p: p || num([0, 0]), s: s || num([100, 100]), r: r || num(0), o: o || num(100), sk: num(0), sa: num(0) });
    const group = (nm, items, tr) => ({ ty: 'gr', nm, it: items.concat([tr || trItem()]) });
    const nameOf = (n) => n.attrs.id || n.tag;
    function staticTr(m, n) {   // матрица без перекоса -> transform группы
      const sx = Math.hypot(m[0], m[1]), det = m[0] * m[3] - m[1] * m[2];
      if (!(sx > 1e-9) || Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-6 * Math.max(1, Math.abs(det))) throw new ECoreError('элемент с движением лежит внутри transform с перекосом (skew): так не поддержано', n.line);
      return trItem(null, num([r3(m[4]), r3(m[5])]), num([r3(sx * 100), r3(det / sx * 100)]), num(r3(Math.atan2(m[1], m[0]) * 180 / Math.PI)));
    }
    const dynTr = (o, tk, pre, c, op) => trItem(num([r3(o[0]), r3(o[1])]),
      P(tk[pre + 'translate'], (v) => [r3(o[0] + v[0]), r3(o[1] + v[1])], [r3(o[0] + c.t[0]), r3(o[1] + c.t[1])]),
      P(tk[pre + 'scale'], (v) => [r3(v[0] * 100), r3(v[1] * 100)], [r3(c.s[0] * 100), r3(c.s[1] * 100)]),
      P(tk[pre + 'rotate'], (v) => [r3(v[0])], r3(c.r[0])), op);

    function build(n, M, alpha) {   // -> элементы Lottie, верхние первыми
      if (!n.st) return [];
      const x = xf(n), tk = x.tracks, o = x.o;
      const opProp = (mult) => P(tk.opacity, (v) => [r3(v[0] * mult * 100)], r3(x.opacity * mult * 100));
      if (!x.dynT && !x.dynA) {
        if (!tk.opacity) return content(n, mul(M, x.Ms), alpha * x.opacity);
        const inner = content(n, mul(M, x.Ms), 1);
        return inner.length ? [group(nameOf(n), inner, trItem(null, null, null, null, opProp(alpha)))] : [];
      }
      // движение: накопленная статичная матрица выходит отдельной группой снаружи
      const conj = (m) => mul(mul(T(o[0], o[1]), m), T(-o[0], -o[1]));
      let inner, pend = M, opDone = false;
      const op = () => { if (opDone) return undefined; opDone = true; return opProp(alpha); };
      if (x.dynA) { inner = content(n, I, 1); inner = inner.length ? [group(nameOf(n), inner, dynTr(o, tk, 't.', x.ch, x.dynT ? undefined : op()))] : []; }
      else inner = content(n, conj(x.A), 1);
      if (!inner.length) return [];
      if (x.dynT) inner = [group(nameOf(n), inner, dynTr(o, tk, '', x.ind, op()))];
      else pend = mul(pend, TRS(o, x.ind.t, x.ind.r, x.ind.s));
      return isI(pend) ? inner : [group(nameOf(n) + ' place', inner, staticTr(pend, n))];
    }
    function content(n, M, alpha) {
      if (SHAPES.has(n.tag)) return paintItems(n, mapSubs(geom(n), M), M, alpha, bbox(n), xf(n).tracks);
      if (n.tag === 'text') return textItems(n, M, alpha);
      const out = []; for (let i = n.kids.length - 1; i >= 0; i--) out.push(...build(n.kids[i], M, alpha));
      return out;
    }
    const toSh = (s) => ({ ty: 'sh', ks: { a: 0, k: { c: s.c, v: s.v.map((p) => [r3(p[0]), r3(p[1])]), i: s.i.map((p) => [r3(p[0]), r3(p[1])]), o: s.o.map((p) => [r3(p[0]), r3(p[1])]) } } });

    // градиент -> поля заливки Lottie; F переводит единицы градиента в координаты фигуры
    function gradient(id, n, M, box) {
      const chain = []; for (let g = ids[id], d = 0; g && d < 8; g = ids[href(g)], d++) chain.push(g);
      const g0 = chain[0]; if (!g0 || !/Gradient$/.test(g0.tag)) { warn('заливка url(#' + id + '): такого градиента нет'); return null; }
      const get = (k) => { for (const g of chain) if (g.attrs[k] !== undefined) return g.attrs[k]; };
      const stopsOf = (chain.find((g) => g.kids.some((k) => k.tag === 'stop')) || g0).kids.filter((k) => k.tag === 'stop');
      const stops = []; let lastOff = 0;
      for (const s of stopsOf) {
        const sd = {}; for (const [k, v] of parseDecls(s.attrs.style || '')) sd[k] = v;
        const c = parseColor(sd['stop-color'] || s.attrs['stop-color'] || 'black') || [0, 0, 0, 0], so = sd['stop-opacity'] || s.attrs['stop-opacity'];
        lastOff = Math.max(lastOff, clamp01(frac(s.attrs.offset || '0') || 0)); stops.push([lastOff, c[0], c[1], c[2], c[3] * (so !== undefined ? clamp01(frac(so)) : 1)]);
      }
      if (!stops.length) return null;
      if (stops.length === 1) stops.push([1].concat(stops[0].slice(1)));
      const user = get('gradientUnits') === 'userSpaceOnUse';
      let Q = user || !box ? I : [box[2] - box[0] || 1, 0, 0, box[3] - box[1] || 1, box[0], box[1]];
      if (get('gradientTransform')) Q = mul(Q, listMatrix(parseTransform(get('gradientTransform')), warn));
      const F = mul(M, Q), det = F[0] * F[3] - F[1] * F[2], c = (k, d, tot) => { const v = get(k); return v === undefined ? (user ? d * tot : d) : /%$/.test(v) ? parseFloat(v) / 100 * (user ? tot : 1) : len(v); };
      const k = []; for (const s of stops) k.push(r3(s[0]), r3(s[1]), r3(s[2]), r3(s[3]));
      if (stops.some((s) => s[4] < 0.999)) for (const s of stops) k.push(r3(s[0]), r3(s[4]));
      const out = { g: { p: stops.length, k: num(k) } };
      if (g0.tag === 'linearGradient') {
        const x1 = c('x1', 0, W), y1 = c('y1', 0, H), dx = c('x2', 1, W) - x1, dy = c('y2', 0, H) - y1, d2 = dx * dx + dy * dy || 1e-9, s = pt(F, x1, y1);
        // под аффинным преобразованием линейный градиент остаётся линейным, но его направление идёт по F^-T
        const gx = (F[3] * dx - F[1] * dy) / (det * d2), gy = (-F[2] * dx + F[0] * dy) / (det * d2), g2 = gx * gx + gy * gy || 1e-9;
        out.t = 1; out.s = num([r3(s[0]), r3(s[1])]); out.e = num([r3(s[0] + gx / g2), r3(s[1] + gy / g2)]);
      } else {
        const cx = c('cx', 0.5, W), cy = c('cy', 0.5, H), r = c('r', 0.5, Math.hypot(W, H) / Math.SQRT2), s = pt(F, cx, cy), sc = Math.sqrt(Math.abs(det));
        if (Math.abs(Math.hypot(F[0], F[1]) - Math.hypot(F[2], F[3])) > 0.02 * sc || Math.abs(F[0] * F[2] + F[1] * F[3]) > 0.02 * sc * sc) warn('радиальный градиент #' + id + ' на вытянутой фигуре станет круглым: задайте gradientUnits="userSpaceOnUse"');
        out.t = 2; out.s = num([r3(s[0]), r3(s[1])]); out.e = num([r3(s[0] + r * sc), r3(s[1])]); out.h = num(0); out.a = num(0);
      }
      return out;
    }

    // фигура с заливкой и обводкой -> группы Lottie. subs уже в координатах группы, M — что в них запечено.
    function paintItems(n, subs, M, alpha, box, tk, name, wk) {
      if (!subs.length) return [];
      const st = n.st, sc = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) * (wk || 1), sh = subs.map(toSh);   // wk: обводка ужатого текста тоньше во столько же раз
      const paint = (kind, def) => {
        let v = st[kind] === undefined ? def : st[kind].trim(); if (v === 'currentColor') v = st.color || 'black';
        const op = (st[kind + '-opacity'] !== undefined ? clamp01(frac(st[kind + '-opacity'])) : 1) * alpha, m = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(v);
        if (m) { const g = gradient(m[1], n, M, box); return g ? Object.assign({ ty: kind === 'fill' ? 'gf' : 'gs', o: num(r3(op * 100)), r: st['fill-rule'] === 'evenodd' ? 2 : 1 }, g) : null; }
        const c = parseColor(v);
        if (c === undefined) { warn('цвет «' + v + '» не разобран'); return null; }
        if (!c && !tk[kind]) return null;
        const c0 = c || [0, 0, 0, 1];
        return { ty: kind === 'fill' ? 'fl' : 'st', c: P(tk[kind], (q) => [r3(q[0]), r3(q[1]), r3(q[2]), 1], [r3(c0[0]), r3(c0[1]), r3(c0[2]), 1]), o: num(r3(op * c0[3] * 100)), r: st['fill-rule'] === 'evenodd' ? 2 : 1 };
      };
      const fill = paint('fill', 'black'); let stroke = paint('stroke', 'none');
      if (stroke) {
        const w = len(st['stroke-width'] === undefined ? '1' : st['stroke-width']);
        if (!(w > 0) && !tk['stroke-width']) stroke = null;
        else { delete stroke.r; Object.assign(stroke, { w: P(tk['stroke-width'], (q) => [r3(q[0] * sc)], r3(w * sc)), lc: 2, lj: 2, ml: 4 }); if ((st['stroke-linecap'] && st['stroke-linecap'] !== 'round') || (st['stroke-linejoin'] && st['stroke-linejoin'] !== 'round')) warn('концы и стыки обводки в eCore всегда круглые: пишите stroke-linecap="round" stroke-linejoin="round"'); }
      }
      // «рисование линии»: stroke-dasharray + stroke-dashoffset превращаются в trim
      let trim = null; const da = st['stroke-dasharray'];
      if (stroke && da && da !== 'none') {
        const nums = da.split(/[\s,]+/).filter(Boolean).map(len), total = n.attrs.pathLength ? +n.attrs.pathLength : pathLen(geom(n));
        const dash = nums[0] / total, gap = (nums.length > 1 ? nums[1] : nums[0]) / total, segs = tk['stroke-dashoffset'], off0 = len(st['stroke-dashoffset'] || '0') / total;
        if (!(total > 0) || nums.length > 2 || !(dash > 0)) warn('пунктир из нескольких штрихов не поддержан, линия останется сплошной');
        else if (Math.abs(dash + gap - 1) < 0.01) trim = { ty: 'tm', s: num(0), e: num(r3(dash * 100)), o: P(segs, (v) => [r3(-v[0] / total * 360)], r3(-off0 * 360)), m: 1 };   // штрих бежит по кругу
        else if (gap < 0.99) warn('пунктир не поддержан, линия останется сплошной: для «рисования линии» задайте pathLength="1" stroke-dasharray="1"');
        else {
          const sOf = (o) => clamp01(-o) * 100, eOf = (o) => clamp01(dash - o) * 100;
          if (!segs) trim = { ty: 'tm', s: num(r3(sOf(off0))), e: num(r3(eOf(off0))), o: num(0), m: 1 };
          else {
            const vals = []; for (const s of segs) vals.push(s.v0[0] / total, s.v1[0] / total);
            const direct = (raw) => vals.every((o) => raw(o) > -0.002 && raw(o) < 1.002);
            // если значение упирается в край, дорожку считаем по кадрам, иначе easing исказится
            const baked = (fn) => { const k = []; let pv = null; for (let f = 0; f <= frames; f++) { const v = r3(fn(evalSegs(segs, f / fps)[0] / total)); if (pv !== null && k.length > 1 && Math.abs(k[k.length - 1].s[0] - pv) < 1e-3 && Math.abs(v - pv) < 1e-3) k[k.length - 1].t = f; else k.push({ t: f, s: [v], o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }); pv = v; } return k.length > 1 ? { a: 1, k } : num(k[0].s[0]); };
            trim = { ty: 'tm', s: vals.every((o) => -o <= 0.002) ? num(0) : direct((o) => -o) ? P(segs, (v) => [r3(sOf(v[0] / total))], 0) : baked(sOf), e: vals.every((o) => dash - o >= 0.998) ? num(100) : direct((o) => dash - o) ? P(segs, (v) => [r3(eOf(v[0] / total))], 100) : baked(eOf), o: num(0), m: 1 };
          }
        }
      }
      const nm = name || nameOf(n), under = /^\s*stroke/.test(st['paint-order'] || '');   // paint-order: stroke кладёт обводку под заливку
      if (!fill && !stroke) return [];
      if (trim && fill) { const a = group(nm + ' line', sh.concat([trim, stroke])), b = group(nm, sh.concat([fill])); return under ? [b, a] : [a, b]; }
      const paints = !stroke ? [fill] : !fill ? [stroke] : under ? [fill, stroke] : [stroke, fill];
      return [group(nm, sh.concat(trim ? [trim] : [], paints))];
    }

    function textItems(n, M, alpha) {
      const lay = layout(n), a = n.attrs;
      if (!lay.glyphs.length) return [];
      const letters = a['data-letters'] ? parseAnimations({ animation: a['data-letters'] }, warn).filter((q) => { if (css.keyframes[q.name]) return true; warn('нет @keyframes с именем «' + q.name + '»'); return false; }) : [];
      if (!letters.length) return paintItems(n, mapSubs([].concat(...lay.glyphs.map((g) => g.subs)), M), M, alpha, lay.box, xf(n).tracks, undefined, lay.fitK);
      // побуквенное движение: каждая буква своя группа, задержка растёт на data-stagger
      const step = a['data-stagger'] ? time(a['data-stagger']) : 0.05, idn = { t: [0, 0], r: [0], s: [1, 1] }, out = [];
      const base = (p) => (p === 'opacity' ? [1] : /translate$/.test(p) ? [0, 0] : /rotate$/.test(p) ? [0] : /scale$/.test(p) ? [1, 1] : null);
      lay.glyphs.forEach((g, i) => {
        const tk = tracksOf(n, letters, base, i * step), o = [(g.box[0] + g.box[2]) / 2, (g.box[1] + g.box[3]) / 2];
        let it = paintItems(n, g.subs, I, 1, lay.box, xf(n).tracks, g.ch, lay.fitK);
        const op = P(tk.opacity, (v) => [r3(v[0] * 100)], 100);
        if (tk['t.translate'] || tk['t.rotate'] || tk['t.scale']) it = [group(g.ch, it, dynTr(o, tk, 't.', idn, tk.translate || tk.rotate || tk.scale ? undefined : op))];
        if (tk.translate || tk.rotate || tk.scale || !(tk['t.translate'] || tk['t.rotate'] || tk['t.scale'])) it = [group(g.ch, it, dynTr(o, tk, '', idn, op))];
        out.unshift(...it);
      });
      return [group(nameOf(n), out, isI(M) ? trItem(null, null, null, null, num(r3(alpha * 100))) : Object.assign(staticTr(M, n), { o: num(r3(alpha * 100)) }))];
    }

    const shapes = build(root, T(-vbox[0], -vbox[1]), 1);
    const lottie = { tgs: 1, v: '5.5.2', fr: fps, ip: 0, op: frames, w: W, h: H, nm: opts.name || root.attrs.id || 'ecore', ddd: 0, assets: [], layers: [{ ddd: 0, ind: 1, ty: 4, nm: 'ecore', sr: 1, ks: { o: num(100), r: num(0), p: num([0, 0, 0]), a: num([0, 0, 0]), s: num([100, 100, 100]) }, ao: 0, shapes, ip: 0, op: frames, st: 0, bm: 0 }] };
    return { lottie, w: W, h: H, fps, frames, duration: D, warnings, slots };
  }

  // сцена -> то, что примет Telegram как .tgs (после gzip): 512x512, 30 или 60 кадров, до 3 секунд, до 64 КБ
  function forTgs(lottie) {
    const problems = [], j = JSON.parse(JSON.stringify(lottie));
    if (j.w !== j.h) problems.push('холст не квадратный (' + j.w + '×' + j.h + '), Telegram принимает только 512×512');
    else if (j.w !== 512) { const k = 512 / j.w * 100; j.layers.forEach((l) => { l.ks.s = { a: 0, k: [k, k, 100] }; }); j.w = j.h = 512; }
    if (j.fr !== 30 && j.fr !== 60) problems.push('частота ' + j.fr + ' кадров, Telegram принимает 30 или 60');
    if ((j.op - j.ip) / j.fr > 3.0001) problems.push('длительность ' + r3((j.op - j.ip) / j.fr) + ' с, Telegram принимает до 3 с');
    return { json: JSON.stringify(j), problems };
  }

  // исходник -> всё сразу: сцена, .ecr и текст для .tgs
  function build(src, opts) {
    const r = compileSource(src, opts), ecr = (G.ECore && G.ECore.compileLottie) || require('./ecr.js').compileLottie, c = ecr(r.lottie, opts && (opts.still || opts.over) ? { still: !!opts.still, over: opts.over } : undefined);
    for (const k in c.unsupported) r.warnings.push(k);
    return Object.assign(r, { ecr: c.bin });
  }

  const api = { compileSource, build, forTgs, parseFont, ECoreError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  G.ECore = Object.assign(G.ECore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
