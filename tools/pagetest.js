#!/usr/bin/env node
// Проверка страницы eCore в браузере: функции (элементы, цвет, перенос, переключение примеров, ошибки)
// и замер на эмуляции телефона (iPhone 13, процессор ×4): плавность прокрутки и время переключения.
// usage: node tools/pagetest.js <URL> [--gl] [--phone|--desktop]
//   PLAYWRIGHT, CHROME, CHROME_LIBS — как в tools/selftest.js; CHROME_ARGS — свои флаги браузера через пробел
'use strict';
const path = require('path');
const URL_ = process.argv[2], GL = process.argv.includes('--gl'), DESKTOP = process.argv.includes('--desktop');
const CHROME = process.env.CHROME || path.join(process.env.HOME, '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell');
(async () => {
  const pw = require(process.env.PLAYWRIGHT || 'playwright-core');
  const env = Object.assign({}, process.env); if (process.env.CHROME_LIBS) env.LD_LIBRARY_PATH = process.env.CHROME_LIBS;
  const browser = await pw.chromium.launch({ executablePath: CHROME, env, args: process.env.CHROME_ARGS ? ['--no-sandbox', '--disable-dev-shm-usage'].concat(process.env.CHROME_ARGS.split(/\s+/).filter(Boolean)) : ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext(DESKTOP ? { viewport: { width: 1280, height: 900 } } : Object.assign({}, pw.devices['iPhone 13']));
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (!DESKTOP) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
  const url = URL_ + (GL ? (URL_.includes('?') ? '&' : '?') + 'backend=gl' : '');
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#stage canvas') && document.querySelector('#element-list button'), null, { timeout: 60000 }).catch(() => {});
  const loadMs = Date.now() - t0;
  const out = { url, backend: GL ? 'gl' : 'auto', device: DESKTOP ? 'desktop' : 'iPhone 13 ×4 CPU', loadMs, errors: 0 };
  const names = () => page.$$eval('#element-list button', (bs) => bs.map((b) => b.textContent));
  // хэш пикселей сцены: дешевле, чем выгружать холст в строку
  const sig = () => page.$eval('#stage canvas', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 53) h = (h * 31 + d[i]) | 0; return h; });
  const stageDiffer = async (fn) => { const a = await sig(); await fn(); await page.waitForTimeout(150); return a !== await sig(); };

  // функции: элементы, цвет, перенос, переключение примеров
  out.elements = await names().catch(() => []);
  if (out.elements.includes('burst')) {
    await page.$eval('#element-list button[data-name="burst"]', (b) => b.click());
    out.colorInputEnabled = await page.$eval('#element-color', (i) => !i.disabled);
    out.colorChangesFrame = await stageDiffer(() => page.$eval('#element-color', (i) => { i.value = '#00ff00'; i.dispatchEvent(new Event('input', { bubbles: true })); }));
    const box = await page.$eval('#stage', (s) => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    out.moveChangesFrame = await stageDiffer(async () => { await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2); await page.mouse.down(); for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.w / 2 + i * 6, box.y + box.h / 2); await page.mouse.up(); });
    await page.$eval('#element-reset', (b) => b.click());
  }
  const t1 = Date.now();
  await page.$eval('.tabs__tab[data-id="heart"]', (b) => b.click());
  await page.waitForFunction(() => document.querySelector('#element-list button[data-name="shadow"]') || document.querySelector('#element-list button[data-name="heart"]'), null, { timeout: 5000 }).catch(() => {});
  out.switchToHeartMs = Date.now() - t1; out.elementsHeart = await names();
  await page.$eval('.tabs__tab[data-id="nick"]', (b) => b.click()).catch(() => {});

  // плавность: прокрутка по странице, интервалы кадров
  const scroll = await page.evaluate(() => new Promise((resolve) => {
    const gaps = []; let last = 0, y = 0; const end = performance.now() + 4000, step = () => {
      const now = performance.now(); if (last) gaps.push(now - last); last = now;
      y = Math.min(document.documentElement.scrollHeight, y + 6); window.scrollTo(0, y);
      if (now < end && y < document.documentElement.scrollHeight) requestAnimationFrame(step); else resolve(gaps);
    }; requestAnimationFrame(step);
  }));
  scroll.sort((a, b) => a - b);
  const p = (q) => scroll.length ? +scroll[Math.min(scroll.length - 1, Math.floor(scroll.length * q))].toFixed(1) : null;
  out.scrollFrames = scroll.length; out.frameMs = { median: p(0.5), p95: p(0.95), worst: p(1) };
  out.errors = errors.length; if (errors.length) out.firstErrors = errors.slice(0, 3);
  console.log(JSON.stringify(out));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
