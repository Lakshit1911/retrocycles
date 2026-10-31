/* Remembers the window size, position, maximized and fullscreen state between launches
   (userData/window-state.json), plus the local server port so the page origin stays the same. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {width:1600, height:900, maximized:false, fullscreen:false};
const MIN = {width:960, height:540};

function readState(file){
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch (e) { return {}; }
}
function writeState(file, state){
  try {
    fs.mkdirSync(path.dirname(file), {recursive:true});
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {}
}

const num = v => (Number.isFinite(v) ? Math.round(v) : undefined);

/** Pure: picks bounds from saved state that fit on one of `workAreas` ([{x,y,width,height}]).
    Falls back to the 1600x900 default (shrunk to fit, keeping 16:9) centred on the first work area. */
function fitBounds(saved, workAreas){
  const areas = workAreas && workAreas.length ? workAreas : [{x:0, y:0, width:1920, height:1080}];
  let width = num(saved.width) || DEFAULTS.width, height = num(saved.height) || DEFAULTS.height;
  const x = num(saved.x), y = num(saved.y);
  if (x !== undefined && y !== undefined) {
    // Keep the saved position only if the window's title bar area is visible on some display
    const hit = areas.find(a => x + 64 > a.x && x + 64 < a.x + a.width && y >= a.y - 8 && y + 32 < a.y + a.height);
    if (hit) return {x, y, width:Math.max(MIN.width, Math.min(width, hit.width)), height:Math.max(MIN.height, Math.min(height, hit.height))};
  }
  const a = areas[0];
  if (width > a.width || height > a.height) {
    const k = Math.min(a.width / width, a.height / height) * 0.92;
    width = Math.round(width * k); height = Math.round(height * k);
  }
  width = Math.max(MIN.width, width); height = Math.max(MIN.height, height);
  return {x:Math.round(a.x + (a.width - width) / 2), y:Math.round(a.y + (a.height - height) / 2), width, height};
}

/** Saves the window's state (debounced) as it changes; `extra()` adds fields such as the port. */
function trackWindow(win, file, extra = () => ({})){
  let timer = null;
  const snapshot = () => {
    if (win.isDestroyed()) return null;
    const normal = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    return {...readState(file), ...normal, maximized:win.isMaximized(), fullscreen:win.isFullScreen(), ...extra()};
  };
  const save = () => { clearTimeout(timer); const s = snapshot(); if (s) writeState(file, s); };
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, later);
  win.on('close', save);
  return save;
}

module.exports = { DEFAULTS, MIN, readState, writeState, fitBounds, trackWindow };
