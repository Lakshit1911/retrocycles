// node tests/apple.test.mjs
// Apple apps track, pure parts: key bindings, controller stick maths, web app manifest, service worker
// routing rules, Vercel headers and the generated icons. Browser checks: tests/browser/apple.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const REPO = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

// In-memory localStorage for the bindings module
const mem = new Map();
globalThis.localStorage = {getItem:k => (mem.has(k) ? mem.get(k) : null), setItem:(k, v) => mem.set(k, String(v)), removeItem:k => mem.delete(k)};
const B = await import('../js/input/bindings.js');
const G = await import('../js/input/gamepad.js');
const ev = (code, o = {}) => ({code, shiftKey:false, ctrlKey:false, metaKey:false, altKey:false, ...o});

console.log('bindings.js');
await test('defaults are the original controls', () => {
  B.reset();
  const a = c => B.actionOf(ev(c)), s = c => B.actionOf(ev(c, {shiftKey:true}));
  assert.deepEqual(['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD'].map(a), ['left', 'left', 'right', 'right']);
  assert.deepEqual(['Space', 'KeyW', 'ArrowUp'].map(a), ['boost', 'boost', 'boost']);
  assert.deepEqual(['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD'].map(s), ['snapLeft', 'snapLeft', 'snapRight', 'snapRight']);
  assert.equal(a('KeyC'), 'camera'); assert.equal(a('KeyP'), 'pause'); assert.equal(a('Escape'), 'pause'); assert.equal(a('KeyM'), 'mute');
  assert.equal(a('KeyE'), 'burst');
  assert.equal(s('Space'), 'boost', 'Shift + Space still boosts (no combo bound)');
  assert.equal(a('KeyQ'), null);
  assert.equal(B.actionOf(ev('KeyW', {metaKey:true})), null, 'Cmd+W is left to the browser / OS');
  assert.equal(B.isDefault(), true);
  assert.equal(mem.get(B.STORAGE_KEY), undefined);
});
await test('keyup releases held actions, with or without Shift', () => {
  assert.deepEqual([...B.releasedBy('ArrowLeft')], ['left']);
  assert.deepEqual([...B.releasedBy('Space')], ['boost']);
  assert.deepEqual([...B.releasedBy('KeyC')], []);
  B.bind('left', 0, 'Shift+KeyQ');
  assert.ok(B.releasedBy('KeyQ').has('left'));
  B.reset();
});
await test('rebinding boost to J: J boosts, Space is free, saved', () => {
  B.reset();
  assert.ok(B.bind('boost', 0, 'KeyJ'));
  assert.equal(B.actionOf(ev('KeyJ')), 'boost');
  assert.equal(B.actionOf(ev('Space')), null);
  assert.deepEqual(JSON.parse(mem.get(B.STORAGE_KEY)).boost, ['KeyJ', 'KeyW', 'ArrowUp']);
  assert.deepEqual(B.labels('boost'), ['J', 'W', '↑']);
});
await test('a key moves from its old action; clearing; limits; bad input refused', () => {
  B.reset();
  B.bind('camera', 1, 'KeyA');
  assert.equal(B.actionOf(ev('KeyA')), 'camera');
  assert.deepEqual(B.get().left, ['ArrowLeft']);
  B.bind('camera', 1, null);
  assert.deepEqual(B.get().camera, ['KeyC']);
  assert.equal(B.bind('camera', 5, 'KeyZ'), false);
  assert.equal(B.bind('nope', 0, 'KeyZ'), false);
  assert.equal(B.bind('camera', 0, 'not a key!'), false);
  B.bind('pause', 2, 'KeyZ');
  assert.deepEqual(B.get().pause, ['KeyP', 'Escape', 'KeyZ']);
  B.reset();
  assert.ok(B.isDefault());
});
await test('sanitize drops junk from storage', () => {
  const s = B.sanitize({boost:['KeyJ', 42, 'KeyJ', 'Shift+KeyK', '<script>', 'KeyL', 'KeyM'], left:'ArrowLeft', bogus:['KeyX']});
  assert.deepEqual(s.boost, ['KeyJ', 'Shift+KeyK', 'KeyL']);
  assert.deepEqual(s.left, ['ArrowLeft', 'KeyA'], 'non-array keeps the default');
  assert.equal(s.bogus, undefined);
  assert.deepEqual(B.sanitize(null).camera, ['KeyC']);
});
await test('labels', () => {
  assert.equal(B.label('Shift+ArrowLeft'), 'Shift + ←');
  assert.equal(B.label('KeyA'), 'A');
  assert.equal(B.label('Digit7'), '7');
  assert.equal(B.label('Numpad4'), 'Num 4');
  assert.equal(B.label('Escape'), 'Esc');
  assert.equal(B.comboOf(ev('ShiftLeft', {shiftKey:true})), 'ShiftLeft');
  assert.equal(B.comboOf(ev('KeyA', {shiftKey:true})), 'Shift+KeyA');
});

console.log('gamepad.js');
await test('stick: dead zone, full lock, partial duty cycle', () => {
  assert.equal(G.steerFromStick(0.1, 0), 0);
  assert.equal(G.steerFromStick(-0.95, 37), -1);
  assert.equal(G.steerFromStick(1, 99), 1);
  const duty = x => { let on = 0; for (let t = 0; t < 1000; t++) if (G.steerFromStick(x, t)) on++; return on / 1000; };
  assert.equal(duty(0.2), 0);
  assert.ok(Math.abs(duty(0.56) - 0.5) < 0.02, `0.56 -> ${duty(0.56)}`);
  assert.ok(duty(0.4) < duty(0.7));
  assert.equal(duty(-1), 1);
});
await test('controller names', () => {
  assert.equal(G.shortName('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'Xbox Wireless Controller');
  assert.equal(G.shortName('DualSense Wireless Controller (STANDARD GAMEPAD)'), 'DualSense Wireless Controller');
  assert.equal(G.shortName('054c-0ce6-DualSense Wireless Controller'), 'DualSense Wireless Controller');
  assert.equal(G.shortName(''), 'Controller');
});
await test('no pads in Node: poll releases everything and never throws', () => {
  const keys = {l:true, r:false, boost:false, snapQ:[]};
  G.pollGamepad(keys, {playing:() => true, free:() => true, paused:() => false, turn(){}, pause(){}, camera(){}, skip(){}});
  assert.equal(G.inputDebug().pads, 0);
});

console.log('web app');
await test('manifest', () => {
  const m = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'Phantom Run');
  assert.equal(m.display, 'fullscreen');
  assert.equal(m.orientation, 'any');
  assert.equal(m.theme_color, '#040508');
  assert.equal(m.background_color, '#040508');
  assert.ok(m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(REPO, i.src)), i.src);
});
await test('icons are generated and up to date', async () => {
  const I = await import('../tools/icons.mjs');
  for (const t of I.targets()) {
    const f = path.join(REPO, t.file);
    assert.ok(fs.existsSync(f), t.file);
    if (t.file.endsWith('.png')) {
      const img = I.decodePNG(fs.readFileSync(f));
      assert.equal(img.width, t.size, t.file);
    }
  }
  const apple = fs.readFileSync(path.join(REPO, 'icons', 'apple-touch-icon.png'));
  assert.equal(apple[25], 2, 'apple-touch-icon is opaque RGB');
  // round trip of the codec
  const src = {width:2, height:2, data:new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 9, 9, 255])};
  assert.deepEqual([...I.decodePNG(I.encodePNG(src)).data], [...src.data]);
});
await test('index.html: manifest, apple-touch-icon, web-app meta', () => {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /viewport-fit=cover/);
});

// sw.js in a sandbox with a fake ServiceWorkerGlobalScope
const listeners = {};
const sandbox = {self:{location:new URL('https://phantom.example/'), registration:{scope:'https://phantom.example/'}, addEventListener:(t, fn) => { listeners[t] = fn; }, clients:{claim(){}}, skipWaiting(){}},
  URL, Request:class { constructor(u, o = {}){ this.url = u; this.method = o.method || 'GET'; this.mode = o.mode || 'cors'; this.headers = new Map(Object.entries(o.headers || {})); } },
  caches:{}, fetch(){}, console};
vm.runInNewContext(fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8') + '\nself.__bypass = bypass; self.__CACHE = CACHE;', sandbox);
const bypass = (u, o) => sandbox.self.__bypass(new sandbox.Request(u, o), new URL(u));
await test('service worker: Firebase, gstatic, Google APIs and /__/auth are never handled', () => {
  for (const u of ['https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js', 'https://retrocycles-e9965-default-rtdb.firebaseio.com/.lp?x=1',
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword', 'https://securetoken.googleapis.com/v1/token',
    'https://retrocycles-e9965.firebaseapp.com/__/auth/handler', 'https://phantom.example/__/auth/handler', 'https://accounts.google.com/o/oauth2',
    'https://phantom.example/sw.js', 'https://evil.example/x.js']) assert.equal(bypass(u), true, u);
  assert.equal(bypass('https://phantom.example/js/game.js', {method:'POST'}), true);
  assert.equal(bypass('https://phantom.example/a.mp3', {headers:{range:'bytes=0-'}}), true);
});
await test('service worker: the game, three.js and fonts are cached', () => {
  for (const u of ['https://phantom.example/', 'https://phantom.example/js/game.js', 'https://phantom.example/icons/icon-512.png',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'https://fonts.googleapis.com/css2?family=Michroma',
    'https://fonts.gstatic.com/s/michroma/v19/x.woff2']) assert.equal(bypass(u), false, u);
  assert.match(sandbox.self.__CACHE, /^phantom-run-v\d+/);
  for (const t of ['install', 'activate', 'fetch', 'message']) assert.equal(typeof listeners[t], 'function', t);
});
await test('vercel.json: sw.js no-cache + Service-Worker-Allowed, auth rewrite kept', () => {
  const v = JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'));
  assert.ok(v.rewrites.some(r => r.source === '/__/auth/:path*'));
  const sw = v.headers.find(h => h.source === '/sw.js').headers;
  const get = k => (sw.find(h => h.key === k) || {}).value;
  assert.equal(get('Cache-Control'), 'no-cache');
  assert.equal(get('Service-Worker-Allowed'), '/');
});
await test('pwa.js: production only (never localhost without ?sw=1, never in the apps)', () => {
  const src = fs.readFileSync(path.join(REPO, 'js', 'pwa.js'), 'utf8');
  assert.match(src, /!LOCAL \|\| params\.get\('sw'\) === '1'/);
  assert.match(src, /phantomDesktop/);
  assert.match(src, /isNativePlatform/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
