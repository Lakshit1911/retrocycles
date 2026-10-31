// macOS polish: menu template, packaging targets (universal dmg + zip), .icns icon, title bar wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(DESKTOP, '..');
const { menuTemplate, aboutOptions, FULLSCREEN_MAC } = require('../src/menu.js');
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));

const flat = items => items.flatMap(i => [i, ...(Array.isArray(i.submenu) ? flat(i.submenu) : [])]);

test('Windows / Linux: no application menu', () => {
  assert.equal(menuTemplate({platform:'win32'}), null);
  assert.equal(menuTemplate({platform:'linux'}), null);
});

test('macOS app menu: About, Hide, Quit with the standard shortcuts', () => {
  const t = menuTemplate({platform:'darwin', appName:'Phantom Run'});
  assert.equal(t[0].label, 'Phantom Run');
  const app = t[0].submenu.filter(i => i.role);
  assert.deepEqual(app.map(i => i.role), ['about', 'hide', 'hideOthers', 'unhide', 'quit']);
  assert.equal(app[0].label, 'About Phantom Run');
  assert.equal(app.find(i => i.role === 'hide').accelerator, 'Command+H');
  const quit = app.find(i => i.role === 'quit');
  assert.equal(quit.label, 'Quit Phantom Run');
  assert.equal(quit.accelerator, 'Command+Q');
});

test('macOS: Edit, View > Toggle Full Screen (Ctrl+Cmd+F), Window', () => {
  const t = menuTemplate({platform:'darwin'});
  assert.equal(t[1].role, 'editMenu');   // copy / paste in the sign-in fields
  const view = t.find(m => m.label === 'View');
  assert.ok(view);
  const fsItem = view.submenu.find(i => i.role === 'togglefullscreen');
  assert.equal(fsItem.accelerator, 'Control+Command+F');
  assert.equal(FULLSCREEN_MAC, 'Control+Command+F');
  assert.equal(t.at(-1).role, 'windowMenu');
  // Development-only items never ship in a release menu
  assert.ok(!flat(t).some(i => i.role === 'toggleDevTools' || i.role === 'reload'));
  assert.ok(flat(menuTemplate({platform:'darwin', debug:true})).some(i => i.role === 'toggleDevTools'));
});

test('About panel text', () => {
  const a = aboutOptions({appName:'Phantom Run', version:'1.2.3', electron:'45.2.0'});
  assert.equal(a.applicationName, 'Phantom Run');
  assert.equal(a.applicationVersion, '1.2.3');
  assert.match(a.version, /Electron 45/);
});

test('mac packaging: universal dmg + zip (+ dir for Steam), .icns icon, hardened runtime', () => {
  const mac = pkg.build.mac;
  const targets = Object.fromEntries(mac.target.map(t => [t.target, t.arch]));
  assert.deepEqual(targets.dmg, ['universal']);
  assert.deepEqual(targets.zip, ['universal']);
  assert.deepEqual(targets.dir, ['universal']);
  assert.equal(mac.icon, 'build/icon.icns');
  assert.ok(fs.existsSync(path.join(DESKTOP, mac.icon)));
  assert.equal(mac.hardenedRuntime, true);
  assert.ok(fs.existsSync(path.join(DESKTOP, mac.entitlements)));
  // steamworks.js ships one universal macOS binary: lipo must not try to merge it
  assert.match(mac.x64ArchFiles, /steamworks\.js\/dist\/osx/);
  assert.match(pkg.scripts['dist:mac'], /--mac --universal/);
  assert.match(pkg.build.dmg.artifactName, /mac\.\$\{ext\}/);
  assert.match(mac.artifactName, /mac\.\$\{ext\}/);   // zip (and dmg) names
});

test('electron-builder accepts the configuration (schema check)', async () => {
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { DebugLogger } = require('builder-util');
  await validateConfiguration(JSON.parse(JSON.stringify(pkg.build)), new DebugLogger(false));
});

test('icon.icns: every size from 16 to 1024 px, PNG-backed', async () => {
  const { readIcns, ICNS_TYPES } = await import('../../tools/icons.mjs');
  const entries = readIcns(fs.readFileSync(path.join(DESKTOP, 'build', 'icon.icns')));
  assert.deepEqual(entries.map(e => e.type), ICNS_TYPES.map(t => t[0]));
  for (const e of entries) assert.equal(e.width, ICNS_TYPES.find(t => t[0] === e.type)[1], e.type);
  assert.ok(entries.some(e => e.width === 1024));
});

test('main.js uses the hidden-inset title bar on macOS only and the menu module', () => {
  const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  assert.match(main, /MAC \? 'hiddenInset' : 'default'/);
  assert.match(main, /titleBarStyle: TITLE_BAR/);
  assert.match(main, /require\('\.\/src\/menu'\)/);
  assert.match(main, /enter-full-screen/);
  const preload = fs.readFileSync(path.join(DESKTOP, 'preload.js'), 'utf8');
  assert.match(preload, /titlebar-drag/);
  const css = fs.readFileSync(path.join(REPO, 'css', 'style.css'), 'utf8');
  assert.match(css, /\.titlebar-drag\{[^}]*-webkit-app-region:drag/);
  assert.match(css, /html\.mac-titlebar/);
});

test('ProMotion: the frame-rate watchdog only enforces a minimum fps', () => {
  const r = fs.readFileSync(path.join(REPO, 'js', 'visuals', 'renderer.js'), 'utf8');
  assert.match(r, /fps < VC\.autoQuality\.minFps/);
  assert.doesNotMatch(r, /fps > |maxFps/);
  const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  assert.doesNotMatch(main, /disable-frame-rate-limit|setFrameRate/);   // Electron follows the display (120 Hz on ProMotion)
});
