#!/usr/bin/env node
/* Browser checks for the Apple apps track (Playwright + Chromium, software WebGL):
     pwa       manifest + icons served, service worker installs, the game reloads and races solo with the
               server stopped, Firebase / gstatic never cached
     gamepad   fake navigator.getGamepads(): connect toast, menu navigation (d-pad / A / B), steering
               (full + partial stick), boost (A / RT), snap (LB / RB), burst (X), camera (View), pause
               (Start) with pause-menu navigation, grid-mode flicks, rumble on crash, disconnect toast
     keys      defaults unchanged (arrows / A D / Shift snap / Space W Up / C / P / E), rebinding boost
               to KeyJ through the Controls screen, persistence, reset
     shots     screenshots at 390x844, 844x390 and 1440x900 (+ the macOS title-bar strip)

   Usage: node tests/browser/apple.mjs [pwa|gamepad|keys|shots ...] [--out <screenshot dir>]
   Needs Playwright (global install is fine: NODE_PATH=$(npm root -g)) and three@0.128.0 in desktop/ or
   mobile/node_modules. Serves the repo itself on a random localhost port. Exit code 1 on any failure. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const { createServer } = require('../../desktop/src/server.js');
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const OUT = outArg >= 0 ? path.resolve(argv[outArg + 1]) : null;
const SUITES = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
const want = s => !SUITES.length || SUITES.includes(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadPlaywright(){
  try { return require('playwright'); } catch (e) {}
  return createRequire(path.join(execSync('npm root -g', {encoding:'utf8'}).trim(), 'noop.js'))('playwright');
}
const THREE = ['desktop', 'mobile'].map(d => path.join(REPO, d, 'node_modules', 'three', 'build', 'three.min.js')).find(f => fs.existsSync(f));
if (!THREE) { console.error('three.min.js not found: run npm ci in desktop/ or mobile/'); process.exit(1); }
const threeJs = fs.readFileSync(THREE, 'utf8');

let failures = 0;
const results = [];
function check(name, ok, detail = ''){
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  console.log(results.at(-1));
  if (!ok) failures++;
}

const { chromium } = loadPlaywright();
const ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];

// Static server for the repo (the desktop shell's own server: loopback only, Host checked)
async function serve(){
  const srv = createServer(REPO);
  const { url } = await srv.listen([0]);
  return {srv, base:url};
}

// Page with: low quality, three.js from node_modules, Firebase unreachable (solo / guest flow)
async function openPage(browser, base, {viewport = {width:1280, height:800}, mobile = false, init = null, query = '', errors = [], firebaseStub = false} = {}){
  const ctx = await browser.newContext({viewport, isMobile:mobile, hasTouch:mobile, deviceScaleFactor:1});
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('pr-quality')) localStorage.setItem('pr-quality', 'low'); } catch (e) {} });
  if (init) await ctx.addInitScript(init);
  await ctx.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('/three.min.js') && !u.startsWith(base)) return r.fulfill({body:threeJs, contentType:'text/javascript'});
    if (u.startsWith(base) || u.startsWith('data:')) return r.continue();
    // A reachable (but empty) Firebase SDK: proves the service worker leaves it alone even when it loads
    if (firebaseStub && u.startsWith('https://www.gstatic.com/firebasejs/')) return r.fulfill({body:'export {};', contentType:'text/javascript', headers:{'access-control-allow-origin':'*'}});
    return r.abort();   // Firebase, Google Fonts: offline
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`pageerror ${e.message}`));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource: net::ERR_(FAILED|INTERNET_DISCONNECTED|CONNECTION_REFUSED)/.test(t)) errors.push(`console.error ${t}`);
  });
  await page.goto(base + query);
  return {ctx, page};
}
const dbg = page => page.evaluate(async () => (await import('/js/game.js')).Game.debug());
const inputDbg = page => page.evaluate(async () => (await import('/js/input/gamepad.js')).inputDebug());
const screenOf = page => page.evaluate(() => document.getElementById('menu').dataset.screen);
async function until(fn, ms = 20000, step = 100){ const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(step); } return false; }
async function toSolo(page){
  await until(() => page.evaluate(() => !document.getElementById('pressStart').hidden), 5000);
  await page.click('#pressStart');
  await until(async () => ['home', 'auth'].includes(await screenOf(page)), 15000);
  if (await screenOf(page) === 'auth') await page.click('#guestBtn');
  await page.click('.tile[data-go="solo"]');
  await until(async () => await screenOf(page) === 'solo', 3000);
}
async function race(page){
  await page.click('#ride');
  return until(async () => (await dbg(page)).state === 'run', 90000, 250);
}

/* ---------------- PWA ---------------- */
async function pwa(browser){
  const errors = [];
  const { srv, base } = await serve();
  // Manifest, icons and headers as served
  const man = await (await fetch(base + 'manifest.webmanifest')).json();
  check('manifest: name, display fullscreen, orientation any, theme', man.name === 'Phantom Run' && man.display === 'fullscreen' && man.orientation === 'any' && man.theme_color === '#040508');
  let iconsOk = true;
  for (const i of man.icons) { const r = await fetch(new URL(i.src, base)); iconsOk = iconsOk && r.ok && r.headers.get('content-type') === 'image/png'; }
  check('manifest icons served', iconsOk, man.icons.map(i => i.sizes + (i.purpose === 'maskable' ? ' maskable' : '')).join(', '));

  const { ctx, page } = await openPage(browser, base, {query:'?sw=1', errors, firebaseStub:true});
  const sdkRequests = [];
  page.on('request', q => { if (q.url().includes('gstatic.com/firebasejs')) sdkRequests.push(q.url()); });
  const html = await page.evaluate(() => ({manifest:document.querySelector('link[rel=manifest]')?.href, touch:document.querySelector('link[rel=apple-touch-icon]')?.href,
    capable:document.querySelector('meta[name=apple-mobile-web-app-capable]')?.content}));
  check('index.html links manifest + apple-touch-icon + apple-mobile-web-app-capable', !!html.manifest && !!html.touch && html.capable === 'yes');
  const ready = await until(() => page.evaluate(() => document.documentElement.dataset.offline === 'ready'), 30000, 250);
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const names = await caches.keys(), keys = [];
    for (const n of names) for (const r of await (await caches.open(n)).keys()) keys.push(r.url);
    return {active:!!(reg && reg.active), scope:reg && reg.scope, controlled:!!navigator.serviceWorker.controller, names, keys};
  });
  check('service worker installed and caching (?sw=1 on localhost)', ready && sw.active && sw.names.some(n => /^phantom-run-v/.test(n)), `${sw.keys.length} cached, caches ${sw.names.join(',')}`);
  const has = p => sw.keys.some(k => k.endsWith(p));
  check('app shell + module graph cached', has('/') && has('/js/game.js') && has('/js/ui.js') && has('/js/input/gamepad.js') && has('/js/visuals/renderer.js') && has('/css/style.css') && sw.keys.some(k => k.includes('three.min.js')));
  // (js/firebase.js is the game's own module and may be cached; the Firebase SDK and APIs it loads may not)
  const foreign = sw.keys.filter(k => !k.startsWith(base));
  check('Firebase / gstatic / auth never cached', !foreign.some(k => /gstatic\.com\/(?!s\/)|firebase|googleapis\.com\/(?!css)/.test(k)) && !sw.keys.some(k => k.includes('/__/')),
    `cross-origin cached: ${foreign.join(' ')}; Firebase SDK requests seen: ${sdkRequests.length}`);

  // Reload (now controlled) then go fully offline: stop the server and block every network request
  await page.reload();
  await until(() => page.evaluate(() => !!navigator.serviceWorker.controller), 10000);
  await srv.close();
  await ctx.setOffline(true);
  await page.reload();
  const booted = await until(() => page.evaluate(() => !!window.THREE && !!document.querySelector('#stage canvas') && !document.getElementById('pressStart').hidden), 20000, 250);
  check('offline reload: page, three.js and the game boot from the cache', booted);
  if (booted) {
    await toSolo(page);
    const raced = await race(page);
    check('offline: a solo race runs', raced, raced ? `speed ${await page.textContent('#spd')}` : `screen ${await screenOf(page)} ${JSON.stringify(await dbg(page).catch(e => String(e))).slice(0, 200)}`);
  }
  check('pwa: no console errors', !errors.length, errors.slice(0, 5).join(' | '));
  if (OUT) await page.screenshot({path:path.join(OUT, 'pwa-offline-race.png')});
  await ctx.close();
}

/* ---------------- Gamepad ---------------- */
// Standard-mapping pad the page reads through navigator.getGamepads()
function fakePad(){
  const mk = () => ({pressed:false, touched:false, value:0});
  window.__rumbles = [];
  window.__padOn = false;
  window.__pad = {id:'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index:0, connected:true, mapping:'standard', timestamp:0,
    buttons:Array.from({length:17}, mk), axes:[0, 0, 0, 0],
    vibrationActuator:{type:'dual-rumble', playEffect:(type, o) => { window.__rumbles.push([type, o]); return Promise.resolve('complete'); }}};
  navigator.getGamepads = () => (window.__padOn ? [window.__pad, null, null, null] : [null, null, null, null]);
  window.__btn = (i, v) => { const b = window.__pad.buttons[i]; b.value = v; b.pressed = v > 0.5; window.__pad.timestamp++; };
  window.__axis = (i, v) => { window.__pad.axes[i] = v; window.__pad.timestamp++; };
}
async function gamepad(browser){
  const errors = [];
  const { srv, base } = await serve();
  const { ctx, page } = await openPage(browser, base, {init:fakePad, errors});
  const tap = async (i, ms = 120) => { await page.evaluate(i => window.__btn(i, 1), i); await sleep(ms); await page.evaluate(i => window.__btn(i, 0), i); await sleep(ms); };
  const axis = (i, v) => page.evaluate(([i, v]) => window.__axis(i, v), [i, v]);
  const focused = () => page.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.dataset.go || a.dataset.s || a.textContent.trim().slice(0, 12)) : ''; });
  const P = {A:0, B:1, X:2, Y:3, LB:4, RB:5, LT:6, RT:7, SELECT:8, START:9, UP:12, DOWN:13, LEFT:14, RIGHT:15};

  await until(() => page.evaluate(() => !document.getElementById('pressStart').hidden), 5000);
  await page.evaluate(() => { window.__padOn = true; });
  const toast = await until(() => page.evaluate(() => /Controller connected/.test(document.getElementById('toast').textContent) && !document.getElementById('toast').hidden), 3000);
  const toastText = await page.textContent('#toast');
  check('pad: "controller connected" toast', toast && /· Xbox Wireless Controller$/.test(toastText), toastText);

  // Title: A presses start; Firebase is offline here, so the game goes to Home (guest)
  await tap(P.A);
  await until(async () => ['home', 'auth'].includes(await screenOf(page)), 15000);
  if (await screenOf(page) === 'auth') { await tap(P.DOWN); for (let i = 0; i < 12 && await focused() !== 'guestBtn'; i++) await tap(P.DOWN); await tap(P.A); }
  check('pad: A on the title screen starts', await screenOf(page) === 'home', await screenOf(page));
  await tap(P.RIGHT); const f1 = await focused();
  await tap(P.RIGHT); const f2 = await focused();
  await tap(P.LEFT); const f3 = await focused();
  check('pad: d-pad moves focus between Home tiles', !!f1 && f1 !== f2 && f3 === f1, `${f1} -> ${f2} -> ${f3}`);
  const ring = await page.evaluate(() => document.documentElement.classList.contains('pad-nav') && getComputedStyle(document.activeElement).outlineStyle !== 'none');
  check('pad: focus ring visible in controller mode', ring);
  // Stick down then A on SOLO
  await page.evaluate(() => document.querySelector('.tile[data-go="solo"]').focus());
  await tap(P.A);
  check('pad: A opens Solo', await until(async () => await screenOf(page) === 'solo', 3000));
  await tap(P.B);
  check('pad: B goes back to Home', await until(async () => await screenOf(page) === 'home', 3000));
  await tap(P.A);   // focus is gone with the old screen: A acts on the main button (SOLO)
  await until(async () => await screenOf(page) === 'solo', 3000);
  // Volume slider follows left / right when focused
  await page.evaluate(() => document.getElementById('volume').focus());
  const v0 = +(await page.inputValue('#volume'));
  await tap(P.RIGHT);
  const v1 = +(await page.inputValue('#volume'));
  check('pad: left / right adjust a focused slider', v1 === Math.min(100, v0 + 5), `${v0} -> ${v1}`);
  // Down from the slider until RIDE, then A
  for (let i = 0; i < 12 && await focused() !== 'ride'; i++) await tap(P.DOWN);
  check('pad: d-pad reaches RIDE', await focused() === 'ride');
  await tap(P.A);
  const running = await until(async () => (await dbg(page)).state === 'run', 90000, 250);
  check('pad: A on RIDE starts a race', running);

  // Steering (free mode)
  await axis(0, -1); await sleep(150);
  const full = await inputDbg(page);
  await axis(0, 0); await sleep(120);
  const center = await inputDbg(page);
  check('pad: full left stick holds keys.l, centre releases', full.keys.l && !full.keys.r && !center.keys.l && full.context === 'race');
  // Partial stick: count frames with keys.r held (software WebGL runs few frames, so a long window)
  await axis(0, 0.55);
  const dutyRes = await page.evaluate(async () => {
    const { inputDebug } = await import('/js/input/gamepad.js');
    let on = 0, n = 0; const t0 = performance.now();
    await new Promise(res => { const f = () => { n++; if (inputDebug().keys.r) on++; if (performance.now() - t0 < 2500) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    return {on, n};
  });
  await axis(0, 0);
  const duty = dutyRes.on / dutyRes.n;
  check('pad: partial stick steers part of the time (analog-ish)', dutyRes.on > 0 && dutyRes.on < dutyRes.n, `held ${dutyRes.on}/${dutyRes.n} frames (${duty.toFixed(2)}) at 0.55`);
  await page.evaluate(() => window.__btn(7, 0.9)); await sleep(150);
  const rt = await inputDbg(page);
  await page.evaluate(() => window.__btn(7, 0)); await sleep(150);
  await page.evaluate(() => window.__btn(0, 1)); await sleep(150);
  const a = await inputDbg(page);
  await page.evaluate(() => window.__btn(0, 0)); await sleep(150);
  check('pad: RT and A boost', rt.keys.boost && a.keys.boost && !(await inputDbg(page)).keys.boost);
  await page.evaluate(() => window.__btn(2, 1)); await sleep(150);
  const x = await inputDbg(page);
  await page.evaluate(() => window.__btn(2, 0)); await sleep(150);
  check('pad: X sets keys.burst', x.keys.burst && !(await inputDbg(page)).keys.burst);
  // Snap turns: LB / RB turn the heading by about 90 degrees
  const me = d => d.bikes[0];
  let d0 = await dbg(page);
  if (me(d0).alive) {
    await tap(P.LB, 60); await sleep(700);
    const d1 = await dbg(page);
    const dh = Math.atan2(Math.sin(me(d1).h - me(d0).h), Math.cos(me(d1).h - me(d0).h));
    check('pad: LB snaps 90 degrees', !me(d1).alive || Math.abs(Math.abs(dh) - Math.PI / 2) < 0.5, `dh ${dh.toFixed(2)} rad`);
  } else check('pad: LB snaps 90 degrees', true, 'skipped: rider already out');
  const cam0 = await page.textContent('#camLabel');
  await tap(P.SELECT);
  check('pad: View / Select cycles the camera', (await page.textContent('#camLabel')) !== cam0, `${cam0} -> ${await page.textContent('#camLabel')}`);
  // Pause with Start, move in the pause menu, B resumes
  await tap(P.START);
  const paused = await page.evaluate(() => !document.getElementById('pausebox').hidden);
  await tap(P.DOWN); const pf = await focused();
  await tap(P.B);
  const resumed = await page.evaluate(() => document.getElementById('pausebox').hidden);
  check('pad: Start opens the pause menu, d-pad moves, B resumes', paused && resumed && ['quitBtn', 'resumeBtn'].includes(pf), pf);
  await tap(P.START); await tap(P.START);
  check('pad: Start toggles pause', await page.evaluate(() => document.getElementById('pausebox').hidden));
  // Rumble on crash
  await page.evaluate(() => dispatchEvent(new CustomEvent('phantom:event', {detail:{type:'crash'}})));
  const rumble = await page.evaluate(() => window.__rumbles);
  check('pad: crash rumbles (vibrationActuator)', rumble.length === 1 && rumble[0][0] === 'dual-rumble' && rumble[0][1].strongMagnitude === 1);
  if (OUT) await page.screenshot({path:path.join(OUT, 'pad-race-1280.png')});

  // Grid mode: quit with Start -> Quit, switch steering, flick the stick
  await tap(P.START);
  await page.click('#quitBtn');
  await until(async () => await screenOf(page) === 'solo', 5000);
  await page.click('#steerSeg button[data-s="grid"]');
  await page.click('#ride');
  await until(async () => (await dbg(page)).state === 'run', 90000, 250);
  d0 = await dbg(page);
  await axis(0, 1); await sleep(200); await axis(0, 0); await sleep(500);
  let d1 = await dbg(page);
  const turned = !me(d1).alive || me(d1).dir !== me(d0).dir;
  check('pad (grid): a stick flick turns once', turned, `dir ${me(d0).dir} -> ${me(d1).dir}`);
  d0 = await dbg(page);
  await axis(0, 1); await sleep(600); await axis(0, 0); await sleep(300);
  d1 = await dbg(page);
  check('pad (grid): holding the stick does not keep turning', !me(d1).alive || ((me(d1).dir - me(d0).dir + 4) % 4) <= 1, `dir ${me(d0).dir} -> ${me(d1).dir}`);
  await tap(P.START); await page.click('#quitBtn');
  await until(async () => await screenOf(page) === 'solo', 5000);
  await page.click('#steerSeg button[data-s="free"]');

  await page.evaluate(() => { window.__padOn = false; });
  check('pad: "controller disconnected" toast', await until(() => page.evaluate(() => /disconnected/.test(document.getElementById('toast').textContent)), 3000));
  check('gamepad: no console errors', !errors.length, errors.slice(0, 5).join(' | '));
  await ctx.close(); await srv.close();
}

/* ---------------- Keyboard bindings ---------------- */
async function keys(browser){
  const errors = [];
  const { srv, base } = await serve();
  // 1. Defaults are today's keys
  let { ctx, page } = await openPage(browser, base, {errors});
  await toSolo(page);
  const hints = await page.evaluate(() => [...document.querySelectorAll('.keys [data-keys]')].map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  check('keys: default hints', hints[0] === '← → / A D' && hints[1] === 'Shift + ← →' && hints[2] === 'Space / W / ↑' && hints[3] === 'C', hints.join(' | '));
  await race(page);
  const k = async (code, opts = {}) => { await page.keyboard.down(code); await sleep(opts.hold || 120); const s = await inputDbg(page); await page.keyboard.up(code); await sleep(80); return s; };
  const left = await k('ArrowLeft'), a = await k('KeyA'), right = await k('KeyD');
  const sp = await k('Space'), w = await k('KeyW'), up = await k('ArrowUp'), e = await k('KeyE');
  check('keys default: ←/A steer left, D right', left.keys.l && a.keys.l && right.keys.r && !(await inputDbg(page)).keys.l);
  check('keys default: Space / W / ↑ boost, E burst', sp.keys.boost && w.keys.boost && up.keys.boost && e.keys.burst && !(await inputDbg(page)).keys.boost);
  const me = d => d.bikes[0];
  let d0 = await dbg(page);
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  await sleep(700);
  let d1 = await dbg(page);
  const dh = Math.atan2(Math.sin(me(d1).h - me(d0).h), Math.cos(me(d1).h - me(d0).h));
  check('keys default: Shift + → snaps 90 degrees (no steer hold)', !me(d1).alive || Math.abs(Math.abs(dh) - Math.PI / 2) < 0.5, `dh ${dh.toFixed(2)}`);
  const cam0 = await page.textContent('#camLabel');
  await page.keyboard.press('KeyC');
  const cam1 = await page.textContent('#camLabel');
  await page.keyboard.press('KeyP');
  const p1 = await page.evaluate(() => !document.getElementById('pausebox').hidden);
  await page.keyboard.press('Escape');
  const p2 = await page.evaluate(() => document.getElementById('pausebox').hidden);
  check('keys default: C camera, P opens / Esc closes the menu', cam1 !== cam0 && p1 && p2);
  await ctx.close();

  // 2. Rebind boost (slot 1: Space) to J through the Controls screen
  ({ ctx, page } = await openPage(browser, base, {errors}));
  await toSolo(page);
  await page.click('#controlsBtn');
  const open = await page.isVisible('#controlsBox');
  await page.click('.ctl-key[data-a="boost"][data-i="0"]');
  const listening = await page.textContent('.ctl-key[data-a="boost"][data-i="0"]');
  await page.keyboard.press('KeyJ');
  const slot = await page.textContent('.ctl-key[data-a="boost"][data-i="0"]');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pr-keys') || 'null'));
  check('keys: Controls screen rebinds boost to J', open && /Press a key/.test(listening) && slot === 'J' && stored && stored.boost.join() === 'KeyJ,KeyW,ArrowUp', `${slot} ${stored && stored.boost}`);
  if (OUT) await page.screenshot({path:path.join(OUT, 'controls-1280.png')});
  // J taken from another action moves; Delete clears; Esc cancels a capture
  await page.click('.ctl-key[data-a="camera"][data-i="1"]');
  await page.keyboard.press('KeyW');
  const moved = await page.evaluate(async () => (await import('/js/input/bindings.js')).get());
  check('keys: a key used elsewhere moves to the new action', moved.camera.includes('KeyW') && !moved.boost.includes('KeyW'), `camera ${moved.camera} boost ${moved.boost}`);
  await page.click('.ctl-key[data-a="camera"][data-i="1"]'); await page.keyboard.press('Delete');
  const cleared = await page.evaluate(async () => (await import('/js/input/bindings.js')).get().camera);
  check('keys: Delete clears a slot', cleared.join() === 'KeyC', cleared.join());
  await page.keyboard.press('Escape');
  check('keys: Esc closes the Controls screen', await page.evaluate(() => document.getElementById('controlsBox').hidden));
  const boostHint = await page.evaluate(() => document.querySelector('.keys [data-keys="boost"]').textContent.replace(/\s+/g, ' ').trim());
  check('keys: hints follow the new binding', boostHint === 'J / ↑', boostHint);
  await race(page);
  await sleep(1000);
  const spd0 = +(await page.textContent('#spd'));
  await page.keyboard.down('KeyJ');
  await sleep(150);
  const j = await inputDbg(page);
  let peak = spd0;
  for (let i = 0; i < 10; i++) { await sleep(100); peak = Math.max(peak, +(await page.textContent('#spd'))); }
  await page.keyboard.up('KeyJ'); await sleep(100);
  const afterJ = await inputDbg(page);
  await page.keyboard.down('Space'); await sleep(150);
  const space = await inputDbg(page);
  await page.keyboard.up('Space');
  const alive = (await dbg(page)).bikes[0].alive;
  check('keys: J boosts (keys.boost + speed up), Space no longer does', j.keys.boost && !afterJ.keys.boost && !space.keys.boost && (!alive || peak > spd0), `speed ${spd0} -> ${peak}`);
  await ctx.close();

  // 3. Persisted across reloads; Reset restores the defaults
  ({ ctx, page } = await openPage(browser, base, {errors, init:() => localStorage.setItem('pr-keys', JSON.stringify({boost:['KeyJ', 'KeyW', 'ArrowUp'], left:['ArrowLeft', 'KeyA'], bogus:['x'], right:[42, 'KeyD']}))}));
  await toSolo(page);
  const loaded = await page.evaluate(async () => (await import('/js/input/bindings.js')).get());
  check('keys: saved bindings load (and bad entries are dropped)', loaded.boost[0] === 'KeyJ' && loaded.right.join() === 'KeyD' && !loaded.bogus);
  await page.click('#controlsBtn');
  await page.click('#controlsReset');
  const reset = await page.evaluate(async () => { const b = await import('/js/input/bindings.js'); return {def:b.isDefault(), stored:localStorage.getItem('pr-keys')}; });
  check('keys: Reset restores the defaults and clears storage', reset.def && reset.stored === null);
  if (OUT) await page.setViewportSize({width:390, height:844});
  if (OUT) await page.screenshot({path:path.join(OUT, 'controls-390.png')});
  check('keys: no console errors', !errors.length, errors.slice(0, 5).join(' | '));
  await ctx.close(); await srv.close();
}

/* ---------------- Screenshots ---------------- */
async function shots(browser){
  if (!OUT) { console.log('shots: pass --out <dir>'); return; }
  const errors = [];
  const { srv, base } = await serve();
  for (const [name, viewport, mobile] of [['390x844', {width:390, height:844}, true], ['844x390', {width:844, height:390}, true], ['1440x900', {width:1440, height:900}, false]]) {
    const { ctx, page } = await openPage(browser, base, {viewport, mobile, errors});
    await sleep(2500);
    await page.screenshot({path:path.join(OUT, `${name}-1-title.png`)});
    await toSolo(page);
    await page.screenshot({path:path.join(OUT, `${name}-2-solo.png`)});
    await page.evaluate(() => { document.getElementById('menu').scrollTop = 1e5; });
    await page.screenshot({path:path.join(OUT, `${name}-3-solo-bottom.png`)});
    await race(page);
    await sleep(1200);
    await page.screenshot({path:path.join(OUT, `${name}-4-race.png`)});
    const layout = await page.evaluate(() => {
      const r = id => { const e = document.getElementById(id); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return {x:Math.round(b.x), y:Math.round(b.y), w:Math.round(b.width), h:Math.round(b.height)}; };
      return {w:innerWidth, h:innerHeight, tL:r('tL'), tB:r('tB'), tR:r('tR'), radar:r('radar'), menuBtn:r('menuBtn'), scrollW:document.documentElement.scrollWidth};
    });
    const inside = b => !b || (b.x >= 0 && b.y >= 0 && b.x + b.w <= layout.w && b.y + b.h <= layout.h);
    check(`layout ${name}: HUD + discs inside the viewport, no horizontal scroll`, [layout.tL, layout.tB, layout.tR, layout.radar, layout.menuBtn].every(inside) && layout.scrollW <= layout.w && (!mobile || !!layout.tL), JSON.stringify({tL:layout.tL, tR:layout.tR}));
    if (mobile) {
      // Hit area of a disc reaches past its edge (::after inset)
      const hit = await page.evaluate(() => { const b = document.getElementById('tL').getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top - 8); return !!e && e.id === 'tL'; });
      check(`layout ${name}: disc hit area extends past the disc`, hit);
    }
    await page.click('#menuBtn');
    await page.screenshot({path:path.join(OUT, `${name}-5-pause.png`)});
    await ctx.close();
  }
  // macOS desktop app look: the title-bar strip the preload adds, HUD below it
  const { ctx, page } = await openPage(browser, base, {viewport:{width:1440, height:900}, errors});
  await page.evaluate(() => { document.documentElement.classList.add('mac-titlebar'); const s = document.createElement('div'); s.className = 'titlebar-drag'; document.body.appendChild(s); });
  await toSolo(page);
  await page.screenshot({path:path.join(OUT, 'mac-titlebar-solo.png')});
  await race(page); await sleep(800);
  const strip = await page.evaluate(() => { const s = document.querySelector('.titlebar-drag').getBoundingClientRect(), m = document.getElementById('menuBtn').getBoundingClientRect(); return {strip:s.height, region:getComputedStyle(document.querySelector('.titlebar-drag')).webkitAppRegion || getComputedStyle(document.querySelector('.titlebar-drag')).getPropertyValue('-webkit-app-region'), btnTop:m.top}; });
  check('mac title bar: drag strip on top, HUD buttons below it', strip.strip === 30 && strip.btnTop >= 30, JSON.stringify(strip));
  await page.screenshot({path:path.join(OUT, 'mac-titlebar-race.png')});
  await ctx.close();
  check('shots: no console errors', !errors.length, errors.slice(0, 5).join(' | '));
  await srv.close();
}

if (OUT) fs.mkdirSync(OUT, {recursive:true});
const browser = await chromium.launch({args:ARGS});
try {
  for (const [name, fn] of [['pwa', pwa], ['gamepad', gamepad], ['keys', keys], ['shots', shots]]) {
    if (!want(name)) continue;
    const t = Date.now();
    try { await fn(browser); } catch (e) { check(`${name} crashed`, false, e.stack || String(e)); }
    console.log(`-- ${name} ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
} finally { await browser.close(); }
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
