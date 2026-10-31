/* Platform bridge: turns game events into Steam achievements and rich presence.

   The game announces what happens by dispatching window CustomEvents named 'phantom:event':
     window.dispatchEvent(new CustomEvent('phantom:event', {detail:{type:'round-win'}}))
   (or `emit('round-win')` from this module). In the desktop build (Electron + Steam) the preload
   script exposes window.phantomDesktop and this module forwards achievements and rich presence to
   Steam. In a normal browser window.phantomDesktop is missing and everything here is a no-op.

   Event types (see desktop/README.md for where the game dispatches each one):
     {type:'menu', screen}                          a menu screen opened (title, auth, home, solo, join, lobby, garage, board)
     {type:'match-start', online, host, riders, diff}  a race begins (riders = total incl. AI)
     {type:'round-win'}                             the local player won a round
     {type:'crash'}                                 the local player hit a wall during a race
     {type:'boost'}                                 the local player started boosting (once per boost, not per frame)
     {type:'join-room', host, code}                 entered an online grid lobby (host = opened it)
     {type:'leave-room'}                            left the online grid
     {type:'match-end', won, online, rounds, roundsWon, diff}   a match finished (Game.hooks.end summary)

   Progress counters live in localStorage, so achievements that need several matches keep counting
   across launches, and anything earned while Steam was not running is reported the next time it is. */

export const EVENT = 'phantom:event';

/* Achievement ids are the API names to create on the Steamworks partner site (desktop/achievements.json).
   `test` reads the progress counters below; keep names and descriptions in sync with achievements.json. */
export const ACHIEVEMENTS = [
  {id:'ACH_FIRST_ROUND',      name:'First Light',            description:'Win a round.',                                   rule:'roundWins >= 1',    test:s => s.roundWins >= 1},
  {id:'ACH_FIRST_WIN',        name:'Own the Grid',           description:'Win a match, solo or online.',                    rule:'wins >= 1',         test:s => s.wins >= 1},
  {id:'ACH_FIRST_ONLINE_WIN', name:'Phantom Among Friends',  description:'Win an online match.',                            rule:'onlineWins >= 1',   test:s => s.onlineWins >= 1},
  {id:'ACH_FLAWLESS',         name:'Untouchable',            description:'Win a match without dropping a single round.',    rule:'flawlessWins >= 1', test:s => s.flawlessWins >= 1},
  {id:'ACH_LEGEND_WIN',       name:'Machine Breaker',        description:'Win a solo match against Legend rivals.',         rule:'legendWins >= 1',   test:s => s.legendWins >= 1},
  {id:'ACH_WINS_10',          name:'Grid Regular',           description:'Win 10 matches.',                                 rule:'wins >= 10',        test:s => s.wins >= 10},
  {id:'ACH_WINS_50',          name:'Night Circuit Legend',   description:'Win 50 matches.',                                 rule:'wins >= 50',        test:s => s.wins >= 50},
  {id:'ACH_MATCHES_25',       name:'Marathon Rider',         description:'Finish 25 matches.',                              rule:'matches >= 25',     test:s => s.matches >= 25},
  {id:'ACH_FIRST_GRID',       name:'Plugged In',             description:'Host or join an online grid.',                    rule:'grids >= 1',        test:s => s.grids >= 1},
  {id:'ACH_FIRST_CRASH',      name:'Every Wall Is a Lesson', description:'Hit a wall for the first time.',                  rule:'crashes >= 1',      test:s => s.crashes >= 1},
  {id:'ACH_BOOST_100',        name:'Afterburner',            description:'Boost 100 times.',                                rule:'boosts >= 100',     test:s => s.boosts >= 100}
];

const STATS_KEY = 'pr-platform-stats', REPORTED_KEY = 'pr-platform-reported';
const COUNTERS = ['roundWins', 'wins', 'onlineWins', 'flawlessWins', 'legendWins', 'matches', 'grids', 'crashes', 'boosts'];

const W = typeof window !== 'undefined' ? window : null;
const desktop = () => (W && W.phantomDesktop && W.phantomDesktop.isDesktop ? W.phantomDesktop : null);
const steam = () => { const d = desktop(); return d && d.steam && d.steam.available ? d.steam : null; };
export const isDesktop = !!desktop();

/** Dispatch a game event: emit('match-end', {won:true, online:false, rounds:5, roundsWon:5}). */
export function emit(type, detail = {}){
  if (!W || typeof CustomEvent !== 'function') return;
  W.dispatchEvent(new CustomEvent(EVENT, {detail:{...detail, type}}));
}

/* ---------- Progress counters ---------- */
function load(key, fallback){
  try { const v = JSON.parse(W.localStorage.getItem(key) || 'null'); return v && typeof v === 'object' ? v : fallback; }
  catch (e) { return fallback; }
}
function store(key, value){ try { W.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }

let stats = null, reported = null;
function ensureLoaded(){
  if (stats) return;
  const raw = load(STATS_KEY, {});
  stats = Object.fromEntries(COUNTERS.map(k => [k, Math.max(0, Math.floor(+raw[k] || 0))]));
  const done = load(REPORTED_KEY, []);
  reported = new Set(Array.isArray(done) ? done.filter(id => typeof id === 'string') : []);
}
export function getStats(){ ensureLoaded(); return {...stats}; }

/* ---------- Achievements ---------- */
const pending = new Set();
async function unlock(id){
  const s = steam();
  if (!s || reported.has(id) || pending.has(id)) return;
  pending.add(id);
  try {
    if (await s.unlockAchievement(id)) { reported.add(id); store(REPORTED_KEY, [...reported]); }
  } catch (e) { console.warn('Achievement not sent', id, e); }
  finally { pending.delete(id); }
}
function sweep(){
  ensureLoaded();
  for (const a of ACHIEVEMENTS) if (!reported.has(a.id) && a.test(stats)) unlock(a.id);
}

/* ---------- Rich presence ---------- */
// steam_display tokens are defined in desktop/rich_presence.vdf (upload it on the partner site).
const SCREEN_STATUS = {
  title:'At the start line', auth:'Signing in', home:'In the menus', solo:'Setting up a solo race',
  join:'Joining an online grid', lobby:'In an online grid lobby', garage:'In the Garage', board:'Reading the leaderboard'
};
const SCREEN_TOKEN = {lobby:'#Status_Lobby', garage:'#Status_Garage', board:'#Status_Ranks'};
const DIFF_NAME = {rookie:'Rookie', rider:'Rider', legend:'Legend'};
let inMatch = false, inRoom = false, lastPresence = {};

function presence(values){
  const s = steam();
  if (!s) return;
  for (const [k, v] of Object.entries(values)) {
    const val = v === undefined || v === null ? '' : String(v);
    if (lastPresence[k] === val) continue;
    lastPresence[k] = val;
    Promise.resolve().then(() => s.setRichPresence(k, val)).catch(e => console.warn('Rich presence not sent', k, e));
  }
}
function menuPresence(screen){
  const token = SCREEN_TOKEN[screen] || (inRoom ? '#Status_Lobby' : '#Status_Menu');
  presence({steam_display:token, status:SCREEN_STATUS[screen] || 'In the menus', difficulty:'', riders:'', score:''});
}

/* ---------- Event handling ---------- */
const count = (k, n = 1) => { stats[k] += n; };

export function handle(detail){
  if (!desktop() || !detail || typeof detail.type !== 'string') return;
  ensureLoaded();
  const d = detail;
  switch (d.type) {
    case 'menu':   // menus only show between races (quitting a match mid-race lands here too)
      inMatch = false;
      menuPresence(String(d.screen || 'home'));
      return;
    case 'match-start': {
      inMatch = true;
      const riders = Math.max(0, +d.riders || 0);
      if (d.online) presence({steam_display:'#Status_Online', status:`Racing online${riders ? ` · ${riders} riders` : ''}`, riders, difficulty:'', score:'0'});
      else {
        const diff = DIFF_NAME[d.diff] || 'Rider';
        presence({steam_display:'#Status_Solo', status:`Racing AI rivals · ${diff}`, difficulty:diff, riders, score:'0'});
      }
      return;
    }
    case 'round-win':
      count('roundWins');
      presence({score:String((+lastPresence.score || 0) + 1)});
      break;
    case 'crash':
      count('crashes');
      break;
    case 'boost':
      count('boosts');
      break;
    case 'join-room':
      inRoom = true;
      count('grids');
      presence({steam_player_group:d.code ? `grid-${String(d.code).slice(0, 8)}` : ''});
      if (!inMatch) menuPresence('lobby');
      break;
    case 'leave-room':
      inRoom = false;
      presence({steam_player_group:''});
      if (!inMatch) menuPresence('home');
      return;
    case 'match-end': {
      inMatch = false;
      count('matches');
      const rounds = +d.rounds || 0, roundsWon = +d.roundsWon || 0;
      if (d.won) {
        count('wins');
        if (d.online) count('onlineWins');
        if (rounds > 0 && roundsWon >= rounds) count('flawlessWins');
        if (!d.online && d.diff === 'legend') count('legendWins');
      }
      menuPresence(inRoom ? 'lobby' : 'solo');
      break;
    }
    default:
      return;
  }
  store(STATS_KEY, stats);
  sweep();
}

let installed = false;
export function install(){
  if (installed || !W || typeof W.addEventListener !== 'function') return;
  installed = true;
  W.addEventListener(EVENT, e => { try { handle(e.detail); } catch (err) { console.warn('phantom:event handler failed', err); } });
  if (desktop()) {
    ensureLoaded();
    if (W.document && W.document.documentElement) W.document.documentElement.dataset.platform = 'desktop';
    sweep();   // report anything earned while Steam was not running
  }
}
install();
