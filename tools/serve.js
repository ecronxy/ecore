#!/usr/bin/env node
// Локальный сервер для просмотра: отдаёт dist/ со сжатием (brotli/gzip) и ETag.
// usage: node tools/serve.js [порт=8080]      HOST=0.0.0.0, чтобы слушать снаружи (по умолчанию только 127.0.0.1)
// В проде то же самое делает nginx; файлам .ecr с хешем в имени ставить Cache-Control: public, max-age=31536000, immutable.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const root = path.join(__dirname, '..', 'dist');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8', '.json': 'application/json', '.ttf': 'font/ttf', '.ecr': 'application/octet-stream', '.tgs': 'application/octet-stream', '.png': 'image/png' };
function serve(port) {
  const host = process.env.HOST || '127.0.0.1', cache = new Map();
  if (!fs.existsSync(path.join(root, 'index.html'))) { console.error('нет dist/: сначала node tools/build-site.js'); process.exit(1); }
  return http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]); if (rel.endsWith('/')) rel += 'index.html';
    const f = path.join(root, path.normalize(rel));
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; return res.end('not found'); }
    const st = fs.statSync(f), etag = `"${st.size}-${st.mtimeMs | 0}"`;
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
    const ae = req.headers['accept-encoding'] || '', enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : '', key = f + etag + enc;
    if (!cache.has(key)) { const raw = fs.readFileSync(f); cache.set(key, enc === 'br' ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } }) : enc === 'gzip' ? zlib.gzipSync(raw, { level: 9 }) : raw); }
    const body = cache.get(key), h = { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream', 'Content-Length': body.length, ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (enc) h['Content-Encoding'] = enc;
    res.writeHead(200, h); res.end(body);
  }).listen(port, host, () => console.log(`http://${host}:${port}/`));
}
if (require.main === module) serve(+(process.argv[2] || 8080));
module.exports = serve;
