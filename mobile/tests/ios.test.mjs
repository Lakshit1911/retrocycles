// iPhone app: Capacitor config, the shared web bundle, the generated Xcode project and its patches,
// and the native bridge mapping in js/mobile.js. Runs anywhere (no Xcode needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MOBILE = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(MOBILE, '..');
const require = createRequire(path.join(MOBILE, 'package.json'));
const config = JSON.parse(fs.readFileSync(path.join(MOBILE, 'capacitor.config.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(MOBILE, 'package.json'), 'utf8'));
let tmp;

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-ios-')); });
after(() => fs.rmSync(tmp, {recursive:true, force:true}));

test('capacitor.config.json', () => {
  assert.match(config.appId, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);
  assert.equal(config.appId, 'app.phantomrun.game');
  assert.equal(config.appName, 'Phantom Run');
  assert.equal(config.webDir, 'www');
  assert.equal(config.ios.contentInset, 'never');   // the page handles the notch with env(safe-area-inset-*)
  assert.equal(config.ios.scrollEnabled, false);    // no rubber-banding of the whole web view
  assert.equal(config.backgroundColor, '#040508');
  assert.ok(!config.server || !config.server.url, 'ships the bundled game, not a live URL');
});

test('pinned Capacitor versions agree', () => {
  const v = pkg.dependencies['@capacitor/core'];
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.dependencies['@capacitor/ios'], v);
  assert.equal(pkg.devDependencies['@capacitor/cli'], v);
  assert.equal(require('@capacitor/core/package.json').version, v);
  for (const p of ['@capacitor/haptics', '@capacitor-community/keep-awake']) assert.ok(require.resolve(`${p}/package.json`));
  // three.js must match desktop/ and the CDN tag (the bundler checks the revision)
  assert.equal(pkg.devDependencies.three, '0.128.0');
});

test('build-web: the shared bundler makes an offline www/ for iOS', async () => {
  const { buildWeb } = await import('../scripts/build-web.mjs');
  const out = path.join(tmp, 'www');
  const r = await buildWeb({out, quiet:true});
  assert.equal(r.info.target, 'ios');
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /<script src="vendor\/three\/three\.min\.js"><\/script>/);
  assert.match(html, /vendor\/fonts\/fonts\.css/);
  assert.deepEqual([...html.matchAll(/\b(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1]), []);
  for (const f of ['js/mobile.js', 'js/input/gamepad.js', 'js/input/bindings.js', 'js/input/controls.js', 'js/pwa.js', 'icons/icon-512.png']) {
    assert.ok(fs.existsSync(path.join(out, f)), f);
  }
});

test('cap add ios + patch: Info.plist, icon and splash; idempotent; survives cap sync', async () => {
  // A throwaway copy of mobile/ (node_modules linked) so the real folder is untouched
  const app = path.join(tmp, 'app');
  fs.mkdirSync(app);
  for (const f of ['package.json', 'capacitor.config.json']) fs.copyFileSync(path.join(MOBILE, f), path.join(app, f));
  fs.symlinkSync(path.join(MOBILE, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  fs.cpSync(path.join(tmp, 'www'), path.join(app, 'www'), {recursive:true});
  const cap = args => execFileSync(process.execPath, [require.resolve('@capacitor/cli/bin/capacitor'), ...args], {cwd:app, stdio:'pipe', env:{...process.env, CI:'1'}});
  cap(['add', 'ios']);
  const { patchProject, paths, INFO_PLIST } = await import('../scripts/ios.mjs');
  const p = paths(path.join(app, 'ios'));
  assert.deepEqual(patchProject(p.root), ['Info.plist', 'AppIcon', 'Splash']);
  const plist = require('plist');
  const info = plist.parse(fs.readFileSync(p.plist, 'utf8'));
  assert.equal(info.UIStatusBarHidden, true);
  assert.equal(info.UIViewControllerBasedStatusBarAppearance, false);
  assert.equal(info.UIRequiresFullScreen, true);
  assert.equal(info.CADisableMinimumFrameDurationOnPhone, true);
  assert.equal(info.GCSupportsControllerUserInteraction, true);
  assert.deepEqual(info.UISupportedInterfaceOrientations, ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight']);
  assert.equal(info.CFBundleDisplayName, 'Phantom Run');
  assert.ok(info.UIApplicationSceneManifest, 'template keys are kept');
  for (const [k, v] of Object.entries(INFO_PLIST)) assert.deepEqual(info[k], v, k);
  // Icon: 1024 px without alpha (App Store rule); splash replaced
  const { decodePNG } = await import(pathToFileURL(path.join(REPO, 'tools', 'icons.mjs')).href);
  const iconBuf = fs.readFileSync(path.join(p.icon, 'AppIcon-512@2x.png'));
  assert.equal(iconBuf[25], 2, 'colour type 2 = RGB, no alpha');
  assert.equal(decodePNG(iconBuf).width, 1024);
  const splash = decodePNG(fs.readFileSync(path.join(p.splash, 'splash-2732x2732.png')));
  assert.equal(splash.width, 2732);
  assert.deepEqual([...splash.data.slice(0, 3)], [4, 5, 8]);
  // Second run changes nothing in Info.plist; cap sync keeps the patch
  const once = fs.readFileSync(p.plist, 'utf8');
  assert.ok(!patchProject(p.root).includes('Info.plist'));
  cap(['sync', 'ios']);
  assert.equal(fs.readFileSync(p.plist, 'utf8'), once);
  // The plugins are wired into the Swift package
  const spm = fs.readFileSync(path.join(app, 'ios', 'App', 'CapApp-SPM', 'Package.swift'), 'utf8');
  assert.match(spm, /CapacitorHaptics/);
  assert.match(spm, /CapacitorCommunityKeepAwake/);
  assert.ok(fs.existsSync(path.join(app, 'ios', 'App', 'App', 'public', 'js', 'mobile.js')));
});

test('js/mobile.js: haptics mapping, no-op on the web', async () => {
  const m = await import(pathToFileURL(path.join(REPO, 'js', 'mobile.js')).href);
  assert.equal(m.isNativeApp, false);
  assert.deepEqual(m.hapticFor({type:'crash'}), {method:'impact', options:{style:'HEAVY'}});
  assert.deepEqual(m.hapticFor({type:'boost'}), {method:'impact', options:{style:'LIGHT'}});
  assert.deepEqual(m.hapticFor({type:'round-win'}), {method:'notification', options:{type:'SUCCESS'}});
  assert.equal(m.hapticFor({type:'menu'}), null);
  assert.equal(m.hapticFor(null), null);
  // Method names and option values the native Haptics plugin understands
  const swift = fs.readFileSync(require.resolve('@capacitor/haptics/package.json').replace('package.json', 'ios/Sources/HapticsPlugin/HapticsPlugin.swift'), 'utf8');
  for (const h of Object.values(m.HAPTICS)) {
    assert.match(swift, new RegExp(`CAPPluginMethod\\(name: "${h.method}"`));
    const val = h.options.style || h.options.type;
    if (val !== 'HEAVY' && val !== 'SUCCESS') assert.match(swift, new RegExp(`"${val}"`));   // HEAVY / SUCCESS are the defaults
  }
});

test('js/mobile.js: in the app, events call the native plugins and Google sign-in is hidden', async () => {
  const calls = [];
  const plugin = name => new Proxy({}, {get:(_, m) => opts => { calls.push([name, m, opts]); return Promise.resolve(); }});
  const listeners = {};
  const el = (id, extra = {}) => ({id, hidden:false, parentElement:null, insertAdjacentElement(_, n){ this.next = n; }, ...extra});
  const or = el('or');
  const google = el('googleBtn', {parentElement:{querySelector:() => or}});
  const docEls = {googleBtn:google, hud:el('hud', {hidden:true})};
  globalThis.window = {
    Capacitor:{isNativePlatform:() => true, Plugins:{Haptics:plugin('Haptics'), KeepAwake:plugin('KeepAwake')}},
    addEventListener:(t, fn) => { (listeners[t] ||= []).push(fn); },
    document:{documentElement:{dataset:{}}, getElementById:id => docEls[id] || null, createElement:() => ({}), addEventListener(){}}
  };
  globalThis.document = globalThis.window.document;
  try {
    const m = await import(pathToFileURL(path.join(REPO, 'js', 'mobile.js')).href + '?native');
    assert.equal(m.isNativeApp, true);
    assert.equal(window.document.documentElement.dataset.native, 'ios');
    assert.equal(google.hidden, true);
    assert.equal(or.hidden, true);
    assert.ok(google.next && /email and password/.test(google.next.textContent));
    const fire = type => listeners['phantom:event'].forEach(fn => fn({detail:{type}}));
    fire('match-start'); fire('boost'); fire('crash'); fire('round-win'); fire('match-end');
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(calls, [
      ['KeepAwake', 'keepAwake', undefined],
      ['Haptics', 'impact', {style:'LIGHT'}],
      ['Haptics', 'impact', {style:'HEAVY'}],
      ['Haptics', 'notification', {type:'SUCCESS'}],
      ['KeepAwake', 'allowSleep', undefined]
    ]);
  } finally { delete globalThis.window; delete globalThis.document; }
});
