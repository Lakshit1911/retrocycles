// The offline bundle: local three.js and fonts, no remote <script>/<link>, platform bridge injected.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let out, html;

before(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-build-'));
  execFileSync(process.execPath, [path.join(DESKTOP, 'scripts', 'build-app.mjs'), '--out', out, '--quiet'], {stdio:'pipe'});
  html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
});
after(() => fs.rmSync(out, {recursive:true, force:true}));

test('copies the site', () => {
  for (const f of ['index.html', 'css/style.css', 'js/ui.js', 'js/game.js', 'js/platform.js', 'js/vendor/three-r128/EffectComposer.js',
    'js/input/gamepad.js', 'js/input/bindings.js', 'manifest.webmanifest', 'icons/icon-192.png']) {
    assert.ok(fs.existsSync(path.join(out, f)), `${f} missing`);
  }
});

test('three.js r128 is vendored and referenced locally', () => {
  assert.match(html, /<script src="vendor\/three\/three\.min\.js"><\/script>/);
  assert.doesNotMatch(html, /cdnjs|three\.min\.js"[^>]*https?:/);
  const three = fs.readFileSync(path.join(out, 'vendor/three/three.min.js'), 'utf8');
  assert.match(three, /REVISION\s*=\s*"128"|"128"/);
  assert.ok(fs.existsSync(path.join(out, 'vendor/three/LICENSE')));
  // core must load before the add-ons that extend THREE
  assert.ok(html.indexOf('vendor/three/three.min.js') < html.indexOf('js/vendor/three-r128/CopyShader.js'));
});

test('fonts are vendored and the Google Fonts links are gone', () => {
  assert.match(html, /<link rel="stylesheet" href="vendor\/fonts\/fonts\.css">/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  const css = fs.readFileSync(path.join(out, 'vendor/fonts/fonts.css'), 'utf8');
  for (const [family, weight] of [['Michroma', 400], ['IBM Plex Mono', 400], ['IBM Plex Mono', 500], ['IBM Plex Mono', 600]]) {
    assert.match(css, new RegExp(`font-family: '${family}';[^}]*font-weight: ${weight};`), `${family} ${weight}`);
  }
  const urls = [...css.matchAll(/url\(\.\/files\/([^)]+)\)/g)].map(m => m[1]);
  assert.ok(urls.length >= 8);
  for (const u of urls) assert.ok(fs.existsSync(path.join(out, 'vendor/fonts/files', u)), `${u} missing`);
  assert.ok(fs.existsSync(path.join(out, 'vendor/fonts/LICENSE-michroma.txt')));
  assert.ok(fs.existsSync(path.join(out, 'vendor/fonts/LICENSE-ibm-plex-mono.txt')));
});

test('index.html loads nothing from the network', () => {
  const remote = [...html.matchAll(/\b(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(remote, []);
});

test('platform bridge is loaded before the UI module (or imported by it)', () => {
  const p = html.indexOf('src="js/platform.js"'), ui = html.indexOf('src="js/ui.js"');
  const imported = /from ['"]\.\/platform\.js['"]/.test(fs.readFileSync(path.join(out, 'js', 'ui.js'), 'utf8'));
  assert.ok(imported || (p > 0 && p < ui));
});

test('only Firebase stays online', () => {
  const info = JSON.parse(fs.readFileSync(path.join(out, 'build-info.json'), 'utf8'));
  assert.equal(info.three, '0.128.0');
  assert.equal(info.target, 'desktop');
  for (const h of info.remoteHosts) assert.match(h, /(^|\.)gstatic\.com$|firebaseio\.com$|firebaseapp\.com$|googleapis\.com$/, h);
});

test('the desktop wrapper and the shared bundler agree', async () => {
  const shared = await import('../../tools/web-bundle.mjs');
  const { buildApp } = await import('../scripts/build-app.mjs');
  assert.equal(typeof buildApp, 'function');
  assert.deepEqual(shared.TARGETS, ['desktop', 'ios']);
  assert.deepEqual(shared.parseFamilies('https://fonts.googleapis.com/css2?family=Michroma&amp;family=IBM+Plex+Mono:wght@400;500;600&amp;display=swap'),
    [{family:'Michroma', weights:['400']}, {family:'IBM Plex Mono', weights:['400', '500', '600']}]);
  assert.deepEqual(shared.remoteResources('<script src="https://x.test/a.js"></script><link rel="stylesheet" href="css/a.css">'), ['https://x.test/a.js']);
});

test('shared bundler: iOS target, refuses dangerous outputs and unknown targets', async () => {
  const { buildBundle, BuildError, REPO } = await import('../../tools/web-bundle.mjs');
  const iosOut = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-ios-'));
  try {
    const r = await buildBundle({out:iosOut, deps:DESKTOP, target:'ios', quiet:true});
    assert.equal(r.info.target, 'ios');
    const ih = fs.readFileSync(path.join(iosOut, 'index.html'), 'utf8');
    assert.match(ih, /vendor\/three\/three\.min\.js/);
    assert.ok(fs.existsSync(path.join(iosOut, 'js', 'mobile.js')));
  } finally { fs.rmSync(iosOut, {recursive:true, force:true}); }
  await assert.rejects(buildBundle({out:REPO, deps:DESKTOP, quiet:true}), BuildError);
  await assert.rejects(buildBundle({out:path.join(os.tmpdir(), 'phantom-x'), deps:DESKTOP, target:'android', quiet:true}), /Unknown target/);
  const noDeps = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-nodeps-'));
  try { await assert.rejects(buildBundle({out:path.join(noDeps, 'out'), deps:noDeps, quiet:true}), /npm package "three" is missing/); }
  finally { fs.rmSync(noDeps, {recursive:true, force:true}); }
});
