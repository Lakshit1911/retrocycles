/* Preload (sandboxed, contextIsolation on, nodeIntegration off).

   Exposes window.phantomDesktop to the game page only. The main process answers 'desktop:info' with
   null for any frame that is not served from the local game origin (for example the Google sign-in
   popup), and then nothing is exposed.

   window.phantomDesktop = {
     isDesktop: true, version, platform, webUrl,
     steam: {
       available,                       // true when Steam is running and initialised for this app
       appId,                           // number or null
       unlockAchievement(id),           // -> Promise<boolean>
       setRichPresence(key, value),     // -> Promise<boolean>; empty value clears the key
       getPersonaName(),                // -> Promise<string|null>
       activateOverlay(target)          // 'friends' | 'community' | 'players' | 'settings' | 'officialgamegroup'
                                        // | 'stats' | 'achievements' | 'https://...' -> Promise<boolean>
     },
     setFullscreen(on), toggleFullscreen(), isFullscreen(),   // -> Promise<boolean> (new state)
     openExternal(httpsUrl),            // open a link in the system browser
     quit()                             // close the game (for a Quit button on desktop)
   } */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

let info = null;
try { info = ipcRenderer.sendSync('desktop:info'); } catch (e) { info = null; }

if (info) {
  const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch(() => null);
  const str = (v, max) => (v === undefined || v === null ? '' : String(v)).slice(0, max);
  contextBridge.exposeInMainWorld('phantomDesktop', {
    isDesktop: true,
    version: info.version,
    platform: info.platform,
    webUrl: info.webUrl,
    steam: {
      available: !!info.steamAvailable,
      appId: info.appId,
      unlockAchievement: id => call('steam:achievement', str(id, 128)).then(Boolean),
      setRichPresence: (key, value) => call('steam:rich-presence', str(key, 64), str(value, 256)).then(Boolean),
      getPersonaName: () => call('steam:persona'),
      activateOverlay: (target = 'friends') => call('steam:overlay', str(target, 2048)).then(Boolean)
    },
    setFullscreen: on => call('app:fullscreen', !!on).then(Boolean),
    toggleFullscreen: () => call('app:fullscreen').then(Boolean),
    isFullscreen: () => call('app:is-fullscreen').then(Boolean),
    openExternal: url => call('app:open-external', str(url, 2048)).then(Boolean),
    quit: () => call('app:quit')
  });
}
