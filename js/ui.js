/* Menus and online flow: title screen, sign-in, home, solo setup, host/join lobby, leaderboard,
   rider profile (rating, season placement, signature light, accent) and the signature reveal ceremony.
   Firebase loads lazily, so the solo game still runs if the network or Firebase is unreachable. */
import { Game, RIDERS, DIFF } from './game.js';
import { VISUAL_CONFIG as VC } from './visuals/config.js';
import { SFX } from './audio.js';
import { emit } from './platform.js';
import { riderColours, cssOf, numOf, ACCENTS, accentFromHue, hueOf } from './progression/colour.js';
import { PLACEMENT, DEFAULT as RATING0 } from './progression/rating.js';
import { seasonId, seasonLabel } from './progression/season.js';
import { styleVector, band } from './progression/signature.js';
import './input/controls.js';   // Controls screen: key remapping + controller layout
import './mobile.js';           // iPhone app bridge (haptics, keep-awake) and iOS touch polish
import './pwa.js';              // service worker for the installable web app (production only)

const $ = id => document.getElementById(id);
const qa = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wait = ms => new Promise(r => setTimeout(r, ms));
const pick = a => a[Math.floor(Math.random() * a.length)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MAX = 6;

let FB = null, NET = null;
const online = Promise.all([import('./firebase.js'), import('./net.js')])
  .then(([f, n]) => { FB = f; NET = n; initAuth(); return true; })
  .catch(e => { console.warn('Online services unavailable', e); return false; });

let user = null, profile = null, guest = false, screen = 'title';
let room = null, roomView = {}, lastStart = null, inMatch = false, matchRoster = null, gone = new Set();
let authMode = 'in', lbField = 'wins', wakeLock = null;
let ratedRoster = null, rosterRatings = {}, revealData = null, revealFrom = 'home', revealTimers = [];
let authReadyResolve; const authReady = new Promise(r => authReadyResolve = r);
let redirectDone = Promise.resolve(null);
// Back from a full-page Google sign-in? (flag set by firebase.js just before redirecting; same key here
// because firebase.js may not have loaded yet)
const backFromGoogle = (() => {
  try { const t = +sessionStorage.getItem('pr-google-redirect'); sessionStorage.removeItem('pr-google-redirect'); return t > 0 && Date.now() - t < 10 * 60e3; }
  catch (e) { return false; }
})();
let pendingJoin = (new URLSearchParams(location.search).get('join') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

let settings = {bots:3, obots:2, diff:'rider', win:5, color:'crimson', steer:'free'};
try { const s = JSON.parse(localStorage.getItem('rc3d-settings') || 'null'); if (s) settings = Object.assign(settings, s); } catch (e) {}
const save = () => { try { localStorage.setItem('rc3d-settings', JSON.stringify(settings)); } catch (e) {} };
const myName = () => (profile && profile.name) || (user && user.displayName) || 'YOU';
// Your Phantom's light colour: the Garage pick, saved with your profile when signed in
const myColor = () => (profile && Game.colourOf(profile.color) && profile.color) || (Game.colourOf(settings.color) && settings.color) || 'crimson';
// Your light: the signature once revealed, else the Garage classic (js/progression/colour.js riderColours)
const myLight = () => riderColours(user ? {...profile, color:myColor()} : {color:myColor()});
const setAccentCss = css => document.documentElement.style.setProperty('--accent', css);
const setAccent = key => setAccentCss(Game.colourOf(key).css);

/* ---------- Helpers ---------- */
let toastT = 0;
function toast(msg, ms = 3200){
  const el = $('toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, ms);
}
async function busy(btn, fn){
  btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); }
}
async function keepAwake(on){
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}

function show(name, keepResult){
  screen = name;
  emit('menu', {screen:name});
  $('menu').dataset.screen = name;
  // The turntable Phantom shows on the title, in the garage and at the signature reveal; your light is the UI accent
  if (name !== 'reveal') clearReveal();
  if (name === 'garage') { setAccent(garagePick); Game.showcase(true, Game.colourOf(garagePick).hex, VC.showroom.garageDrop); }
  else if (name === 'reveal') Game.showcase(true, numOf(REVEAL_NEUTRAL), VC.showroom.garageDrop);
  else { const c = myLight().primaryHex; setAccentCss(c); Game.showcase(name === 'title', numOf(c), VC.showroom.drop); }
  qa('.screen').forEach(s => s.hidden = s.dataset.screen !== name);
  if (!keepResult) $('result').hidden = true;
  const slot = document.querySelector(`.screen[data-screen="${name}"] [data-slot="settings"]`), blk = $('settingsBlock');
  if (slot) { slot.appendChild(blk); blk.hidden = false; } else blk.hidden = true;
  renderSettings();
  if (name === 'home') renderHome();
  if (name === 'lobby') renderLobby();
  if (name === 'board') loadBoard(lbField);
  if (name === 'profile') renderProfile();
  if (name === 'reveal') playReveal();
  if (name === 'join') { $('joinCode').value = pendingJoin; onCodeInput(); }
  $('menu').scrollTop = 0;
}
function route(){
  if (!user && !guest) return show('auth');
  if (pendingJoin && user) return show('join');
  show('home');
}

/* ---------- Title screen ---------- */
const BOOT = ['PHANTOM OS 3.0 // night circuit division', 'mounting phantom bay ............ ', 'calibrating light wall emitters .. ', 'linking to the online grid ...... '];
async function boot(){
  const el = $('bootLog');
  const status = async i => i < BOOT.length - 1 ? 'OK' : ((await online) ? 'ONLINE' : 'OFFLINE');
  if (reduceMotion) {
    for (let i = 0; i < BOOT.length; i++) el.innerHTML += esc(BOOT[i]) + (i ? `<span class="ok">${await status(i)}</span>` : '') + '\n';
    return;
  }
  for (let i = 0; i < BOOT.length; i++) {
    for (const ch of BOOT[i]) { el.innerHTML += esc(ch); await wait(12); }
    if (i) { await wait(140); el.innerHTML += `<span class="ok">${await status(i)}</span>`; }
    el.innerHTML += '\n';
  }
}
async function pressStart(){
  Game.initAudio();
  const ok = await Promise.race([online, wait(5000).then(() => false)]);
  if (!ok) { guest = true; toast('Online grid unreachable. Solo races still work.'); return show('home'); }
  await Promise.race([authReady, wait(5000)]);
  route();
}
$('pressStart').addEventListener('click', () => busy($('pressStart'), pressStart));
addEventListener('keydown', e => {
  if (screen === 'title' && !$('menu').hidden && (e.code === 'Enter' || e.code === 'Space')) { e.preventDefault(); $('pressStart').click(); }
});

/* ---------- Auth ---------- */
function setAuthMode(m){
  authMode = m;
  qa('[data-auth]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.auth === m)));
  $('nameField').hidden = m !== 'up';
  $('fPw').autocomplete = m === 'up' ? 'new-password' : 'current-password';
  $('authGo').textContent = m === 'up' ? 'CREATE RIDER ID' : 'ENTER THE GRID';
  authMsg('');
}
function authMsg(m, ok){ $('authErr').textContent = m; $('authErr').classList.toggle('ok', !!ok); }
qa('[data-auth]').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));

$('authForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!FB) return authMsg('Online services are unreachable right now.');
  const name = $('fName').value.trim(), email = $('fEmail').value.trim(), pw = $('fPw').value;
  if (authMode === 'up' && !name) return authMsg('Pick a rider name. It shows on the leaderboard.');
  if (!email) return authMsg('Enter your email.');
  if (pw.length < 6) return authMsg('Password needs at least 6 characters.');
  busy($('authGo'), async () => {
    try {
      if (authMode === 'up') { await FB.signUp(name, email, pw); profile = await FB.ensureProfile(FB.auth.currentUser); }
      else await FB.signIn(email, pw);
      $('fPw').value = '';
      guest = false; route();
    } catch (err) { authMsg(FB.authError(err)); }
  });
});
$('googleBtn').addEventListener('click', () => {
  if (!FB) return authMsg('Online services are unreachable right now.');
  busy($('googleBtn'), async () => {
    try { const r = await FB.signInGoogle(); if (r && r.user) { guest = false; route(); } }
    catch (err) { authMsg(FB.authError(err)); }
  });
});
$('forgotBtn').addEventListener('click', async () => {
  const email = $('fEmail').value.trim();
  if (!FB) return authMsg('Online services are unreachable right now.');
  if (!email) return authMsg('Type your email above first, then tap Forgot password.');
  try { await FB.resetPassword(email); authMsg('Reset link sent. Check your inbox (and spam).', true); }
  catch (err) { authMsg(FB.authError(err)); }
});
$('guestBtn').addEventListener('click', () => { guest = true; show('home'); });

function initAuth(){
  // If this page load just completed a Google sign-in, skip the title and go straight to Home
  redirectDone = FB.redirectResult()
    .then(async r => {
      if (r && r.user) { await authReady; guest = false; if (screen === 'title' || screen === 'auth') route(); }
      return r;
    })
    .catch(err => { authMsg(FB.authError(err)); return {error:err}; });
  FB.onAuth(async u => {
    user = u;
    if (u) {
      guest = false;
      try { profile = await FB.ensureProfile(u); }
      catch (e) { console.warn(e); profile = {name:FB.cleanName(u.displayName || 'RIDER')}; }
    } else {
      profile = null;
      if (room) leaveRoom();
    }
    authReadyResolve();
    if (screen === 'auth' && u) route();
    if (screen === 'home') renderHome();
  });
}

/* ---------- Home ---------- */
function renderHome(){
  const signed = !!user;
  const rt = signed && liveRating();
  $('whoami').textContent = signed ? `Signed in · ${myName()}${rt && rt.placed ? ` · ${Math.round(rt.r)}` : ''}` : 'Guest rider · solo only';
  $('authBtn').textContent = signed ? 'Sign out' : 'Sign in';
  $('renameBtn').hidden = !signed;
  $('homeEyebrow').textContent = signed ? 'Rider online' : 'Guest mode';
  $('homeLede').textContent = signed
    ? (unseenSignature() ? `Your signature light is ready, ${myName()}. Open your profile to reveal it.` : `Welcome back, ${myName()}. The grid has been quiet without you.`)
    : 'Solo races only. Sign in to host or join a grid and climb the ranks.';
  $('profileBtn').classList.toggle('dot', !!unseenSignature());
  qa('.tile[data-go="host"], .tile[data-go="join"]').forEach(t => t.classList.toggle('locked', !signed));
}
function needAuth(fn){
  if (!FB) return toast('Online grid unreachable right now. Try solo.');
  if (!user) { toast('Sign in first to ride online.'); setAuthMode('in'); return show('auth'); }
  fn();
}
qa('[data-go]').forEach(t => t.addEventListener('click', () => {
  const go = t.dataset.go;
  if (go === 'solo') show('solo');
  else if (go === 'host') needAuth(hostGrid);
  else if (go === 'join') needAuth(() => show('join'));
  else if (go === 'board') show('board');
}));
qa('[data-back]').forEach(b => b.addEventListener('click', () => show(b.dataset.back)));
$('authBtn').addEventListener('click', async () => {
  if (user) { if (room) await leaveRoom(); await FB.logOut(); guest = false; setAuthMode('in'); show('auth'); }
  else { setAuthMode('in'); show('auth'); }
});
$('renameBtn').addEventListener('click', async () => {
  const n = prompt('New rider name (up to 12 characters)', myName());
  if (!n || !user) return;
  try { profile = {...profile, name:await FB.renameRider(user.uid, n)}; renderHome(); toast(`Rider renamed to ${profile.name}`); }
  catch (e) { toast('Could not rename: ' + e.message); }
});

/* ---------- Settings (shared by Solo and Lobby) ---------- */
function renderSettings(){
  const lobby = screen === 'lobby' && room, view = lobby && !room.isHost;
  const c = view ? (roomView.cfg || {}) : {};
  const diff = DIFF[c.diff] ? c.diff : settings.diff, win = c.win || settings.win;
  let bots;
  if (lobby) {
    const free = Math.max(0, MAX - Object.keys(roomView.players || {}).length);
    bots = Math.min(view ? (c.bots || 0) : settings.obots, free);
    $('botsHint').textContent = view ? 'Set by the host' : `Fill open seats · ${free} free`;
  } else {
    bots = settings.bots = clamp(settings.bots, 1, 5);
    $('botsHint').textContent = 'Bots sharing the arena';
  }
  $('botsVal').textContent = bots;
  // Steering: guests see the host's pick (a room without one predates free steering: grid)
  const steer = view ? (c.steer === 'free' ? 'free' : 'grid') : settings.steer === 'grid' ? 'grid' : 'free', free = steer === 'free';
  qa('#steerSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.s === steer)));
  $('steerHint').textContent = free ? 'Hold to carve, Shift or swipe to snap 90°' : 'Classic: every press turns 90°';
  $('kTurn').textContent = free ? 'Steer (hold)' : 'Turn 90°';
  $('kSnap').hidden = !free;
  $('kPhone').textContent = free ? 'hold ◀ ▶ to steer · swipe to snap' : 'buttons or swipe';
  qa('#diffSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.d === diff)));
  qa('#winSeg button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.w === win)));
  qa('#qualitySeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.q === Game.quality)));
  $('diffHint').textContent = DIFF[diff].hint;
  $('settingsBlock').classList.toggle('locked', !!view);
}
const cfgOut = () => ({bots:settings.obots, diff:settings.diff, win:settings.win, steer:settings.steer});
function changed(){
  save(); renderSettings();
  if (screen === 'lobby' && room && room.isHost) { room.setCfg(cfgOut()); renderLobby(); }
}
function stepBots(d){
  if (screen === 'lobby') settings.obots = clamp(settings.obots + d, 0, MAX - Object.keys(roomView.players || {}).length);
  else settings.bots = clamp(settings.bots + d, 1, 5);
  changed();
}
$('botsMinus').addEventListener('click', () => stepBots(-1));
$('botsPlus').addEventListener('click', () => stepBots(1));
qa('#diffSeg button').forEach(b => b.addEventListener('click', () => { settings.diff = b.dataset.d; changed(); }));
qa('#winSeg button').forEach(b => b.addEventListener('click', () => { settings.win = +b.dataset.w; changed(); }));
qa('#steerSeg button').forEach(b => b.addEventListener('click', () => { settings.steer = b.dataset.s; changed(); }));
// Graphics quality is per device, so it never goes into the room settings
qa('#qualitySeg button').forEach(b => b.addEventListener('click', () => { Game.setQuality(b.dataset.q); renderSettings(); }));
// Master volume (per device), alongside the SOUND mute button
let volume = 50;
try { const v = localStorage.getItem('pr-volume'); if (v !== null) volume = +v; } catch (e) {}
const applyVolume = () => {
  SFX.setVolume(volume / 100);
  $('volume').value = volume; $('volume').style.setProperty('--v', volume + '%');
};
$('volume').addEventListener('input', e => {
  volume = +e.target.value; applyVolume();
  try { localStorage.setItem('pr-volume', String(volume)); } catch (err) {}
});
applyVolume();
// Quiet clicks on menu buttons
document.addEventListener('click', e => { if (e.target.closest('.menu button, .pausebox button')) SFX.click(); });
Game.hooks.quality = (q, auto) => {
  renderSettings();
  if (auto) toast(`Graphics lowered to ${q[0].toUpperCase() + q.slice(1)} to keep the frame rate smooth`);
};

/* ---------- Solo ---------- */
$('ride').addEventListener('click', () => {
  save(); keepAwake(true); ratedRoster = null;
  Game.startSolo({bots:settings.bots, diff:settings.diff, win:settings.win, steer:settings.steer, name:myName(), color:myColor()});
});

/* ---------- Match end / quit ---------- */
const WIN_QUIPS = ['Ghosted the competition.', 'Light work. Literally.', 'Wall-to-wall victory.', 'A phantom finish. They never saw you coming.'];
const LOSS_QUIPS = ['Rebooting pride.exe…', 'Every wall is a lesson. Some are just very bright.', 'Close call. The grid remembers.', 'Hit a wall? Happens to the best of us.'];
function showResult(s){
  const title = s.won ? 'YOU OWN THE GRID' : s.winner ? `${s.winner} OWNS THE GRID` : 'MATCH OVER';
  $('result').innerHTML = `<div class="tag eyebrow">${s.online ? 'Online' : 'Solo'} match · ${s.rounds} rounds</div>
    <h3>${esc(title)}</h3><div class="hint">${pick(s.won ? WIN_QUIPS : LOSS_QUIPS)}</div>
    <div class="rows">${s.table.map(r => `<div class="${r.me ? 'me' : ''}"><i style="background:${r.css}"></i><span>${esc(r.name)}${r.bot ? ' · AI' : ''}${r.me ? ' · you' : ''}</span><b>${r.score}</b></div>`).join('')}</div>
    <div class="rating-line" id="ratingLine">${user ? '<span class="tag">Rating</span><span class="hint">Updating…</span>' : '<span class="hint">Guest ride · sign in to earn a skill rating and your signature light</span>'}</div>`;
  $('result').style.setProperty('--win', s.winnerCss);
  $('result').hidden = false;
}
Game.hooks.end = s => {
  emit('match-end', {won:s.won, online:s.online, rounds:s.rounds, roundsWon:s.roundsWon, diff:s.diff});
  keepAwake(false);
  showResult(s);
  if (user && FB) {
    const uid = user.uid;
    FB.recordMatch(uid, myName(), s, {opponents:opponentRatings(s)})
      .then(({report, user:u}) => { if (user && user.uid === uid) { profile = {...profile, ...u}; showRatingChange(report); } })
      .catch(e => { console.warn('Stats not saved', e); const el = $('ratingLine'); if (el) el.innerHTML = '<span class="hint">Could not save this match to your profile.</span>'; });
  }
  if (s.online && room) {
    inMatch = false; matchRoster = null; room.stopMatch();
    if (room.isHost) room.endMatch();
    show('lobby', true);
  } else show('solo', true);
};
Game.hooks.quit = async wasOnline => {
  keepAwake(false);
  if (wasOnline && room) { await leaveRoom(); show('home'); toast('You left the grid.'); }
  else show('solo');
};

/* ---------- Host / join ---------- */
async function hostGrid(){
  const tile = document.querySelector('.tile[data-go="host"]');
  await busy(tile, async () => {
    try {
      room = await NET.Room.host(user.uid, myName(), cfgOut(), myColor());
      emit('join-room', {host:true, code:room.code});
      watchRoom(); show('lobby');
    } catch (e) { toast('Could not open a grid: ' + (e.message || e)); room = null; }
  });
}
function onCodeInput(){
  const el = $('joinCode'), raw = el.value.toUpperCase();
  const clean = raw.replace(/[^A-Z0-9]/g, '').split('').filter(c => NET ? NET.CODE_CHARS.includes(c) : true).join('').slice(0, 5);
  if (clean.length < raw.replace(/[^A-Z0-9]/g, '').slice(0, 5).length) $('joinErr').textContent = 'Codes never use O, 0, I or 1.';
  else $('joinErr').textContent = '';
  el.value = clean;
  $('joinGo').disabled = clean.length !== 5;
}
$('joinCode').addEventListener('input', onCodeInput);
$('joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const code = $('joinCode').value;
  if (code.length !== 5) return;
  needAuth(() => busy($('joinGo'), async () => {
    try {
      room = await NET.Room.join(code, user.uid, myName(), myColor());
      emit('join-room', {host:false, code});
      pendingJoin = '';
      if (location.search) history.replaceState(null, '', location.pathname);
      watchRoom(); show('lobby');
    } catch (err) { room = null; $('joinErr').textContent = err.code === 'PERMISSION_DENIED' ? 'That grid is not accepting riders right now.' : err.message; }
  }));
});

function sortedPlayers(){
  const host = room && (room.isHost ? room.uid : roomView.host);
  return Object.entries(roomView.players || {})
    .map(([uid, v]) => ({uid, name:(v && v.name) || 'RIDER', t:(v && v.t) || 0, color:v && v.color}))
    .sort((a, b) => (b.uid === host) - (a.uid === host) || a.t - b.t);
}
/* No two riders share a colour: in join order each rider keeps their Garage pick if it is free,
   otherwise takes the first free one; AI rivals get what is left. */
function assignColours(players, bots){
  const used = new Set(), keys = VC.riders.map(c => c.key), free = () => keys.find(k => !used.has(k));
  const mine = players.map(p => { const k = keys.includes(p.color) && !used.has(p.color) ? p.color : free(); used.add(k); return k; });
  const theirs = Array.from({length:bots}, () => { const k = free(); used.add(k); return k; });
  return {players:mine, bots:theirs};
}
function watchRoom(){
  roomView = {players:{}, cfg:{}, status:'lobby', start:null, host:null};
  lastStart = null; inMatch = false; matchRoster = null; gone = new Set();
  let known = null;
  const r = room;
  r.watch({
    host:v => { roomView.host = v; if (screen === 'lobby') renderLobby(); },
    closed:() => {
      emit('leave-room');
      if (room !== r) return;
      const wasIn = inMatch;
      room.leave(); room = null; inMatch = false; keepAwake(false);
      if (wasIn) Game.toDemo();
      show('home'); toast('The host closed the grid.');
    },
    players:p => {
      if (room !== r) return;
      roomView.players = p;
      const names = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v && v.name]));
      if (known && !inMatch) {
        for (const k in names) if (!(k in known) && k !== user.uid) toast(`${names[k]} joined the grid`);
        for (const k in known) if (!(k in names) && k !== user.uid) toast(`${known[k]} left the grid`);
      }
      known = names;
      if (!r.isHost && !p[user.uid] && roomView.status === 'lobby') r.reseat(myName(), myColor());
      if (r.isHost && inMatch && matchRoster) matchRoster.forEach((pl, i) => {
        if (!pl.bot && pl.uid !== user.uid && !p[pl.uid] && !gone.has(i)) { gone.add(i); Game.removeRider(i); }
      });
      if (screen === 'lobby') { renderSettings(); renderLobby(); }
    },
    cfg:c => { if (room !== r) return; roomView.cfg = c; if (screen === 'lobby') { renderSettings(); renderLobby(); } },
    status:s => {
      if (room !== r) return;
      roomView.status = s;
      // Host wrapped up but the final snapshot never reached us: bring the guest back to the lobby
      if (s === 'lobby' && inMatch && !r.isHost) { inMatch = false; r.stopMatch(); Game.toDemo(); keepAwake(false); show('lobby'); }
      tryBegin();
    },
    start:st => { if (room !== r) return; roomView.start = st; tryBegin(); }
  });
}
function tryBegin(){
  if (!room || room.isHost || inMatch) return;
  const st = roomView.start;
  if (roomView.status !== 'playing' || !st || st.id === lastStart) return;
  lastStart = st.id;
  const roster = st.roster || [], me = roster.findIndex(p => p.uid === user.uid);
  if (me < 0) { toast('A match started without you. You are in for the next one.'); return; }
  inMatch = true; keepAwake(true); primeRatings(roster);
  Game.startOnline({role:'guest', roster, me, diff:st.diff, win:st.win, steer:st.steer, id:st.id,
    net:{turn:(t, at, r) => room.sendTurn(t, at, r), boost:b => room.sendBoost(b), input:(r, q, s) => room.sendInputs(r, q, s)}});
  room.listenMatch(Game.applySnapshot, Game.addTurnPoint, Game.addFreePoints);
}
async function hostStart(){
  const players = sortedPlayers(), bots = Math.min(settings.obots, MAX - players.length);
  if (players.length + bots < 2) return toast('Add an AI rival or wait for a friend to join.');
  const col = assignColours(players, bots);
  const roster = [
    ...players.map((p, i) => ({name:p.name, uid:p.uid, bot:false, color:col.players[i]})),
    ...Array.from({length:bots}, (_, j) => ({name:RIDERS[players.length + j].name, uid:'', bot:true, color:col.bots[j]}))
  ];
  const start = {id:String(Date.now()), roster, diff:settings.diff, win:settings.win, steer:settings.steer};
  await busy($('startMatch'), async () => {
    try { await room.begin(start); }
    catch (e) { toast('Could not start: ' + e.message); return; }
    lastStart = start.id; inMatch = true; matchRoster = roster; gone = new Set(); keepAwake(true); primeRatings(roster);
    room.listenInputs(roster, Game.remoteTurn, Game.remoteBoost, Game.remoteInput);
    Game.startOnline({role:'host', roster, me:0, diff:settings.diff, win:settings.win, steer:settings.steer, id:start.id,
      net:{state:s => room.sendState(s), turn:(r, i, n, x, z) => room.logTurn(r, i, n, x, z), points:(r, q, p) => room.logPoints(r, q, p)}});
  });
}
$('startMatch').addEventListener('click', hostStart);
async function leaveRoom(){
  if (!room) return;
  const r = room; room = null; inMatch = false; matchRoster = null;
  emit('leave-room');
  await r.leave();
}
$('leaveRoom').addEventListener('click', async () => { await leaveRoom(); show('home'); });
$('shareBtn').addEventListener('click', async () => {
  if (!room) return;
  const url = `${location.origin}${location.pathname}?join=${room.code}`;
  const text = `Race me on Phantom Run. Grid code: ${room.code}`;
  try {
    if (navigator.share) await navigator.share({title:'Phantom Run', text, url});
    else { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Code and link copied'); }
  } catch (e) { if (e.name !== 'AbortError') toast(`Grid code: ${room.code}`); }
});

function renderLobby(){
  if (!room) return;
  $('roomCode').textContent = room.code;
  $('lobbyEyebrow').textContent = room.isHost ? 'Your grid code · share it' : 'Grid code';
  const players = sortedPlayers(), host = room.isHost ? room.uid : roomView.host;
  const c = room.isHost ? cfgOut() : (roomView.cfg || {});
  const bots = Math.min(c.bots || 0, MAX - players.length);
  const slots = [], col = assignColours(players, bots), css = k => Game.colourOf(k).css;
  players.forEach((p, i) => slots.push(`<div class="slot${p.uid === user.uid ? ' me' : ''}" style="--c:${css(col.players[i])}"><span class="dot"></span><span class="nm">${esc(p.name)}</span>${p.uid === host ? '<small>HOST</small>' : ''}${p.uid === user.uid ? '<small>YOU</small>' : ''}</div>`));
  for (let j = 0; j < bots; j++) { const i = players.length + j; slots.push(`<div class="slot bot" style="--c:${css(col.bots[j])}"><span class="dot"></span><span class="nm">${RIDERS[i].name}</span><small>AI</small></div>`); }
  for (let i = players.length + bots; i < MAX; i++) slots.push('<div class="slot open"><span class="dot"></span><span class="nm">Open slot</span></div>');
  $('slots').innerHTML = slots.join('');
  const ready = players.length + bots >= 2;
  $('startMatch').hidden = !room.isHost;
  $('startMatch').disabled = !ready;
  $('lobbyNote').textContent = room.isHost
    ? (ready ? `${players.length} rider${players.length > 1 ? 's' : ''} + ${bots} AI ready. Your device runs the race, so keep this tab open and in front.`
             : 'Add an AI rival or wait for a friend to join with your code.')
    : 'Waiting for the host to start the match. Warm up those reflexes.';
}

/* ---------- Garage ---------- */
let garagePick = 'crimson', garageFrom = 'home';
const titleCase = k => k[0].toUpperCase() + k.slice(1);
function openGarage(from){ garageFrom = from; garagePick = myColor(); renderGarage(); show('garage'); }
function renderGarage(){
  // In a lobby, colours other riders already hold are shown but locked
  const taken = new Set();
  if (room && garageFrom === 'lobby') {
    const players = sortedPlayers(), col = assignColours(players, 0);
    players.forEach((p, i) => { if (p.uid !== user.uid) taken.add(col.players[i]); });
  }
  $('swatches').innerHTML = VC.riders.map(c =>
    `<button class="swatch" role="radio" style="--c:${c.css}" data-c="${c.key}" aria-label="${titleCase(c.key)}" aria-pressed="${c.key === garagePick}" aria-checked="${c.key === garagePick}"${taken.has(c.key) ? ' disabled title="Another rider in this grid has it"' : ''}></button>`).join('');
  $('garageName').textContent = titleCase(garagePick);
  const sig = user && profile && profile.signature;
  $('garageHint').textContent = sig
    ? `Your signature light, ${sig.name}, is your colour. The classic you pick here is your fallback wherever a signature can't be shown.`
    : 'Your colour is the light your Phantom casts. In a lobby, if someone already rides it, you take the next free one.';
  qa('#swatches .swatch').forEach(b => b.addEventListener('click', () => {
    garagePick = b.dataset.c; setAccent(garagePick); Game.showcase(true, Game.colourOf(garagePick).hex); renderGarage();
  }));
}
$('garageSave').addEventListener('click', async () => {
  settings.color = garagePick; save();
  if (user && FB) { try { await FB.setColor(user.uid, garagePick); profile = {...profile, color:garagePick}; } catch (e) { toast('Saved on this device. Could not reach your profile.'); } }
  if (room) room.setSeatColor(garagePick);
  toast(`${titleCase(garagePick)} it is.`);
  show(garageFrom);
});
$('garageBack').addEventListener('click', () => show(garageFrom));
$('homeGarage').addEventListener('click', () => openGarage('home'));
$('garageBtn').addEventListener('click', () => openGarage('lobby'));

/* ---------- Rating ---------- */
// Your rating as it stands this season (a stored rating from last season counts as unplaced until you ride)
function liveRating(){
  const rt = profile && profile.rating, season = seasonId();
  if (!rt || !Number.isFinite(rt.r)) return {r:RATING0.r, rd:RATING0.rd, n:0, placed:false, season, fresh:true};
  const n = rt.season === season ? rt.n || 0 : 0;
  return {r:rt.r, rd:rt.rd, n, placed:n >= PLACEMENT, season};
}
// Opponent ratings are read when a match starts, so everyone rates against pre-match numbers
function primeRatings(roster){
  ratedRoster = roster; rosterRatings = {};
  if (!FB || !user) return;
  const uids = roster.filter(p => !p.bot && p.uid && p.uid !== user.uid).map(p => p.uid);
  if (uids.length) FB.ratingsOf(uids).then(r => { if (ratedRoster === roster) rosterRatings = r; }).catch(() => {});
}
// Ratings aligned with the summary table (sorted by score); human rows are matched back to roster seats by name
function opponentRatings(s){
  if (!s.online || !ratedRoster) return [];
  const used = new Set();
  return s.table.map(row => {
    if (row.me || row.bot) return null;
    const i = ratedRoster.findIndex((p, k) => !used.has(k) && !p.bot && p.uid !== (user && user.uid) && String(p.name).toUpperCase() === String(row.name).toUpperCase());
    if (i < 0) return null;
    used.add(i);
    return rosterRatings[ratedRoster[i].uid] || null;
  });
}
function showRatingChange(rep){
  const el = $('ratingLine');
  if (!el || !rep) return;
  if (rep.sigEvent === 'evolve') prevSignature = rep.previousSignature;
  const d = rep.delta, sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  const place = rep.placed ? `± ${Math.round(rep.after.rd)}` : `Placement ${rep.placement} / ${PLACEMENT}`;
  el.innerHTML = `<span class="tag">Rating</span><b class="num">${Math.round(rep.after.r)}</b>
    <span class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${sign}${Math.abs(d)}</span><span class="hint">${place}</span>
    ${rep.sigEvent ? `<button class="ride cut sig-cta" type="button" id="sigCta" style="--sig:${rep.signature.hex}">${rep.sigEvent === 'evolve' ? 'Your light has shifted · see it' : 'Reveal your signature light'}</button>` : ''}`;
  if (rep.sigEvent) $('sigCta').addEventListener('click', () => openReveal(screen));
  if (screen === 'home') renderHome();
}

/* ---------- Profile ---------- */
const seenKey = () => `pr-sig-seen-${user ? user.uid : ''}`;
function unseenSignature(){
  const sig = user && profile && profile.signature;
  if (!sig) return null;
  let seen = 0;
  try { seen = +localStorage.getItem(seenKey()) || 0; } catch (e) {}
  return (sig.revealedAt || 0) > seen ? sig : null;
}
let accentPick = null;
function renderProfile(){
  const signed = !!user;
  $('profGuest').hidden = signed; $('profBody').hidden = !signed;
  $('profName').textContent = signed ? myName() : 'Guest rider';
  const rt = liveRating();
  $('profSeason').textContent = `${seasonLabel(rt.season)} · Rider profile`;
  if (!signed) return;
  $('profRating').textContent = Math.round(rt.r);
  $('profRd').textContent = rt.fresh ? 'Unrated · first match sets it' : `± ${Math.round(rt.rd)}${rt.placed ? '' : ' · provisional'}`;
  $('profPips').innerHTML = Array.from({length:PLACEMENT}, (_, i) => `<i class="${i < Math.min(rt.n, PLACEMENT) ? 'on' : ''}"></i>`).join('');
  $('profPlace').textContent = rt.placed ? `Placed · ${rt.n} rated` : `${rt.n} / ${PLACEMENT} matches`;
  const ss = (profile.seasons && profile.seasons[rt.season]) || {};
  const played = (ss.matches || 0) + (ss.soloMatches || 0), won = (ss.wins || 0) + (ss.soloWins || 0);
  $('profWins').textContent = won;
  $('profMatches').textContent = `win${won === 1 ? '' : 's'} · ${played} match${played === 1 ? '' : 'es'}`;
  const sig = profile.signature && cssOf(profile.signature.hex) ? profile.signature : null;
  $('profSig').classList.toggle('locked', !sig);
  $('profSig').style.setProperty('--sig', sig ? sig.hex : 'var(--line-strong)');
  $('profSigName').textContent = sig ? sig.name : 'Unrevealed';
  const left = Math.max(0, PLACEMENT - rt.n);
  if (sig) {
    const v = styleVector(ss), b = band(rt.r);
    $('profSigHint').textContent = sig.season === rt.season
      ? `${v.archetype} · ${b.tier} · ${sig.season}`
      : `Revealed ${sig.season}. Shifts after ${left} more rated match${left === 1 ? '' : 'es'} this season.`;
  } else $('profSigHint').textContent = `Revealing after ${left} more rated match${left === 1 ? '' : 'es'}. How you ride sets the hue; how well, the brightness.`;
  $('profReplay').hidden = !sig;
  $('profReplay').textContent = unseenSignature() ? 'Reveal' : 'Replay';
  accentPick = (profile.accent && cssOf(profile.accent.hex)) || null;
  renderAccents();
}
function renderAccents(){
  const cur = accentPick || myLight().accentHex;
  $('accentSwatches').innerHTML = ACCENTS.map(c =>
    `<button class="swatch" role="radio" style="--c:${c}" data-a="${c}" aria-label="Accent ${c}" aria-checked="${c === accentPick}" aria-pressed="${c === accentPick}"></button>`).join('');
  $('accentHue').value = Math.round(hueOf(cur));
  $('accentChip').style.setProperty('--c', cur);
  $('accentChip').style.setProperty('--p', myLight().primaryHex);
}
$('accentSwatches').addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  accentPick = b.dataset.a; renderAccents();
});
$('accentHue').addEventListener('input', e => {
  accentPick = accentFromHue(+e.target.value);
  qa('#accentSwatches .swatch').forEach(b => { b.setAttribute('aria-checked', 'false'); b.setAttribute('aria-pressed', 'false'); });
  $('accentChip').style.setProperty('--c', accentPick);
});
$('accentSave').addEventListener('click', () => {
  if (!user || !FB || !accentPick) return toast(accentPick ? 'Sign in to save an accent.' : 'Pick an accent first.');
  busy($('accentSave'), async () => {
    try { await FB.saveAccent(user.uid, accentPick); profile = {...profile, accent:{hex:accentPick}}; toast('Accent saved.'); }
    catch (e) { toast('Could not save your accent: ' + e.message); }
  });
});
$('profileBtn').addEventListener('click', () => show('profile'));
$('profSignIn').addEventListener('click', () => { setAuthMode('in'); show('auth'); });
$('profReplay').addEventListener('click', () => openReveal('profile'));

/* ---------- Signature reveal ceremony ---------- */
// The turntable Phantom starts in neutral light, then takes the signature colour as the name resolves
const REVEAL_NEUTRAL = '#8a93a6';
let prevSignature = null, revealKeepResult = false;   // last season's signature, remembered when a match evolves it
function openReveal(from){
  const sig = profile && profile.signature;
  if (!sig || !cssOf(sig.hex)) return;
  revealFrom = ['home', 'solo', 'lobby', 'profile'].includes(from) ? from : 'home';
  if (revealFrom === 'lobby' && !room) revealFrom = 'home';
  revealKeepResult = !$('result').hidden;
  revealData = {sig, prev:prevSignature && prevSignature.season !== sig.season ? prevSignature : null};
  show('reveal');
}
function clearReveal(){ revealTimers.forEach(clearTimeout); revealTimers = []; }
function playReveal(){
  clearReveal();
  const { sig, prev } = revealData || {};
  const el = document.querySelector('.reveal-screen');
  if (!sig) return;
  const rt = liveRating(), ss = (profile.seasons && profile.seasons[sig.season]) || {};
  el.style.setProperty('--sig', sig.hex);
  $('revealEyebrow').textContent = prev ? `${seasonLabel(sig.season)} · your light has shifted` : `Placement complete · ${seasonLabel(sig.season)}`;
  $('revealKicker').textContent = prev ? 'Your signature light, evolved' : 'Your signature light';
  $('revealFrom').hidden = !prev;
  if (prev) $('revealFrom').innerHTML = `From <i class="sig-dot" style="--c:${esc(prev.hex)}"></i>${esc(prev.name)}`;
  $('revealName').innerHTML = [...sig.name].map((ch, i) => `<span style="--i:${i}">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`).join('');
  $('revealName').setAttribute('aria-label', sig.name);
  $('revealMeta').textContent = `${sig.hex} · ${styleVector(ss).archetype} · ${band(rt.r).tier} tier`;
  const at = (ms, fn) => revealTimers.push(setTimeout(fn, ms));
  el.classList.remove('lit', 'named', 'done');
  if (reduceMotion) { el.classList.add('lit', 'named', 'done'); Game.showcase(true, numOf(sig.hex), VC.showroom.garageDrop); setAccentCss(sig.hex); }
  else {
    void el.offsetWidth;   // restart the CSS animations on replay
    at(600, () => el.classList.add('lit'));
    at(1700, () => { Game.showcase(true, numOf(sig.hex), VC.showroom.garageDrop); setAccentCss(sig.hex); SFX.click(); });
    at(1900, () => el.classList.add('named'));
    at(1900 + sig.name.length * 90 + 700, () => el.classList.add('done'));
  }
  try { localStorage.setItem(seenKey(), String(sig.revealedAt || Date.now())); } catch (e) {}
}
$('revealDone').addEventListener('click', () => {
  clearReveal();
  if (revealFrom === 'lobby' && !room) revealFrom = 'home';
  show(revealFrom, revealKeepResult);
  if (revealKeepResult) $('result').hidden = false;
});

/* ---------- Leaderboard ---------- */
async function loadBoard(field){
  lbField = field;
  qa('[data-lb]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lb === field)));
  const ol = $('ranks'), season = seasonId();
  $('lbNote').hidden = field !== 'rating';
  $('lbNote').textContent = `${seasonLabel(season)} · skill rating · riders with ${PLACEMENT}+ rated matches this season`;
  ol.innerHTML = '<li class="empty">Loading the hall of light…</li>';
  if (!(await online)) { ol.innerHTML = '<li class="empty">Leaderboard is offline right now.</li>'; return; }
  try {
    if (field === 'rating') {
      const rows = await FB.topRated(season);
      if (lbField !== field) return;
      ol.innerHTML = rows.length ? rows.map((r, i) => {
        const sig = r.signature && cssOf(r.signature.hex);
        return `<li class="${user && r.uid === user.uid ? 'me' : ''}"><span class="pos">#${i + 1}</span><span class="nm">${sig ? `<i class="sig-dot" style="--c:${sig}" title="${esc(r.signature.name || '')}"></i>` : ''}${esc(r.name || 'RIDER')}</span><span class="sc">${Math.round(r.rating.r)}<small>± ${Math.round(r.rating.rd)} · ${r.rating.n} rated</small></span></li>`;
      }).join('') : `<li class="empty">No placed riders yet this season. Finish ${PLACEMENT} rated matches to be the first.</li>`;
      return;
    }
    const rows = await FB.topRiders(field);
    if (lbField !== field) return;
    ol.innerHTML = rows.length ? rows.map((r, i) => {
      const n = r[field] || 0;
      const sub = field === 'wins' ? `${r.matches || 0} matches · ${r.rounds || 0} rounds` : `${r.soloMatches || 0} races`;
      return `<li class="${user && r.uid === user.uid ? 'me' : ''}"><span class="pos">#${i + 1}</span><span class="nm">${esc(r.name || 'RIDER')}</span><span class="sc">${n} win${n === 1 ? '' : 's'}<small>${sub}</small></span></li>`;
    }).join('') : '<li class="empty">No riders on the board yet. Be the first light on it.</li>';
  } catch (e) { ol.innerHTML = `<li class="empty">Could not load the board: ${esc(e.message)}</li>`; }
}
qa('[data-lb]').forEach(b => b.addEventListener('click', () => loadBoard(b.dataset.lb)));

/* ---------- Boot ---------- */
// Returning from a Google redirect: skip the title, finish sign-in, then go straight to Home
async function finishGoogleRedirect(){
  show('auth');
  authMsg('Finishing Google sign-in…', true);
  if (!(await Promise.race([online, wait(8000).then(() => false)]))) return authMsg('Online services are unreachable right now.');
  const res = await Promise.race([redirectDone, wait(12000).then(() => ({timeout:true}))]);
  await Promise.race([authReady, wait(3000)]);
  if (user) return route();
  if (!res || !res.error) authMsg('Google sign-in did not finish in this browser. Try again, or use email and password.');
}

setAuthMode('in');
if (backFromGoogle) finishGoogleRedirect();
else { show('title'); boot(); }
