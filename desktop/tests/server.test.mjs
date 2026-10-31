// Local static server: MIME types, path traversal, Host check, port fallback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createServer, portCandidates, resolveFile } = require('../src/server.js');
const PORT = 8092;
let root, srv, base;

// Raw request so we can send any Host header / path
function get(p, {method = 'GET', host} = {}){
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port:srv.port, path:p, method, headers:{Host:host || `localhost:${srv.port}`}}, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', c => body += c); res.on('end', () => resolve({status:res.statusCode, headers:res.headers, body}));
    });
    req.on('error', reject); req.end();
  });
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-srv-'));
  fs.mkdirSync(path.join(root, 'site', 'js'), {recursive:true});
  fs.mkdirSync(path.join(root, 'site', 'fonts'));
  fs.writeFileSync(path.join(root, 'site', 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(root, 'site', 'js', 'a.js'), 'export const a = 1;');
  fs.writeFileSync(path.join(root, 'site', 'fonts', 'f.woff2'), 'x');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'nope');
  srv = createServer(path.join(root, 'site'));
  const r = await srv.listen([PORT]);
  base = r.url;
});
after(async () => { await srv.close(); fs.rmSync(root, {recursive:true, force:true}); });

test('serves on http://localhost:<port>/', () => {
  assert.equal(base, `http://localhost:${PORT}/`);
  assert.equal(srv.origin, `http://localhost:${PORT}`);
});

test('index and MIME types', async () => {
  const idx = await get('/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers['content-type'], /^text\/html/);
  const q = await get('/?join=ABCDE');
  assert.equal(q.status, 200);
  const js = await get('/js/a.js');
  assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.equal(js.headers['x-content-type-options'], 'nosniff');
  const font = await get('/fonts/f.woff2');
  assert.equal(font.headers['content-type'], 'font/woff2');
  const head = await get('/js/a.js', {method:'HEAD'});
  assert.equal(head.status, 200); assert.equal(head.body, '');
});

test('directories redirect to a trailing slash, missing files 404', async () => {
  const d = await get('/js');
  assert.equal(d.status, 301); assert.equal(d.headers.location, '/js/');
  assert.equal((await get('/nope.js')).status, 404);
});

test('cannot escape the root', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/js/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/%00', '/%E0%A4%A']) {
    const r = await get(p);
    assert.notEqual(r.status, 200, p);
    assert.doesNotMatch(r.body, /nope/, p);
  }
  assert.equal(resolveFile('/srv/app', '/../etc/passwd'), '/srv/app/etc/passwd');   // clamped inside root
  assert.equal(resolveFile('/srv/app', '/a/b/'), '/srv/app/a/b/index.html');
});

test('rejects foreign Host headers (DNS rebinding) and non-GET methods', async () => {
  assert.equal((await get('/', {host:'evil.example:' + PORT})).status, 421);
  assert.equal((await get('/', {host:'localhost:1'})).status, 421);
  assert.equal((await get('/', {host:`127.0.0.1:${PORT}`})).status, 200);
  assert.equal((await get('/', {method:'POST'})).status, 405);
});

test('falls back to the next port when the remembered one is busy', async () => {
  // A port that is free right now (neighbours of 8092 may be in use by other test servers)
  const free = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const other = createServer(path.join(root, 'site'));
  try {
    const r = await other.listen([PORT, free]);   // PORT is held by `srv`
    assert.equal(r.port, free);
  } finally { await other.close(); }
  assert.deepEqual(portCandidates(50000, 47823, 3), [50000, 47823, 47824, 47825]);
  assert.deepEqual(portCandidates(undefined, 47823, 2), [47823, 47824]);
});
