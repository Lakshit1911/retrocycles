/* Tiny static file server for the bundled game (desktop/app).

   The window loads http://localhost:<port>/ instead of file:// because Firebase sign-in only works
   from an authorized domain, and `localhost` is authorized by default in every Firebase project.
   The origin (and with it localStorage, IndexedDB and the Firebase sign-in session) depends on the
   port, so we try a fixed, remembered port first and only fall back to other ports when it is busy.

   Only loopback addresses are bound (127.0.0.1 and, when the OS has IPv6, ::1 on the same port, since
   Chromium may resolve `localhost` to either). Requests must name localhost in the Host header,
   which blocks DNS-rebinding pages from reading the bundle. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
};
const mimeOf = file => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

/** Maps a URL path to a file inside root, or null if it escapes root or is malformed. */
function resolveFile(root, urlPath){
  let p;
  try { p = decodeURIComponent(urlPath); } catch (e) { return null; }
  if (p.includes('\0')) return null;
  if (p.endsWith('/')) p += 'index.html';
  const file = path.resolve(root, '.' + path.posix.normalize('/' + p.replace(/\\/g, '/')));
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

function createServer(rootDir, opts = {}){
  const root = path.resolve(rootDir);
  const log = opts.log || (() => {});
  let port = 0;
  const hostOk = host => host === `localhost:${port}` || host === `127.0.0.1:${port}` || host === `[::1]:${port}`;

  const handler = (req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, {'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-store', ...headers});
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (!hostOk(String(req.headers.host || '').toLowerCase())) return send(421, 'Misdirected request');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed', {Allow:'GET, HEAD'});
    let url;
    try { url = new URL(req.url, `http://localhost:${port}`); } catch (e) { return send(400, 'Bad request'); }
    const file = resolveFile(root, url.pathname);
    if (!file) return send(404, 'Not found');
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) {
        // /dir -> /dir/ so relative URLs inside index.html resolve correctly
        return send(301, 'Moved', {Location:url.pathname.replace(/\/?$/, '/') + url.search});
      }
      if (err || !st.isFile()) return send(404, 'Not found');
      res.writeHead(200, {
        'Content-Type': mimeOf(file),
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', e => { log('read failed', file, e.message); res.destroy(e); });
      stream.pipe(res);
    });
  };

  const servers = [];
  function bind(host, p){
    return new Promise((resolve, reject) => {
      const s = http.createServer(handler);
      s.keepAliveTimeout = 5000;
      s.once('error', reject);
      s.listen({host, port:p, exclusive:true}, () => { s.off('error', reject); resolve(s); });
    });
  }
  async function closeAll(){
    await Promise.all(servers.splice(0).map(s => new Promise(r => { s.closeAllConnections && s.closeAllConnections(); s.close(() => r()); })));
  }
  // Binds 127.0.0.1:p and, if the machine has IPv6 loopback, [::1]:p. A port counts as taken if
  // either address is in use (otherwise `localhost` could reach some other program on ::1).
  async function tryPort(p){
    const v4 = await bind('127.0.0.1', p);
    servers.push(v4);
    const actual = v4.address().port;
    try { servers.push(await bind('::1', actual)); }
    catch (e) {
      if (e.code === 'EADDRINUSE') { await closeAll(); throw e; }
      log(`IPv6 loopback unavailable (${e.code}), serving on 127.0.0.1 only`);
    }
    return actual;
  }

  return {
    /** Listens on the first free port of `ports` (then any free port). Resolves to {port, url}. */
    async listen(ports = []){
      // 0 = any free port; tried a few times in case that port is taken on ::1
      const candidates = [...new Set(ports.filter(p => Number.isInteger(p) && p > 0 && p < 65536)), 0, 0, 0];
      let lastErr;
      for (const p of candidates) {
        try { port = await tryPort(p); return {port, url:`http://localhost:${port}/`}; }
        catch (e) { lastErr = e; if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') break; }
      }
      throw lastErr || new Error('No free port');
    },
    get port(){ return port; },
    get origin(){ return `http://localhost:${port}`; },
    close: closeAll
  };
}

/** Ports to try: the one remembered from last launch, then a small fixed range. */
function portCandidates(remembered, preferred = 47823, span = 16){
  const list = [];
  if (Number.isInteger(remembered)) list.push(remembered);
  for (let i = 0; i < span; i++) list.push(preferred + i);
  return [...new Set(list)];
}

module.exports = { createServer, portCandidates, resolveFile, mimeOf };
