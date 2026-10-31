/* Phantom Run desktop shell (Electron main process).

   - serves the bundled game (desktop/app, built by `npm run build-app`) from http://localhost:<port>
   - one 16:9 window (1600x900 by default) that remembers its size, position and fullscreen state
   - F11 / Alt+Enter toggle fullscreen; no menu bar
   - Google sign-in popups open as child windows; other links open in the system browser
   - optional Steamworks (achievements, rich presence, overlay) through steamworks.js; the game runs
     the same without Steam

   Flags / environment:
     --smoke-test            load the game, drive the title -> solo race flow, print SMOKE_RESULT and exit
     --smoke-test --offline  same, with every request outside the local server blocked
     --no-steam              skip Steam entirely (also PHANTOM_NO_STEAM=1)
     PHANTOM_STEAM_APPID=n   override desktop/steam_appid.txt
     PHANTOM_DEBUG=1         allow DevTools (F12 / Ctrl+Shift+I) in packaged builds */
'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer, portCandidates } = require('./src/server');
const { createSteam, readAppId, restartAppIfNecessary, DEV_APP_ID } = require('./src/steam');
const { readState, fitBounds, trackWindow, MIN } = require('./src/window-state');
const pkg = require('./package.json');

const CFG = pkg.phantomRun || {};
const SMOKE = process.argv.includes('--smoke-test');
const OFFLINE = SMOKE && process.argv.includes('--offline');   // smoke test with every non-local request blocked
const NO_STEAM = process.argv.includes('--no-steam') || process.env.PHANTOM_NO_STEAM === '1';
const DEBUG = !app.isPackaged || process.env.PHANTOM_DEBUG === '1';
const APP_DIR = path.join(__dirname, 'app');
const BG = '#040508';
const log = (...a) => console.log('[phantom]', ...a);

// Hosts allowed to open as sign-in popups (Firebase auth handler + Google account chooser)
const isAuthUrl = url => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'accounts.google.com' || u.hostname.endsWith('.firebaseapp.com'));
  } catch (e) { return false; }
};
const isWebUrl = url => /^https?:\/\//i.test(url);

if (SMOKE) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-smoke-')));

/* ---------- Steam (before 'ready': the overlay needs command-line switches) ---------- */
const { appId, source: appIdSource } = readAppId([__dirname, process.resourcesPath].filter(Boolean));
let steam = createSteam({appId, loader:() => { throw new Error('disabled with --no-steam'); }, log:() => {}});
// Release builds can insist on being launched through Steam (phantomRun.steamRestartIfNecessary):
// if Steam is installed and did not start us, it relaunches the game through Steam and we quit.
const relaunching = !NO_STEAM && !SMOKE && app.isPackaged && !!CFG.steamRestartIfNecessary && appId !== DEV_APP_ID &&
  !process.env.SteamAppId && restartAppIfNecessary(appId);
if (relaunching) app.exit(0);
else if (!NO_STEAM) {
  let achievementIds = null;
  try { achievementIds = require('./achievements.json').achievements.map(a => a.apiName); } catch (e) {}
  steam = createSteam({appId, achievementIds, log:m => log(`steam: ${m}`)});
  log(`steam app id ${appId} (${appIdSource})`);
  if (steam.available && CFG.steamOverlay !== false) steam.enableOverlay();
}

/* ---------- Single instance ---------- */
let win = null, server = null;
if (relaunching) { /* exiting */ }
else if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
else start();

function start(){
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { if (server) server.close(); });
  app.on('web-contents-created', (_, contents) => {
    contents.on('will-attach-webview', e => e.preventDefault());
  });
  app.whenReady().then(ready).catch(e => { console.error(e); app.exit(1); });
}

async function ready(){
  // Google refuses sign-in from user agents that look like embedded browsers; drop the Electron token
  app.userAgentFallback = app.userAgentFallback.replace(/\s(?:Electron|phantom-run-desktop|Phantom Run)\/\S+/gi, '');
  setupMenu();
  setupPermissions();

  if (!fs.existsSync(path.join(APP_DIR, 'index.html'))) {
    console.error(`[phantom] ${APP_DIR}/index.html is missing. Run \`npm run build-app\` first.`);
    app.exit(1); return;
  }
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  const saved = readState(stateFile);
  server = createServer(APP_DIR, {log:m => log(`server: ${m}`)});
  const ports = SMOKE ? [Number(process.env.PHANTOM_PORT) || 0] : portCandidates(saved.port, CFG.preferredPort || 47823);
  const { url } = await server.listen(ports);
  log(`serving ${APP_DIR} at ${url}`);

  setupIpc();
  if (OFFLINE) {
    const { session } = require('electron');
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({cancel:!d.url.startsWith(server.origin + '/') && !d.url.startsWith('devtools:')}));
  }
  win = createWindow(saved, stateFile);
  win.loadURL(url);
  if (SMOKE) runSmoke(win);
}

/* ---------- Window ---------- */
function createWindow(saved, stateFile){
  const bounds = fitBounds(saved, screen.getAllDisplays().map(d => d.workArea));
  const icon = path.join(__dirname, 'build', 'icon.png');
  const w = new BrowserWindow({
    ...bounds,
    minWidth: MIN.width, minHeight: MIN.height,
    show: false,
    backgroundColor: BG,
    title: 'Phantom Run',
    autoHideMenuBar: true,
    fullscreenable: true,
    icon: process.platform === 'linux' && fs.existsSync(icon) ? icon : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,   // an online host keeps simulating while the window is in the background
      spellcheck: false,
      devTools: DEBUG
    }
  });
  if (process.platform !== 'darwin') w.removeMenu();
  w.once('ready-to-show', () => {
    w.show();
    if (saved.maximized) w.maximize();
    if (saved.fullscreen) w.setFullScreen(true);
  });
  if (!SMOKE) trackWindow(w, stateFile, () => ({port:server.port}));

  const wc = w.webContents;
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11' || (input.key === 'Enter' && input.alt)) { e.preventDefault(); w.setFullScreen(!w.isFullScreen()); }
    else if (DEBUG && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) { e.preventDefault(); wc.toggleDevTools(); }
    else if (DEBUG && input.control && input.key.toLowerCase() === 'r') { e.preventDefault(); wc.reload(); }
  });
  // The page itself may only navigate within the local server or into the sign-in redirect flow
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith(server.origin + '/') || isAuthUrl(url)) return;
    e.preventDefault();
    if (isWebUrl(url)) shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({url}) => {
    if (isAuthUrl(url)) {
      return {action:'allow', overrideBrowserWindowOptions:{
        width:520, height:720, parent:w, modal:false, show:true, autoHideMenuBar:true,
        backgroundColor:'#ffffff', title:'Sign in', fullscreenable:false,
        webPreferences:{preload:undefined, contextIsolation:true, nodeIntegration:false, sandbox:true, devTools:DEBUG}
      }};
    }
    if (isWebUrl(url)) shell.openExternal(url);
    return {action:'deny'};
  });
  wc.on('did-create-window', child => {
    child.removeMenu();
    // The popup must not open further windows; links that leave the sign-in flow go to the browser
    child.webContents.setWindowOpenHandler(({url}) => { if (isWebUrl(url) && !isAuthUrl(url)) shell.openExternal(url); return {action:'deny'}; });
  });
  wc.on('render-process-gone', (_, d) => log(`renderer gone: ${d.reason}`));
  wc.on('did-fail-load', (_, code, desc, url, isMain) => { if (isMain) log(`load failed ${code} ${desc} ${url}`); });
  w.on('page-title-updated', e => e.preventDefault());
  return w;
}

function setupMenu(){
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  // macOS needs a menu for Cmd+Q and copy/paste in the sign-in fields; it lives in the system menu bar
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {role:'appMenu'},
    {role:'editMenu'},
    {label:'View', submenu:[{role:'togglefullscreen'}, ...(DEBUG ? [{role:'reload'}, {role:'toggleDevTools'}] : [])]},
    {role:'windowMenu'}
  ]));
}

function setupPermissions(){
  const { session } = require('electron');
  const DENY = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'display-capture', 'mediaKeySystem',
    'openExternal', 'idle-detection', 'window-management', 'hid', 'serial', 'usb', 'bluetooth', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((_, permission, cb) => cb(!DENY.has(permission)));
}

/* ---------- Bridge for the preload script ---------- */
function setupIpc(){
  // Only the game page (served from our origin) may use the bridge, never the sign-in popups
  const fromGame = e => {
    try { return !!e.senderFrame && new URL(e.senderFrame.url).origin === server.origin; } catch (err) { return false; }
  };
  ipcMain.on('desktop:info', e => {
    e.returnValue = fromGame(e) ? {
      steamAvailable: steam.available, appId: steam.available ? steam.appId : null,
      version: app.getVersion(), platform: process.platform, webUrl: CFG.webUrl || ''
    } : null;
  });
  const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => (fromGame(e) ? fn(...args) : null));
  handle('steam:achievement', id => steam.unlockAchievement(id));
  handle('steam:rich-presence', (key, value) => steam.setRichPresence(key, value));
  handle('steam:persona', () => steam.getPersonaName());
  handle('steam:overlay', target => steam.activateOverlay(target));
  handle('app:fullscreen', on => { if (win) win.setFullScreen(on === undefined ? !win.isFullScreen() : !!on); return win ? win.isFullScreen() : false; });
  handle('app:is-fullscreen', () => (win ? win.isFullScreen() : false));
  handle('app:quit', () => { setTimeout(() => app.quit(), 0); return true; });
  handle('app:open-external', url => { if (typeof url === 'string' && /^https:\/\//i.test(url)) { shell.openExternal(url); return true; } return false; });
}

/* ---------- Smoke test (CI / headless): node-free check that the bundle boots in Electron ---------- */
function runSmoke(w){
  const consoleLines = [];
  const levels = ['verbose', 'info', 'warning', 'error'];
  w.webContents.on('console-message', (...a) => {
    // Electron >= 35 passes one details object; older versions pass (event, level, message, line, source)
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : {level:levels[a[1]] || a[1], message:a[2], sourceId:a[4], lineNumber:a[3]};
    consoleLines.push({level:typeof d.level === 'number' ? levels[d.level] : d.level, message:String(d.message), source:`${d.sourceId || ''}:${d.lineNumber || ''}`});
  });
  const finish = (result) => {
    result.console = consoleLines;
    result.ok = !!result.ok && !consoleLines.some(l => l.level === 'error' && !/gstatic|firebase|ERR_|net::/i.test(l.message));
    process.stdout.write(`SMOKE_RESULT ${JSON.stringify(result)}\n`);
    app.exit(result.ok ? 0 : 1);
  };
  setTimeout(() => finish({ok:false, error:'timeout'}), 60000).unref();
  w.webContents.once('did-finish-load', async () => {
    try {
      const r = await w.webContents.executeJavaScript(`(${smokeScript.toString()})()`, true);
      finish({...r, offline:OFFLINE, fullscreenable:w.isFullScreenable(), bounds:w.getBounds(), menuBarVisible:w.isMenuBarVisible()});
    } catch (e) { finish({ok:false, error:String(e && e.message || e)}); }
  });
}
// Runs inside the page
async function smokeScript(){
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(100); } return false; };
  const $ = id => document.getElementById(id);
  const out = {origin:location.origin, title:document.title};
  out.three = window.THREE ? window.THREE.REVISION : null;
  out.bridge = window.phantomDesktop ? {isDesktop:window.phantomDesktop.isDesktop, steam:window.phantomDesktop.steam.available} : null;
  // Force-load every face the game uses; load() resolves to [] when no @font-face matches
  const faces = ['16px Michroma', '400 16px "IBM Plex Mono"', '500 16px "IBM Plex Mono"', '600 16px "IBM Plex Mono"'];
  const loaded = await Promise.all(faces.map(f => document.fonts.load(f).then(l => l.length > 0, () => false)));
  out.fonts = {michroma:loaded[0], plex:loaded.slice(1).every(Boolean),
    loaded:[...document.fonts].filter(f => f.status === 'loaded').map(f => `${f.family} ${f.weight}`)};
  out.remoteScripts = [...document.scripts].map(s => s.src).filter(s => s && !s.startsWith(location.origin));
  out.platformAttr = document.documentElement.dataset.platform || null;
  out.canvas = !!document.querySelector('#stage canvas');
  await until(() => !$('pressStart').hidden, 3000);
  $('pressStart').click();
  await until(() => ['home', 'auth'].includes($('menu').dataset.screen), 12000);
  out.afterStart = $('menu').dataset.screen;
  if (out.afterStart === 'auth') { $('guestBtn').click(); await until(() => $('menu').dataset.screen === 'home', 3000); }
  document.querySelector('.tile[data-go="solo"]').click();
  await until(() => $('menu').dataset.screen === 'solo', 3000);
  $('ride').click();
  out.racing = await until(() => !$('hud').hidden && $('menu').hidden, 5000);
  await until(() => +$('spd').textContent > 0, 15000);   // countdown, then the race runs
  out.round = $('roundLabel').textContent;
  out.speed = +$('spd').textContent;
  out.ok = out.three === '128' && out.fonts.michroma && out.fonts.plex && out.remoteScripts.length === 0 && out.canvas && out.racing && out.speed > 0;
  return out;
}
