#!/usr/bin/env node
/* Headless Chromium (Playwright) check of the bundled game served by the desktop's own local server.

   Runs twice: with the network as-is, and "offline" with every request outside localhost aborted
   (the Steam build must still boot and race solo when Firebase cannot load). Fails on page errors,
   console errors, or any request for three.js / fonts going to the network.

   Needs Playwright (local devDependency or a global install) and `npm run build-app` first.
   Usage: node tests/browser-smoke.mjs [--port 8092] [--online-only | --offline-only]
   SMOKE_DEBUG=1 logs page console / failed requests; SMOKE_CHANNEL picks the Playwright browser channel. */
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const DESKTOP = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { createServer } = require('../src/server.js');
const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? +process.argv[portArg + 1] : 8092;

function loadPlaywright(){
  try { return require('playwright'); } catch (e) {}
  const globalRoot = execSync('npm root -g', {encoding:'utf8'}).trim();
  return createRequire(path.join(globalRoot, 'noop.js'))('playwright');
}

async function run(chromium, base, offline){
  // Fresh browser per run: nothing cached or stored carries over between online and offline
  const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  // Offline: every host except localhost fails DNS, like a machine with no network
  if (offline) args.push('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost');
  // channel 'chromium' = the full Chromium build (new headless mode) rather than chrome-headless-shell
  const browser = await chromium.launch({args, channel:process.env.SMOKE_CHANNEL || 'chromium'});
  try { return await drive(browser, base, offline); } finally { await browser.close(); }
}
async function drive(browser, base, offline){
  const page = await browser.newPage({viewport:{width:1600, height:900}});
  const problems = [], remote = [], warnings = [];
  page.on('crash', () => problems.push('page crashed'));
  if (process.env.SMOKE_DEBUG) {
    browser.on('disconnected', () => console.log('browser disconnected'));
    page.on('console', m => console.log('console', m.type(), m.text()));
    page.on('requestfailed', q => console.log('request failed', q.url()));
  }
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    // In offline mode the blocked Firebase CDN requests log "Failed to load resource"; that is expected
    if (m.type() === 'error' && !(offline && /^Failed to load resource: net::ERR_/.test(m.text()))) problems.push(`console.error: ${m.text()}`);
    if (m.type() === 'warning') warnings.push(m.text());
  });
  page.on('request', q => { if (!q.url().startsWith(base) && !q.url().startsWith('data:')) remote.push(q.url()); });
  await page.goto(base, {waitUntil:'load'});
  const r = await page.evaluate(async () => {
    const faces = ['16px Michroma', '400 16px "IBM Plex Mono"', '500 16px "IBM Plex Mono"', '600 16px "IBM Plex Mono"'];
    return {
      three: window.THREE && window.THREE.REVISION,
      fonts: await Promise.all(faces.map(f => document.fonts.load(f).then(l => l.length > 0, () => false))),
      bridge: !!window.phantomDesktop
    };
  });
  await page.click('#pressStart');
  await page.waitForFunction(() => ['home', 'auth'].includes(document.getElementById('menu').dataset.screen), null, {timeout:15000});
  const afterStart = await page.evaluate(() => document.getElementById('menu').dataset.screen);
  if (afterStart === 'auth') await page.click('#guestBtn');
  await page.click('.tile[data-go="solo"]');
  await page.click('#ride');
  await page.waitForFunction(() => +document.getElementById('spd').textContent > 0 && !document.getElementById('hud').hidden, null, {timeout:20000});
  const race = await page.evaluate(() => ({round:document.getElementById('roundLabel').textContent, speed:+document.getElementById('spd').textContent}));
  await page.close();
  const assetLeaks = remote.filter(u => /three|fonts\.(googleapis|gstatic)|cdnjs/.test(u));
  const ok = r.three === '128' && r.fonts.every(Boolean) && assetLeaks.length === 0 && problems.length === 0;
  return {mode:offline ? 'offline' : 'online', ok, ...r, afterStart, race, problems, warnings, remoteHosts:[...new Set(remote.map(u => new URL(u).host))], assetLeaks};
}

const { chromium } = loadPlaywright();
const server = createServer(path.join(DESKTOP, 'app'));
const { url } = await server.listen([PORT]);
if (!url.includes(`:${PORT}/`)) console.warn(`port ${PORT} busy, using ${url}`);
let failed = false;
setTimeout(() => { console.error('BROWSER SMOKE: TIMEOUT'); process.exit(1); }, 150000).unref();
try {
  const modes = process.argv.includes('--offline-only') ? [true] : process.argv.includes('--online-only') ? [false] : [false, true];
  for (const offline of modes) {
    const res = await run(chromium, url, offline);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) failed = true;
  }
} catch (e) { console.error(e); failed = true; }
await server.close();
console.log(failed ? 'BROWSER SMOKE: FAIL' : 'BROWSER SMOKE: PASS');
process.exit(failed ? 1 : 0);
