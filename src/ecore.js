// eCore. Copyright (c) 2026 ecronx. Лицензия CPAL 1.0, полный текст в файле LICENSE. Пользоваться можно бесплатно,
// если в интерфейсе продукта видна надпись «Rendered with eCore» со ссылкой на https://tier.guru/ecore/.
// eCore: плеер файлов .ecr (их делает ecr.js из tgs или из исходника).
// На кадр процессор делает три вещи: считает ключи, собирает матрицы и режет кривые на отрезки.
// Растеризует видеокарта: фрагментный шейдер считает точное покрытие пикселя по отрезкам
// из float-текстуры, слой уходит одним instanced-вызовом.
// Запуск не ждёт WebGL: первый кадр рисуется сразу через Canvas 2D, контекст и шейдер
// готовятся в фоне один раз на страницу и общие для всех анимаций. Canvas 2D остаётся
// запасным путём там, где WebGL2 нет или он программный. Третий путь, Soft, считает те же
// данные на процессоре без браузера: им рисуют на сервере и сверяют ядро с rlottie.
(function (G) {
  'use strict';
  const SEGW = 1024, SEG_ROWS = 128, INST_F = 20, LUT_ROWS = 1024, GL_SIZE = 512, KAPPA = 0.5522847498;
  // ключи структуры файла: список общий с ecr.js, новые только в конец
  const KEYS = 'v w h fr ip op ng nf names over comps ty st sr par hd tt ks rf gx cn ch pa ge tr sy a p px py s r o n c t el rc q k ru xf nm g e row hl ha lc lj ml d x y color src cs'.split(' ');
  // рабочие буферы общие: кадры рисуются строго по одному. Все растут по мере надобности
  let SEG = new Float32Array(SEGW * SEG_ROWS * 4), INST = new Float32Array(2048 * INST_F), IM = new Int32Array(2048 * 4);
  // корзины по строкам (bin() ниже): отрезки, разложенные по строкам, и таблица «строка -> диапазон корзины»
  const ROW_ROWS = 16;
  let SEG2 = new Float32Array(SEGW * SEG_ROWS * 4), ROWT = new Float32Array(SEGW * ROW_ROWS * 4), RC = new Int32Array(256), BN = 0, RN = 0;
  let PTS = new Float32Array(1 << 16), LEN = new Float32Array(1 << 15), PC = new Int32Array(3 * 256), PC2 = new Int32Array(3 * 256), CMD = new Float64Array(3 * 64);
  const V2 = new Float32Array(8), GV = new Float32Array(8), PV = new Float32Array(160), DV = new Float32Array(32);
  let CTRL = new Float32Array(4096), Q = new Float64Array(4096), GOV = new Float32Array(64);
  const TD = new TextDecoder();
  const Z1 = Float32Array.of(0), Z2 = Float32Array.of(0, 0), O100 = Float32Array.of(100), S100 = Float32Array.of(100, 100), ONE4 = Float32Array.of(1, 1, 1, 1);
  const DRAW = 0, PUSH = 1, POP = 2, POPM = 3;

  const VS = `#version 300 es
  layout(location=0) in vec2 aCorner;
  layout(location=1) in vec4 aBox;
  layout(location=2) in vec4 aSeg;
  layout(location=3) in vec4 aCol;
  layout(location=4) in vec4 aG0;
  layout(location=5) in vec4 aG1;
  uniform vec2 uSize;
  flat out vec4 vSeg; flat out vec4 vCol; flat out vec4 vG0; flat out vec4 vG1; flat out float vTop;
  void main() {
    vec2 p = mix(aBox.xy, aBox.zw, aCorner);
    vSeg = aSeg; vCol = aCol; vG0 = aG0; vG1 = aG1; vTop = floor(aBox.y);
    gl_Position = vec4(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0, 0.0, 1.0);
  }`;

  const FS = `#version 300 es
  precision highp float; precision highp sampler2D;
  uniform sampler2D uSeg; uniform sampler2D uRow; uniform sampler2D uLut; uniform float uTop;
  flat in vec4 vSeg; flat in vec4 vCol; flat in vec4 vG0; flat in vec4 vG1; flat in float vTop;
  out vec4 o;
  float G(float x) { float c = clamp(x, 0.0, 1.0); return 0.5 * c * c + max(x - 1.0, 0.0); }
  void main() {
    vec2 p = vec2(gl_FragCoord.x, uTop - gl_FragCoord.y);
    int mode = int(vSeg.z);
    // отрезки, которые задевают эту строку пикселей: из корзины строки, а не весь список экземпляра
    int ri = int(vSeg.x) + clamp(int(floor(p.y)) - int(vTop), 0, int(vSeg.y) - 1);
    vec4 rt = texelFetch(uRow, ivec2(ri & ${SEGW - 1}, ri >> ${Math.log2(SEGW)}), 0);
    int s = int(rt.x), e = s + int(rt.y);
    float cov;
    if (mode == 2) {
      // обводка: расстояние до ломаной, круглые стыки и концы получаются сами
      float d2 = 1e20;
      for (int i = s; i < e; i++) {
        vec4 g = texelFetch(uSeg, ivec2(i & ${SEGW - 1}, i >> ${Math.log2(SEGW)}), 0);
        vec2 ba = g.zw - g.xy, pa = p - g.xy;
        float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
        vec2 q = pa - ba * h; d2 = min(d2, dot(q, q));
      }
      float d = sqrt(d2), hw = vSeg.w;
      cov = clamp(hw - d + 0.5, 0.0, 1.0) - clamp(-hw - d + 0.5, 0.0, 1.0);
    } else {
      // заливка: интеграл числа оборотов по площади пикселя, точно для каждого отрезка
      vec2 org = p - 0.5; float acc = 0.0;
      for (int i = s; i < e; i++) {
        vec4 g = texelFetch(uSeg, ivec2(i & ${SEGW - 1}, i >> ${Math.log2(SEGW)}), 0);
        vec2 a = g.xy - org, b = g.zw - org;
        float dy = b.y - a.y;
        if (abs(dy) < 1e-7) continue;
        float t0 = clamp(-a.y / dy, 0.0, 1.0), t1 = clamp((1.0 - a.y) / dy, 0.0, 1.0);
        float ta = min(t0, t1), tb = max(t0, t1);
        if (tb <= ta) continue;
        float xa = mix(a.x, b.x, ta), xb = mix(a.x, b.x, tb), dx = xb - xa;
        float avg = abs(dx) < 1e-5 ? clamp(0.5 * (xa + xb), 0.0, 1.0) : (G(xb) - G(xa)) / dx;
        acc += (tb - ta) * dy * avg;
      }
      cov = mode == 0 ? min(abs(acc), 1.0) : abs(acc - 2.0 * round(acc * 0.5));
    }
    if (cov <= 0.0) discard;
    vec4 c = vCol;
    int pt = int(vG1.z);
    if (pt != 0) {
      vec2 q = vec2(vG0.x * p.x + vG0.z * p.y + vG1.x, vG0.y * p.x + vG0.w * p.y + vG1.y);
      float t;
      if (pt == 1) t = q.x;
      else if (vCol.z > 0.5) {
        // блик: фокус сдвинут от центра, t ищется из пересечения луча «фокус -> точка» с единичным кругом
        vec2 d = q - vCol.xy; float A = 1.0 - dot(vCol.xy, vCol.xy), B = -dot(d, vCol.xy);
        t = (-B + sqrt(max(B * B + A * dot(d, d), 0.0))) / max(A, 1e-6);
      } else t = length(q);
      t = clamp(t, 0.0, 1.0);
      vec4 g = texture(uLut, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, (vG1.w + 0.5) / ${LUT_ROWS}.0));
      c = g * vCol.a;   // в LUT цвета уже умножены на альфу
    }
    o = c * cov;
  }`;
  // сведение слоёв, нарисованных в сторону: непрозрачность группы и маска (uLuma: маска по яркости)
  const VS2 = `#version 300 es
  layout(location=0) in vec2 aCorner;
  void main() { gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0); }`;
  const FS2 = `#version 300 es
  precision highp float;
  uniform sampler2D uTex; uniform float uAlpha; uniform float uLuma;
  out vec4 o;
  void main() {
    vec4 c = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0);
    if (uLuma > 0.5) c = vec4(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)));
    o = c * uAlpha;
  }`;

  function ease(ox, oy, ix, iy, u) {
    if (ox === oy && ix === iy) return u;
    let t = u, lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mt = 1 - t, x = 3 * mt * mt * t * ox + 3 * mt * t * t * ix + t * t * t - u;
      if (x > -1e-6 && x < 1e-6) break;
      if (x < 0) lo = t; else hi = t;
      const dx = 3 * mt * mt * ox + 6 * mt * t * (ix - ox) + 3 * t * t * (1 - ix);
      let n = dx > 1e-6 ? t - x / dx : -1;
      if (!(n > lo && n < hi)) n = (lo + hi) * 0.5;
      t = n;
    }
    const mt = 1 - t;
    return 3 * mt * mt * t * oy + 3 * mt * t * t * iy + t * t * t;
  }

  // ---------- свой inflate (RFC 1951): пара к deflate из ecr.js ----------
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  // таблица разбора кода: индекс — биты из потока, значение — символ и длина его кода
  function huff(lens, n) {
    let max = 1; for (let i = 0; i < n; i++) if (lens[i] > max) max = lens[i];
    const cnt = new Uint16Array(16), next = new Uint16Array(16), tab = new Uint16Array(1 << max);
    for (let i = 0; i < n; i++) cnt[lens[i]]++;
    cnt[0] = 0; let c = 0;
    for (let b = 1; b < 16; b++) { c = (c + cnt[b - 1]) << 1; next[b] = c; }
    for (let s = 0; s < n; s++) {
      const l = lens[s]; if (!l) continue;
      let v = next[l]++, r = 0; for (let k = 0; k < l; k++) { r = (r << 1) | (v & 1); v >>= 1; }
      for (let i = r; i < tab.length; i += 1 << l) tab[i] = (s << 4) | l;
    }
    return { tab, max };
  }
  let FIXL = null, FIXD = null;
  function inflateRaw(src) {
    let out = new Uint8Array(Math.max(1024, src.length * 4)), op = 0, pos = 0, bb = 0, bn = 0;
    const room = (k) => { if (op + k > out.length) { const g = new Uint8Array(Math.max(out.length * 2, op + k)); g.set(out.subarray(0, op)); out = g; } };
    const bits = (k) => { while (bn < k) { bb |= (src[pos++] || 0) << bn; bn += 8; } const v = bb & ((1 << k) - 1); bb >>>= k; bn -= k; return v; };
    const sym = (T) => {
      while (bn < T.max) { bb |= (src[pos++] || 0) << bn; bn += 8; }
      const e = T.tab[bb & ((1 << T.max) - 1)], l = e & 15;
      if (!l) throw new Error('ecore: файл .ecr повреждён');
      bb >>>= l; bn -= l; return e >> 4;
    };
    for (;;) {
      const last = bits(1), type = bits(2);
      if (type === 0) {
        pos -= bn >> 3; bb = 0; bn = 0;
        const len = src[pos] | (src[pos + 1] << 8); pos += 4;
        room(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len;
      } else if (type === 3) throw new Error('ecore: файл .ecr повреждён');
      else {
        let LT, DT;
        if (type === 1) {
          if (!FIXL) { const l = new Uint8Array(288); for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8; FIXL = huff(l, 288); FIXD = huff(new Uint8Array(30).fill(5), 30); }
          LT = FIXL; DT = FIXD;
        } else {
          const hl = bits(5) + 257, hd = bits(5) + 1, hc = bits(4) + 4, cl = new Uint8Array(19);
          for (let i = 0; i < hc; i++) cl[CLORD[i]] = bits(3);
          const CT = huff(cl, 19), lens = new Uint8Array(hl + hd);
          for (let i = 0; i < hl + hd;) {
            const s = sym(CT);
            if (s < 16) lens[i++] = s;
            else if (s === 16) { let r = 3 + bits(2); const v = lens[i - 1]; while (r-- > 0 && i < lens.length) lens[i++] = v; }
            else i += s === 17 ? 3 + bits(3) : 11 + bits(7);
          }
          LT = huff(lens.subarray(0, hl), hl); DT = huff(lens.subarray(hl), hd);
        }
        for (;;) {
          const s = sym(LT);
          if (s < 256) { room(1); out[op++] = s; continue; }
          if (s === 256) break;
          const li = s - 257, len = LBASE[li] + bits(LEXT[li]), ds = sym(DT), dist = DBASE[ds] + bits(DEXT[ds]);
          if (dist > op) throw new Error('ecore: файл .ecr повреждён');
          room(len);
          for (let k = 0; k < len; k++, op++) out[op] = out[op - dist];
        }
      }
      if (last) break;
      if (pos > src.length + 4) throw new Error('ecore: файл .ecr оборван');
    }
    return out.subarray(0, op);
  }

  // файл -> заголовок, плоский Float32-массив ключей и таблица «номер дорожки -> место в массиве»
  function decode(buf) {
    let u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8[0] !== 69 || u8[1] !== 67 || u8[2] !== 82) throw new Error('ecore: это не файл .ecr');
    if (u8[3] !== 50) throw new Error('ecore: файл .ecr другой версии, пересоберите его');
    u8 = u8[4] & 1 ? inflateRaw(u8.subarray(5)) : u8.subarray(5);
    let p = 0;
    const rd = () => { let b = u8[p++]; if (b < 128) return b; let r = b & 127, m = 128; do { b = u8[p++]; r += (b & 127) * m; m *= 128; } while (b > 127); return r; };
    const zz = () => { const z = rd(); return z % 2 ? -(z + 1) / 2 : z / 2; };
    const str = (n) => { const s = TD.decode(u8.subarray(p, p + n)); p += n; return s; };
    const val = () => {
      const v = rd(), tag = v % 8, x = (v - tag) / 8;
      switch (tag) {
        case 0: return x;
        case 1: return -x;
        case 2: return x / 1000;
        case 3: return -x / 1000;
        case 4: { const a = new Array(x); for (let i = 0; i < x; i++) a[i] = val(); return a; }
        case 5: { const o = {}; for (let i = 0; i < x; i++) { const id = rd(), k = id ? KEYS[id - 1] : str(rd()); if (k === undefined) throw new Error('ecore: файл .ecr новее плеера'); o[k] = val(); } return o; }
        case 6: return str(x);
        case 7: return (x % 2 ? -(x + 1) / 2 : x / 2) / 1048576;
        default: throw new Error('ecore: файл .ecr повреждён');
      }
    };
    const h = val(), F = new Float32Array(h.nf), nd = rd(), off = new Int32Array(nd);
    let o = 0;
    for (let n = 0; n < nd; n++) {
      const type = rd(); off[n] = o;
      if (type === 1) {
        const len = rd(); if (Q.length < len) Q = new Float64Array(len * 2);
        for (let d = 0; d < len; d++) { let q = zz(); if (d >= 6 && d % 6 < 2) q += Q[d - 6]; Q[d] = q; F[o + d] = q / 64; }
        o += len; continue;
      }
      const sc = type === 3 ? 1024 : type === 5 ? 65536 : 64, D = rd(), N = rd(), E = rd(), fl = rd(), hasE = fl & 1, sp = fl & 2, ne = 4 * E;
      F[o++] = D; F[o++] = N; F[o++] = E; F[o++] = fl;
      if (Q.length < D + ne) Q = new Float64Array((D + ne) * 2);
      Q.fill(0, 0, D + ne);
      let t = 0;
      for (let k = 0; k < N; k++) {
        t += zz(); F[o++] = t / 16; F[o++] = rd();
        for (let j = 0; j < ne; j++) { Q[j] += zz(); F[o++] = Q[j] / 1024; }
        if (k === 0 && type === 4) for (let d = 0; d < D; d++) { let q = zz(); if (d >= 6 && d % 6 < 2) q += Q[ne + d - 6]; Q[ne + d] = q; F[o++] = q / sc; }
        else for (let d = 0; d < D; d++) { Q[ne + d] += zz(); F[o++] = Q[ne + d] / sc; }
        if (hasE) for (let d = 0; d < D; d++) F[o++] = (Q[ne + d] + zz()) / sc;
        if (sp) for (let d = 0; d < 2 * D; d++) F[o++] = zz() / 64;
      }
    }
    return { h, F, off };
  }

  // Стопы градиента из записи Lottie: k = [pos,r,g,b]*n, затем [pos,a]*m. Цвет и прозрачность сводятся в один
  // список так же, как это делает rlottie в Telegram (со всеми его особенностями: стоп прозрачности раньше стопа
  // цвета берёт цвет следующего стопа, а когда стопы прозрачности кончились, градиент обрывается на следующем цвете),
  // иначе градиенты с прозрачностью разойдутся с Telegram. out: [pos,r,g,b,a]*число
  let GS = new Float32Array(5 * 64);
  function stopsOf(k, n, m) {
    if (GS.length < 5 * (n + m + 2)) GS = new Float32Array(10 * (n + m + 2));
    const out = GS, ob = 4 * n, on = 2 * m; let c = 0, j = 0;
    const put = (pos, i, a) => { if (!(a === a)) a = 0; const q = c * 5; out[q] = pos; out[q + 1] = k[i * 4 + 1]; out[q + 2] = k[i * 4 + 2]; out[q + 3] = k[i * 4 + 3]; out[q + 4] = a < 0 ? 0 : a > 1 ? 1 : a; c++; };
    for (let i = 0; i < n; i++) {
      const cs = k[i * 4];
      if (on <= 0) { put(cs, i, 1); continue; }
      // стопы прозрачности кончились: rlottie ставит ещё один стоп цвета и дальше повторяет его же, градиент на нём обрывается
      if (j === on) { const s1 = k[ob + j - 4], o1 = k[ob + j - 3], s2 = k[ob + j - 2], o2 = k[ob + j - 1]; put(cs, i, cs > s2 ? o2 : o1 + (cs - s1) / (s2 - s1) * (o2 - o1)); break; }
      for (; j < on; j += 2) {
        if (k[ob + j] < cs) { put(k[ob + j], i, k[ob + j + 1]); continue; }
        put(cs, i, j === 0 ? k[ob + 1] : k[ob + j - 1] + (cs - k[ob + j - 2]) / (k[ob + j] - k[ob + j - 2]) * (k[ob + j + 1] - k[ob + j - 1]));
        j += 2; break;
      }
    }
    return c;
  }
  // имена групп, в которые входит цепочка c: от ближней к дальней, для выбора «сверху вниз» в редакторе
  const chainGroups = (l, c) => { const out = []; for (; c > 0; c = l.chains[c][0]) if (l.chainSrc[c]) out.push(l.chainSrc[c]); return out; };
  // overlay слоя или группы: поворот (градусы), масштаб (число или [x, y]) и прозрачность (0..1) заменяют прежние; null сбрасывает
  const setOv = (t, p) => { const sc = p && p.scale !== undefined ? (Array.isArray(p.scale) ? p.scale : [p.scale, p.scale]) : [1, 1]; t.dr = p && p.rotate ? +p.rotate || 0 : 0; t.dsx = +sc[0] || 0; t.dsy = +sc[1] || 0; t.dop = p && p.opacity !== undefined ? +p.opacity : 1; };
  // цвета стопов градиента по порядку: позиции и прозрачность остаются из файла
  const stopColors = (cols, n) => { if (!Array.isArray(cols) || cols.length !== n) throw new Error('ecore: у градиента ' + n + ' стопов, передано ' + (cols ? cols.length : 0)); const out = new Float32Array(3 * n); cols.forEach((c, i) => { const v = toRgba(c); out[i * 3] = v[0]; out[i * 3 + 1] = v[1]; out[i * 3 + 2] = v[2]; }); return out; };
  const css = (r, g, b, a) => 'rgba(' + Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ',' + (a < 0 ? 0 : a > 1 ? 1 : a) + ')';
  const hexOf = (c) => '#' + [c[0], c[1], c[2]].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  // цвет: '#rgb', '#rrggbb', '#rrggbbaa' или массив [r, g, b, a] в долях 0..1
  function toRgba(c) {
    if (Array.isArray(c)) return [c[0], c[1], c[2], c.length > 3 ? c[3] : 1];
    let h = String(c).trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) throw new Error('ecore: цвет «' + c + '» не разобрать, нужен вид #rrggbb');
    const n = (k) => parseInt(h.substr(k, 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  }
  // Корзины для видеокарты: каждая строка пикселей получает только отрезки, которые её задевают.
  // m — запас по высоте (для обводки: полтолщины и пиксель). Возвращает первую строку экземпляра в ROWT.
  function bin(s0, s1, top, H, m) {
    const base = RN;
    if (RC.length < H) RC = new Int32Array(H * 2);
    RC.fill(0, 0, H);
    for (let i = s0; i < s1; i++) {
      const ya = SEG[i * 4 + 1], yb = SEG[i * 4 + 3];
      const r0 = Math.max(0, Math.floor(Math.min(ya, yb) - m) - top), r1 = Math.min(H - 1, Math.floor(Math.max(ya, yb) + m) - top);
      for (let r = r0; r <= r1; r++) RC[r]++;
    }
    const rneed = Math.max((base + H) * 4, Math.ceil((base + H) / SEGW) * SEGW * 4);
    if (rneed > ROWT.length) { const g = new Float32Array(Math.max(ROWT.length * 2, rneed)); g.set(ROWT); ROWT = g; }
    let acc = BN;
    for (let r = 0; r < H; r++) { const q = (base + r) * 4, c = RC[r]; ROWT[q] = acc; ROWT[q + 1] = c; RC[r] = acc; acc += c; }
    const need = Math.ceil(acc / SEGW) * SEGW * 4;
    if (need > SEG2.length) { const g = new Float32Array(Math.max(SEG2.length * 2, need)); g.set(SEG2.subarray(0, BN * 4)); SEG2 = g; }
    for (let i = s0; i < s1; i++) {
      const ya = SEG[i * 4 + 1], yb = SEG[i * 4 + 3];
      const r0 = Math.max(0, Math.floor(Math.min(ya, yb) - m) - top), r1 = Math.min(H - 1, Math.floor(Math.max(ya, yb) + m) - top);
      for (let r = r0; r <= r1; r++) { const j = RC[r]++ * 4, q = i * 4; SEG2[j] = SEG[q]; SEG2[j + 1] = SEG[q + 1]; SEG2[j + 2] = SEG[q + 2]; SEG2[j + 3] = SEG[q + 3]; }
    }
    BN = acc; RN = base + H;
    return base;
  }
  // запас места в общих буферах
  const needPts = (n) => { if (n * 2 > PTS.length) { const g = new Float32Array(Math.max(PTS.length * 2, n * 2)); g.set(PTS); PTS = g; } if (n > LEN.length) LEN = new Float32Array(Math.max(LEN.length * 2, n)); };
  const needSeg = (n) => { if (n * 4 > SEG.length) { const g = new Float32Array(Math.max(SEG.length * 2, n * 4)); g.set(SEG); SEG = g; } };
  const needPc = (n) => { if (n * 3 > PC.length) { const g = new Int32Array(Math.max(PC.length * 2, n * 3)); g.set(PC); PC = g; } };
  // холсты для слоёв, которые рисуются в сторону (маска, непрозрачность группы) в пути Canvas 2D
  const side = [];
  const sideCtx = (depth, w, h) => {
    let c = side[depth];
    if (!c) c = side[depth] = (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })).getContext('2d');
    const cv = c.canvas;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } else { c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, w, h); }
    return c;
  };

  class Scene {
    constructor(buf) {
      const d = decode(buf), F = this.F = d.F, off = d.off, H = this.h = d.h;
      this.kc = new Int32Array(F.length); this.frames = Math.max(1, Math.round(H.op - H.ip)); this.stamp = 0; this.np = 0; this.arcs = new Map();
      // имена элементов из исходника: moves — можно двигать (именованная группа), paint — есть сплошная заливка
      const NE = (this.names = H.names || []).length;
      this.ovArr = new Array(NE).fill(null); this.moves = new Uint8Array(NE); this.paint = new Uint8Array(NE); this.color = new Array(NE).fill(null);
      const P = (p, def) => (p === undefined ? { t: -1, v: def } : typeof p === 'number' ? { t: -1, v: Float32Array.of(p) } : Array.isArray(p) ? { t: -1, v: Float32Array.from(p) } : { t: off[p.t], v: null });
      const X = (k) => { const o = { a: P(k.a, Z2), s: P(k.s, S100), r: P(k.r, Z1), o: P(k.o, O100), split: k.px !== undefined, dx: 0, dy: 0, dr: 0, dsx: 1, dsy: 1, dop: 1 }; if (o.split) { o.px = P(k.px, Z1); o.py = P(k.py, Z1); } else o.p = P(k.p, Z2); return o; };
      let maxCtrl = 64; this.styles = []; this.nodes = new Map();
      this.comps = (H.comps || []).map((layers) => ({ layers, complex: layers.length > 1 }));
      for (const C of this.comps) for (const l of C.layers) {
        if (l.ty === undefined) l.ty = 4;
        if (l.ip === undefined) l.ip = -Infinity; if (l.op === undefined) l.op = Infinity;
        l.parent = (l.par || 0) - 1; l.st = l.st || 0; l.sr = l.sr || 1; l.hd = l.hd || 0; l.tt = l.tt || 0;
        l.ks = X(l.ks || {}); l.wm = new Float32Array(6); l.stamp = -1;
        if (l.src) this.nodes.set(l.src, { layer: l, chain: 0 });
        if (l.ty !== 4) continue;
        const ch = l.ch || [], nch = ch.length / 2 + 1;
        l.chains = [[-1, -1]]; for (let i = 0; i < ch.length; i += 2) l.chains.push([ch[i], ch[i + 1]]);
        l.gx = (l.gx || []).map(X);
        l.cnName = new Int32Array(nch).fill(-1); for (let i = 0; i < (l.cn || []).length; i += 2) { l.cnName[l.cn[i]] = l.cn[i + 1]; this.moves[l.cn[i + 1]] = 1; }
        for (let i = 0; i < (l.cs || []).length; i += 2) this.nodes.set(l.cs[i + 1], { layer: l, chain: l.cs[i] });
        l.cm = new Float32Array(6 * nch); l.co = new Float32Array(nch); l.cdev = null;
        l.paths = (l.pa || []).map((p) => {
          if (p.el) return { kind: 1, dir: p.el, n: 4, c: 1, p: P(p.p, Z2), s: P(p.s, Z2) };
          if (p.rc) return { kind: 2, dir: p.rc, n: 8, c: 1, p: P(p.p, Z2), s: P(p.s, Z2), q: P(p.q, Z1) };
          const anim = p.t !== undefined, o = anim ? off[p.t] : off[p.o];
          if (6 * p.n > maxCtrl) maxCtrl = 6 * p.n;
          return { kind: 0, n: p.n, c: p.c, anim, st: anim ? null : F.subarray(o, o + 6 * p.n), off: anim ? o : -1 };
        });
        l.trims = (l.tr || []).map((t) => ({ s: P(t.s, Z1), e: P(t.e, O100), o: P(t.o, Z1) }));
        l.geoms = []; const ge = l.ge || []; for (let i = 0; i < ge.length; i += 3) l.geoms.push({ p: ge[i], xf: ge[i + 1], tm: ge[i + 2] - 1 });
        l.masks = (l.mk || []).map((m) => ({ mode: m.m, inv: m.i, o: P(m.o, O100), x: P(m.x, Z1), g: m.g }));
        l.gpc = new Int32Array(l.geoms.length); l.gst = new Int32Array(l.geoms.length); l.pieces = [];
        l.chainSrc = []; for (let i = 0; i < (l.cs || []).length; i += 2) l.chainSrc[l.cs[i]] = l.cs[i + 1];
        l.styles = (l.sy || []).map((s) => {
          const st = { k: s.k || 0, rule: s.ru === 2 ? 2 : 1, o: P(s.o, O100), xf: s.xf, geoms: s.ge, nm: s.nm === undefined ? -1 : s.nm, uid: this.styles.length, src: s.src || '', layer: l, ov: null, g: null, c: null, css: null, d: null, groups: chainGroups(l, s.xf) };
          this.styles.push(st);
          if (st.k) { st.w = P(s.w, Z1); st.lc = s.lc || 2; st.lj = s.lj || 2; st.ml = s.ml === undefined ? 4 : s.ml; if (s.d) st.d = s.d.map((v) => P(v, Z1)); }
          if (s.g) {
            const g = st.g = { t: s.g.t, s: P(s.g.s, Z2), e: P(s.g.e, Z2), n: s.g.n, k: P(s.g.k, Z1), row: s.g.row, hl: s.g.hl === undefined ? null : P(s.g.hl, Z1), ha: P(s.g.ha, Z1), cg: null, ok: false };
            g.len = g.k.t < 0 ? g.k.v.length : F[g.k.t]; g.fixed = g.k.t < 0 && g.s.t < 0 && g.e.t < 0 && (!g.hl || (g.hl.t < 0 && g.ha.t < 0));
            if (g.len > maxCtrl) maxCtrl = g.len;
          } else {
            st.c = P(s.c, ONE4); st.css = st.c.t < 0 ? css(st.c.v[0], st.c.v[1], st.c.v[2], 1) : null;
            if (st.nm >= 0) { this.paint[st.nm] = 1; if (this.color[st.nm] === null && st.c.t < 0) this.color[st.nm] = hexOf(st.c.v); }
          }
          if (st.src) this.nodes.set(st.src, { layer: l, style: st });
          return st;
        });
      }
      if (CTRL.length < maxCtrl) CTRL = new Float32Array(maxCtrl * 2);
      this.lut = new Uint8ClampedArray(Math.max(1, H.ng || 0) * 1024); this.lutN = 0; this.lutDirty = true; this.segs = 0; this.inst = 0; this.nc = 0;
      for (const n in H.over || {}) this.setOver(n, H.over[n]);   // стартовые смещения и цвета из файла
    }

    // элементы, которые можно двигать (move) и красить (paint), с цветом по умолчанию
    elements() { return this.names.map((name, i) => ({ name, move: !!this.moves[i], paint: !!this.paint[i], color: this.color[i] })).filter((e) => e.move || e.paint); }
    // смещение {x, y} в единицах исходника и/или цвет {color}: без пересборки, со следующего кадра
    setOver(name, patch) {
      const i = this.names.indexOf(name); if (i < 0) return false;
      const o = this.ovArr[i] || (this.ovArr[i] = { x: 0, y: 0, c: null });
      if (patch.x !== undefined) o.x = +patch.x || 0;
      if (patch.y !== undefined) o.y = +patch.y || 0;
      if (patch.color !== undefined) o.c = patch.color ? toRgba(patch.color) : null;
      return true;
    }
    // Правка любого узла без пересборки (для редактора). src — путь узла в исходном Lottie
    // ('layers/3', 'layers/3/shapes/0/it', 'layers/3/shapes/0/it/2'), файл должен быть собран с opts.src.
    // { x, y }: сдвиг слоя или группы в единицах сцены; { color }: цвет заливки или обводки; null сбрасывает
    patch(src, p) {
      const nd = this.nodes.get(src); if (!nd) return false;
      if (nd.style) {
        const st = nd.style;
        if (p === null || p.color !== undefined) st.ov = p && p.color ? toRgba(p.color) : null;
        if (st.g && (p === null || p.stops !== undefined)) { st.g.ov = p && p.stops ? stopColors(p.stops, st.g.n) : null; st.g.ok = false; st.g.cg = null; }
        return true;
      }
      const l = nd.layer, x = p ? +p.x || 0 : 0, y = p ? +p.y || 0 : 0;
      setOv(nd.chain ? l.gx[l.chains[nd.chain][1]] : l.ks, p);
      if (!nd.chain) { l.ks.dx = x; l.ks.dy = y; return true; }
      if (!l.cdev) l.cdev = new Float32Array(2 * l.chains.length);
      l.cdev[nd.chain * 2] = x; l.cdev[nd.chain * 2 + 1] = y;
      return true;
    }

    // значение дорожки в кадре f; out получает D чисел
    _track(off, f, out) {
      const F = this.F, D = F[off], N = F[off + 1], E = F[off + 2], fl = F[off + 3], hasE = fl & 1, sp = fl & 2;
      const vo = 2 + 4 * E, st = vo + D * (1 + hasE + sp), base = off + 4, last = base + (N - 1) * st;
      let r;
      if (f <= F[base]) r = base; else if (f >= F[last]) r = last; else {
        let k = this.kc[off];
        if (k > N - 2 || F[base + k * st] > f) k = 0;
        while (k < N - 2 && F[base + (k + 1) * st] <= f) k++;
        this.kc[off] = k;
        r = base + k * st;
        if (!F[r + 1]) {
          const r2 = r + st, u = (f - F[r]) / (F[r2] - F[r]), a = r + vo, b = hasE ? a + D : r2 + vo;
          if (sp && this._curve(r, a, b, D, hasE, ease(F[r + 2], F[r + 3], F[r + 4], F[r + 5], u), out)) return;
          if (E === 1) { const w = ease(F[r + 2], F[r + 3], F[r + 4], F[r + 5], u); for (let d = 0; d < D; d++) out[d] = F[a + d] + (F[b + d] - F[a + d]) * w; }
          else for (let d = 0; d < D; d++) out[d] = F[a + d] + (F[b + d] - F[a + d]) * ease(F[r + 2 + d], F[r + 2 + E + d], F[r + 2 + 2 * E + d], F[r + 2 + 3 * E + d], u);
          return;
        }
      }
      const a = r + vo; for (let d = 0; d < D; d++) out[d] = F[a + d];
    }
    // движение по пространственной кривой Безье с равномерной скоростью по длине дуги.
    // Таблица длин строится один раз на отрезок ключей; false, если касательные нулевые (тогда обычная прямая)
    _curve(r, a, b, D, hasE, w, out) {
      const F = this.F, to = a + D * (1 + hasE), ti = to + D;
      let tab = this.arcs.get(r);
      if (tab === undefined) {
        let any = false; for (let d = 0; d < 2 * D; d++) if (F[to + d] > 1e-6 || F[to + d] < -1e-6) any = true;
        if (!any) tab = null; else {
          const M = 200; tab = new Float32Array((M + 1) * (D + 1));
          for (let i = 0; i <= M; i++) {
            const t = i / M, mt = 1 - t, w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t, q = i * (D + 1); let l2 = 0;
            for (let d = 0; d < D; d++) { const v = w0 * F[a + d] + w1 * (F[a + d] + F[to + d]) + w2 * (F[b + d] + F[ti + d]) + w3 * F[b + d]; tab[q + d] = v; if (i) { const dv = v - tab[q - D - 1 + d]; l2 += dv * dv; } }
            // длина шага в метрике rlottie: «большая сторона + 0,375 меньшей» (он так меряет и кривую движения)
            let step = Math.sqrt(l2);
            if (i && D === 2) { let lx = tab[q] - tab[q - 3], ly = tab[q + 1] - tab[q - 2]; if (lx < 0) lx = -lx; if (ly < 0) ly = -ly; step = lx > ly ? lx + 0.375 * ly : ly + 0.375 * lx; }
            tab[q + D] = i ? tab[q - 1] + step : 0;
          }
        }
        this.arcs.set(r, tab);
      }
      if (!tab) return false;
      const M = 200, W = D + 1, target = w * tab[M * W + D];
      let lo = 1, hi = M; while (lo < hi) { const mid = (lo + hi) >> 1; if (tab[mid * W + D] < target) lo = mid + 1; else hi = mid; }
      const q1 = lo * W, q0 = q1 - W, seg = tab[q1 + D] - tab[q0 + D], u = seg > 1e-9 ? (target - tab[q0 + D]) / seg : 0;
      for (let d = 0; d < D; d++) out[d] = tab[q0 + d] + (tab[q1 + d] - tab[q0 + d]) * u;
      return true;
    }
    _num(p) { if (p.t < 0) return p.v[0]; this._track(p.t, this.f, V2); return V2[0]; }
    _vec(p, out) { if (p.t < 0) { out[0] = p.v[0]; out[1] = p.v[1]; } else this._track(p.t, this.f, out); }

    // локальная матрица T(p)·R(r)·S(s)·T(-a) в m[o..o+5], возвращает непрозрачность 0..1
    _local(x, m, o) {
      const v = V2; let px, py;
      if (x.split) { px = this._num(x.px); py = this._num(x.py); } else { this._vec(x.p, v); px = v[0]; py = v[1]; }
      this._vec(x.a, v); const ax = v[0], ay = v[1];
      this._vec(x.s, v); const sx = v[0] * 0.01 * x.dsx, sy = v[1] * 0.01 * x.dsy;
      const r = (this._num(x.r) + x.dr) * 0.017453292519943295, c = Math.cos(r), s = Math.sin(r);
      const A = c * sx, B = s * sx, C = -s * sy, Dd = c * sy;
      m[o] = A; m[o + 1] = B; m[o + 2] = C; m[o + 3] = Dd; m[o + 4] = px + x.dx - (A * ax + C * ay); m[o + 5] = py + x.dy - (B * ax + Dd * ay);
      return this._num(x.o) * 0.01 * x.dop;
    }
    // матрица слоя в координатах корня: цепочка родителей своей композиции, дальше матрица слоя-вхождения (base)
    _world(C, l, base, stamp) {
      if (l.stamp === stamp) return l.wm;
      l.stamp = stamp;
      const m = l.wm; this._local(l.ks, m, 0);
      const p = l.parent >= 0 ? this._world(C, C.layers[l.parent], base, stamp) : base;
      if (p) { const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5]; m[0] = p[0] * a + p[2] * b; m[1] = p[1] * a + p[3] * b; m[2] = p[0] * c + p[2] * d; m[3] = p[1] * c + p[3] * d; m[4] = p[0] * e + p[2] * f + p[4]; m[5] = p[1] * e + p[3] * f + p[5]; }
      return m;
    }

    // вершины контура (по 6 чисел: точка, входящая и исходящая касательные) для пути любого вида
    _ctrl(path) {
      if (!path.kind) { if (!path.anim) return path.st; this._track(path.off, this.f, CTRL); return CTRL; }
      const v = V2, c = CTRL; this._vec(path.p, v); const cx = v[0], cy = v[1]; this._vec(path.s, v);
      const put = (i, x, y, ix, iy, ox, oy) => { const q = i * 6; c[q] = x; c[q + 1] = y; c[q + 2] = ix; c[q + 3] = iy; c[q + 4] = ox; c[q + 5] = oy; };
      if (path.kind === 1) {
        // эллипс как в rlottie: старт сверху, четыре кривые
        const rx = v[0] / 2, ry = v[1] / 2, kx = rx * KAPPA, ky = ry * KAPPA; path.n = 4;
        if (path.dir === 3) { put(0, cx, cy - ry, kx, 0, -kx, 0); put(1, cx - rx, cy, 0, -ky, 0, ky); put(2, cx, cy + ry, -kx, 0, kx, 0); put(3, cx + rx, cy, 0, ky, 0, -ky); }
        else { put(0, cx, cy - ry, -kx, 0, kx, 0); put(1, cx + rx, cy, 0, -ky, 0, ky); put(2, cx, cy + ry, kx, 0, -kx, 0); put(3, cx - rx, cy, 0, ky, 0, -ky); }
        return c;
      }
      // прямоугольник как в rlottie: старт на правой стороне, скругление не больше половины меньшей стороны
      const w = v[0], h = v[1], x = cx - w / 2, y = cy - h / 2, rx = Math.min(this._num(path.q), w / 2, h / 2), ry = rx;   // радиус один на обе стороны
      if (!(rx > 1e-4 && ry > 1e-4)) {
        path.n = 4;
        if (path.dir === 3) { put(0, x + w, y, 0, 0, 0, 0); put(1, x, y, 0, 0, 0, 0); put(2, x, y + h, 0, 0, 0, 0); put(3, x + w, y + h, 0, 0, 0, 0); }
        else { put(0, x + w, y, 0, 0, 0, 0); put(1, x + w, y + h, 0, 0, 0, 0); put(2, x, y + h, 0, 0, 0, 0); put(3, x, y, 0, 0, 0, 0); }
        return c;
      }
      const kx = rx * KAPPA, ky = ry * KAPPA; path.n = 8;
      if (path.dir === 3) {
        put(0, x + w, y + ry, 0, 0, 0, -ky); put(1, x + w - rx, y, kx, 0, 0, 0); put(2, x + rx, y, 0, 0, -kx, 0); put(3, x, y + ry, 0, -ky, 0, 0);
        put(4, x, y + h - ry, 0, 0, 0, ky); put(5, x + rx, y + h, -kx, 0, 0, 0); put(6, x + w - rx, y + h, 0, 0, kx, 0); put(7, x + w, y + h - ry, 0, ky, 0, 0);
      } else {
        put(0, x + w, y + ry, 0, -ky, 0, 0); put(1, x + w, y + h - ry, 0, 0, 0, ky); put(2, x + w - rx, y + h, kx, 0, 0, 0); put(3, x + rx, y + h, 0, 0, -kx, 0);
        put(4, x, y + h - ry, 0, ky, 0, 0); put(5, x, y + ry, 0, 0, 0, -ky); put(6, x + rx, y, -kx, 0, 0, 0); put(7, x + w - rx, y, 0, 0, kx, 0);
      }
      return c;
    }

    // кривые пути -> ломаная в пикселях (PTS); куски записываются в l.pieces тройками [начало, число точек, разомкнут]
    _geom(l, gi) {
      const g = l.geoms[gi], path = l.paths[g.p], ctrl = this._ctrl(path), n = path.n, tol = this.tol;
      const mo = g.xf * 6, cm = l.cm, a = cm[mo], b = cm[mo + 1], c = cm[mo + 2], d = cm[mo + 3], e = cm[mo + 4], f = cm[mo + 5];
      const start = this.np; let np = start;
      const segN = path.c ? n : n - 1;
      needPts(np + segN * 33 + 8);
      let x0 = a * ctrl[0] + c * ctrl[1] + e, y0 = b * ctrl[0] + d * ctrl[1] + f;
      PTS[np * 2] = x0; PTS[np * 2 + 1] = y0; np++;
      for (let j = 0; j < segN; j++) {
        const i0 = j * 6, i1 = ((j + 1) % n) * 6;
        const vx = ctrl[i0], vy = ctrl[i0 + 1], ox = vx + ctrl[i0 + 4], oy = vy + ctrl[i0 + 5];
        const wx = ctrl[i1], wy = ctrl[i1 + 1], ix = wx + ctrl[i1 + 2], iy = wy + ctrl[i1 + 3];
        const x1 = a * ox + c * oy + e, y1 = b * ox + d * oy + f, x2 = a * ix + c * iy + e, y2 = b * ix + d * iy + f, x3 = a * wx + c * wy + e, y3 = b * wx + d * wy + f;
        const d1x = x0 - 2 * x1 + x2, d1y = y0 - 2 * y1 + y2, d2x = x1 - 2 * x2 + x3, d2y = y1 - 2 * y2 + y3;
        const dd = Math.sqrt(Math.max(d1x * d1x + d1y * d1y, d2x * d2x + d2y * d2y));
        let k = Math.ceil(Math.sqrt(0.75 * dd / tol)); if (!(k >= 1)) k = 1; else if (k > 32) k = 32;
        for (let s = 1; s < k; s++) {
          const t = s / k, mt = 1 - t, w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t;
          PTS[np * 2] = w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3; PTS[np * 2 + 1] = w0 * y0 + w1 * y1 + w2 * y2 + w3 * y3; np++;
        }
        PTS[np * 2] = x3; PTS[np * 2 + 1] = y3; np++;
        x0 = x3; y0 = y3;
      }
      this.np = np;
      l.gst[gi] = l.pieces.length;
      if (g.tm < 0) { l.pieces.push(start, np - start, path.c ? 0 : 1); l.gpc[gi] = 1; return; }
      // trim: вырезаем часть ломаной по длине
      const tm = l.trims[g.tm]; let s = this._num(tm.s) * 0.01, en = this._num(tm.e) * 0.01; const off = this._num(tm.o) / 360;
      if (s > en) { const t = s; s = en; en = t; }
      s = s < 0 ? 0 : s > 1 ? 1 : s; en = en < 0 ? 0 : en > 1 ? 1 : en;
      const span = en - s;
      if (span <= 1e-6) { l.gpc[gi] = 0; return; }
      if (span >= 1 - 1e-6) { l.pieces.push(start, np - start, path.c ? 0 : 1); l.gpc[gi] = 1; return; }
      const cnt = np - start; LEN[0] = 0;
      needPts(np + 2 * cnt + 8);
      // Длину rlottie меряет до преобразований, в координатах самого пути, и не по Пифагору, а быстрым приближением
      // «большая сторона + 0,375 меньшей». Повторяем, иначе концы обрезанных линий разойдутся с Telegram на несколько процентов
      { const dt = a * d - b * c, ok = dt > 1e-12 || dt < -1e-12, ia = ok ? d / dt : 1, ib = ok ? -b / dt : 0, ic = ok ? -c / dt : 0, id = ok ? a / dt : 1;
        for (let i = 1; i < cnt; i++) { const q = (start + i) * 2, DX = PTS[q] - PTS[q - 2], DY = PTS[q + 1] - PTS[q - 1]; let lx = ia * DX + ic * DY, ly = ib * DX + id * DY; if (lx < 0) lx = -lx; if (ly < 0) ly = -ly; LEN[i] = LEN[i - 1] + (lx > ly ? lx + 0.375 * ly : ly + 0.375 * lx); } }
      const total = LEN[cnt - 1]; let s0 = (s + off) % 1; if (s0 < 0) s0 += 1; const e0 = s0 + span; let pc = 0;
      const cut = (from, to) => {
        const st = this.np; let q = st, i = 1;
        while (i < cnt - 1 && LEN[i] < from) i++;
        const put = (L, k) => { const sg = LEN[k] - LEN[k - 1], u = sg > 1e-9 ? (L - LEN[k - 1]) / sg : 0, p0 = (start + k - 1) * 2, p1 = (start + k) * 2; PTS[q * 2] = PTS[p0] + (PTS[p1] - PTS[p0]) * u; PTS[q * 2 + 1] = PTS[p0 + 1] + (PTS[p1 + 1] - PTS[p0 + 1]) * u; q++; };
        put(from, i);
        while (i < cnt - 1 && LEN[i] < to) { PTS[q * 2] = PTS[(start + i) * 2]; PTS[q * 2 + 1] = PTS[(start + i) * 2 + 1]; q++; i++; }
        put(to, i);
        this.np = q; l.pieces.push(st, q - st, 1); pc++;
      };
      if (cnt < 2) { l.gpc[gi] = 0; return; }
      if (e0 <= 1) cut(s0 * total, e0 * total); else { cut(s0 * total, total); cut(0, (e0 - 1) * total); }
      l.gpc[gi] = pc;
    }

    // пунктир: куски из PC режутся на штрихи. Значения в файле: штрих, пробел, ..., сдвиг; sc переводит их в пиксели
    _dash(st, npc, sc) {
      const dv = DV, raw = st.d.length; let n = 0;
      for (let i = 0; i < raw && i < 31; i++) dv[n++] = this._num(st.d[i]) * sc;
      // чётное число значений: последнему штриху не хватает пробела, он равен самому штриху (как в rlottie)
      if (n % 2 === 0) { dv[n] = dv[n - 1]; dv[n - 1] = dv[n - 2]; n++; }
      const pairs = (n - 1) >> 1; let total = 0, gaps = 0;
      for (let i = 0; i < pairs; i++) { if (dv[2 * i] < 0) dv[2 * i] = 0; if (dv[2 * i + 1] < 0) dv[2 * i + 1] = 0; total += dv[2 * i] + dv[2 * i + 1]; gaps += dv[2 * i + 1]; }
      if (!(total > 1e-4) || gaps <= 1e-6) return npc;
      let off = dv[n - 1] % total; if (off < 0) off += total;
      let out = 0;
      for (let k = 0; k < npc; k++) {
        const ps = PC[k * 3], cnt0 = PC[k * 3 + 1], closed = !PC[k * 3 + 2], cnt = closed ? cnt0 + 1 : cnt0;
        // с какого места узора начинается кусок
        let idx = 0, on = true, rem = off;
        for (let guard = 0; guard < 2 * pairs + 2; guard++) { const L = dv[2 * idx + (on ? 0 : 1)]; if (rem < L) { rem = L - rem; break; } rem -= L; if (!on) idx = (idx + 1) % pairs; on = !on; }
        let px = PTS[ps * 2], py = PTS[ps * 2 + 1], startPt = -1, q = this.np;
        const open = () => { needPts(q + 4); startPt = q; PTS[q * 2] = px; PTS[q * 2 + 1] = py; q++; };
        const close = () => { if (startPt >= 0 && q - startPt > 1) { if ((out + 1) * 3 > PC2.length) { const g = new Int32Array(PC2.length * 2); g.set(PC2); PC2 = g; } PC2[out * 3] = startPt; PC2[out * 3 + 1] = q - startPt; PC2[out * 3 + 2] = 1; out++; } startPt = -1; };
        if (on) open();
        for (let i = 1; i < cnt; i++) {
          const j = (ps + (i === cnt0 ? 0 : i)) * 2, nx = PTS[j], ny = PTS[j + 1];
          let lx = nx - px, ly = ny - py; if (lx < 0) lx = -lx; if (ly < 0) ly = -ly;
          let L = lx > ly ? lx + 0.375 * ly : ly + 0.375 * lx, zero = 0;   // длина в метрике rlottie (см. trim)
          while (L > rem && zero < 4 * pairs + 4) {
            const u = L > 1e-9 ? rem / L : 0; px += (nx - px) * u; py += (ny - py) * u; L -= rem;
            if (on) { needPts(q + 4); PTS[q * 2] = px; PTS[q * 2 + 1] = py; q++; close(); } else idx = (idx + 1) % pairs;
            on = !on; rem = dv[2 * idx + (on ? 0 : 1)];
            if (on) open();
            zero = rem <= 1e-9 ? zero + 1 : 0;
          }
          rem -= L; px = nx; py = ny;
          if (on) { needPts(q + 4); PTS[q * 2] = px; PTS[q * 2 + 1] = py; q++; }
        }
        close(); this.np = q;
      }
      needPc(out + 1); PC.set(PC2.subarray(0, out * 3));
      return out;
    }

    // выпуклый многоугольник из PV (n точек) -> отрезки в SEG; все куски обводки обходятся в одну сторону,
    // тогда правило «ненулевого числа оборотов» склеивает их в одну фигуру без дыр на перекрытиях
    _poly(n) {
      let ar = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; ar += PV[i * 2] * PV[j * 2 + 1] - PV[j * 2] * PV[i * 2 + 1]; }
      if (ar > -1e-12 && ar < 1e-12) return;
      needSeg(this.ns + n);
      let ns = this.ns;
      for (let i = 0; i < n; i++) { const a = ar < 0 ? i : n - 1 - i, b = ar < 0 ? (i + 1) % n : (n - 1 - i + n - 1) % n, o = ns * 4; SEG[o] = PV[a * 2]; SEG[o + 1] = PV[a * 2 + 1]; SEG[o + 2] = PV[b * 2]; SEG[o + 3] = PV[b * 2 + 1]; ns++; }
      this.ns = ns;
    }
    _disc(x, y, r) { const k = Math.max(8, Math.min(40, Math.ceil(2.2 * Math.sqrt(r) + 6))); for (let i = 0; i < k; i++) { const a = i * 6.283185307179586 / k; PV[i * 2] = x + Math.cos(a) * r; PV[i * 2 + 1] = y + Math.sin(a) * r; } this._poly(k); }
    // Обводка с некруглыми концами или стыками: контур собирается из выпуклых кусков (тело отрезка, клин стыка, колпачок)
    _stroke(npc, hw, cap, join, ml) {
      for (let k = 0; k < npc; k++) {
        const ps = PC[k * 3], closed = !PC[k * 3 + 2]; let cnt = PC[k * 3 + 1];
        // у замкнутого куска последняя точка повторяет первую
        if (closed && cnt > 1 && Math.abs(PTS[ps * 2] - PTS[(ps + cnt - 1) * 2]) < 1e-4 && Math.abs(PTS[ps * 2 + 1] - PTS[(ps + cnt - 1) * 2 + 1]) < 1e-4) cnt--;
        const m = closed ? cnt : cnt - 1;   // число отрезков
        let pdx = 0, pdy = 0, have = false, fdx = 0, fdy = 0, fx = 0, fy = 0, lx = PTS[ps * 2], ly = PTS[ps * 2 + 1];
        const jn = (x, y, ax, ay, bx, by) => {
          // стык в точке (x, y) между направлениями a и b: клин с внешней стороны поворота
          const cr = ax * by - ay * bx, dt = ax * bx + ay * by;
          if (cr > -1e-6 && cr < 1e-6 && dt > 0) return;
          const s = cr > 0 ? -hw : hw, n0x = -ay * s, n0y = ax * s, n1x = -by * s, n1y = bx * s;
          PV[0] = x; PV[1] = y; PV[2] = x + n0x; PV[3] = y + n0y;
          if (join === 2) {
            const a0 = Math.atan2(n0y, n0x); let da = Math.atan2(n1y, n1x) - a0; if (da > Math.PI) da -= 6.283185307179586; else if (da < -Math.PI) da += 6.283185307179586;
            const steps = Math.max(1, Math.min(24, Math.ceil(Math.abs(da) * (0.6 * Math.sqrt(hw) + 1)))); let q = 2;
            for (let i = 1; i < steps; i++) { const an = a0 + da * i / steps; PV[q * 2] = x + Math.cos(an) * hw; PV[q * 2 + 1] = y + Math.sin(an) * hw; q++; }
            PV[q * 2] = x + n1x; PV[q * 2 + 1] = y + n1y; this._poly(q + 1); return;
          }
          if (join === 1 && dt > -0.9999 && Math.sqrt(2 / (1 + dt)) <= ml) { const kk = 1 / (1 + dt); PV[4] = x + (n0x + n1x) * kk; PV[5] = y + (n0y + n1y) * kk; PV[6] = x + n1x; PV[7] = y + n1y; this._poly(4); return; }
          PV[4] = x + n1x; PV[5] = y + n1y; this._poly(3);
        };
        const capAt = (x, y, dx, dy) => {   // dx, dy смотрит наружу от конца линии
          if (cap === 2) this._disc(x, y, hw);
          else if (cap === 3) { const nx = -dy * hw, ny = dx * hw, ex = dx * hw, ey = dy * hw; PV[0] = x + nx; PV[1] = y + ny; PV[2] = x + nx + ex; PV[3] = y + ny + ey; PV[4] = x - nx + ex; PV[5] = y - ny + ey; PV[6] = x - nx; PV[7] = y - ny; this._poly(4); }
        };
        for (let i = 0; i < m; i++) {
          const j = (ps + (i + 1) % cnt) * 2, nx = PTS[j], ny = PTS[j + 1]; let dx = nx - lx, dy = ny - ly; const len = Math.hypot(dx, dy);
          if (len < 1e-6) continue;
          dx /= len; dy /= len;
          const ox = -dy * hw, oy = dx * hw;
          PV[0] = lx + ox; PV[1] = ly + oy; PV[2] = nx + ox; PV[3] = ny + oy; PV[4] = nx - ox; PV[5] = ny - oy; PV[6] = lx - ox; PV[7] = ly - oy; this._poly(4);
          if (have) jn(lx, ly, pdx, pdy, dx, dy); else { have = true; fdx = dx; fdy = dy; fx = lx; fy = ly; }
          pdx = dx; pdy = dy; lx = nx; ly = ny;
        }
        if (!have) { if (cap !== 1) capAt(lx, ly, 1, 0); continue; }   // точка: от неё остаётся только колпачок
        if (closed) jn(fx, fy, pdx, pdy, fdx, fdy); else { capAt(fx, fy, -fdx, -fdy); capAt(lx, ly, pdx, pdy); }
      }
    }

    // строка LUT градиента: 256 RGBA
    // значения стопов градиента на кадре: из файла или дорожки; перекрашенные цвета из overlay подменяются здесь
    _stopK(g) {
      let k = g.k.v; if (g.k.t >= 0) { this._track(g.k.t, this.f, CTRL); k = CTRL; }
      if (!g.ov) return k;
      if (GOV.length < g.len) GOV = new Float32Array(g.len * 2);
      GOV.set(k.subarray(0, g.len)); for (let i = 0; i < g.n; i++) { GOV[i * 4 + 1] = g.ov[i * 3]; GOV[i * 4 + 2] = g.ov[i * 3 + 1]; GOV[i * 4 + 3] = g.ov[i * 3 + 2]; }
      return GOV;
    }
    _lutRow(g, row) {
      if ((row + 1) * 1024 > this.lut.length) { const n = new Uint8ClampedArray(Math.max(this.lut.length * 2, (row + 1) * 1024)); n.set(this.lut); this.lut = n; }
      const k = this._stopK(g);
      const n = g.n, cnt = stopsOf(k, n, (g.len - 4 * n) >> 1), S = GS, out = this.lut, o = row * 1024; let si = 0;
      for (let x = 0; x < 256; x++) {
        const t = x / 255, q = o + x * 4; let r, gg, b, a;
        while (si < cnt - 1 && t >= S[(si + 1) * 5]) si++;
        const p = si * 5;
        if (si >= cnt - 1 || t <= S[p]) { a = S[p + 4]; r = S[p + 1] * a; gg = S[p + 2] * a; b = S[p + 3] * a; }
        else { const u = (t - S[p]) / (S[p + 5] - S[p]), a0 = S[p + 4] * (1 - u), a1 = S[p + 9] * u; a = a0 + a1; r = S[p + 1] * a0 + S[p + 6] * a1; gg = S[p + 2] * a0 + S[p + 7] * a1; b = S[p + 3] * a0 + S[p + 8] * a1; }
        out[q] = r * 255; out[q + 1] = gg * 255; out[q + 2] = b * 255; out[q + 3] = a * 255;
      }
      this.lutDirty = true;
    }
    // фокус радиального градиента в единицах радиуса: GV[6], GV[7]; false, если блика нет
    _focal(g, dx, dy) {
      if (!g.hl) return false;
      let pr = this._num(g.hl) * 0.01; if (pr > 0.99) pr = 0.99; else if (pr < -0.99) pr = -0.99;
      if (pr > -1e-4 && pr < 1e-4) return false;
      const an = Math.atan2(dy, dx) + this._num(g.ha) * 0.017453292519943295;
      GV[6] = Math.cos(an) * pr; GV[7] = Math.sin(an) * pr;
      return true;
    }
    // mt задан (матрица лежит в mt со смещения mo): градиент строится сразу в пикселях. Так делаем для обводок, чтобы
    // толщина линии не зависела от матрицы и совпадала с WebGL-путём.
    _canvasGrad(ctx, g, mt, mo, rms) {
      if (!mt && g.fixed && g.cg) return g.cg;
      const v = V2; this._vec(g.s, v); let sx = v[0], sy = v[1]; this._vec(g.e, v); let ex = v[0], ey = v[1], rad = Math.hypot(ex - sx, ey - sy);
      let fx = sx, fy = sy; if (g.t !== 1 && this._focal(g, ex - sx, ey - sy)) { fx = sx + GV[6] * rad; fy = sy + GV[7] * rad; }
      if (mt) { const a = mt[mo], b = mt[mo + 1], c = mt[mo + 2], d = mt[mo + 3], e = mt[mo + 4], f = mt[mo + 5], x0 = a * sx + c * sy + e, y0 = b * sx + d * sy + f, x1 = a * ex + c * ey + e, y1 = b * ex + d * ey + f, x2 = a * fx + c * fy + e, y2 = b * fx + d * fy + f; sx = x0; sy = y0; ex = x1; ey = y1; fx = x2; fy = y2; rad *= rms; }
      const k = this._stopK(g);
      const n = g.n, cnt = stopsOf(k, n, (g.len - 4 * n) >> 1), S = GS;
      const cg = g.t === 1 ? ctx.createLinearGradient(sx, sy, ex, ey) : ctx.createRadialGradient(fx, fy, 0, sx, sy, rad || 1e-6);
      let lastPos = 0;
      for (let i = 0; i < cnt; i++) { let ps = S[i * 5]; ps = ps < lastPos ? lastPos : ps > 1 ? 1 : ps; lastPos = ps; cg.addColorStop(ps, css(S[i * 5 + 1], S[i * 5 + 2], S[i * 5 + 3], S[i * 5 + 4])); }
      if (!mt && g.fixed) g.cg = cg;
      return cg;
    }

    // ---- слои в сторону: непрозрачность группы и маска. В пути Canvas 2D это отдельные холсты, иначе команды ----
    _cmd(op, a, b) { if ((this.nc + 1) * 3 > CMD.length) { const g = new Float64Array(CMD.length * 2); g.set(CMD); CMD = g; } const o = this.nc++ * 3; CMD[o] = op; CMD[o + 1] = a; CMD[o + 2] = b; }
    _flush() { if (this.ni > this.from) { this._cmd(DRAW, this.from, this.ni - this.from); this.from = this.ni; } }
    _push() {
      if (this.ctx) { this.stack.push(this.ctx); this.ctx = sideCtx(this.stack.length - 1, this.size, this.hgt); }
      else { this._flush(); this._cmd(PUSH, 0, 0); }
    }
    _pop(alpha) {
      if (this.ctx) { const top = this.ctx, c = this.ctx = this.stack.pop(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = alpha > 1 ? 1 : alpha; c.drawImage(top.canvas, 0, 0); c.globalAlpha = 1; }
      else { this._flush(); this._cmd(POP, alpha, 0); }
    }
    // маска лежит сверху стопки, содержимое под ней. tt: 1 альфа, 2 альфа наоборот, 3 яркость, 4 яркость наоборот
    _popMatte(tt) {
      if (this.ctx) {
        const m = this.ctx, c = this.ctx = this.stack.pop();
        if (tt > 2) { const im = m.getImageData(0, 0, this.size, this.hgt), d = im.data; for (let i = 0; i < d.length; i += 4) d[i + 3] = Math.round((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) * d[i + 3] / 255); m.putImageData(im, 0, 0); }
        c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = tt === 1 || tt === 3 ? 'destination-in' : 'destination-out'; c.drawImage(m.canvas, 0, 0); c.globalCompositeOperation = 'source-over';
      } else { this._flush(); this._cmd(POPM, tt, 0); }
    }

    // композиция в своём времени f: слои снизу вверх. base — матрица слоя-вхождения, alpha — его непрозрачность
    _comp(C, f, base, alpha) {
      const L = C.layers, stamp = ++this.stamp;
      for (let li = L.length - 1; li >= 0; li--) {
        const l = L[li];
        if (l.tt) {
          // слой с маской: источник маски лежит прямо над ним. Пара рисуется в сторону и сводится (как в rlottie)
          const src = li > 0 ? L[--li] : null;
          if (!src || l.hd || src.hd || f < l.ip || f >= l.op || f < src.ip || f >= src.op) continue;
          this._push(); this._layer(C, l, f, base, alpha, stamp);
          this._push(); this.mute++; this._layer(C, src, f, base, alpha, stamp); this.mute--;
          this._popMatte(l.tt); this._pop(1);
          continue;
        }
        if (!l.hd && f >= l.ip && f < l.op) this._layer(C, l, f, base, alpha, stamp);
      }
    }
    _layer(C, l, f, base, alpha, stamp) {
      if (l.ty === 3) return;
      this.f = f; l.seen = this.frameId;
      const w = this._world(C, l, base, stamp), a = alpha * this._num(l.ks.o) * 0.01 * l.ks.dop;
      if (a <= 0.002) return;
      if (l.ty === 4) { if (l.styles.length) { if (l.masks.length) this._masked(l, w, a); else this._shapes(l, w, a); } return; }
      const sub = this.comps[l.rf]; if (!sub || this.depth > 24) return;
      // Вложенная композиция обрезается своей рамкой w×h. Правило снято с rlottie (так рисует Telegram): рамки
      // вложенных композиций пересекаются между собой, а когда пересечение пусто, обрезка снимается совсем
      const S = this.S, x0 = w[4] * S, y0 = w[5] * S, ax = w[0] * l.w * S, ay = w[1] * l.w * S, bx = w[2] * l.h * S, by = w[3] * l.h * S;
      const saved = this.clip, EPS = 1 / 256;
      let cx0 = Math.min(x0, x0 + ax, x0 + bx, x0 + ax + bx), cy0 = Math.min(y0, y0 + ay, y0 + by, y0 + ay + by), cx1 = Math.max(x0, x0 + ax, x0 + bx, x0 + ax + bx), cy1 = Math.max(y0, y0 + ay, y0 + by, y0 + ay + by);
      if (saved) { if (saved[0] > cx0) cx0 = saved[0]; if (saved[1] > cy0) cy0 = saved[1]; if (saved[2] < cx1) cx1 = saved[2]; if (saved[3] < cy1) cy1 = saved[3]; }
      const cl = this.clip = cx1 - cx0 > EPS && cy1 - cy0 > EPS ? [cx0, cy0, cx1, cy1] : null;
      // повёрнутая рамка: прямоугольник по осям её не передаёт, поэтому она рисуется маской поверх содержимого
      const det = ax * by - ay * bx; let quad = false;
      if (cl && !((Math.abs(ay) < 1e-3 && Math.abs(bx) < 1e-3) || (Math.abs(ax) < 1e-3 && Math.abs(by) < 1e-3)) && (det > 1e-9 || det < -1e-9)) {
        const inside = (px, py) => { const u = ((px - x0) * by - (py - y0) * bx) / det, v = ((py - y0) * ax - (px - x0) * ay) / det; return u >= -1e-3 && u <= 1.001 && v >= -1e-3 && v <= 1.001; };
        quad = !(inside(0, 0) && inside(this.size, 0) && inside(0, this.hgt) && inside(this.size, this.hgt));
      }
      if (quad) this._push();
      this.depth++;
      const fs = l.sr === 1 ? f - l.st : Math.trunc((f - l.st) / l.sr);   // при растяжении времени rlottie берёт целый кадр
      if (sub.complex && a < 0.998) { this._push(); this._comp(sub, fs, w, 1); this._pop(a); } else this._comp(sub, fs, w, a);
      this.depth--; this.f = f;
      if (quad) {
        this._push(); this.clip = null;
        PV[0] = x0; PV[1] = y0; PV[2] = x0 + ax; PV[3] = y0 + ay; PV[4] = x0 + ax + bx; PV[5] = y0 + ay + by; PV[6] = x0 + bx; PV[7] = y0 + by;
        const ctx = this.ctx;
        if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(PV[0], PV[1]); ctx.lineTo(PV[2], PV[3]); ctx.lineTo(PV[4], PV[5]); ctx.lineTo(PV[6], PV[7]); ctx.closePath(); ctx.fill(); }
        else { const s0 = this.ns; this._poly(4); this._emit(s0, 0, 0, -1, 1, 1, 1, 1); }
        this._popMatte(1); this._pop(1);
      }
      this.clip = saved;
    }

    // маска слоя: содержимое уходит в буфер, маски собираются в буфер сверху и гасят его, как мат-слой
    _masked(l, w, a) {
      this._push(); this._shapes(l, w, a);
      this._push(); this._masks(l);
      this._popMatte(1); this._pop(1);
    }
    // маски по порядку: каждая собирается в свой буфер с непрозрачностью, потом добавляется, вычитается или пересекается
    _masks(l) {
      const cm = l.cm, a0 = cm[0], b0 = cm[1], c0 = cm[2], d0 = cm[3], rms = Math.sqrt(((a0 + c0) * (a0 + c0) + (b0 + d0) * (b0 + d0)) * 0.5);
      for (const m of l.masks) {
        const alpha = this._num(m.o) * 0.01, hw = this._num(m.x) * rms;
        this._push(); this._push(); this._cover(l, m.g, hw, m.inv);
        this._pop(alpha);
        if (m.mode === 1) this._pop(1); else this._popMatte(m.mode === 2 ? 2 : 1);
      }
    }
    // покрытие маски в пустой буфер сверху: контур с расширением hw (больше нуля — наружу, меньше — внутрь);
    // инверсия — весь холст без этого контура
    _cover(l, g, hw, inv) {
      if (inv) { this._fill(); this._push(); this._shape(l, g, hw); this._popMatte(2); }
      else this._shape(l, g, hw);
    }
    // контур маски с расширением: заливка, затем объединение с полосой (наружу) или вычитание полосы (внутрь)
    _shape(l, g, hw) {
      const k = this._pieces(l, g), ctx = this.ctx;
      if (ctx) {
        this._pathCtx(k); ctx.fillStyle = '#fff'; ctx.fill('nonzero');
        if (hw > 0) this._strokeCtx(k, hw);
        else if (hw < 0) { this._push(); this._strokeCtx(k, -hw); this._popMatte(2); }
        return;
      }
      const s0 = this.ns; let ns = s0, tot = 0; for (let q0 = 0; q0 < k; q0++) tot += PC[q0 * 3 + 1] + 1; needSeg(ns + tot);
      for (let q0 = 0; q0 < k; q0++) {
        const ps = PC[q0 * 3], cnt = PC[q0 * 3 + 1]; let q = ps * 2, px = PTS[q], py = PTS[q + 1];
        for (let j = 1; j < cnt; j++) { q += 2; const nx = PTS[q], ny = PTS[q + 1], o = ns * 4; SEG[o] = px; SEG[o + 1] = py; SEG[o + 2] = nx; SEG[o + 3] = ny; ns++; px = nx; py = ny; }
        if (PC[q0 * 3 + 2] && cnt > 1) { const o = ns * 4; SEG[o] = px; SEG[o + 1] = py; SEG[o + 2] = PTS[ps * 2]; SEG[o + 3] = PTS[ps * 2 + 1]; ns++; }
      }
      const emit = (mode, h) => { this.ns = ns; this._emit(s0, mode, h, -1, 1, 1, 1, 1); };
      emit(0, 0);
      if (hw > 0) emit(2, hw);
      else if (hw < 0) { this._push(); emit(2, -hw); this._popMatte(2); }
      this.ns = ns;
    }
    // контур маски на Canvas 2D: путь из PC/PTS
    _pathCtx(k) {
      const ctx = this.ctx; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.beginPath();
      for (let q0 = 0; q0 < k; q0++) { const cnt = PC[q0 * 3 + 1]; let q = PC[q0 * 3] * 2; ctx.moveTo(PTS[q], PTS[q + 1]); for (let j = 1; j < cnt; j++) { q += 2; ctx.lineTo(PTS[q], PTS[q + 1]); } if (!PC[q0 * 3 + 2]) ctx.closePath(); }
    }
    // полоса шириной 2·hw вокруг контура (объединение с заливкой, белым цветом)
    _strokeCtx(k, hw) {
      const ctx = this.ctx; this._pathCtx(k);
      ctx.lineWidth = 2 * hw; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
    // геометрия маски в PC/PTS: куски контура, как у заливки стиля
    _pieces(l, g) {
      if (l.gst[g] < 0) this._geom(l, g);
      const pb = l.gst[g], k = l.gpc[g]; needPc(k);
      for (let j = 0; j < k; j++) { PC[j * 3] = l.pieces[pb + j * 3]; PC[j * 3 + 1] = l.pieces[pb + j * 3 + 1]; PC[j * 3 + 2] = l.pieces[pb + j * 3 + 2]; }
      return k;
    }
    // весь холст (альфа 1) в пустой буфер сверху
    _fill() {
      const ctx = this.ctx, W = this.size, Hh = this.hgt;
      if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, Hh); return; }
      PV[0] = 0; PV[1] = 0; PV[2] = W; PV[3] = 0; PV[4] = W; PV[5] = Hh; PV[6] = 0; PV[7] = Hh;
      const s0 = this.ns; this._poly(4); this._emit(s0, 0, 0, -1, 1, 1, 1, 1);
    }

    // экземпляр для видеокарты и Soft: отрезки SEG[s0..ns), режим (0 заливка, 1 чётно-нечётная, 2 обводка расстоянием)
    _emit(s0, mode, hw, uid, r, g, b, a) {
      const ns = this.ns; if (ns === s0) return -1;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = s0 * 4; i < ns * 4; i += 4) { const ax = SEG[i], ay = SEG[i + 1], bx = SEG[i + 2], by = SEG[i + 3]; if (ax < x0) x0 = ax; if (ax > x1) x1 = ax; if (bx < x0) x0 = bx; if (bx > x1) x1 = bx; if (ay < y0) y0 = ay; if (ay > y1) y1 = ay; if (by < y0) y0 = by; if (by > y1) y1 = by; }
      const pad = hw + 1; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      // за холстом и за рамкой вложенной композиции пиксели не нужны
      const cl = this.clip, lx = cl ? Math.max(0, Math.round(cl[0])) : 0, ty = cl ? Math.max(0, Math.round(cl[1])) : 0, rx = cl ? Math.min(this.size, Math.round(cl[2])) : this.size, by = cl ? Math.min(this.hgt, Math.round(cl[3])) : this.hgt;
      if (x0 < lx) x0 = lx; if (y0 < ty) y0 = ty; if (x1 > rx) x1 = rx; if (y1 > by) y1 = by;
      if (!(x1 > x0 && y1 > y0)) { this.ns = s0; return -1; }
      if ((this.ni + 1) * INST_F > INST.length) { const n = new Float32Array(INST.length * 2); n.set(INST); INST = n; const m = new Int32Array(IM.length * 2); m.set(IM); IM = m; }
      const ni = this.ni++, o = ni * INST_F, top = Math.floor(y0), Hh = Math.ceil(y1) - top;
      INST[o] = x0; INST[o + 1] = y0; INST[o + 2] = x1; INST[o + 3] = y1;
      INST[o + 4] = bin(s0, ns, top, Hh, mode === 2 ? hw + 1 : 1); INST[o + 5] = Hh; INST[o + 6] = mode; INST[o + 7] = hw;
      INST[o + 8] = r * a; INST[o + 9] = g * a; INST[o + 10] = b * a; INST[o + 11] = a;
      for (let i = 12; i < 20; i++) INST[o + i] = 0;
      IM[ni * 4] = s0; IM[ni * 4 + 1] = ns - s0; IM[ni * 4 + 2] = uid; IM[ni * 4 + 3] = this.mute ? 1 : 0;
      return o;
    }

    // слой-шейп: w — матрица слоя в единицах сцены, alpha — непрозрачность слоя вместе с вложенностью
    _shapes(l, w, alpha) {
      const S = this.S, f = this.f, ctx = this.ctx, cm = l.cm, co = l.co, v = V2;
      // кадр для попаданий (rec): точки всех слоёв остаются в PTS до конца кадра, их читают контуры
      if (!this.rec) this.np = 0;
      cm[0] = w[0] * S; cm[1] = w[1] * S; cm[2] = w[2] * S; cm[3] = w[3] * S; cm[4] = w[4] * S; cm[5] = w[5] * S;
      co[0] = alpha;
      for (let c = 1; c < l.chains.length; c++) {
        const pc = l.chains[c][0] * 6, o = c * 6;
        co[c] = co[l.chains[c][0]] * this._local(l.gx[l.chains[c][1]], GV, 0);
        cm[o] = cm[pc] * GV[0] + cm[pc + 2] * GV[1]; cm[o + 1] = cm[pc + 1] * GV[0] + cm[pc + 3] * GV[1];
        cm[o + 2] = cm[pc] * GV[2] + cm[pc + 2] * GV[3]; cm[o + 3] = cm[pc + 1] * GV[2] + cm[pc + 3] * GV[3];
        cm[o + 4] = cm[pc] * GV[4] + cm[pc + 2] * GV[5] + cm[pc + 4]; cm[o + 5] = cm[pc + 1] * GV[4] + cm[pc + 3] * GV[5] + cm[pc + 5];
        const nmi = l.cnName[c]; if (nmi >= 0) { const q = this.ovArr[nmi]; if (q) { cm[o + 4] += q.x * S; cm[o + 5] += q.y * S; } }
        if (l.cdev) { cm[o + 4] += l.cdev[c * 2] * S; cm[o + 5] += l.cdev[c * 2 + 1] * S; }
      }
      l.gst.fill(-1); l.pieces.length = 0;
      // Canvas 2D: рамка вложенной композиции ставится на время этого слоя (снять обрезку посреди вложенных save нельзя)
      const cl = ctx ? this.clip : null, clipped = !!cl && !(cl[0] <= 0 && cl[1] <= 0 && cl[2] >= this.size && cl[3] >= this.hgt);
      if (clipped) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.beginPath(); ctx.rect(cl[0], cl[1], cl[2] - cl[0], cl[3] - cl[1]); ctx.clip(); }
      for (let si = 0; si < l.styles.length; si++) {
        const st = l.styles[si], alphaS = co[st.xf] * this._num(st.o) * 0.01;
        if (alphaS <= 0.002) continue;
        const ovc = st.ov || (st.nm >= 0 && this.ovArr[st.nm] ? this.ovArr[st.nm].c : null), grad = ovc ? null : st.g;   // свой цвет заменяет и градиент
        const mo = st.xf * 6, a = cm[mo], b = cm[mo + 1], c = cm[mo + 2], d = cm[mo + 3], e = cm[mo + 4], ff = cm[mo + 5];
        // толщина как в rlottie: ширина умножается на длину образа вектора (1,1), а не на корень из определителя
        const rms = Math.sqrt(((a + c) * (a + c) + (b + d) * (b + d)) * 0.5);
        let hw = 0; if (st.k) { hw = this._num(st.w) * 0.5 * rms; if (hw <= 0.001) continue; }
        // куски контура этого стиля
        let npc = 0;
        for (let gi = 0; gi < st.geoms.length; gi++) {
          const g = st.geoms[gi]; if (l.gst[g] < 0) this._geom(l, g);
          const pb = l.gst[g], k = l.gpc[g]; needPc(npc + k);
          for (let j = 0; j < k; j++) { PC[npc * 3] = l.pieces[pb + j * 3]; PC[npc * 3 + 1] = l.pieces[pb + j * 3 + 1]; PC[npc * 3 + 2] = l.pieces[pb + j * 3 + 2]; npc++; }
        }
        if (st.d && npc) npc = this._dash(st, npc, rms);
        if (!npc) continue;
        // контуры стиля ровно такими, какими они нарисованы (с обрезкой и пунктиром): uid, полутолщина обводки, правило, куски
        if (this.rec && !this.mute) { const r = this.rec; r.push(st.uid, hw, st.rule === 2 ? 1 : 0, npc); for (let k = 0; k < npc * 3; k++) r.push(PC[k]); }

        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.beginPath();
          for (let k = 0; k < npc; k++) {
            const cnt = PC[k * 3 + 1]; let q = PC[k * 3] * 2;
            ctx.moveTo(PTS[q], PTS[q + 1]);
            for (let j = 1; j < cnt; j++) { q += 2; ctx.lineTo(PTS[q], PTS[q + 1]); }
            if (!PC[k * 3 + 2]) ctx.closePath();
          }
          let paint;
          // градиент задан в координатах своей группы: путь уже в пикселях, а матрицу ставим перед заливкой
          if (grad && st.k) paint = this._canvasGrad(ctx, grad, cm, mo, rms);
          else if (grad) { paint = this._canvasGrad(ctx, grad); ctx.setTransform(a, b, c, d, e, ff); }
          else if (ovc) paint = css(ovc[0], ovc[1], ovc[2], ovc[3]);
          else if (st.css) paint = st.css;
          else { this._track(st.c.t, f, CTRL); paint = css(CTRL[0], CTRL[1], CTRL[2], 1); }
          ctx.globalAlpha = alphaS > 1 ? 1 : alphaS;
          if (st.k) { ctx.lineWidth = 2 * hw; ctx.lineCap = st.lc === 1 ? 'butt' : st.lc === 3 ? 'square' : 'round'; ctx.lineJoin = st.lj === 1 ? 'miter' : st.lj === 3 ? 'bevel' : 'round'; ctx.miterLimit = st.ml > 1 ? st.ml : 1; ctx.strokeStyle = paint; ctx.stroke(); }
          else { ctx.fillStyle = paint; ctx.fill(st.rule === 2 ? 'evenodd' : 'nonzero'); }
          this.ni++;
          continue;
        }

        const s0 = this.ns; let mode = st.k ? 2 : st.rule === 2 ? 1 : 0, pad = hw;
        if (st.k && (st.lc !== 2 || st.lj !== 2)) { this._stroke(npc, hw, st.lc, st.lj, st.ml); mode = 0; pad = 0; }
        else {
          let ns = s0, tot = 0; for (let k = 0; k < npc; k++) tot += PC[k * 3 + 1] + 1;
          needSeg(ns + tot);
          for (let k = 0; k < npc; k++) {
            const ps = PC[k * 3], cnt = PC[k * 3 + 1];
            let q = ps * 2, px = PTS[q], py = PTS[q + 1];
            // обводка одной точки: остаётся круглый колпачок
            if (cnt === 1 && st.k) { const o = ns * 4; SEG[o] = px; SEG[o + 1] = py; SEG[o + 2] = px; SEG[o + 3] = py + 1e-3; ns++; continue; }
            for (let j = 1; j < cnt; j++) { q += 2; const nx = PTS[q], ny = PTS[q + 1], o = ns * 4; SEG[o] = px; SEG[o + 1] = py; SEG[o + 2] = nx; SEG[o + 3] = ny; ns++; px = nx; py = ny; }
            // заливка всегда замкнута; обводка замкнутого пути уже содержит замыкающий отрезок
            if (!st.k && PC[k * 3 + 2] && cnt > 1) { const o = ns * 4; SEG[o] = px; SEG[o + 1] = py; SEG[o + 2] = PTS[ps * 2]; SEG[o + 3] = PTS[ps * 2 + 1]; ns++; }
          }
          this.ns = ns;
        }
        if (grad) {
          const g = grad, o = this._emit(s0, mode, pad, st.uid, 0, 0, 0, alphaS); if (o < 0) continue;
          const det = a * d - b * c, id = 1 / det, ia = d * id, ib = -b * id, ic = -c * id, idd = a * id, ie = (c * ff - d * e) * id, iff = (b * e - a * ff) * id;
          this._vec(g.s, v); const sx = v[0], sy = v[1]; this._vec(g.e, v); const dx = v[0] - sx, dy = v[1] - sy;
          INST[o + 8] = 0; INST[o + 9] = 0; INST[o + 10] = 0; INST[o + 11] = alphaS;
          if (g.t === 1) {
            const l2 = dx * dx + dy * dy || 1e-9;
            INST[o + 12] = (ia * dx + ib * dy) / l2; INST[o + 14] = (ic * dx + idd * dy) / l2; INST[o + 16] = (ie * dx + iff * dy - sx * dx - sy * dy) / l2;
          } else {
            const r = Math.sqrt(dx * dx + dy * dy) || 1e-9;
            INST[o + 12] = ia / r; INST[o + 13] = ib / r; INST[o + 14] = ic / r; INST[o + 15] = idd / r; INST[o + 16] = (ie - sx) / r; INST[o + 17] = (iff - sy) / r;
            if (this._focal(g, dx, dy)) { INST[o + 8] = GV[6]; INST[o + 9] = GV[7]; INST[o + 10] = 1; }
          }
          // строка LUT: у неизменного градиента своя постоянная, у анимированного новая на каждое рисование
          let row = g.row; if (g.k.t >= 0) row = this.lutN++; else if (!g.ok) g.ok = true; else row = -1;
          if (row >= 0) this._lutRow(g, row); else row = g.row;
          INST[o + 18] = g.t; INST[o + 19] = row;
        } else {
          let cr, cg, cb, ca;
          if (ovc) { cr = ovc[0]; cg = ovc[1]; cb = ovc[2]; ca = ovc[3]; }
          else if (st.c && st.c.t < 0) { cr = st.c.v[0]; cg = st.c.v[1]; cb = st.c.v[2]; ca = 1; } else { this._track(st.c.t, f, CTRL); cr = CTRL[0]; cg = CTRL[1]; cb = CTRL[2]; ca = 1; }
          this._emit(s0, mode, pad, st.uid, cr, cg, cb, alphaS * ca);
        }
      }
      if (clipped) ctx.restore();
    }

    // Один кадр. ctx задан: рисуем в Canvas 2D. Иначе заполняем SEG/INST/CMD для видеокарты и Soft и возвращаем число экземпляров.
    frame(i, size, ctx) {
      const H = this.h; this.frameId = (this.frameId || 0) + 1;
      this.size = size; this.hgt = Math.max(1, Math.round(size * H.h / H.w)); this.S = size / H.w; this.ctx = ctx || null; this.tol = ctx ? 0.1 : 0.2;
      this.ns = 0; this.ni = 0; this.nc = 0; this.from = 0; this.lutN = H.ng || 0; this.clip = null; this.depth = 0; this.mute = 0; this.stack = [];
      if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.clearRect(0, 0, size, this.hgt); } else { BN = 0; RN = 0; }
      this._comp(this.comps[0], H.ip + i, null, 1);
      if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; } else this._flush();
      this.segs = this.ns; this.inst = this.ni; this.nb = BN; this.nr = RN;
      return this.ni;
    }

    // Что нарисовано в точке (x, y) кадра i при ширине size: верхний стиль под точкой или null.
    // Возвращает { uid, src, name, layer }; источники масок не считаются
    pick(i, size, x, y) { return this._hitsAt(i, size, x, y, 1)[0] || null; }
    // все стили под точкой, сверху вниз, без повторов: редактор выбирает группу, а не только верхний слой
    pickAll(i, size, x, y) { return this._hitsAt(i, size, x, y, Infinity); }
    // Кадр для попаданий считается один раз и делится между кликами, наведением и подсветкой.
    // Рабочие буферы (PTS, SEG, INST, IM) общие для всех сцен страницы: любой другой кадр их перепишет,
    // поэтому кадр попаданий копируется в свои массивы сцены.
    _ensure(i, size) {
      if (this.hp && this.prepI === i && this.prepS === size && this.prepF === this.frameId) return;
      this.np = 0; this.rec = [];
      try { this.frame(i, size, null); } finally { this.hr = this.rec; this.rec = null; }
      this.hp = PTS.slice(0, this.np * 2); this.hs = SEG.slice(0, this.ns * 4); this.hi = INST.slice(0, this.ni * INST_F); this.hm = IM.slice(0, this.ni * 4); this.hn = this.ni;
      this.prepI = i; this.prepS = size; this.prepF = this.frameId;
    }
    // Контуры стилей на кадре i в пикселях холста шириной size, как они нарисованы (обрезка, пунктир, несколько вхождений
    // одной композиции): [{ uid, pts: Float32Array(x, y, ...), closed, w, evenodd }]. w — полутолщина обводки в пикселях
    // (0 у заливки): обводку подсвечивают линией этой толщины, а не заливкой контура. Для подсветки выделения без перебора пикселей
    outlines(uids, i, size) {
      this._ensure(i, size);
      const want = uids instanceof Set ? uids : new Set(uids), r = this.hr, P = this.hp, out = [];
      for (let o = 0; o < r.length;) {
        const uid = r[o], w = r[o + 1], evenodd = r[o + 2] === 1, n = r[o + 3]; o += 4;
        if (want.has(uid)) for (let k = 0; k < n; k++) {
          const start = r[o + k * 3], cnt = r[o + k * 3 + 1], pts = P.slice(start * 2, (start + cnt) * 2);
          out.push({ uid, pts, closed: !r[o + k * 3 + 2], w, evenodd });
        }
        o += n * 3;
      }
      return out;
    }
    _hitsAt(i, size, x, y, max) {
      this._ensure(i, size); const out = [], seen = new Set(), INST = this.hi, IM = this.hm, SEG = this.hs;
      for (let n = this.hn - 1; n >= 0 && out.length < max; n--) {
        const o = n * INST_F; if (IM[n * 4 + 3] || IM[n * 4 + 2] < 0 || x < INST[o] || x > INST[o + 2] || y < INST[o + 1] || y > INST[o + 3]) continue;
        const s0 = IM[n * 4], s1 = s0 + IM[n * 4 + 1], mode = INST[o + 6]; let hit = false;
        if (mode === 2) {
          const hw = Math.max(INST[o + 7], 3);
          for (let k = s0; k < s1 && !hit; k++) { const ax = SEG[k * 4], ay = SEG[k * 4 + 1], bx = SEG[k * 4 + 2] - ax, by = SEG[k * 4 + 3] - ay, t = Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / (bx * bx + by * by || 1e-12))); hit = Math.hypot(x - ax - bx * t, y - ay - by * t) <= hw; }
        } else {
          let wn = 0;
          for (let k = s0; k < s1; k++) { const ax = SEG[k * 4], ay = SEG[k * 4 + 1], bx = SEG[k * 4 + 2], by = SEG[k * 4 + 3]; if ((ay <= y) !== (by <= y)) { const xi = ax + (y - ay) * (bx - ax) / (by - ay); if (xi > x) wn += by > ay ? 1 : -1; } }
          hit = mode === 1 ? (wn & 1) !== 0 : wn !== 0;
        }
        if (hit) { const st = this.styles[IM[n * 4 + 2]]; if (!seen.has(st.uid)) { seen.add(st.uid); out.push({ uid: st.uid, src: st.src, name: st.nm >= 0 ? this.names[st.nm] : '', layer: st.layer.src || '', groups: st.groups }); } }
      }
      return out;
    }
    // матрица узла (слой, группа или стиль) в единицах сцены на кадре i и его непрозрачность; null, если узел на кадре не нарисован
    worldAt(src, i) {
      const nd = this.nodes.get(src); if (!nd) return null;
      this.frame(i, this.h.w, null);
      const l = nd.layer; if (l.seen !== this.frameId) return null;
      if (!nd.style && !nd.chain) return { m: Array.from(l.wm), o: this._num(l.ks.o) * 0.01 * l.ks.dop };
      const c = nd.style ? nd.style.xf : nd.chain;
      return { m: Array.from(l.cm.subarray(c * 6, c * 6 + 6)), o: l.co[c] };
    }
    // рамка узла по пути в исходном Lottie (слой, группа или стиль) в пикселях кадра i при ширине size; маска рамку не режет
    nodeBounds(src, i, size) { return this.bounds(i, size, (st) => st.src === src || st.src.startsWith(src + '/') || st.layer.src === src); }
    // Рамка [x0, y0, x1, y1] в пикселях того, что подходит под test(style) в кадре i; null, если ничего не нарисовано
    bounds(i, size, test) {
      this.frame(i, size, null);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let n = 0; n < this.ni; n++) {
        const uid = IM[n * 4 + 2]; if (uid < 0 || !test(this.styles[uid])) continue;
        const hw = INST[n * INST_F + 6] === 2 ? INST[n * INST_F + 7] : 0;
        for (let k = IM[n * 4] * 4, e = k + IM[n * 4 + 1] * 4; k < e; k += 2) { const px = SEG[k], py = SEG[k + 1]; if (px - hw < x0) x0 = px - hw; if (px + hw > x1) x1 = px + hw; if (py - hw < y0) y0 = py - hw; if (py + hw > y1) y1 = py + hw; }
      }
      return x1 >= x0 ? [x0, y0, x1, y1] : null;
    }
  }

  // Рисование на процессоре: те же экземпляры и та же математика покрытия, что в шейдере, без видеокарты и без браузера.
  // Нужен там, где холста нет совсем (сервер, бот), и для сверки ядра с rlottie.
  class Soft {
    constructor() { this.bufs = []; this.cov = new Float32Array(0); this.acc = new Float32Array(0); }
    _buf(depth, n) { let b = this.bufs[depth]; if (!b || b.length !== n) b = this.bufs[depth] = new Float32Array(n); else b.fill(0); return b; }
    // кадр i сцены шириной size -> { width, height, data }: RGBA по 8 бит, альфа не умножена (как у ImageData)
    render(sc, i, size) {
      sc.frame(i, size, null);
      const W = size, Hh = sc.hgt, n4 = W * Hh * 4, stack = []; let dst = this._buf(0, n4);
      for (let c = 0; c < sc.nc; c++) {
        const op = CMD[c * 3], a = CMD[c * 3 + 1];
        if (op === DRAW) { for (let n = a, e = a + CMD[c * 3 + 2]; n < e; n++) this._inst(sc, dst, W, Hh, n); }
        else if (op === PUSH) { stack.push(dst); dst = this._buf(stack.length, n4); }
        else if (op === POP) { const src = dst; dst = stack.pop(); for (let k = 0; k < n4; k += 4) { const sa = src[k + 3] * a; if (sa <= 0) continue; const inv = 1 - sa; dst[k] = src[k] * a + dst[k] * inv; dst[k + 1] = src[k + 1] * a + dst[k + 1] * inv; dst[k + 2] = src[k + 2] * a + dst[k + 2] * inv; dst[k + 3] = sa + dst[k + 3] * inv; } }
        else {
          const m = dst; dst = stack.pop();
          for (let k = 0; k < n4; k += 4) {
            if (dst[k + 3] <= 0) continue;
            let q = a > 2 ? 0.2126 * m[k] + 0.7152 * m[k + 1] + 0.0722 * m[k + 2] : m[k + 3]; if (a === 2 || a === 4) q = 1 - q;
            dst[k] *= q; dst[k + 1] *= q; dst[k + 2] *= q; dst[k + 3] *= q;
          }
        }
      }
      const out = new Uint8ClampedArray(n4);
      for (let k = 0; k < n4; k += 4) { const al = dst[k + 3]; if (al <= 0) continue; const q = 255 / al; out[k] = dst[k] * q + 0.5; out[k + 1] = dst[k + 1] * q + 0.5; out[k + 2] = dst[k + 2] * q + 0.5; out[k + 3] = al * 255 + 0.5; }
      return { width: W, height: Hh, data: out };
    }
    _inst(sc, dst, W, Hh, n) {
      const o = n * INST_F, x0 = Math.max(0, Math.floor(INST[o])), y0 = Math.max(0, Math.floor(INST[o + 1])), x1 = Math.min(W, Math.ceil(INST[o + 2])), y1 = Math.min(Hh, Math.ceil(INST[o + 3]));
      const w = x1 - x0, h = y1 - y0; if (w <= 0 || h <= 0) return;
      const s0 = IM[n * 4], s1 = s0 + IM[n * 4 + 1], mode = INST[o + 6], hw = INST[o + 7];
      if (this.cov.length < w * h) this.cov = new Float32Array(w * h * 2);
      const cov = this.cov;
      if (mode === 2) {
        // обводка: квадрат расстояния до ближайшего отрезка, как в шейдере
        cov.fill(1e20, 0, w * h);
        const m = hw + 1;
        for (let k = s0; k < s1; k++) {
          const ax = SEG[k * 4], ay = SEG[k * 4 + 1], bx = SEG[k * 4 + 2], by = SEG[k * 4 + 3], dx = bx - ax, dy = by - ay, l2 = Math.max(dx * dx + dy * dy, 1e-12);
          const ya = Math.max(y0, Math.floor(Math.min(ay, by) - m)), yb = Math.min(y1 - 1, Math.floor(Math.max(ay, by) + m)), xa = Math.max(x0, Math.floor(Math.min(ax, bx) - m)), xb = Math.min(x1 - 1, Math.floor(Math.max(ax, bx) + m));
          for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
            const px = x + 0.5 - ax, py = y + 0.5 - ay; let t = (px * dx + py * dy) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = px - dx * t, qy = py - dy * t, d2 = qx * qx + qy * qy, q = (y - y0) * w + x - x0;
            if (d2 < cov[q]) cov[q] = d2;
          }
        }
        for (let q = 0; q < w * h; q++) { const d = Math.sqrt(cov[q]); let a = hw - d + 0.5, b = -hw - d + 0.5; a = a < 0 ? 0 : a > 1 ? 1 : a; b = b < 0 ? 0 : b > 1 ? 1 : b; cov[q] = a - b; }
      } else {
        // заливка: каждая ячейка копит вклад отрезков в площадь, сумма слева направо даёт покрытие пикселя
        const sw = w + 2; if (this.acc.length < sw * h) this.acc = new Float32Array(sw * h * 2);
        const A = this.acc; A.fill(0, 0, sw * h);
        for (let k = s0; k < s1; k++) {
          let ax = SEG[k * 4], ay = SEG[k * 4 + 1], bx = SEG[k * 4 + 2], by = SEG[k * 4 + 3], dir = 1;
          if (ay === by) continue;
          if (ay > by) { const tx = ax, ty = ay; ax = bx; ay = by; bx = tx; by = ty; dir = -1; }
          const dxdy = (bx - ax) / (by - ay), ya = Math.max(y0, Math.floor(ay)), yb = Math.min(y1, Math.ceil(by));
          for (let y = ya; y < yb; y++) {
            const t0 = y > ay ? y : ay, t1 = y + 1 < by ? y + 1 : by; if (t1 <= t0) continue;
            let xa = ax + (t0 - ay) * dxdy - x0, xb = ax + (t1 - ay) * dxdy - x0, d = (t1 - t0) * dir; const row = (y - y0) * sw;
            if (xa > xb) { const t = xa; xa = xb; xb = t; }
            if (xb <= 0) { A[row] += d; continue; }
            if (xa >= w) continue;
            if (xa < 0) { const t = -xa / (xb - xa); A[row] += d * t; d *= 1 - t; xa = 0; }
            if (xb > w) { d *= (w - xa) / (xb - xa); xb = w; }
            const xi = Math.floor(xa), xj = Math.ceil(xb);
            if (xj <= xi + 1) { const xm = 0.5 * (xa + xb) - xi; A[row + xi] += d - d * xm; A[row + xi + 1] += d * xm; }
            else {
              const s = 1 / (xb - xa), f0 = xa - xi, a0 = 0.5 * s * (1 - f0) * (1 - f0), f1 = xb - xj + 1, am = 0.5 * s * f1 * f1;
              A[row + xi] += d * a0;
              if (xj === xi + 2) A[row + xi + 1] += d * (1 - a0 - am);
              else { const a1 = s * (1.5 - f0); A[row + xi + 1] += d * (a1 - a0); for (let x = xi + 2; x < xj - 1; x++) A[row + x] += d * s; A[row + xj - 1] += d * (1 - a1 - (xj - xi - 3) * s - am); }
              A[row + xj] += d * am;
            }
          }
        }
        for (let y = 0; y < h; y++) { let acc = 0; const row = y * sw, q = y * w; for (let x = 0; x < w; x++) { acc += A[row + x]; let c = acc < 0 ? -acc : acc; if (mode === 0) { if (c > 1) c = 1; } else { c = c - 2 * Math.round(c * 0.5); if (c < 0) c = -c; } cov[q + x] = c; } }
      }
      const pt = INST[o + 18];
      if (!pt) {
        const r = INST[o + 8], g = INST[o + 9], b = INST[o + 10], a = INST[o + 11];
        for (let y = 0; y < h; y++) { let q = y * w, k = ((y + y0) * W + x0) * 4; for (let x = 0; x < w; x++, q++, k += 4) { const c = cov[q]; if (c <= 0) continue; const inv = 1 - a * c; dst[k] = r * c + dst[k] * inv; dst[k + 1] = g * c + dst[k + 1] * inv; dst[k + 2] = b * c + dst[k + 2] * inv; dst[k + 3] = a * c + dst[k + 3] * inv; } }
        return;
      }
      const m0 = INST[o + 12], m1 = INST[o + 13], m2 = INST[o + 14], m3 = INST[o + 15], m4 = INST[o + 16], m5 = INST[o + 17], lut = sc.lut, lo = INST[o + 19] * 1024, al = INST[o + 11];
      const focal = INST[o + 10] > 0.5, fx = INST[o + 8], fy = INST[o + 9], fa = 1 - fx * fx - fy * fy;
      for (let y = 0; y < h; y++) {
        let q = y * w, k = ((y + y0) * W + x0) * 4; const py = y + y0 + 0.5;
        for (let x = 0; x < w; x++, q++, k += 4) {
          const c = cov[q]; if (c <= 0) continue;
          const px = x + x0 + 0.5, qx = m0 * px + m2 * py + m4, qy = m1 * px + m3 * py + m5; let t;
          if (pt === 1) t = qx;
          else if (focal) { const dx = qx - fx, dy = qy - fy, B = -(dx * fx + dy * fy); t = (-B + Math.sqrt(Math.max(B * B + fa * (dx * dx + dy * dy), 0))) / Math.max(fa, 1e-6); }
          else t = Math.sqrt(qx * qx + qy * qy);
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const u = t * 255, i0 = u | 0, i1 = i0 < 255 ? i0 + 1 : 255, fr = u - i0, p0 = lo + i0 * 4, p1 = lo + i1 * 4;
          const k2 = al * c / 255, inv = 1 - (lut[p0 + 3] + (lut[p1 + 3] - lut[p0 + 3]) * fr) * k2;
          dst[k] = (lut[p0] + (lut[p1] - lut[p0]) * fr) * k2 + dst[k] * inv; dst[k + 1] = (lut[p0 + 1] + (lut[p1 + 1] - lut[p0 + 1]) * fr) * k2 + dst[k + 1] * inv;
          dst[k + 2] = (lut[p0 + 2] + (lut[p1 + 2] - lut[p0 + 2]) * fr) * k2 + dst[k + 2] * inv; dst[k + 3] = (1 - inv) + dst[k + 3] * inv;
        }
      }
    }
  }
  let soft = null;
  // кадр без холста: source — файл .ecr или Scene; ответ { width, height, data } с пикселями RGBA
  const renderRGBA = (source, i, size) => (soft || (soft = new Soft())).render(source instanceof Scene ? source : new Scene(source), i, size || 512);

  // Один WebGL2-контекст на страницу. Создаётся и компилирует шейдер в фоне, пока кадры идут через Canvas 2D.
  class GL {
    constructor(force) {
      const cv = this.canvas = document.createElement('canvas'); cv.width = cv.height = GL_SIZE;
      // failIfMajorPerformanceCaveat: на программном WebGL контекст не создаётся, остаёмся на Canvas 2D
      const gl = this.gl = cv.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, failIfMajorPerformanceCaveat: !force });
      this.ok = false; this.dead = !gl; this.dry = false; this.slow = false; this.seen = 0; this.bad = 0; this.fbos = []; this.instCap = 0; this.lutOwner = null;
      this.px = null; this.name = '';
      if (!gl) return;
      // программный WebGL (без видеокарты) медленнее Canvas 2D, а флаг выше браузеры ставят не всегда
      const info = gl.getExtension('WEBGL_debug_renderer_info'), name = this.name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      if (!force && /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) { this.dead = true; return; }
      cv.addEventListener('webglcontextlost', () => { this.dead = true; this.ok = false; });   // дальше рисует Canvas 2D
      this.par = gl.getExtension('KHR_parallel_shader_compile');
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
      const prog = (v, f) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, v)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, f)); gl.linkProgram(p); return p; };
      this.pr = prog(VS, FS); this.pr2 = prog(VS2, FS2);
    }
    ready() {
      if (this.ok) return true;
      if (this.dead) return false;
      const gl = this.gl, pr = this.pr, pr2 = this.pr2;
      if (this.par && !(gl.getProgramParameter(pr, this.par.COMPLETION_STATUS_KHR) && gl.getProgramParameter(pr2, this.par.COMPLETION_STATUS_KHR))) return false;
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS) || !gl.getProgramParameter(pr2, gl.LINK_STATUS)) { this.dead = true; console.warn('ecore: шейдер не собрался', gl.getProgramInfoLog(pr), gl.getProgramInfoLog(pr2)); return false; }
      gl.bindVertexArray(gl.createVertexArray());
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      for (let i = 0; i < 5; i++) { gl.enableVertexAttribArray(1 + i); gl.vertexAttribDivisor(1 + i, 1); }
      const tex = (unit, filter) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture()); for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); };
      tex(1, gl.LINEAR); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, LUT_ROWS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      tex(0, gl.NEAREST); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SEGW, SEG_ROWS, 0, gl.RGBA, gl.FLOAT, null); this.segH = SEG_ROWS;
      tex(2, gl.NEAREST); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SEGW, ROW_ROWS, 0, gl.RGBA, gl.FLOAT, null); this.rowH = ROW_ROWS;
      gl.useProgram(pr2);
      gl.uniform1i(gl.getUniformLocation(pr2, 'uTex'), 3); this.uAlpha = gl.getUniformLocation(pr2, 'uAlpha'); this.uLuma = gl.getUniformLocation(pr2, 'uLuma');
      gl.useProgram(pr);
      gl.uniform1i(gl.getUniformLocation(pr, 'uSeg'), 0); gl.uniform1i(gl.getUniformLocation(pr, 'uLut'), 1); gl.uniform1i(gl.getUniformLocation(pr, 'uRow'), 2);
      this.uSize = gl.getUniformLocation(pr, 'uSize'); this.uTop = gl.getUniformLocation(pr, 'uTop');
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.enable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0);
      return (this.ok = true);
    }
    // корзины отрезков и таблица строк; текстуры растут вдвое, когда места не хватает
    _upload(sc) {
      const gl = this.gl, sh = Math.ceil(sc.nb / SEGW), rh = Math.ceil(sc.nr / SEGW);
      gl.activeTexture(gl.TEXTURE0);
      if (sh > this.segH) { this.segH = Math.max(sh, this.segH * 2); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SEGW, this.segH, 0, gl.RGBA, gl.FLOAT, null); }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SEGW, sh, gl.RGBA, gl.FLOAT, SEG2);
      gl.activeTexture(gl.TEXTURE2);
      if (rh > this.rowH) { this.rowH = Math.max(rh, this.rowH * 2); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SEGW, this.rowH, 0, gl.RGBA, gl.FLOAT, null); }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SEGW, rh, gl.RGBA, gl.FLOAT, ROWT);
      gl.activeTexture(gl.TEXTURE0);
    }
    // холст в сторону: текстура размером с общий холст
    _fbo(depth) {
      const gl = this.gl, cv = this.canvas; let f = this.fbos[depth];
      if (!f) { f = this.fbos[depth] = { fb: gl.createFramebuffer(), tex: gl.createTexture(), w: 0, h: 0 }; }
      if (f.w !== cv.width || f.h !== cv.height) {
        f.w = cv.width; f.h = cv.height;
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, f.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, f.w, f.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.tex, 0);
        gl.activeTexture(gl.TEXTURE0);
      }
      return f;
    }
    // Самопроверка: только что нарисованный кадр сверяется с тем же кадром, посчитанным на процессоре.
    // Драйверы видеокарт ошибаются по-разному и молча, а расчёт на процессоре один и тот же везде.
    // Сверяется то, что реально получит страница: копия кадра с общего холста видеокарты на обычный холст.
    // Если копия неверна, отдельно читается сам кадр на видеокарте, чтобы назвать, где именно сбой.
    // Возвращает null, если картинка сошлась, иначе описание расхождения.
    verify(sc, i, size) {
      const gl = this.gl, hgt = Math.max(1, Math.round(size * sc.h.h / sc.h.w)), top = this.canvas.height;
      // холст для сверки каждый раз новый: с него читают один раз, и браузер не переводит его на медленный путь
      const pv = document.createElement('canvas'); pv.width = size; pv.height = hgt;
      const pc = pv.getContext('2d');
      pc.drawImage(this.canvas, 0, 0, size, hgt, 0, 0, size, hgt);
      const got = pc.getImageData(0, 0, size, hgt).data;
      const ref = (soft || (soft = new Soft())).render(sc, i, size).data;
      // обе картинки сравниваются с цветом, умноженным на альфу; flip: строки идут снизу вверх (так читает видеокарта)
      const diff = (px, flip, pre) => {
        let bad = 0, all = 0, x0 = size, y0 = hgt, x1 = -1, y1 = -1;
        for (let y = 1; y < hgt; y += 3) for (let x = 1; x < size; x += 3) {
          const q = (y * size + x) * 4, g = flip ? ((hgt - 1 - y) * size + x) * 4 : q, a = ref[q + 3] / 255, b = pre ? 1 : px[g + 3] / 255; all++;
          if (Math.abs(px[g + 3] - ref[q + 3]) > 56 || Math.abs(px[g] * b - ref[q] * a) > 56 || Math.abs(px[g + 1] * b - ref[q + 1] * a) > 56 || Math.abs(px[g + 2] * b - ref[q + 2] * a) > 56) { bad++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        return bad > Math.max(8, all * 0.002) ? 'неверных точек ' + bad + ' из ' + all + ', область x ' + x0 + '–' + x1 + ', y ' + y0 + '–' + y1 : '';
      };
      const copy = diff(got, false, false);
      if (!copy) return null;
      const n = size * hgt * 4; if (!this.px || this.px.length < n) this.px = new Uint8Array(n);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, top - hgt, size, hgt, gl.RGBA, gl.UNSIGNED_BYTE, this.px);
      const frame = diff(this.px, true, true);
      return (frame ? 'сам кадр на видеокарте неверен: ' + frame : 'кадр на видеокарте верен, но на холст страницы он копируется с ошибкой: ' + copy) + '; кадр ' + Math.floor(i) + ', холст ' + size + '×' + hgt + (this.name ? ', ' + this.name : '');
    }
    // первые кадры меряем: если видеокарта не тянет (или копия на холст идёт через процессор), дальше рисует Canvas 2D
    probe(ms) { if (this.seen++ < 2 || this.seen > 14) return; if (ms > 12) this.bad++; if (this.bad >= 5) this.slow = true; }
    // рисует кадр в левый верхний угол общего холста
    draw(sc, i, size) {
      const gl = this.gl, cv = this.canvas, hgt = Math.max(1, Math.round(size * sc.h.h / sc.h.w));
      if (Math.max(size, hgt) > cv.width) cv.width = cv.height = Math.max(size, hgt);
      const ni = sc.frame(i, size, null), top = cv.height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, top - hgt, size, hgt); gl.scissor(0, top - hgt, size, hgt);
      if (!this.dry) gl.clear(gl.COLOR_BUFFER_BIT);
      if (!ni) return;
      // строки градиентов этой сцены: заново, когда они менялись или текстуру занимала другая сцена
      if (sc.lutN && (sc.lutDirty || this.lutOwner !== sc)) { gl.activeTexture(gl.TEXTURE1); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, Math.min(LUT_ROWS, Math.max(sc.lutN, sc.h.ng || 0)), gl.RGBA, gl.UNSIGNED_BYTE, sc.lut); gl.activeTexture(gl.TEXTURE0); this.lutOwner = sc; sc.lutDirty = false; }
      gl.uniform2f(this.uSize, size, hgt); gl.uniform1f(this.uTop, top);
      this._upload(sc);
      if (INST.byteLength > this.instCap) { this.instCap = INST.byteLength; gl.bufferData(gl.ARRAY_BUFFER, this.instCap, gl.DYNAMIC_DRAW); }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, INST, 0, ni * INST_F);
      if (this.dry) return;   // dry: только работа процессора и загрузка данных, для замеров
      let depth = 0, at = -1;
      const quad = (tex, alpha, luma) => { gl.useProgram(this.pr2); gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1f(this.uAlpha, alpha); gl.uniform1f(this.uLuma, luma); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.activeTexture(gl.TEXTURE0); gl.useProgram(this.pr); };
      const target = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, depth ? this.fbos[depth - 1].fb : null); };
      for (let c = 0; c < sc.nc; c++) {
        const op = CMD[c * 3], a = CMD[c * 3 + 1];
        if (op === DRAW) {
          if (at !== a) { at = a; for (let k = 0; k < 5; k++) gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, INST_F * 4, a * INST_F * 4 + k * 16); }
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, CMD[c * 3 + 2]);
        } else if (op === PUSH) { const f = this._fbo(depth++); gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb); gl.clear(gl.COLOR_BUFFER_BIT); }
        else if (op === POP) { const f = this.fbos[--depth]; target(); quad(f.tex, a, 0); }
        else {
          // маска: содержимое под ней умножается на её альфу (или на обратную)
          const f = this.fbos[--depth]; target();
          if (a === 1 || a === 3) gl.blendFunc(gl.ZERO, gl.SRC_ALPHA); else gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
          quad(f.tex, 1, a > 2 ? 1 : 0); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }
  let shared = null, asked = false, glFault = '';   // glFault: что нашла самопроверка видеокарты, если она ошиблась
  const getGL = (force) => {
    if (glFault) return null;   // видеокарта уже ошибалась на этой странице: дальше рисует Canvas 2D
    if (shared) return shared;
    if (force) return (shared = new GL(true));
    // в обычном режиме контекст создаётся после первого кадра, чтобы не задерживать его
    if (!asked) { asked = true; setTimeout(() => { shared = new GL(false); }, 0); }
    return null;
  };

  // Низкий уровень: один холст, одна сцена, кадр по номеру.
  class Player {
    // source: ArrayBuffer/Uint8Array файла .ecr или готовая Scene; opts.backend: 'auto' | 'gl' | '2d' | 'soft'
    constructor(canvas, source, opts) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.backend = (opts && opts.backend) || 'auto'; this.used = '';
      this.checks = 0; this.checked = -100; this.checkSize = 0;
      this.setScene(source);
    }
    // подменить сцену на лету: сначала стоп-кадр, потом полная анимация
    setScene(source) { this.scene = source instanceof Scene ? source : new Scene(source); this.frames = this.scene.frames; this.fr = this.scene.h.fr; this.checks = 0; this.checked = -100; }
    // i: номер кадра от 0, можно дробный
    render(i) {
      const size = this.canvas.width, sc = this.scene, hgt = Math.max(1, Math.round(size * sc.h.h / sc.h.w));
      if (this.backend === 'soft') { const r = renderRGBA(sc, i, size); this.ctx.putImageData(new ImageData(r.data, r.width, r.height), 0, 0); this.used = 'soft'; return; }
      // стоп-кадр рисуется один раз и видеокарту не будит: создание контекста не должно задерживать первый показ
      const gl = this.backend === '2d' || (this.frames <= 1 && this.backend !== 'gl') ? null : getGL(this.backend === 'gl');
      if (gl && gl.ready() && !(gl.slow && this.backend !== 'gl')) {
        const t = performance.now();
        gl.draw(sc, i, size);
        // Сверка с процессором: до пяти разных кадров сцены. Устройство, прошедшее шестнадцать сверок, дальше проверяется
        // только на холстах крупнее уже проверенных: ошибки драйверов часто зависят именно от размера
        if (!gl.dry && verifyGL && sc.inst && (this.checkSize !== size || (this.checks < 5 && Math.abs(i - this.checked) >= 12)) && (okChecks < 16 || size > okSize)) {
          if (this.checkSize !== size) { this.checkSize = size; this.checks = 0; }
          this.checks++; this.checked = i;
          const fault = gl.verify(sc, i, size);
          if (!fault) { okChecks++; if (this.checks >= 5 && size > okSize) okSize = size; }
          if (fault) { glFault = fault; gl.dead = true; gl.ok = false; console.warn('ecore: кадр с видеокарты не сошёлся с расчётом на процессоре, дальше рисует Canvas 2D. ' + fault); sc.frame(i, size, this.ctx); this.used = '2d'; return; }
          const c = this.ctx; c.clearRect(0, 0, size, hgt); c.drawImage(gl.canvas, 0, 0, size, hgt, 0, 0, size, hgt); this.used = 'gl'; return;   // время сверки в замер скорости не идёт
        }
        if (!gl.dry) { const c = this.ctx; c.clearRect(0, 0, size, hgt); c.drawImage(gl.canvas, 0, 0, size, hgt, 0, 0, size, hgt); }
        if (this.backend !== 'gl') gl.probe(performance.now() - t);
        this.used = 'gl';
      } else { sc.frame(i, size, this.ctx); this.used = '2d'; }
    }
  }

  // Высокий уровень: то, что ставят в проект. Один requestAnimationFrame на страницу, играют только
  // анимации, которые видно; за экраном и в фоновой вкладке работа не идёт. destroy() отпускает всё.
  // Одновременно играет не больше maxLive анимаций: остальные ждут очереди и стоят на кадре, а место им уступает тот,
  // кто доиграл свой круг.
  // На один кадр экрана у всех анимаций вместе есть бюджет времени: кто не уложился, рисуется в следующий кадр,
  // так что страница остаётся отзывчивой, а при прокрутке бюджет ещё меньше.
  const live = new Set(), waiting = new Set(), files = new Map();
  let raf = 0, ticking = false, backend = 'auto', maxLive = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 6 : 16;
  let budget = 7, scrollBudget = 3, scrollUntil = 0, turn = 0, verifyGL = true, okChecks = 0, okSize = 0;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tick = (now) => {
    raf = 0; ticking = true;
    const list = Array.from(live), n = list.length, lim = now < scrollUntil ? scrollBudget : budget, t0 = performance.now();
    // очередь идёт по кругу с того места, где кончился бюджет: никто не остаётся без кадра надолго
    let done = 0;
    try { for (; done < n; done++) { if (done && performance.now() - t0 > lim) break; list[(turn + done) % n]._step(now); } }
    finally { ticking = false; }
    turn = n ? (turn + done) % n : 0;
    if (live.size) raf = requestAnimationFrame(tick);
  };
  // пока идёт tick, следующий кадр закажет он сам: иначе анимация, которая внутри шага освобождает место другой,
  // заказала бы второй цикл, и на каждый кадр экрана их становилось бы всё больше
  const wake = () => { if (!raf && !ticking && live.size) raf = requestAnimationFrame(tick); };
  const admit = () => { for (const a of waiting) { if (live.size >= maxLive) break; waiting.delete(a); if (a.playing && a.visible && a.player && !a.dead) { a.last = 0; live.add(a); } } wake(); };
  const drop = (a) => { waiting.delete(a); if (live.delete(a)) admit(); };
  const load = (url) => { let p = files.get(url); if (!p) { p = fetch(url).then((r) => { if (!r.ok) throw new Error('ecore: ' + url + ' ответил ' + r.status); return r.arrayBuffer(); }); files.set(url, p); p.catch(() => files.delete(url)); } return p; };
  if (typeof addEventListener === 'function') {
    // пока страницу листают, анимациям остаётся малая доля кадра: прокрутка важнее
    const onScroll = () => { scrollUntil = performance.now() + 160; };
    addEventListener('scroll', onScroll, { passive: true, capture: true }); addEventListener('wheel', onScroll, { passive: true }); addEventListener('touchmove', onScroll, { passive: true });
  }

  class Animation {
    constructor(target, source, opts) {
      opts = opts || {};
      const own = !(target instanceof HTMLCanvasElement);
      this.canvas = own ? target.appendChild(document.createElement('canvas')) : target;
      if (own) this.canvas.style.cssText = 'display:block;width:100%';
      this.own = own; this.loop = opts.loop !== false; this.speed = opts.speed || 1; this.backend = opts.backend || backend; this.fixed = opts.size || 0;
      // subframe: рисовать и между кадрами файла (плавнее на экранах 120 Гц, вдвое больше работы). По умолчанию кадр рисуется один раз
      this.subframe = !!opts.subframe; this.shown = -1;
      this.listeners = {}; this.segment = null; this.direction = 1; this.loopsLeft = typeof opts.loop === 'number' ? opts.loop - 1 : -1;
      this.onComplete = opts.onComplete || null; this.player = null; this.playing = false; this.visible = true; this.frame = 0; this.last = 0; this.dead = false; this.gen = 0; this.over = new Map();
      this.want = opts.autoplay !== false && !(reduced && opts.reducedMotion !== 'ignore');
      if (typeof IntersectionObserver === 'function') { this.io = new IntersectionObserver((e) => { this.visible = e[e.length - 1].isIntersecting; this._sync(); }); this.io.observe(this.canvas); }
      if (!this.fixed && typeof ResizeObserver === 'function') { this.ro = new ResizeObserver(() => this._fit(true)); this.ro.observe(this.canvas); }
      this.ready = (opts.still ? this._set(opts.still).catch(() => {}) : Promise.resolve()).then(() => this._set(source)).then(() => { if (this.want) this.play(); return this; });
    }
    get frames() { return this.player ? this.player.frames : 0; }
    get fps() { return this.player ? this.player.fr : 0; }
    get used() { return this.player ? this.player.used : ''; }
    get scene() { return this.player ? this.player.scene : null; }
    _draw() { if (this.player) { this.player.render(this.subframe ? this.frame : Math.floor(this.frame)); this.shown = Math.floor(this.frame); this._emit('enterFrame'); } }
    // события как в lottie-web: enterFrame, loopComplete, complete, DOMLoaded, data_ready, error
    on(name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn); return this; }
    off(name, fn) { const a = this.listeners[name]; if (a) { const k = a.indexOf(fn); if (k >= 0) a.splice(k, 1); } return this; }
    addEventListener(name, fn) { return this.on(name, fn); }
    removeEventListener(name, fn) { return this.off(name, fn); }
    _emit(name) { const a = this.listeners[name]; if (a && a.length) { const e = { type: name, currentTime: this.frame, totalTime: this.frames, direction: this.direction }; for (const fn of a.slice()) fn(e); } }
    // source: адрес .ecr, ArrayBuffer, Uint8Array или Scene
    _set(source) {
      const gen = ++this.gen;
      return Promise.resolve(typeof source === 'string' ? load(source) : source).then((data) => {
        if (this.dead || gen !== this.gen) return;
        if (this.player) this.player.setScene(data); else this.player = new Player(this.canvas, data, { backend: this.backend });
        for (const [n, p] of this.over) this.player.scene.setOver(n, p);
        if (this.frame >= this.player.frames) this.frame = 0;
        this._fit(false); this._draw();
        if (!this.loaded) { this.loaded = true; this._emit('DOMLoaded'); this._emit('data_ready'); }
      }).catch((e) => { this._emit('error'); throw e; });
    }
    // элементы сцены: что можно двигать (move) и красить (paint), с цветом по умолчанию
    names() { return this.player ? this.player.scene.elements() : []; }
    // set('имя', { x, y, color }): смещение в единицах исходника, цвет '#rrggbb'. Без пересборки, сразу на экране
    set(name, patch) {
      const cur = Object.assign(this.over.get(name) || {}, patch || {}); this.over.set(name, cur);
      if (this.player) { this.player.scene.setOver(name, cur); if (!this.playing) this._draw(); else this.shown = -1; }
      return this;
    }
    // сбросить смещение и цвет элемента к исходным
    reset(name) { this.over.delete(name); if (this.player) { this.player.scene.setOver(name, { x: 0, y: 0, color: null }); if (!this.playing) this._draw(); else this.shown = -1; } return this; }
    // правка узла по пути в исходном Lottie (см. Scene.patch), сразу на экране
    patch(src, p) { if (this.player && this.player.scene.patch(src, p)) { if (!this.playing) this._draw(); else this.shown = -1; } return this; }
    // что нарисовано под точкой экрана (clientX, clientY): { uid, src, name, layer } или null
    pick(clientX, clientY) {
      if (!this.player) return null;
      const r = this.canvas.getBoundingClientRect(), k = this.canvas.width / (r.width || 1);
      return this.player.scene.pick(Math.floor(this.frame), this.canvas.width, (clientX - r.left) * k, (clientY - r.top) * k);
    }
    // все попадания под точкой, сверху вниз: [{ uid, src, name, layer, groups }]
    pickAll(clientX, clientY) {
      if (!this.player) return [];
      const r = this.canvas.getBoundingClientRect(), k = this.canvas.width / (r.width || 1);
      return this.player.scene.pickAll(Math.floor(this.frame), this.canvas.width, (clientX - r.left) * k, (clientY - r.top) * k);
    }
    // рамка узла по пути в экранных координатах: { left, top, right, bottom } или null
    nodeBounds(src) {
      if (!this.player) return null;
      const b = this.player.scene.nodeBounds(src, Math.floor(this.frame), this.canvas.width); if (!b) return null;
      const r = this.canvas.getBoundingClientRect(), k = (r.width || 1) / this.canvas.width;
      return { left: r.left + b[0] * k, top: r.top + b[1] * k, right: r.left + b[2] * k, bottom: r.top + b[3] * k };
    }
    // матрица узла в единицах сцены на текущем кадре: { m: [a, b, c, d, e, f], o } или null
    worldAt(src) { return this.player ? this.player.scene.worldAt(src, Math.floor(this.frame)) : null; }
    // рамка элемента с именем name (или стилей, для которых test вернул true) в координатах экрана: { left, top, right, bottom }
    bounds(nameOrTest) {
      if (!this.player) return null;
      const sc = this.player.scene, test = typeof nameOrTest === 'function' ? nameOrTest : (st) => st.nm >= 0 && sc.names[st.nm] === nameOrTest;
      const b = sc.bounds(Math.floor(this.frame), this.canvas.width, test); if (!b) return null;
      const r = this.canvas.getBoundingClientRect(), k = (r.width || 1) / this.canvas.width;
      return { left: r.left + b[0] * k, top: r.top + b[1] * k, right: r.left + b[2] * k, bottom: r.top + b[3] * k };
    }
    setSource(source) { return this._set(source).then(() => { this._sync(); return this; }); }
    _fit(redraw) {
      if (!this.player) return;
      const h = this.player.scene.h, cv = this.canvas;
      const w = this.fixed || Math.max(16, Math.min(1024, Math.round((cv.clientWidth || h.w) * Math.min(2, G.devicePixelRatio || 1))));
      if (this.own) cv.style.aspectRatio = h.w + ' / ' + h.h;
      if (cv.width === w && cv.height === Math.round(w * h.h / h.w)) return;
      cv.width = w; cv.height = Math.round(w * h.h / h.w);
      if (redraw) this._draw();
    }
    _sync() {
      if (this.playing && this.visible && this.player && !this.dead) {
        if (live.has(this)) return;
        if (live.size >= maxLive) { waiting.add(this); return; }
        this.last = 0; live.add(this); wake();
      } else drop(this);
    }
    _step(now) {
      const p = this.player, dt = this.last ? Math.min(100, now - this.last) : 0; this.last = now;
      const lo = this.segment ? this.segment[0] : 0, hi = this.segment ? Math.min(this.segment[1], p.frames) : p.frames, span = hi - lo;
      let f = this.frame + dt * p.fr * this.speed * this.direction / 1000, end = false, lap = false;
      if (f >= hi || f < lo) {
        if (this.loop && span > 1 && this.loopsLeft !== 0) { if (this.loopsLeft > 0) this.loopsLeft--; f = lo + ((f - lo) % span + span) % span; lap = true; }
        else { f = this.direction > 0 ? Math.max(lo, hi - 1) : lo; end = true; }
      }
      this.frame = f;
      // экран обновляется чаще, чем меняются кадры файла: один и тот же кадр второй раз не рисуем
      if (this.subframe || Math.floor(f) !== this.shown) this._draw();
      if (end) { this.playing = false; drop(this); this._emit('complete'); if (this.onComplete) this.onComplete(this); }
      // доиграла круг, а другие ждут очереди: уступает место и встаёт в конец. Так играют все по кругу, а не первые шесть
      else if (lap) { this._emit('loopComplete'); if (waiting.size) { live.delete(this); waiting.add(this); admit(); } }
    }
    play() { this.want = true; this.playing = true; this._sync(); return this; }
    pause() { this.want = false; this.playing = false; this._sync(); return this; }
    seek(frame) { this.frame = Math.max(0, Math.min(frame, Math.max(0, this.frames - 1))); this._draw(); return this; }
    get totalFrames() { return this.frames; }
    get currentFrame() { return this.frame; }
    get isLoaded() { return !!this.player; }
    get isPaused() { return !this.playing; }
    getDuration(inFrames) { return inFrames ? this.frames : this.frames / (this.fps || 1); }
    setSpeed(speed) { this.speed = +speed || 0; return this; }
    setDirection(d) { this.direction = d < 0 ? -1 : 1; return this; }
    // значение в кадрах, либо в миллисекундах при isFrame = false (как в lottie-web)
    _at(value, isFrame) { const f = isFrame ? +value : (+value) * (this.fps || 1) / 1000; return Math.max(0, Math.min(f, Math.max(0, this.frames - 1))); }
    goToAndStop(value, isFrame) { this.pause(); this.frame = this._at(value, isFrame); this._draw(); return this; }
    goToAndPlay(value, isFrame) { this.frame = this._at(value, isFrame); this.play(); return this; }
    // сегмент воспроизведения [первый кадр, последний кадр); force — начать с сегмента
    playSegments(seg, force) { const r = Array.isArray(seg[0]) ? seg[0] : seg; this.segment = [+r[0], +r[1]]; if (force || this.frame < r[0] || this.frame >= r[1]) this.frame = +r[0]; return this.play(); }
    resetSegments(force) { this.segment = null; if (force) this.frame = 0; return this; }
    destroy() { this.dead = true; this.playing = false; drop(this); if (this.io) this.io.disconnect(); if (this.ro) this.ro.disconnect(); if (this.own) this.canvas.remove(); this.player = null; this.onComplete = null; }
  }
  const mount = (target, source, opts) => new Animation(target, source, opts);
  // .tgs (gzip) и .json по адресу: разбирается компилятором в сцену
  const gunzipMaybe = (buf) => { const b = new Uint8Array(buf); if (b[0] !== 0x1f || b[1] !== 0x8b || typeof DecompressionStream !== 'function') return buf; return new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); };
  const lottieUrl = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error('ecore: ' + url + ' ответил ' + r.status); return r.arrayBuffer(); }).then(gunzipMaybe).then((buf) => fromLottie(JSON.parse(new TextDecoder().decode(buf))));
  // совместимость с lottie.loadAnimation: container или rendererSettings.context, animationData или path (.ecr, .json, .tgs)
  const loadAnimation = (params) => {
    params = params || {};
    const rs = params.rendererSettings || {};
    const target = rs.context && rs.context.canvas ? rs.context.canvas : params.container;
    let source = params.animationData ? fromLottie(params.animationData) : params.path;
    if (typeof source === 'string' && !/\.ecr(\?|#|$)/i.test(source)) source = lottieUrl(source);
    // холст из rendererSettings.context сохраняет свой размер, как у lottie: по нему выбирают точки и миниатюры;
    // backend — необязательный параметр eCore (2d, gl, soft): редактор берёт 2d для пикера и миниатюр
    const own = rs.context && rs.context.canvas;
    return new Animation(target, source, { loop: params.loop === undefined ? true : params.loop, autoplay: params.autoplay, size: own ? own.width : 0, backend: params.backend });
  };

  // <e-core src="a.ecr" still="a.still.ecr" style="width:160px"></e-core>
  if (typeof customElements !== 'undefined' && !customElements.get('e-core')) customElements.define('e-core', class extends HTMLElement {
    static get observedAttributes() { return ['src']; }
    connectedCallback() {
      if (this.anim || !this.getAttribute('src')) return;
      if (getComputedStyle(this).display === 'inline') this.style.display = 'inline-block';
      const g = (k) => this.getAttribute(k);
      this.anim = mount(this, g('src'), { still: g('still') || undefined, loop: g('loop') !== 'false', autoplay: g('autoplay') !== 'false', speed: +g('speed') || 1, backend: g('backend') || undefined, size: +g('size') || 0, subframe: g('subframe') !== null && g('subframe') !== 'false' });
    }
    disconnectedCallback() { if (this.anim) { this.anim.destroy(); this.anim = null; } }
    attributeChangedCallback(name, old, val) { if (this.anim && val && val !== old) this.anim.setSource(val); else if (!this.anim && this.isConnected) this.connectedCallback(); }
  });

  // сцена прямо из документа Lottie (нужен ecr.js рядом): для редактора, без записи файла на диск
  const fromLottie = (json, opts) => { if (!G.ECore || !G.ECore.compileLottie) throw new Error('ecore: для fromLottie подключите компилятор (ecr.js)'); return new Scene(G.ECore.compileLottie(json, Object.assign({ raw: true, src: true }, opts)).bin); };

  const api = {
    _buffers: () => ({ INST, SEG, SEG2, ROWT, IM, CMD, INST_F, SEGW }),   // для проверок: то, что получает видеокарта
    Scene, Player, Animation, Soft, mount, loadAnimation, load, renderRGBA, fromLottie, inflateRaw,
    setBackend: (b) => { backend = b === 'gl' || b === '2d' || b === 'soft' ? b : 'auto'; },
    warm: () => { getGL(false); },   // можно позвать при старте страницы, чтобы WebGL был готов заранее
    gl: () => shared,
    setMaxLive: (n) => { maxLive = Math.max(1, n | 0); admit(); },
    // сколько миллисекунд кадра экрана можно занять всем анимациям: обычно и во время прокрутки
    setBudget: (ms, scrollMs) => { budget = Math.max(1, +ms || 7); scrollBudget = Math.max(0.5, +scrollMs || Math.min(3, budget)); },
    // самопроверка видеокарты (включена): false выключает сверку первых кадров с процессором
    setVerify: (on) => { verifyGL = !!on; },
    // пустая строка, если видеокарта рисует верно; иначе что именно она нарисовала не так (после этого работает Canvas 2D)
    glFault: () => glFault,
    version: '0.4.0',
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  G.ECore = Object.assign(G.ECore || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
