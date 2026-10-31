/* Application menu templates (pure data, so tests can check them without Electron).

   macOS: the standard app menu in the system menu bar:
     Phantom Run  About Phantom Run · Hide ⌘H · Hide Others ⌥⌘H · Show All · Quit Phantom Run ⌘Q
     Edit         undo / cut / copy / paste / select all (needed in the sign-in fields)
     View         Toggle Full Screen ⌃⌘F (+ Reload / DevTools in development)
     Window       Minimize ⌘M · Zoom · Bring All to Front
   Windows / Linux: no menu bar at all (F11 / Alt+Enter handle fullscreen in main.js). */
'use strict';

const FULLSCREEN_MAC = 'Control+Command+F';

/** @returns {Array|null} an Electron MenuItem template, or null for "no application menu" */
function menuTemplate({platform = process.platform, appName = 'Phantom Run', debug = false} = {}){
  if (platform !== 'darwin') return null;
  return [
    {label:appName, submenu:[
      {role:'about', label:`About ${appName}`},
      {type:'separator'},
      {role:'hide', label:`Hide ${appName}`, accelerator:'Command+H'},
      {role:'hideOthers', accelerator:'Command+Alt+H'},
      {role:'unhide'},
      {type:'separator'},
      {role:'quit', label:`Quit ${appName}`, accelerator:'Command+Q'}
    ]},
    {role:'editMenu'},
    {label:'View', submenu:[
      {role:'togglefullscreen', label:'Toggle Full Screen', accelerator:FULLSCREEN_MAC},
      ...(debug ? [{type:'separator'}, {role:'reload'}, {role:'toggleDevTools'}] : [])
    ]},
    {role:'windowMenu'}
  ];
}

/** Text for the macOS About panel (app.setAboutPanelOptions). */
function aboutOptions({appName = 'Phantom Run', version = '0.0.0', electron = ''} = {}){
  return {
    applicationName: appName,
    applicationVersion: version,
    version: electron ? `Electron ${electron}` : '',
    copyright: 'Copyright (c) Phantom Run',
    credits: 'An anti-gravity night race. three.js (MIT) · Michroma and IBM Plex Mono (SIL OFL 1.1)'
  };
}

module.exports = { menuTemplate, aboutOptions, FULLSCREEN_MAC };
