// eCore. Copyright (c) 2026 ecronx. Лицензия CPAL 1.0, полный текст в файле LICENSE. Пользоваться можно бесплатно,
// если в интерфейсе продукта видна надпись «Rendered with eCore» со ссылкой на https://tier.guru/ecore/.
// eCore: сцена (в раскладке Lottie) -> бинарный файл .ecr для плеера (ecore.js).
// Вся работа, которую можно сделать заранее, делается здесь: дерево шейпов разворачивается
// в плоский список стилей, ключи кладутся в один блок чисел.
// Файл: 'ECR2', байт флагов, дальше тело, сжатое своим deflate. В теле структура сцены (компактная
// запись с таблицей ключей) и числа квантованными дельтами (varint): координаты 1/64, цвета и easing 1/1024.
// Вложенные композиции хранятся один раз и разворачиваются плеером, эллипсы и прямоугольники параметрами.
// Работает и в Node, и в браузере: сцену даёт либо разобранный tgs, либо компилятор исходника (source.js).
(function (G) {
  'use strict';
  const arr = (v) => (Array.isArray(v) ? v : [v]);
  const nz = (v) => arr(v).some((x) => Math.abs(x) > 1e-6);
  const fit = (v, d, pad = 0) => { const a = arr(v).slice(0, d); while (a.length < d) a.push(pad); return a; };
  const isAnim = (p) => !!p && Array.isArray(p.k) && p.k.length > 0 && p.k[0] !== null && typeof p.k[0] === 'object' && !Array.isArray(p.k[0]) && 't' in p.k[0];

  // Ключи структуры: в файле вместо имени пишется номер. Список общий с ecore.js, новые ключи только в конец.
  const KEYS = 'v w h fr ip op ng nf names over comps ty st sr par hd tt ks rf gx cn ch pa ge tr sy a p px py s r o n c t el rc q k ru xf nm g e row hl ha lc lj ml d x y color src cs'.split(' ');

  function ease(ox, oy, ix, iy, u) {
    if (ox === oy && ix === iy) return u;
    let lo = 0, hi = 1, t = u;
    for (let i = 0; i < 40; i++) {
      const mt = 1 - t, x = 3 * mt * mt * t * ox + 3 * mt * t * t * ix + t * t * t;
      if (Math.abs(x - u) < 1e-7) break;
      if (x < u) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    const mt = 1 - t;
    return 3 * mt * mt * t * oy + 3 * mt * t * t * iy + t * t * t;
  }

  // ---------- свой deflate (RFC 1951): поиск повторов по хеш-цепочкам, ленивый выбор, динамические коды Хаффмана ----------
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const LSYM = new Uint8Array(259), DSYM = new Uint8Array(512);
  for (let i = 0, s = 0; i < 259; i++) { while (s < 28 && LBASE[s + 1] <= i) s++; LSYM[i] = s; }
  for (let i = 0, s = 0; i < 512; i++) { const d = i < 256 ? i + 1 : ((i - 256) << 7) + 1; while (s < 29 && DBASE[s + 1] <= d) s++; DSYM[i] = s; }
  const dsym = (d) => (d <= 256 ? DSYM[d - 1] : DSYM[256 + ((d - 1) >> 7)]);

  // длины кодов Хаффмана не длиннее limit: обычное дерево, при переполнении частоты сглаживаются
  function codeLengths(freq, limit) {
    const n = freq.length, len = new Uint8Array(n);
    let f = Array.from(freq);
    for (;;) {
      const nodes = [];
      for (let i = 0; i < n; i++) if (f[i] > 0) nodes.push({ w: f[i], s: i, l: null, r: null });
      if (!nodes.length) return len;
      if (nodes.length === 1) { len[nodes[0].s] = 1; return len; }
      nodes.sort((a, b) => a.w - b.w || a.s - b.s);
      // два списка: листья и собранные узлы, оба по возрастанию веса
      const q = []; let li = 0, qi = 0;
      const take = () => (li < nodes.length && (qi >= q.length || nodes[li].w <= q[qi].w) ? nodes[li++] : q[qi++]);
      while (nodes.length - li + q.length - qi > 1) { const a = take(), b = take(); q.push({ w: a.w + b.w, s: -1, l: a, r: b }); }
      let max = 0; const stack = [[q[q.length - 1], 0]];
      while (stack.length) { const [nd, d] = stack.pop(); if (nd.s >= 0) { len[nd.s] = d; if (d > max) max = d; } else { stack.push([nd.l, d + 1]); stack.push([nd.r, d + 1]); } }
      if (max <= limit) return len;
      f = f.map((x) => (x > 0 ? (x + 1) >> 1 : 0));
    }
  }
  function codes(len) {
    const cnt = new Uint16Array(16), next = new Uint16Array(16), out = new Uint16Array(len.length);
    for (const l of len) cnt[l]++;
    cnt[0] = 0; let c = 0;
    for (let b = 1; b < 16; b++) { c = (c + cnt[b - 1]) << 1; next[b] = c; }
    for (let i = 0; i < len.length; i++) { const l = len[i]; if (!l) continue; let v = next[l]++, r = 0; for (let k = 0; k < l; k++) { r = (r << 1) | (v & 1); v >>= 1; } out[i] = r; }
    return out;
  }

  function deflateRaw(src) {
    const n = src.length, out = []; let bb = 0, bn = 0;
    const put = (v, k) => { bb |= v << bn; bn += k; while (bn >= 8) { out.push(bb & 255); bb >>>= 8; bn -= 8; } };
    const put2 = (v, k) => { if (k > 16) { put(v & 0xffff, 16); put(v >>> 16, k - 16); } else put(v, k); };
    // 1. LZ77: tok = литерал (0..255) или (длина << 16 | расстояние) + 256 << 0 через отдельные массивы
    const tl = new Uint16Array(n + 1), td = new Uint16Array(n + 1); let nt = 0;
    const HS = 1 << 15, head = new Int32Array(HS).fill(-1), prev = new Int32Array(Math.max(1, n));
    const hash = (i) => ((src[i] << 10) ^ (src[i + 1] << 5) ^ src[i + 2]) & (HS - 1);
    const find = (i) => {
      let bl = 2, bd = 0, p = head[hash(i)], chain = 512; const maxl = Math.min(258, n - i);
      while (p >= 0 && i - p <= 32768 && chain-- > 0) {
        if (src[p + bl] === src[i + bl] && src[p] === src[i]) { let l = 0; while (l < maxl && src[p + l] === src[i + l]) l++; if (l > bl) { bl = l; bd = i - p; if (l === maxl) break; } }
        p = prev[p];
      }
      return bl >= 3 ? (bl << 16) | bd : 0;
    };
    const ins = (i) => { if (i + 2 < n) { const h = hash(i); prev[i] = head[h]; head[h] = i; } };
    for (let i = 0; i < n;) {
      let m = i + 2 < n ? find(i) : 0;
      if (m) {
        ins(i);
        // ленивый выбор: если со следующего байта повтор длиннее, этот байт уходит литералом
        const m2 = i + 3 < n ? find(i + 1) : 0;
        if (m2 >>> 16 > (m >>> 16) + ((m & 0xffff) > 4096 ? 1 : 0)) { tl[nt] = 0; td[nt++] = src[i]; i++; continue; }
        if ((m >>> 16) === 3 && (m & 0xffff) > 8192) m = 0;   // далёкий повтор из трёх байт дороже трёх литералов
        if (m) { const l = m >>> 16; tl[nt] = l; td[nt++] = m & 0xffff; for (let k = 1; k < l; k++) ins(i + k); i += l; continue; }
        tl[nt] = 0; td[nt++] = src[i]; i++; continue;
      }
      ins(i); tl[nt] = 0; td[nt++] = src[i]; i++;
    }
    // 2. блоки: у каждого свои коды. Вариантов два (динамические и фиксированные коды), берётся тот, что короче
    const BLOCK = 32768;
    const FL = new Uint8Array(288); for (let i = 0; i < 288; i++) FL[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    const FD = new Uint8Array(30).fill(5), FLC = codes(FL), FDC = codes(FD);
    for (let b0 = 0; b0 < nt || b0 === 0; b0 += BLOCK) {
      const b1 = Math.min(nt, b0 + BLOCK), last = b1 >= nt ? 1 : 0;
      const lf = new Uint32Array(286), df = new Uint32Array(30); lf[256] = 1;
      for (let t = b0; t < b1; t++) { if (tl[t]) { lf[257 + LSYM[tl[t]]]++; df[dsym(td[t])]++; } else lf[td[t]]++; }
      const ll = codeLengths(lf, 15), dl = codeLengths(df, 15);
      if (!dl.some((x) => x)) dl[0] = 1;
      let hl = 286; while (hl > 257 && !ll[hl - 1]) hl--;
      let hd = 30; while (hd > 1 && !dl[hd - 1]) hd--;
      // длины кодов сами записываются кодами 0..18 с повторами
      const seq = [], all = new Uint8Array(hl + hd); all.set(ll.subarray(0, hl)); all.set(dl.subarray(0, hd), hl);
      for (let i = 0; i < all.length;) {
        const v = all[i]; let r = 1; while (i + r < all.length && all[i + r] === v) r++;
        i += r;
        if (v === 0) { while (r >= 11) { const k = Math.min(138, r); seq.push(18, k - 11); r -= k; } if (r >= 3) { seq.push(17, r - 3); r = 0; } while (r-- > 0) seq.push(0, 0); }
        else { seq.push(v, 0); r--; while (r >= 3) { const k = Math.min(6, r); seq.push(16, k - 3); r -= k; } while (r-- > 0) seq.push(v, 0); }
      }
      const cf = new Uint32Array(19); for (let i = 0; i < seq.length; i += 2) cf[seq[i]]++;
      const cl = codeLengths(cf, 7), cc = codes(cl);
      let hc = 19; while (hc > 4 && !cl[CLORD[hc - 1]]) hc--;
      let dyn = 14 + 3 * hc, fix = 0;
      for (let i = 0; i < seq.length; i += 2) dyn += cl[seq[i]] + (seq[i] === 16 ? 2 : seq[i] === 17 ? 3 : seq[i] === 18 ? 7 : 0);
      for (let s = 0; s < 286; s++) { const x = s > 256 ? LEXT[s - 257] : 0; dyn += lf[s] * (ll[s] + x); fix += lf[s] * (FL[s] + x); }
      for (let s = 0; s < 30; s++) { dyn += df[s] * (dl[s] + DEXT[s]); fix += df[s] * (5 + DEXT[s]); }
      const useFix = fix <= dyn, L = useFix ? FL : ll, D = useFix ? FD : dl, LC = useFix ? FLC : codes(ll), DC = useFix ? FDC : codes(dl);
      put(last, 1); put(useFix ? 1 : 2, 2);
      if (!useFix) {
        put(hl - 257, 5); put(hd - 1, 5); put(hc - 4, 4);
        for (let i = 0; i < hc; i++) put(cl[CLORD[i]], 3);
        for (let i = 0; i < seq.length; i += 2) { const s = seq[i]; put(cc[s], cl[s]); if (s === 16) put(seq[i + 1], 2); else if (s === 17) put(seq[i + 1], 3); else if (s === 18) put(seq[i + 1], 7); }
      }
      for (let t = b0; t < b1; t++) {
        if (!tl[t]) { put(LC[td[t]], L[td[t]]); continue; }
        const ls = LSYM[tl[t]], ds = dsym(td[t]);
        put(LC[257 + ls], L[257 + ls]); if (LEXT[ls]) put(tl[t] - LBASE[ls], LEXT[ls]);
        put(DC[ds], D[ds]); if (DEXT[ds]) put2(td[t] - DBASE[ds], DEXT[ds]);
      }
      put(LC[256], L[256]);
    }
    if (bn) out.push(bb & 255);
    return Uint8Array.from(out);
  }

  // ---------- запись структуры: тег в трёх младших битах, ключи объектов номерами из KEYS ----------
  function pack(root) {
    const out = [], te = new TextEncoder();
    const wr = (v) => { while (v > 127) { out.push((v % 128) | 128); v = Math.floor(v / 128); } out.push(v); };
    const val = (v) => {
      if (typeof v === 'number') {
        if (!isFinite(v)) v = 0;
        if (Number.isInteger(v)) { wr(Math.abs(v) * 8 + (v < 0 ? 1 : 0)); return; }
        const q = Math.round(v * 1000);
        if (Math.abs(q - v * 1000) < 1e-6 || Math.abs(v) > 1e6) { wr(Math.abs(q) * 8 + (q < 0 ? 3 : 2)); return; }
        const f = Math.round(v * 1048576); wr((f < 0 ? -f * 2 - 1 : f * 2) * 8 + 7); return;   // стопы градиента: тысячных мало
      }
      if (typeof v === 'string') { const b = te.encode(v); wr(b.length * 8 + 6); for (const x of b) out.push(x); return; }
      if (Array.isArray(v)) { wr(v.length * 8 + 4); for (const x of v) val(x); return; }
      if (v === null || v === undefined || typeof v === 'boolean') { wr(v ? 8 : 0); return; }
      const ks = Object.keys(v).filter((k) => v[k] !== undefined);
      wr(ks.length * 8 + 5);
      for (const k of ks) {
        const id = KEYS.indexOf(k);
        if (id >= 0) wr(id + 1); else { const b = te.encode(k); wr(0); wr(b.length); for (const x of b) out.push(x); }   // имя не из списка (имена элементов в over) пишется текстом
        val(v[k]);
      }
    };
    val(root);
    return out;
  }

  // opts.still: «стоп-кадр» — та же сцена, но все свойства взяты в первом кадре и анимации нет.
  // Такой файл в несколько раз меньше и нужен, чтобы показать картинку раньше, чем доедет вся анимация.
  // opts.over: стартовые смещения и цвета элементов. opts.src: записать в стили путь к исходному узлу Lottie (для редактора).
  function compileLottie(j, opts) {
    opts = opts || {};
    const STILL = !!opts.still, SRC = !!opts.src;
    // время как в rlottie: кадры композиции идут от целой части ip, а начало, вход и выход слоя округляются до целого
    const IP = Math.trunc(+j.ip || 0), OP = Math.max(IP + 1, Math.trunc(+j.op || 0));
    const lround = (v) => { v = +v || 0; return v < 0 ? -Math.round(-v) : Math.round(v); };
    let f0 = IP;            // кадр, в котором берутся значения стоп-кадра (свой у каждой вложенной композиции)
    const F = [], DIR = [];   // DIR: чем занят F по порядку: [1, длина] статичный путь, [2|3|4|5] дорожка (шаг 1/64, цвет 1/1024, путь, градиент 1/65536)
    const unsupported = {};
    const warn = (k) => { unsupported[k] = (unsupported[k] || 0) + 1; };
    const push = (a) => { for (let i = 0; i < a.length; i++) F.push(a[i]); return DIR.push([1, a.length]) - 1; };

    function normKfs(raw, conv) {
      const out = [];
      for (let i = 0; i < raw.length; i++) {
        const k = raw[i];
        let s = k.s !== undefined ? conv(k.s) : null;
        if (!s) { const p = raw[i - 1]; s = p && p.e !== undefined ? conv(p.e) : out[i - 1] ? out[i - 1].s : null; }
        if (!s) continue;
        // easing у rlottie один на все измерения: из массивов x и y берётся первое число (остальные Telegram отбрасывает)
        const e1 = (v, d) => { const x = arr(v)[0]; return [typeof x === 'number' ? x : d]; };
        out.push({ t: k.t, h: k.h ? 1 : 0, ox: k.o ? e1(k.o.x, 0) : [0], oy: k.o ? e1(k.o.y, 0) : [0], ix: k.i ? e1(k.i.x, 1) : [1], iy: k.i ? e1(k.i.y, 1) : [1], s, e: k.e !== undefined ? conv(k.e) : null, to: k.to, ti: k.ti });
      }
      return out;
    }
    const curved = (k) => (k.to && nz(k.to)) || (k.ti && nz(k.ti));
    // значение свойства в кадре f (нужно только для стоп-кадра)
    function evalKfs(kfs, f) {
      const N = kfs.length;
      if (f <= kfs[0].t) return kfs[0].s;
      if (f >= kfs[N - 1].t) return kfs[N - 1].s;
      let k = 0; while (k < N - 2 && kfs[k + 1].t <= f) k++;
      const a = kfs[k], b = kfs[k + 1];
      if (a.h) return a.s;
      const end = a.e || b.s, u = (f - a.t) / (b.t - a.t), D = a.s.length;
      if (curved(a)) {
        // движение по пространственной кривой Безье с равномерной скоростью по длине дуги
        const w = ease(a.ox[0], a.oy[0], a.ix[0], a.iy[0], u);
        const p0 = a.s, p3 = end, p1 = p0.map((v, d) => v + ((a.to || [])[d] || 0)), p2 = p3.map((v, d) => v + ((a.ti || [])[d] || 0));
        const M = 200, pts = [], len = [0];
        for (let i = 0; i <= M; i++) { const t = i / M, mt = 1 - t; pts.push(p0.map((_, d) => mt * mt * mt * p0[d] + 3 * mt * mt * t * p1[d] + 3 * mt * t * t * p2[d] + t * t * t * p3[d])); if (i) { const dx = Math.abs(pts[i][0] - pts[i - 1][0]), dy = Math.abs((pts[i][1] || 0) - (pts[i - 1][1] || 0)); len.push(len[i - 1] + (dx > dy ? dx + 0.375 * dy : dy + 0.375 * dx)); } }   // длина в метрике rlottie
        const target = w * len[M]; let i = 1; while (i < M && len[i] < target) i++;
        const seg = len[i] - len[i - 1], q = seg > 1e-9 ? (target - len[i - 1]) / seg : 0;
        return pts[i - 1].map((v, d) => v + (pts[i][d] - v) * q);
      }
      const out = new Array(D);
      for (let d = 0; d < D; d++) { const e = Math.min(d, a.ox.length - 1); out[d] = a.s[d] + (end[d] - a.s[d]) * ease(a.ox[e], a.oy[e], a.ix[e], a.iy[e], u); }
      return out;
    }

    // дорожка в F: [D, N, E, флаги], затем на ключ: t, hold, easing 4·E, значение D, [конец D], [касательные to, ti по D]
    function emitTrack(kfs, D, type = 2, spatial = false) {
      const N = kfs.length; let E = 1, hasE = 0;
      for (const k of kfs) for (const key of ['ox', 'oy', 'ix', 'iy']) if (k[key].length > 1 && k[key].some((x) => x !== k[key][0])) E = D;
      for (let i = 0; i < N - 1; i++) if (kfs[i].e && kfs[i].e.some((v, d) => Math.abs(v - kfs[i + 1].s[d]) > 1e-4)) hasE = 1;
      const sp = spatial && kfs.some(curved) ? 2 : 0;
      if (sp) E = 1;   // по кривой идут с одной общей скоростью
      F.push(D, N, E, hasE | sp);
      for (let i = 0; i < N; i++) {
        const k = kfs[i], end = k.e || (i < N - 1 ? kfs[i + 1].s : k.s);   // у ключа без своего конца отрезок идёт к началу следующего
        F.push(k.t, k.h);
        for (const key of ['ox', 'oy', 'ix', 'iy']) for (let d = 0; d < E; d++) F.push(k[key][Math.min(d, k[key].length - 1)]);
        for (let d = 0; d < D; d++) F.push(k.s[d] || 0);
        if (hasE) for (let d = 0; d < D; d++) F.push(end[d] || 0);
        if (sp) { for (let d = 0; d < D; d++) F.push((k.to || [])[d] || 0); for (let d = 0; d < D; d++) F.push((k.ti || [])[d] || 0); }
      }
      return { t: DIR.push([type]) - 1 };
    }
    // свойство: число, массив или { t: номер дорожки }
    // Статичные значения округляются до тысячных; у градиента (type 5) до миллионных: его стопы бывают ближе тысячной,
    // и слипшиеся стопы дали бы другую картинку
    function prop(p, D, pad = 0, spatial = false, type = 2) {
      const k = type === 5 ? 1e6 : 1000, one = (a) => { a = a.map((x) => Math.round(x * k) / k); return D === 1 ? a[0] : a; };
      if (!p || p.k === undefined) return one(fit([], D, pad));
      if (!isAnim(p)) return one(fit(p.k, D, pad));
      const kfs = normKfs(p.k, (v) => fit(v, D, pad));
      if (!kfs.length) return one(fit([], D, pad));
      if (kfs.length === 1) return one(kfs[0].s);
      if (STILL) return one(evalKfs(kfs, f0));
      return emitTrack(kfs, D, type, spatial);
    }
    const isDef = (v, d) => (typeof v === 'number' ? v === d : Array.isArray(v) && v.every((x) => x === d));

    function xform(ks) {
      const o = {}, set = (k, v, d) => { if (!isDef(v, d)) o[k] = v; };
      set('a', prop(ks.a, 2), 0); set('s', prop(ks.s, 2, 100), 100); set('r', prop(ks.r, 1), 0); set('o', prop(ks.o, 1, 100), 100);
      if (ks.p && ks.p.s === true) { o.px = prop(ks.p.x, 1); o.py = prop(ks.p.y, 1); } else set('p', prop(ks.p, 2, 0, true), 0);
      if (ks.sk && (isAnim(ks.sk) || nz(ks.sk.k))) warn('skew (Telegram его не рисует)');
      return o;
    }
    const flatShape = (sh) => { const n = sh.v.length, a = new Array(6 * n); for (let i = 0; i < n; i++) { a[6 * i] = sh.v[i][0]; a[6 * i + 1] = sh.v[i][1]; a[6 * i + 2] = sh.i[i][0]; a[6 * i + 3] = sh.i[i][1]; a[6 * i + 4] = sh.o[i][0]; a[6 * i + 5] = sh.o[i][1]; } return a; };
    function pathOf(it) {
      const ks = it.ks;
      if (!isAnim(ks)) { const sh = Array.isArray(ks.k) ? ks.k[0] : ks.k; return { n: sh.v.length, c: sh.c ? 1 : 0, o: push(flatShape(sh)) }; }
      const first = ks.k.find((k) => k.s), sh0 = Array.isArray(first.s) ? first.s[0] : first.s, n = sh0.v.length;
      const conv = (s) => { const sh = Array.isArray(s) ? s[0] : s; if (sh.v.length !== n) warn('morph: разное число вершин'); return fit(flatShape(sh), 6 * n); };
      const kfs = normKfs(ks.k, conv);
      if (kfs.length === 1) return { n, c: sh0.c ? 1 : 0, o: push(kfs[0].s) };
      if (STILL) return { n, c: sh0.c ? 1 : 0, o: push(evalKfs(kfs, f0)) };
      return { n, c: sh0.c ? 1 : 0, t: emitTrack(kfs, 6 * n, 4).t };
    }
    // эллипс и прямоугольник остаются параметрами: плеер строит контур сам, как rlottie (el/rc: 1 по часовой, 3 против)
    const ellipseOf = (it) => ({ el: it.d === 3 ? 3 : 1, p: prop(it.p, 2, 0, true), s: prop(it.s, 2) });
    const rectOf = (it) => { const o = { rc: it.d === 3 ? 3 : 1, p: prop(it.p, 2, 0, true), s: prop(it.s, 2) }, q = prop(it.r, 1); if (!isDef(q, 0)) o.q = q; return o; };

    const names = [];
    // имена элементов (id из исходника) в одну таблицу: слои и заливки ссылаются на неё по номеру
    const nid = (s) => { let i = names.indexOf(s); if (i < 0) i = names.push(s) - 1; return i; };
    const clean = (s) => String(s).replace(/ place$/, '');
    let nGrad = 0;

    // nm: имя ближайшего именованного предка (для заливок); rec: имя, под которым записать трансформацию этой группы;
    // owner: имя уже записанной снаружи группы. Вложенная группа с тем же именем (спутник «place») не пишется второй раз,
    // иначе смещение элемента применилось бы дважды
    function walk(items, chain, open, trims, L, nm, rec, owner, src) {
      let my = chain;
      const tr = items.find((it) => it.ty === 'tr');
      if (tr) { const g = L.gx.push(xform(tr)); L.ch.push(chain, g - 1); my = L.ch.length / 2; if (rec) L.cn.push(my, nid(rec)); if (SRC) L.cs.push(my, src); }
      const own = [], ownTrims = [];
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]; if (it.hd) continue;
        switch (it.ty) {
          case 'fl': case 'gf': case 'st': case 'gs': {
            const stroke = it.ty === 'st' || it.ty === 'gs';
            const st = { xf: my, ge: [] }, o = prop(it.o, 1, 100);
            if (stroke) st.k = 1;
            if (it.r === 2 && !stroke) st.ru = 2;
            if (!isDef(o, 100)) st.o = o;
            if (nm) st.nm = nid(nm);
            if (SRC) st.src = src + '/' + i;
            if (stroke) {
              st.w = prop(it.w, 1);
              // концы и стыки как их читает rlottie: 1 прямой, 2 круглый, иное квадрат/срез; без ключа прямой конец и острый стык,
              // предел остроты без ключа равен нулю (тогда стык всегда срезается)
              const lc = it.lc === undefined || it.lc === 1 ? 1 : it.lc === 2 ? 2 : 3, lj = it.lj === undefined || it.lj === 1 ? 1 : it.lj === 2 ? 2 : 3, ml = typeof it.ml === 'number' ? it.ml : 0;
              if (lc !== 2) st.lc = lc; if (lj !== 2) st.lj = lj;
              if (lj === 1 && ml !== 4) st.ml = ml;
              // пунктир: штрих, пробел, ..., последним сдвиг (порядок как в файле Lottie)
              if (Array.isArray(it.d) && it.d.length > 1) st.d = it.d.map((d) => prop(d.v, 1));
            }
            if (it.ty === 'gf' || it.ty === 'gs') {
              const len = (isAnim(it.g.k) ? it.g.k.k.find((k) => k.s).s : it.g.k.k).length;
              const g = st.g = { t: it.t === 1 ? 1 : 2, s: prop(it.s, 2), e: prop(it.e, 2), n: it.g.p, k: prop(it.g.k, len, 0, false, 5), row: nGrad++ };
              // блик: фокус радиального градиента сдвинут от центра на долю радиуса hl под углом ha
              if (g.t === 2 && it.h && (isAnim(it.h) || nz(it.h.k))) { g.hl = prop(it.h, 1); const ha = prop(it.a, 1); if (!isDef(ha, 0)) g.ha = ha; }
            } else st.c = prop(it.c, 3, 1, false, 3);   // альфа цвета не берётся: rlottie её не читает, прозрачность задаёт только o
            L.sy.push(st); own.push(st); break;
          }
          case 'gr': { const gn = it.nm ? clean(it.nm) : '', fresh = gn && gn !== owner; walk(it.it || [], my, open.concat(own), trims.concat(ownTrims), L, gn || nm, fresh ? gn : '', fresh ? gn : owner, src + '/' + i + '/it'); break; }
          case 'sh': case 'el': case 'rc': {
            const p = L.pa.push(it.ty === 'sh' ? pathOf(it) : it.ty === 'el' ? ellipseOf(it) : rectOf(it)) - 1, tm = trims.concat(ownTrims);
            if (tm.length > 1) warn('несколько trim на путь');
            const g = L.ge.length / 3; L.ge.push(p, my, tm.length ? tm[tm.length - 1] + 1 : 0);
            for (const st of open.concat(own)) st.ge.push(g);
            break;
          }
          case 'tm': { const t = {}, s = prop(it.s, 1), e = prop(it.e, 1, 100), o = prop(it.o, 1); if (!isDef(s, 0)) t.s = s; if (!isDef(e, 100)) t.e = e; if (!isDef(o, 0)) t.o = o; ownTrims.push(L.tr.push(t) - 1); if ((it.m || 1) !== 1) warn('trim mode 2'); break; }
          case 'tr': break;
          case 'mm': warn('merge paths (Telegram их не рисует)'); break;
          case 'rd': warn('round corners (Telegram их не рисует)'); break;
          default: warn('shape ' + it.ty);
        }
      }
    }

    // композиции: корень первым, вложенные по мере встречи. В обычном файле каждая хранится один раз,
    // в стоп-кадре у каждого вхождения своя копия: значения берутся в её собственном времени
    const comps = [], compIds = new Map(), assets = new Map();
    for (const a of j.assets || []) if (a && a.layers) assets.set(a.id, a);
    function comp(layers, key, src, depth) {
      if (compIds.has(key)) return compIds.get(key);
      const ci = comps.push(null) - 1; compIds.set(key, ci);
      // слой, у которого ks записан массивом (так пишут пустой объект некоторые конвертеры), обрывает разбор в rlottie:
      // Telegram покажет только слои до него. Делаем так же, чтобы картинка совпадала
      const cut = layers.findIndex((l) => l && Array.isArray(l.ks));
      if (cut >= 0) { warn('повреждённый слой (ks массивом): слои с него и ниже Telegram не рисует'); layers = layers.slice(0, cut); }
      const idx = new Map(); layers.forEach((l, i) => idx.set(l.ind, i));
      const mine = f0;
      comps[ci] = layers.map((l, li) => {
        f0 = mine;
        const L = { ks: xform(l.ks || {}) }, lsrc = src + '/' + li;
        if (SRC) L.src = lsrc;
        if (l.ty !== 4) L.ty = l.ty === 0 ? 0 : 3;
        const ip = lround(l.ip), op = lround(l.op);
        if (!STILL) { L.ip = ip; L.op = op; } else if (f0 < ip || f0 >= op) L.hd = 1;
        if (l.parent !== undefined && idx.has(l.parent)) L.par = idx.get(l.parent) + 1;
        if (l.hd) L.hd = 1;
        if (l.tt) { L.tt = l.tt; if (l.tt > 2) warn('luma matte'); }
        if (l.ty === 4) {
          const S = { gx: [], cn: [], ch: [], pa: [], ge: [], tr: [], sy: [], cs: [] };
          if (!L.hd) walk(l.shapes || [], 0, [], [], S, '', '', '', lsrc + '/shapes');
          S.sy = S.sy.filter((s) => s.ge.length);
          for (const k in S) if (S[k].length) L[k] = S[k];
        } else if (l.ty === 0) {
          const a = assets.get(l.refId), sr = l.sr || 1, st = lround(l.st);
          if (!a || depth > 16) { warn('precomp без композиции'); L.ty = 3; }
          else if (L.hd) L.ty = 3;
          else {
            if (l.tm) warn('time remap');
            L.w = l.w || j.w; L.h = l.h || j.h;
            if (STILL) { f0 = sr === 1 ? mine - st : Math.trunc((mine - st) / sr); L.rf = comp(a.layers, l.refId + '@' + f0, 'assets/' + l.refId + '/layers', depth + 1); f0 = mine; }
            else { if (st) L.st = st; if (sr !== 1) L.sr = sr; L.rf = comp(a.layers, l.refId, 'assets/' + l.refId + '/layers', depth + 1); }
          }
        } else if (l.ty !== 3) warn('layer type ' + l.ty);
        if (l.masksProperties && l.masksProperties.length) warn('mask');
        if (l.ef && l.ef.length) warn('effects (Telegram их не рисует)');
        if (l.bm) warn('blend mode (Telegram его не рисует)');
        return L;
      });
      return ci;
    }
    comp(j.layers || [], '', 'layers', 0);

    // числа: дельта к предыдущему ключу той же дорожки, у путей первый ключ ещё и дельта к предыдущей вершине
    function encode(out) {
      const wr = (v) => { while (v > 127) { out.push((v % 128) | 128); v = Math.floor(v / 128); } out.push(v); };
      const zz = (v) => wr(v < 0 ? -v * 2 - 1 : v * 2);
      let o = 0; wr(DIR.length);
      for (const [type, len] of DIR) {
        wr(type);
        if (type === 1) { wr(len); const q = []; for (let d = 0; d < len; d++) { q[d] = Math.round(F[o + d] * 64); zz(d >= 6 && d % 6 < 2 ? q[d] - q[d - 6] : q[d]); } o += len; continue; }
        const sc = type === 3 ? 1024 : type === 5 ? 65536 : 64, D = F[o], N = F[o + 1], E = F[o + 2], fl = F[o + 3], hasE = fl & 1, sp = fl & 2, ne = 4 * E;
        wr(D); wr(N); wr(E); wr(fl); o += 4;
        let pt = 0; const pe = new Array(ne).fill(0), ps = new Array(D).fill(0), qs = new Array(D);
        for (let k = 0; k < N; k++) {
          const t = Math.round(F[o] * 16); zz(t - pt); pt = t; wr(F[o + 1]); o += 2;
          for (let n = 0; n < ne; n++) { const q = Math.round(F[o + n] * 1024); zz(q - pe[n]); pe[n] = q; } o += ne;
          for (let d = 0; d < D; d++) qs[d] = Math.round(F[o + d] * sc);
          if (k === 0 && type === 4) for (let d = 0; d < D; d++) zz(d >= 6 && d % 6 < 2 ? qs[d] - qs[d - 6] : qs[d]);
          else for (let d = 0; d < D; d++) zz(qs[d] - ps[d]);
          for (let d = 0; d < D; d++) ps[d] = qs[d]; o += D;
          if (hasE) { for (let d = 0; d < D; d++) zz(Math.round(F[o + d] * sc) - qs[d]); o += D; }
          if (sp) { for (let d = 0; d < 2 * D; d++) zz(Math.round(F[o + d] * 64)); o += 2 * D; }
        }
      }
    }
    const header = { v: 2, w: j.w, h: j.h, fr: j.fr, ip: IP, op: STILL ? IP + 1 : OP, nf: F.length, comps };
    if (nGrad) header.ng = nGrad;
    if (names.length) header.names = names;
    // over: стартовые смещения и цвета элементов ({имя: {x, y, color}}), плеер применяет их при загрузке
    if (opts.over && Object.keys(opts.over).length) header.over = opts.over;
    const body = pack(header), headerBytes = body.length;
    encode(body);
    const raw = Uint8Array.from(body), z = opts.raw ? raw : deflateRaw(raw), bin = new Uint8Array(5 + z.length);
    bin.set([69, 67, 82, 50, opts.raw ? 0 : 1]);   // 'ECR2', флаг: тело сжато
    bin.set(z, 5);
    return { bin, unsupported, stats: { headerBytes, rawBytes: raw.length, floats: F.length } };
  }

  const api = { compileLottie, deflateRaw, KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  G.ECore = Object.assign(G.ECore || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
