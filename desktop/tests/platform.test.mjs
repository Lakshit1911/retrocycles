// js/platform.js: event -> achievement / rich presence mapping, browser no-op, achievements.json in sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const PLATFORM = pathToFileURL(path.join(REPO, 'js', 'platform.js')).href;
const tick = () => new Promise(r => setTimeout(r, 0));
let n = 0;

function fakeWindow({desktop = true, steamAvailable = true, stored = {}} = {}){
  const w = new EventTarget();
  const mem = new Map(Object.entries(stored));
  w.localStorage = {getItem:k => (mem.has(k) ? mem.get(k) : null), setItem:(k, v) => mem.set(k, String(v)), removeItem:k => mem.delete(k)};
  w.document = {documentElement:{dataset:{}}};
  const calls = {unlock:[], presence:[]};
  if (desktop) {
    w.phantomDesktop = {isDesktop:true, steam:{
      available:steamAvailable,
      unlockAchievement:async id => { calls.unlock.push(id); return true; },
      setRichPresence:async (k, v) => { calls.presence.push([k, v]); return true; },
      getPersonaName:async () => 'Flynn', activateOverlay:async () => true
    }};
  }
  return {w, mem, calls};
}
// Fresh module instance per fake window
async function load(w){
  globalThis.window = w;
  try { return await import(`${PLATFORM}?t=${++n}`); } finally { delete globalThis.window; }
}
const fire = (w, detail) => w.dispatchEvent(new CustomEvent('phantom:event', {detail}));
const lastPresence = (calls, key) => { const c = calls.presence.filter(p => p[0] === key).pop(); return c && c[1]; };

test('browser (no phantomDesktop): complete no-op', async () => {
  const {w, mem} = fakeWindow({desktop:false});
  const p = await load(w);
  assert.equal(p.isDesktop, false);
  fire(w, {type:'match-end', won:true, online:false, rounds:5, roundsWon:5});
  fire(w, {type:'round-win'});
  await tick();
  assert.equal(mem.size, 0);
  assert.equal(w.document.documentElement.dataset.platform, undefined);
});

test('first solo win unlocks the right achievements and sets rich presence', async () => {
  const {w, calls} = fakeWindow();
  const p = await load(w);
  assert.equal(p.isDesktop, true);
  assert.equal(w.document.documentElement.dataset.platform, 'desktop');
  fire(w, {type:'menu', screen:'solo'});
  fire(w, {type:'match-start', online:false, riders:4, diff:'legend'});
  await tick();
  assert.equal(lastPresence(calls, 'steam_display'), '#Status_Solo');
  assert.equal(lastPresence(calls, 'difficulty'), 'Legend');
  fire(w, {type:'boost'});
  fire(w, {type:'round-win'});
  await tick();
  assert.deepEqual(calls.unlock, ['ACH_FIRST_ROUND']);
  assert.equal(lastPresence(calls, 'score'), '1');
  for (let i = 0; i < 4; i++) fire(w, {type:'round-win'});
  fire(w, {type:'match-end', won:true, online:false, rounds:5, roundsWon:5, diff:'legend'});
  await tick();
  assert.deepEqual(new Set(calls.unlock), new Set(['ACH_FIRST_ROUND', 'ACH_FIRST_WIN', 'ACH_FLAWLESS', 'ACH_LEGEND_WIN']));
  assert.equal(lastPresence(calls, 'steam_display'), '#Status_Menu');
  const s = p.getStats();
  assert.equal(s.wins, 1); assert.equal(s.matches, 1); assert.equal(s.roundWins, 5); assert.equal(s.boosts, 1);
});

test('online: join, win with a dropped round, leave', async () => {
  const {w, calls} = fakeWindow();
  await load(w);
  fire(w, {type:'join-room', host:true, code:'K7Q2M'});
  await tick();
  assert.ok(calls.unlock.includes('ACH_FIRST_GRID'));
  assert.equal(lastPresence(calls, 'steam_player_group'), 'grid-K7Q2M');
  assert.equal(lastPresence(calls, 'steam_display'), '#Status_Lobby');
  fire(w, {type:'match-start', online:true, host:true, riders:5});
  await tick();
  assert.equal(lastPresence(calls, 'steam_display'), '#Status_Online');
  assert.equal(lastPresence(calls, 'riders'), '5');
  fire(w, {type:'match-end', won:true, online:true, rounds:7, roundsWon:5});
  await tick();
  assert.ok(calls.unlock.includes('ACH_FIRST_ONLINE_WIN'));
  assert.ok(!calls.unlock.includes('ACH_FLAWLESS'));
  assert.equal(lastPresence(calls, 'steam_display'), '#Status_Lobby');   // back in the room
  fire(w, {type:'leave-room'});
  await tick();
  assert.equal(lastPresence(calls, 'steam_player_group'), '');
});

test('counters persist across launches; thresholds unlock once', async () => {
  const first = fakeWindow();
  await load(first.w);
  for (let i = 0; i < 99; i++) fire(first.w, {type:'boost'});
  for (let i = 0; i < 9; i++) fire(first.w, {type:'match-end', won:true, online:false, rounds:3, roundsWon:3});
  await tick();
  assert.ok(!first.calls.unlock.includes('ACH_BOOST_100'));
  assert.ok(!first.calls.unlock.includes('ACH_WINS_10'));
  const stored = Object.fromEntries(['pr-platform-stats', 'pr-platform-reported'].map(k => [k, first.mem.get(k)]));

  const second = fakeWindow({stored});
  await load(second.w);
  await tick();
  assert.deepEqual(second.calls.unlock, []);   // nothing new to report at startup
  fire(second.w, {type:'boost'});
  fire(second.w, {type:'match-end', won:true, online:false, rounds:3, roundsWon:2});
  fire(second.w, {type:'crash'});
  await tick();
  assert.deepEqual(second.calls.unlock.sort(), ['ACH_BOOST_100', 'ACH_FIRST_CRASH', 'ACH_WINS_10']);
});

test('earned while Steam was off: reported at the next launch with Steam', async () => {
  const off = fakeWindow({steamAvailable:false});
  await load(off.w);
  fire(off.w, {type:'match-end', won:true, online:false, rounds:3, roundsWon:3});
  await tick();
  assert.deepEqual(off.calls.unlock, []);
  const on = fakeWindow({stored:{'pr-platform-stats':off.mem.get('pr-platform-stats')}});
  await load(on.w);
  await tick();
  assert.deepEqual(new Set(on.calls.unlock), new Set(['ACH_FIRST_WIN', 'ACH_FLAWLESS']));
});

test('bad events and corrupt storage are ignored', async () => {
  const {w, calls} = fakeWindow({stored:{'pr-platform-stats':'{not json', 'pr-platform-reported':'"x"'}});
  const p = await load(w);
  fire(w, null); fire(w, {}); fire(w, {type:42}); fire(w, {type:'unknown'});
  await tick();
  assert.deepEqual(calls.unlock, []);
  assert.equal(p.getStats().wins, 0);
});

test('emit() dispatches phantom:event', async () => {
  const {w} = fakeWindow({desktop:false});
  const p = await load(w);
  const seen = [];
  w.addEventListener('phantom:event', e => seen.push(e.detail));
  globalThis.window = w;
  try { p.emit('round-win'); p.emit('menu', {screen:'home'}); } finally { delete globalThis.window; }
  assert.deepEqual(seen, [{type:'round-win'}, {screen:'home', type:'menu'}]);
});

test('desktop/achievements.json matches js/platform.js', async () => {
  const {w} = fakeWindow({desktop:false});
  const { ACHIEVEMENTS } = await load(w);
  const json = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop', 'achievements.json'), 'utf8')).achievements;
  assert.deepEqual(json.map(a => a.apiName), ACHIEVEMENTS.map(a => a.id));
  for (const a of ACHIEVEMENTS) {
    const j = json.find(x => x.apiName === a.id);
    assert.equal(j.displayName.english, a.name);
    assert.equal(j.description.english, a.description);
    assert.equal(j.unlockRule, a.rule);
    assert.match(a.id, /^[A-Z0-9_]+$/);
  }
});
