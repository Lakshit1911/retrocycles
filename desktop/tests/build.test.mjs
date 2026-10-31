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
  for (const f of ['index.html', 'css/style.css', 'js/ui.js', 'js/game.js', 'js/platform.js', 'js/vendor/three-r128/EffectComposer.js']) {
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

test('platform bridge is loaded before the UI module', () => {
  const p = html.indexOf('src="js/platform.js"'), ui = html.indexOf('src="js/ui.js"');
  assert.ok(p > 0 && p < ui);
});

test('only Firebase stays online', () => {
  const info = JSON.parse(fs.readFileSync(path.join(out, 'build-info.json'), 'utf8'));
  assert.equal(info.three, '0.128.0');
  for (const h of info.remoteHosts) assert.match(h, /(^|\.)gstatic\.com$|firebaseio\.com$|firebaseapp\.com$|googleapis\.com$/, h);
});
