/* Menus and online flow: title screen, sign-in, home, solo setup, host/join lobby, leaderboard.
   Firebase loads lazily, so the solo game still runs if the network or Firebase is unreachable. */
import { Game, RIDERS, DIFF } from './game.js';

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
let authReadyResolve; const authReady = new Promise(r => authReadyResolve = r);
let redirectDone = Promise.resolve(null);
// Back from a full-page Google sign-in? (flag set by firebase.js just before redirecting; same key here
// because firebase.js may not have loaded yet)
const backFromGoogle = (() => {
  try { const t = +sessionStorage.getItem('pr-google-redirect'); sessionStorage.removeItem('pr-google-redirect'); return t > 0 && Date.now() - t < 10 * 60e3; }
  catch (e) { return false; }
})();
let pendingJoin = (new URLSearchParams(location.search).get('join') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

let settings = {bots:3, obots:2, diff:'rider', win:5};
try { const s = JSON.parse(localStorage.getItem('rc3d-settings') || 'null'); if (s) settings = Object.assign(settings, s); } catch (e) {}
const save = () => { try { localStorage.setItem('rc3d-settings', JSON.stringify(settings)); } catch (e) {} };
const myName = () => (profile && profile.name) || (user && user.displayName) || 'YOU';

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
  qa('.screen').forEach(s => s.hidden = s.dataset.screen !== name);
  if (!keepResult) $('result').hidden = true;
  const slot = document.querySelector(`.screen[data-screen="${name}"] [data-slot="settings"]`), blk = $('settingsBlock');
  if (slot) { slot.appendChild(blk); blk.hidden = false; } else blk.hidden = true;
  renderSettings();
  if (name === 'home') renderHome();
  if (name === 'lobby') renderLobby();
  if (name === 'board') loadBoard(lbField);
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
  $('whoami').textContent = signed ? `Signed in · ${myName()}` : 'Guest rider · solo only';
  $('authBtn').textContent = signed ? 'Sign out' : 'Sign in';
  $('renameBtn').hidden = !signed;
  $('homeEyebrow').textContent = signed ? 'Rider online' : 'Guest mode';
  $('homeLede').textContent = signed
    ? `Welcome back, ${myName()}. The grid has been quiet without you.`
    : 'Solo races only. Sign in to host or join a grid and climb the ranks.';
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
  qa('#diffSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.d === diff)));
  qa('#winSeg button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.w === win)));
  $('diffHint').textContent = DIFF[diff].hint;
  $('settingsBlock').classList.toggle('locked', !!view);
}
const cfgOut = () => ({bots:settings.obots, diff:settings.diff, win:settings.win});
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

/* ---------- Solo ---------- */
$('ride').addEventListener('click', () => {
  save(); keepAwake(true);
  Game.startSolo({bots:settings.bots, diff:settings.diff, win:settings.win, name:myName()});
});

/* ---------- Match end / quit ---------- */
const WIN_QUIPS = ['Ghosted the competition.', 'Light work. Literally.', 'Wall-to-wall victory.', 'A phantom finish. They never saw you coming.'];
const LOSS_QUIPS = ['Rebooting pride.exe…', 'Every wall is a lesson. Some are just very bright.', 'Close call. The grid remembers.', 'Hit a wall? Happens to the best of us.'];
function showResult(s){
  const title = s.won ? 'YOU OWN THE GRID' : s.winner ? `${s.winner} OWNS THE GRID` : 'MATCH OVER';
  $('result').innerHTML = `<div class="tag eyebrow">${s.online ? 'Online' : 'Solo'} match · ${s.rounds} rounds</div>
    <h3>${esc(title)}</h3><div class="hint">${pick(s.won ? WIN_QUIPS : LOSS_QUIPS)}</div>
    <div class="rows">${s.table.map(r => `<div class="${r.me ? 'me' : ''}"><i style="background:${r.css}"></i><span>${esc(r.name)}${r.bot ? ' · AI' : ''}${r.me ? ' · you' : ''}</span><b>${r.score}</b></div>`).join('')}</div>`;
  $('result').hidden = false;
}
Game.hooks.end = s => {
  keepAwake(false);
  if (user && FB) FB.recordMatch(user.uid, myName(), s).catch(e => console.warn('Stats not saved', e));
  showResult(s);
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
      room = await NET.Room.host(user.uid, myName(), cfgOut());
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
      room = await NET.Room.join(code, user.uid, myName());
      pendingJoin = '';
      if (location.search) history.replaceState(null, '', location.pathname);
      watchRoom(); show('lobby');
    } catch (err) { room = null; $('joinErr').textContent = err.code === 'PERMISSION_DENIED' ? 'That grid is not accepting riders right now.' : err.message; }
  }));
});

function sortedPlayers(){
  const host = room && (room.isHost ? room.uid : roomView.host);
  return Object.entries(roomView.players || {})
    .map(([uid, v]) => ({uid, name:(v && v.name) || 'RIDER', t:(v && v.t) || 0}))
    .sort((a, b) => (b.uid === host) - (a.uid === host) || a.t - b.t);
}
function watchRoom(){
  roomView = {players:{}, cfg:{}, status:'lobby', start:null, host:null};
  lastStart = null; inMatch = false; matchRoster = null; gone = new Set();
  let known = null;
  const r = room;
  r.watch({
    host:v => { roomView.host = v; if (screen === 'lobby') renderLobby(); },
    closed:() => {
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
      if (!r.isHost && !p[user.uid] && roomView.status === 'lobby') r.reseat(myName());
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
  inMatch = true; keepAwake(true);
  Game.startOnline({role:'guest', roster, me, diff:st.diff, win:st.win, id:st.id,
    net:{turn:(t, at, r) => room.sendTurn(t, at, r), boost:b => room.sendBoost(b)}});
  room.listenMatch(Game.applySnapshot, Game.addTurnPoint);
}
async function hostStart(){
  const players = sortedPlayers(), bots = Math.min(settings.obots, MAX - players.length);
  if (players.length + bots < 2) return toast('Add an AI rival or wait for a friend to join.');
  const roster = [
    ...players.map(p => ({name:p.name, uid:p.uid, bot:false})),
    ...Array.from({length:bots}, (_, j) => ({name:RIDERS[players.length + j].name, uid:'', bot:true}))
  ];
  const start = {id:String(Date.now()), roster, diff:settings.diff, win:settings.win};
  await busy($('startMatch'), async () => {
    try { await room.begin(start); }
    catch (e) { toast('Could not start: ' + e.message); return; }
    lastStart = start.id; inMatch = true; matchRoster = roster; gone = new Set(); keepAwake(true);
    room.listenInputs(roster, Game.remoteTurn, Game.remoteBoost);
    Game.startOnline({role:'host', roster, me:0, diff:settings.diff, win:settings.win, id:start.id,
      net:{state:s => room.sendState(s), turn:(r, i, n, x, z) => room.logTurn(r, i, n, x, z)}});
  });
}
$('startMatch').addEventListener('click', hostStart);
async function leaveRoom(){
  if (!room) return;
  const r = room; room = null; inMatch = false; matchRoster = null;
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
  const slots = [];
  players.forEach((p, i) => slots.push(`<div class="slot" style="--c:${RIDERS[i].css}"><span class="dot"></span><span class="nm">${esc(p.name)}</span>${p.uid === host ? '<small>HOST</small>' : ''}${p.uid === user.uid ? '<small>YOU</small>' : ''}</div>`));
  for (let j = 0; j < bots; j++) { const i = players.length + j; slots.push(`<div class="slot bot" style="--c:${RIDERS[i].css}"><span class="dot"></span><span class="nm">${RIDERS[i].name}</span><small>AI</small></div>`); }
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

/* ---------- Leaderboard ---------- */
async function loadBoard(field){
  lbField = field;
  qa('[data-lb]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lb === field)));
  const ol = $('ranks');
  ol.innerHTML = '<li class="empty">Loading the hall of light…</li>';
  if (!(await online)) { ol.innerHTML = '<li class="empty">Leaderboard is offline right now.</li>'; return; }
  try {
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
