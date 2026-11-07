// Medicine catalogue: a small local server for Özlem's medicine catalogue.
// No dependencies. Listens on 127.0.0.1 only. Run: node server.js [port]
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = Number(process.argv[2] || process.env.PORT || 5180);
const HOST = '127.0.0.1';
const ROOT = __dirname;

// ---- data -------------------------------------------------------------------
// data/catalogue.json = { index, items: { id: detail } }, built by tools/build_catalogue.py
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalogue.json'), 'utf8'));
const byId = new Map(Object.entries(data.items));
const indexJson = JSON.stringify(data.index);
const indexGz = zlib.gzipSync(indexJson);

// ---- static files: a fixed allowlist, so no path ever comes from the request ---
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const staticCache = new Map();
function readStatic(name) {
  // Re-read on every request while developing is cheap; files are tiny.
  if (process.env.NODE_ENV === 'production' && staticCache.has(name)) return staticCache.get(name);
  const buf = fs.readFileSync(path.join(ROOT, 'public', name));
  staticCache.set(name, buf);
  return buf;
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'X-Frame-Options': 'DENY',
};

function send(req, res, status, body, type, extra = {}) {
  const headers = { ...SECURITY_HEADERS, 'Content-Type': type, ...extra };
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (!headers['Content-Encoding'] && buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = buf.length;
  headers.Vary = 'Accept-Encoding';
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const json = (req, res, status, obj, extra) => send(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);

const server = http.createServer((req, res) => {
  try {
    // Reject anything that isn't a plain read, and requests for another host name
    // (DNS-rebinding protection: only localhost names are accepted).
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return json(req, res, 421, { error: 'unknown host' });

    const url = new URL(req.url, `http://${HOST}`);
    const p = url.pathname;

    if (p === '/api/index') {
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        return send(req, res, 200, indexGz, 'application/json; charset=utf-8', { 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' });
      }
      return send(req, res, 200, indexJson, 'application/json; charset=utf-8', { 'Cache-Control': 'no-cache' });
    }
    const m = /^\/api\/item\/([a-z0-9_\-]{1,120})$/.exec(p);
    if (m) {
      const med = byId.get(m[1]);
      if (!med) return json(req, res, 404, { error: 'not found' });
      return json(req, res, 200, med, { 'Cache-Control': 'no-cache' });
    }
    const file = STATIC[p];
    if (file) return send(req, res, 200, readStatic(file[0]), file[1], { 'Cache-Control': 'no-cache' });
    return json(req, res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    return json(req, res, 500, { error: 'server error' });
  }
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.listen(PORT, HOST, () => {
  console.log(`Medicine catalogue: ${data.index.ings.length} ingredients, ${data.index.uk.length} archive pages`);
  console.log(`Listening on http://${HOST}:${PORT}/`);
});
