/* Controls screen: remap the keyboard (js/input/bindings.js) and see the controller layout.

   Opened from the "Controls" row in the race settings (Solo and Lobby). Each action has up to three
   key slots: click (or A on a pad) a slot, then press the new key. Delete / Backspace clears the slot,
   Esc cancels. A key already used elsewhere moves to the new action. Saved per device in localStorage.
   Also renders every [data-keys] label on the page (key hints in Solo and the race HUD). */
import { ACTIONS, SLOTS, get, bind, reset, isDefault, onChange, label, comboOf, isModifier } from './bindings.js';
import { listPads } from './gamepad.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const PAD_ROWS = [
  ['Steer', 'Left stick / d-pad'], ['Boost', 'A / Cross or right trigger'], ['Snap 90°', 'LB / RB (L1 / R1)'],
  ['Burst', 'X / Square'], ['Camera', 'View / Select'], ['Menu', 'Start / Options'], ['Menus', 'd-pad moves · A selects · B back']
];

let box = null, capture = null, padTimer = 0, opener = null, pendingMod = '';

/* ---------- Key hints on the page ---------- */
// data-keys="left,right": slots side by side ("← → / A D"); data-first: only the first key of each action
export function renderHints(root = document){
  const b = get();
  root.querySelectorAll('[data-keys]').forEach(el => {
    const acts = el.dataset.keys.split(',').map(s => s.trim()).filter(a => b[a]);
    if (!acts.length) return;
    if (el.hasAttribute('data-first')) { el.textContent = acts.map(a => label(b[a][0]) || '—').join(' '); return; }
    const max = +el.dataset.slots || (acts.length > 1 ? 2 : SLOTS);
    const slots = Math.min(max, Math.max(...acts.map(a => b[a].length)));
    const groups = [];
    for (let i = 0; i < slots; i++) {
      const keys = acts.map(a => b[a][i]).filter(Boolean);
      if (!keys.length) continue;
      // "Shift + ← →" rather than "Shift + ← Shift + →"
      const shift = keys.length > 1 && keys.every(k => k.startsWith('Shift+'));
      const kbd = keys.map(k => `<kbd>${esc(label(shift ? k.slice(6) : k))}</kbd>`).join(' ');
      groups.push(shift ? `<kbd>Shift</kbd> + ${kbd}` : kbd);
    }
    el.innerHTML = groups.join(' / ') || '<kbd>—</kbd>';
  });
}

/* ---------- Modal ---------- */
function build(){
  box = document.createElement('div');
  box.className = 'pausebox controls-box';
  box.id = 'controlsBox';
  box.hidden = true;
  box.setAttribute('data-pad-modal', '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'controlsTitle');
  box.innerHTML = `<div class="pausecard controls-card">
    <div class="big" id="controlsTitle">CONTROLS</div>
    <div class="tag" id="controlsTip">Pick a slot, then press a key · Delete clears · Esc cancels</div>
    <div class="ctl-list" id="ctlList" role="table" aria-label="Keyboard bindings"></div>
    <div class="ctl-pad">
      <div class="label">Game controller</div>
      <div class="hint" id="ctlPadStatus">No controller found. Connect one and press any button.</div>
      <div class="ctl-pad-map">${PAD_ROWS.map(([a, b]) => `<div><span>${esc(a)}</span><span>${esc(b)}</span></div>`).join('')}</div>
    </div>
    <div class="ctl-actions">
      <button class="ghost cut" id="controlsReset" type="button">Reset keys</button>
      <button class="ride cut" id="controlsDone" type="button" data-pad-back data-pad-default>DONE</button>
    </div>
  </div>`;
  document.body.appendChild(box);
  box.addEventListener('click', e => {
    const slot = e.target.closest('.ctl-key');
    if (slot) return startCapture(slot);
    if (e.target === box) close();
  });
  $('controlsDone').addEventListener('click', close);
  $('controlsReset').addEventListener('click', () => { stopCapture(); reset(); render(); });
}

function render(){
  const b = get();
  $('ctlList').innerHTML = ACTIONS.map(a => `<div class="ctl-row" role="row">
    <span class="ctl-name" role="rowheader">${esc(a.label)}${a.hint ? `<small>${esc(a.hint)}</small>` : ''}</span>
    <span class="ctl-keys" role="cell">${Array.from({length:SLOTS}, (_, i) => {
      const k = b[a.id][i];
      return `<button class="ctl-key${k ? '' : ' empty'}" type="button" data-a="${a.id}" data-i="${i}" aria-label="${esc(a.label)} key ${i + 1}: ${k ? esc(label(k)) : 'empty'}">${k ? esc(label(k)) : '+'}</button>`;
    }).join('')}</span></div>`).join('');
  $('controlsReset').disabled = isDefault();
  renderPads();
}
function renderPads(){
  const pads = listPads(), el = $('ctlPadStatus');
  if (!el) return;
  el.textContent = pads.length
    ? `Connected: ${pads.map(p => String(p.id).replace(/\s*\(.*?\)\s*/g, ' ').trim() || 'controller').join(', ')}${pads.some(p => p.mapping !== 'standard') ? ' (non-standard layout: buttons may differ)' : ''}`
    : 'No controller found. Connect one and press any button.';
}

function startCapture(el){
  stopCapture();
  capture = {action:el.dataset.a, slot:+el.dataset.i, el};
  el.classList.add('listening');
  el.textContent = 'Press a key…';
  $('controlsTip').textContent = 'Press the new key · Delete clears this slot · Esc cancels';
}
function stopCapture(){
  if (!capture) return;
  capture = null; pendingMod = '';
  $('controlsTip').textContent = 'Pick a slot, then press a key · Delete clears · Esc cancels';
}
function finish(combo){
  const { action, slot } = capture;
  stopCapture();
  bind(action, slot, combo);
  render();
  const again = box.querySelector(`.ctl-key[data-a="${action}"][data-i="${Math.min(slot, get()[action].length)}"]`) || box.querySelector(`.ctl-key[data-a="${action}"]`);
  if (again) again.focus();
}

// Capture phase on window: runs before the game's and the menus' key handlers
function onKeyDown(e){
  if (!box || box.hidden) return;
  if (!capture) {
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    return;
  }
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.repeat) return;
  if (e.code === 'Escape') { stopCapture(); render(); return; }
  if (e.code === 'Backspace' || e.code === 'Delete') return finish(null);
  if (isModifier(e.code)) { pendingMod = e.code; return; }   // a lone Shift / Ctrl ... binds on release
  finish(comboOf(e));
}
function onKeyUp(e){
  if (!box || box.hidden || !capture) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (pendingMod && e.code === pendingMod) finish(pendingMod);
}

export function open(){
  if (!box) build();
  opener = document.activeElement;
  render();
  box.hidden = false;
  clearInterval(padTimer); padTimer = setInterval(renderPads, 1000);
  const first = box.querySelector('.ctl-key');
  if (first) first.focus();
}
export function close(){
  if (!box || box.hidden) return;
  stopCapture();
  box.hidden = true;
  clearInterval(padTimer);
  if (opener && document.contains(opener)) opener.focus();
}
export const isOpen = () => !!box && !box.hidden;

addEventListener('keydown', onKeyDown, true);
addEventListener('keyup', onKeyUp, true);
onChange(() => renderHints());
const btn = $('controlsBtn');
if (btn) btn.addEventListener('click', open);
renderHints();
