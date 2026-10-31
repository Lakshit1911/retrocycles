/* Game controllers through the Gamepad API (standard mapping: Xbox, PlayStation, MFi, Switch Pro ...).
   Works in Chrome / Edge / Electron, Safari on macOS and iOS, and the iOS app's WKWebView.

   game.js calls pollGamepad(keys, game) once per frame. In a race:
     left stick / d-pad   steer (free mode: stick deflection becomes a duty cycle on keys.l / keys.r;
                          grid mode: one 90° turn per flick through game.turn)
     A or right trigger   boost (keys.boost)          X / Square   burst (keys.burst)
     LB / RB (L1 / R1)    snap turn left / right (game.turn -> keys.snapQ in free mode)
     Start / Menu         pause menu                  Select / View / Share   camera
   In menus and the pause box: d-pad / left stick moves the focus between buttons, A activates,
   B goes back (or resumes), Start activates too; sliders move with left / right.
   A crash rumbles the pad (vibrationActuator) where the browser supports it. */

const BTN = {A:0, B:1, X:2, Y:3, LB:4, RB:5, LT:6, RT:7, SELECT:8, START:9, LS:10, RS:11, UP:12, DOWN:13, LEFT:14, RIGHT:15};
export const PAD = Object.freeze({...BTN});
export const DEADZONE = 0.22;      // stick radius ignored
const FULL = 0.9;                  // stick deflection that counts as full lock
const PWM_MS = 100;                // free steering duty-cycle period (6 sim ticks at 60 Hz)
const FLICK_ON = 0.6, FLICK_OFF = 0.35, TRIGGER = 0.3, NAV_ON = 0.55;
const REPEAT_FIRST = 380, REPEAT_NEXT = 140;
const HELD = ['l', 'r', 'boost', 'burst', 'brake'];

const W = typeof window !== 'undefined' ? window : null;
const doc = () => (W ? W.document : null);
let held = {l:false, r:false, boost:false, burst:false, brake:false};
let prev = [];                      // merged button state last frame
let suppress = new Set();           // buttons held through a context switch: ignored until released
let context = 'none', flick = 0, nav = {dir:'', next:0};
let known = new Map();              // pad index -> id
let lastKeys = null, lastPads = 0;

const now = () => (W && W.performance ? W.performance.now() : Date.now());
// "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)" -> "Xbox Wireless Controller"
export const shortName = id => String(id || '').replace(/\s*\([^)]*(?:STANDARD GAMEPAD|Vendor:|Product:)[^)]*\)/gi, ' ')
  .replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Controller';

export function listPads(){
  if (!W || !W.navigator || typeof W.navigator.getGamepads !== 'function') return [];
  let list = [];
  try { list = [...W.navigator.getGamepads()]; } catch (e) { return []; }
  return list.filter(p => p && p.connected !== false);
}

/* ---------- Toast + rumble ---------- */
let toastT = 0;
function toast(msg){
  const d = doc(), el = d && d.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2600);
}
export function rumble(strong = 1, weak = 0.6, duration = 260){
  for (const p of listPads()) {
    const a = p.vibrationActuator;
    if (!a || typeof a.playEffect !== 'function') continue;
    try { Promise.resolve(a.playEffect(a.type === 'trigger-rumble' ? 'trigger-rumble' : 'dual-rumble', {startDelay:0, duration, strongMagnitude:strong, weakMagnitude:weak})).catch(() => {}); } catch (e) {}
  }
}
if (W && typeof W.addEventListener === 'function') {
  W.addEventListener('phantom:event', e => { if (e.detail && e.detail.type === 'crash') rumble(1, .6, 280); });
  // Any mouse / touch / key use leaves controller navigation mode (no focus ring for the mouse)
  const leave = () => { const d = doc(); if (d && d.documentElement.classList.contains('pad-nav')) d.documentElement.classList.remove('pad-nav'); };
  ['pointerdown', 'mousemove'].forEach(t => W.addEventListener(t, leave, {passive:true}));
}

/* ---------- Reading pads ---------- */
// All connected pads merged into one: any button down, the stick with the largest deflection
function readPads(pads){
  const buttons = [], axes = [0, 0, 0, 0];
  for (const p of pads) {
    (p.buttons || []).forEach((b, i) => {
      const v = typeof b === 'number' ? b : (b.value || (b.pressed ? 1 : 0));
      buttons[i] = Math.max(buttons[i] || 0, v, b && b.pressed ? 1 : 0);
    });
    (p.axes || []).slice(0, 4).forEach((v, i) => { if (Math.abs(v) > Math.abs(axes[i])) axes[i] = v; });
  }
  return {buttons, axes};
}
const isDown = (s, i) => (i === BTN.LT || i === BTN.RT ? (s.buttons[i] || 0) > TRIGGER : (s.buttons[i] || 0) > 0.5) && !suppress.has(i);

function setHeld(keys, name, want){
  if (held[name] === want) return;
  held[name] = want;
  keys[name] = want;
}
function releaseAll(keys){ if (keys) HELD.forEach(n => setHeld(keys, n, false)); }

/* ---------- Race ---------- */
/** Free steering from a stick axis at time t (ms): -1 / 0 / 1. Partial deflection holds the steer key
    for that share of every 100 ms (time based, so 60 Hz and 120 Hz displays steer the same). */
export function steerFromStick(x, t){
  const m = Math.abs(x);
  if (m <= DEADZONE) return 0;
  const amount = Math.min(1, (m - DEADZONE) / (FULL - DEADZONE));
  const on = amount >= 0.999 || ((t % PWM_MS) + PWM_MS) % PWM_MS / PWM_MS < amount;
  return on ? Math.sign(x) : 0;
}
function race(keys, game, s, pressed){
  const lx = Math.abs(s.axes[0]) > DEADZONE ? s.axes[0] : 0;
  const pad = (isDown(s, BTN.RIGHT) ? 1 : 0) - (isDown(s, BTN.LEFT) ? 1 : 0);
  let l = false, r = false;
  if (game.free()) {
    if (pad) { l = pad < 0; r = pad > 0; }
    else if (lx) { const st = steerFromStick(lx, now()); l = st < 0; r = st > 0; }
  } else {
    // Grid: one 90° turn per flick of the stick or press of the d-pad
    if (flick === 0 && Math.abs(lx) >= FLICK_ON) { flick = Math.sign(lx); game.turn(flick); }
    else if (flick !== 0 && Math.abs(lx) < FLICK_OFF) flick = 0;
    if (pressed(BTN.LEFT)) game.turn(-1);
    if (pressed(BTN.RIGHT)) game.turn(1);
  }
  setHeld(keys, 'l', l);
  setHeld(keys, 'r', r);
  const boost = isDown(s, BTN.A) || isDown(s, BTN.RT);
  if (boost && !held.boost) game.skip();
  setHeld(keys, 'boost', boost);
  setHeld(keys, 'burst', isDown(s, BTN.X));
  setHeld(keys, 'brake', isDown(s, BTN.LT));   // Circuit mode
  if (pressed(BTN.LB)) game.turn(-1);
  if (pressed(BTN.RB)) game.turn(1);
  if (pressed(BTN.START)) game.pause();
  if (pressed(BTN.SELECT) || pressed(BTN.Y)) game.camera();
}

/* ---------- Menus: spatial focus navigation ---------- */
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
const visible = el => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
export function navContainer(){
  const d = doc();
  if (!d) return null;
  const modal = [...d.querySelectorAll('[data-pad-modal]')].find(visible);
  if (modal) return modal;
  const pause = d.getElementById('pausebox');
  if (visible(pause)) return pause;
  const menu = d.getElementById('menu');
  if (visible(menu)) return menu;
  return null;
}
function candidates(root){
  return [...root.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && visible(el));
}
function preferred(list){
  return list.find(el => el.matches('#pressStart, .ride, .tile, [data-pad-default]')) || list[0];
}
function focusEl(el){
  const d = doc();
  if (!el || !d) return;
  d.documentElement.classList.add('pad-nav');
  try { el.focus({preventScroll:false, focusVisible:true}); } catch (e) { el.focus(); }
  if (el.scrollIntoView) try { el.scrollIntoView({block:'nearest', inline:'nearest'}); } catch (e) {}
}
/** Picks the nearest element in a direction ('up' | 'down' | 'left' | 'right') from `from` among `list`. */
export function nearest(from, list, dir){
  const a = from.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === from) continue;
    const b = el.getBoundingClientRect(), bx = b.left + b.width / 2, by = b.top + b.height / 2;
    const dx = bx - ax, dy = by - ay;
    let main, cross;
    if (dir === 'left') { main = a.left - b.right; cross = Math.abs(dy); if (dx >= -1) continue; }
    else if (dir === 'right') { main = b.left - a.right; cross = Math.abs(dy); if (dx <= 1) continue; }
    else if (dir === 'up') { main = a.top - b.bottom; cross = Math.abs(dx); if (dy >= -1) continue; }
    else { main = b.top - a.bottom; cross = Math.abs(dx); if (dy <= 1) continue; }
    const score = Math.max(0, main) + cross * 2 + Math.hypot(dx, dy) * 0.1;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}
function moveFocus(root, dir){
  const d = doc(), list = candidates(root);
  if (!list.length) return;
  const cur = d.activeElement && root.contains(d.activeElement) && visible(d.activeElement) ? d.activeElement : null;
  if (!cur) return focusEl(preferred(list));
  if (cur.matches('input[type="range"]') && (dir === 'left' || dir === 'right')) {
    const step = +cur.step || 1, v = Math.min(+cur.max || 100, Math.max(+cur.min || 0, +cur.value + (dir === 'left' ? -step : step)));
    if (v !== +cur.value) { cur.value = String(v); cur.dispatchEvent(new Event('input', {bubbles:true})); cur.dispatchEvent(new Event('change', {bubbles:true})); }
    d.documentElement.classList.add('pad-nav');
    return;
  }
  const next = nearest(cur, list, dir);
  if (next) focusEl(next);
}
function activate(root){
  const d = doc();
  let cur = d.activeElement;
  // Nothing focused yet (fresh screen): A acts on the screen's main button (Press start, RIDE, SOLO ...)
  if (!cur || !root.contains(cur) || !visible(cur)) { cur = preferred(candidates(root)); if (!cur) return; focusEl(cur); }
  d.documentElement.classList.add('pad-nav');
  if (cur.matches('input[type="text"], input[type="email"], input[type="password"], input:not([type]), textarea')) { cur.focus(); return; }
  cur.click();
}
function back(root, game){
  const d = doc();
  const close = root.querySelector('[data-pad-back]');
  if (close && visible(close)) return close.click();
  if (root.id === 'pausebox') return game.pause();
  const btn = [...root.querySelectorAll('[data-back], .back, #garageBack')].find(visible);
  if (btn) { btn.click(); d.documentElement.classList.add('pad-nav'); }
}
function menus(game, s, pressed){
  const root = navContainer();
  if (!root) return;
  // Direction with auto-repeat while held
  const ax = s.axes[0], ay = s.axes[1];
  const dir = isDown(s, BTN.UP) || ay <= -NAV_ON ? 'up' : isDown(s, BTN.DOWN) || ay >= NAV_ON ? 'down'
    : isDown(s, BTN.LEFT) || ax <= -NAV_ON ? 'left' : isDown(s, BTN.RIGHT) || ax >= NAV_ON ? 'right' : '';
  const t = now();
  if (dir && dir !== nav.dir) { nav = {dir, next:t + REPEAT_FIRST}; moveFocus(root, dir); }
  else if (dir && t >= nav.next) { nav.next = t + REPEAT_NEXT; moveFocus(root, dir); }
  else if (!dir) nav = {dir:'', next:0};
  if (pressed(BTN.A)) activate(root);
  if (pressed(BTN.B)) back(root, game);
  if (pressed(BTN.START)) { if (root.id === 'pausebox') game.pause(); else activate(root); }
}

/* ---------- Per-frame entry point ---------- */
/**
 * @param {{l:boolean, r:boolean, boost:boolean, burst?:boolean, snapQ:number[]}} keys  game.js input state
 * @param {{playing():boolean, free():boolean, paused():boolean, turn(t:number):void, pause():void, camera():void, skip():void}} game
 */
export function pollGamepad(keys, game){
  lastKeys = keys;
  const pads = listPads();
  // Connect / disconnect notices
  const ids = new Map(pads.map(p => [p.index, p.id]));
  for (const [i, id] of ids) if (known.get(i) !== id) toast(`Controller connected · ${shortName(id)}`);
  for (const [i] of known) if (!ids.has(i)) toast('Controller disconnected');
  known = ids; lastPads = pads.length;
  if (!pads.length) { releaseAll(keys); prev = []; suppress.clear(); context = 'none'; return; }

  const s = readPads(pads);
  for (const b of [...suppress]) if (!((s.buttons[b] || 0) > 0.2)) suppress.delete(b);
  const was = prev;
  prev = s.buttons.map((v, i) => isDown(s, i));
  const pressed = i => prev[i] && !was[i];

  const ctx = game.playing() && !game.paused() && !navContainer() ? 'race' : 'menu';
  if (ctx !== context) {
    // Buttons held across the switch (A that pressed RIDE, Start that closed the menu) wait for a release
    s.buttons.forEach((v, i) => { if (v > 0.2) suppress.add(i); });
    prev = s.buttons.map(() => false);
    flick = 0; nav = {dir:'', next:0};
    if (ctx !== 'race') releaseAll(keys);
    context = ctx;
    return;
  }
  if (ctx === 'race') race(keys, game, s, pressed);
  else menus(game, s, pressed);
}

/** Test / debug view of the controller layer and the shared key state. */
export function inputDebug(){
  return {pads:lastPads, context, held:{...held},
    keys:lastKeys ? {l:!!lastKeys.l, r:!!lastKeys.r, boost:!!lastKeys.boost, burst:!!lastKeys.burst, snapQ:(lastKeys.snapQ || []).slice()} : null};
}
