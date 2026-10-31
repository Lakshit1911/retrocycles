/* iPhone: the Capacitor app bridge plus touch polish for iOS (Safari, home-screen web app and the app).

   In the iOS app (mobile/, Capacitor) the native side injects window.Capacitor with the installed
   plugins, so nothing has to be bundled:
     - haptics from game events, like js/platform.js maps them to Steam: crash = heavy impact,
       boost start = light impact, round won = success notification (@capacitor/haptics)
     - the screen stays on during a match (@capacitor-community/keep-awake)
     - Google sign-in is hidden: Google blocks OAuth inside embedded web views (WKWebView), so the app
       signs in with email and password (see mobile/README.md)
   Everywhere: Web Audio is resumed on the next tap after iOS suspends it (calls, Control Centre,
   app switch), and pinch zoom is blocked while racing. In a normal browser without
   Capacitor every native call is skipped, so the website behaves exactly as before. */
import { SFX } from './audio.js';

const W = typeof window !== 'undefined' ? window : null;
const cap = () => (W && W.Capacitor) || null;
export const isNativeApp = (() => { const c = cap(); try { return !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform()); } catch (e) { return false; } })();
const plugin = name => { const c = cap(); return isNativeApp && c && c.Plugins && c.Plugins[name] ? c.Plugins[name] : null; };
const call = (p, method, opts) => { try { const r = p && typeof p[method] === 'function' ? p[method](opts) : null; if (r && r.catch) r.catch(() => {}); } catch (e) {} };

/* ---------- Haptics ---------- */
// Event -> haptic, as {method, options} for the Haptics plugin. Pure, so it can be tested in Node.
export const HAPTICS = {
  'crash':     {method:'impact', options:{style:'HEAVY'}},
  'boost':     {method:'impact', options:{style:'LIGHT'}},
  'round-win': {method:'notification', options:{type:'SUCCESS'}}
};
export const hapticFor = detail => (detail && typeof detail.type === 'string' && HAPTICS[detail.type]) || null;

/* ---------- Keep the screen on during a match ---------- */
let awake = false;
function keepAwake(on){
  if (on === awake) return;
  awake = on;
  call(plugin('KeepAwake'), on ? 'keepAwake' : 'allowSleep');
}

export function handle(detail){
  if (!isNativeApp || !detail) return;
  const h = hapticFor(detail);
  if (h) call(plugin('Haptics'), h.method, h.options);
  if (detail.type === 'match-start') keepAwake(true);
  else if (detail.type === 'match-end' || detail.type === 'menu') keepAwake(false);
}

/* ---------- Sign-in inside the app ---------- */
function appSignIn(){
  const g = document.getElementById('googleBtn');
  if (!g) return;
  g.hidden = true;
  const or = g.parentElement && g.parentElement.querySelector('.or');
  if (or) or.hidden = true;
  if (document.getElementById('appAuthNote')) return;
  const note = document.createElement('p');
  note.id = 'appAuthNote';
  note.className = 'hint app-note';
  note.textContent = 'Google sign-in is not available inside the iPhone app (Google blocks it in embedded browsers). '
    + 'Sign in with email and password. Created your rider with Google? Type your Gmail address and tap “Forgot password?” to set a password for the same rider.';
  g.insertAdjacentElement('afterend', note);
}

/* ---------- Install ---------- */
if (W && W.document) {
  W.addEventListener('phantom:event', e => { try { handle(e.detail); } catch (err) {} });
  if (isNativeApp) {
    W.document.documentElement.dataset.native = 'ios';
    appSignIn();
  }
  // iOS suspends (or "interrupts") the AudioContext after calls, Siri or an app switch; a tap brings it back
  const resume = () => { const c = SFX.ctx; if (c && c.state !== 'running' && c.state !== 'closed') SFX.init(); };
  ['touchend', 'click', 'keydown'].forEach(t => W.addEventListener(t, resume, {passive:true}));
  // No pinch-zoom while a race is on screen (Safari gesture events; double-tap zoom is off through
  // touch-action in css/style.css)
  const racing = () => { const h = W.document.getElementById('hud'); return !!h && !h.hidden; };
  W.document.addEventListener('gesturestart', e => { if (racing()) e.preventDefault(); });
}
