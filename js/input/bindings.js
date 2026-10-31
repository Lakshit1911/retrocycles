/* Keyboard bindings: which keys drive which action, remappable and stored per device.

   A binding is a KeyboardEvent.code ('ArrowLeft', 'KeyA', 'Space') or a Shift combo ('Shift+ArrowLeft').
   Combos win over plain keys while Shift is held, so the defaults keep today's controls exactly:
   hold arrows / A D to steer, Shift + arrow snaps 90°, Space / W / Up boosts, C camera, P / Esc menu,
   M sound. Every action keeps up to SLOTS keys. Pure module: no DOM access at import time. */

export const STORAGE_KEY = 'pr-keys';
export const SLOTS = 3;
export const ACTIONS = [
  {id:'left',      label:'Steer left',  hint:'hold (Grid: turn 90°)'},
  {id:'right',     label:'Steer right', hint:'hold (Grid: turn 90°)'},
  {id:'snapLeft',  label:'Snap left',   hint:'90° turn'},
  {id:'snapRight', label:'Snap right',  hint:'90° turn'},
  {id:'boost',     label:'Boost',       hint:'hold'},
  {id:'burst',     label:'Burst',       hint:'Circuit mode'},
  {id:'camera',    label:'Camera',      hint:'chase / cockpit / overview'},
  {id:'pause',     label:'Menu / pause', hint:''},
  {id:'mute',      label:'Sound on / off', hint:''}
];
export const DEFAULTS = Object.freeze({
  left:      ['ArrowLeft', 'KeyA'],
  right:     ['ArrowRight', 'KeyD'],
  snapLeft:  ['Shift+ArrowLeft', 'Shift+KeyA'],
  snapRight: ['Shift+ArrowRight', 'Shift+KeyD'],
  boost:     ['Space', 'KeyW', 'ArrowUp'],
  burst:     ['KeyE'],
  camera:    ['KeyC'],
  pause:     ['KeyP', 'Escape'],
  mute:      ['KeyM']
});
// Actions that are held (released on keyup); the rest fire once per press
export const HELD = new Set(['left', 'right', 'boost', 'burst']);
const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
const VALID = /^(Shift\+)?[A-Za-z][A-Za-z0-9]{0,31}$/;

const clone = b => Object.fromEntries(ACTIONS.map(a => [a.id, [...(b[a.id] || [])]]));
let current = clone(DEFAULTS);
let index = new Map();   // binding -> action
const listeners = new Set();

function reindex(){
  index = new Map();
  for (const a of ACTIONS) for (const k of current[a.id]) if (!index.has(k)) index.set(k, a.id);
}
/** Cleans untrusted input (localStorage) into a full bindings map; unknown actions and bad codes are dropped. */
export function sanitize(raw){
  const out = clone(DEFAULTS);
  if (!raw || typeof raw !== 'object') return out;
  const seen = new Set();
  for (const a of ACTIONS) {
    if (!Array.isArray(raw[a.id])) continue;
    out[a.id] = raw[a.id].filter(k => typeof k === 'string' && VALID.test(k) && !seen.has(k) && seen.add(k)).slice(0, SLOTS);
  }
  return out;
}
function storage(){ try { return globalThis.localStorage || null; } catch (e) { return null; } }
export function load(){
  let raw = null;
  try { const s = storage(); raw = s && JSON.parse(s.getItem(STORAGE_KEY) || 'null'); } catch (e) { raw = null; }
  current = sanitize(raw); reindex();
  return get();
}
function persist(){
  try {
    const s = storage(); if (!s) return;
    if (isDefault()) s.removeItem(STORAGE_KEY); else s.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch (e) {}
}
const changed = () => { reindex(); persist(); listeners.forEach(fn => { try { fn(get()); } catch (e) {} }); };

export const get = () => clone(current);
export const isDefault = () => ACTIONS.every(a => current[a.id].join() === DEFAULTS[a.id].join());
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };

/** The binding string for a key event: 'Shift+KeyA' while Shift is held (unless the key is Shift itself). */
export function comboOf(e){
  if (!e || !e.code) return '';
  return e.shiftKey && !MODIFIERS.has(e.code) ? `Shift+${e.code}` : e.code;
}
/** Action for a keydown: the Shift combo if one is bound, else the plain key. Ctrl / Alt / Cmd combos are left to the browser. */
export function actionOf(e){
  if (!e || !e.code || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.shiftKey && !MODIFIERS.has(e.code)) { const a = index.get(`Shift+${e.code}`); if (a) return a; }
  return index.get(e.code) || null;
}
/** Held actions to release on a keyup of this physical key (with or without Shift). */
export function releasedBy(code){
  const out = new Set();
  for (const a of HELD) if (current[a].some(k => k === code || k === `Shift+${code}`)) out.add(a);
  return out;
}

/** Sets slot `slot` of `action` to `combo` (null clears it). The key is taken away from any other action. */
export function bind(action, slot, combo){
  if (!current[action] || slot < 0 || slot >= SLOTS) return false;
  if (combo != null && (typeof combo !== 'string' || !VALID.test(combo))) return false;
  const list = current[action].slice();
  if (combo != null) {
    for (const a of ACTIONS) current[a.id] = current[a.id].filter(k => k !== combo);
    list.splice(0, list.length, ...current[action]);
    if (slot < list.length) list[slot] = combo; else list.push(combo);
  } else if (slot < list.length) list.splice(slot, 1);
  current[action] = [...new Set(list)].slice(0, SLOTS);
  changed();
  return true;
}
export function reset(){ current = clone(DEFAULTS); changed(); }
export const isModifier = code => MODIFIERS.has(code);

const NAMES = {ArrowLeft:'←', ArrowRight:'→', ArrowUp:'↑', ArrowDown:'↓', Space:'Space', Escape:'Esc', Enter:'Enter', Backspace:'⌫',
  Tab:'Tab', Minus:'-', Equal:'=', BracketLeft:'[', BracketRight:']', Backslash:'\\', Semicolon:';', Quote:"'", Comma:',', Period:'.',
  Slash:'/', Backquote:'`', CapsLock:'Caps'};
/** Short label for a binding: 'Shift+ArrowLeft' -> 'Shift + ←', 'KeyA' -> 'A', 'Digit1' -> '1', 'Numpad4' -> 'Num 4'. */
export function label(combo){
  if (!combo) return '';
  const shift = combo.startsWith('Shift+'), code = shift ? combo.slice(6) : combo;
  let n = NAMES[code];
  if (!n) n = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^Numpad/.test(code) ? 'Num ' + code.slice(6) : code;
  return shift ? `Shift + ${n}` : n;
}
export const labels = action => (current[action] || []).map(label);

load();
