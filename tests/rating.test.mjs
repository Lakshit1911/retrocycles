// node tests/rating.test.mjs
import assert from 'node:assert/strict';
import {
  glicko2, idle, expected, matchGames, rateMatch, carry, boardKey, multiWeight, pairScore,
  BOT_RATINGS, AI_WEIGHT, PLACEMENT, DEFAULT, RD_MIN, RD_MAX, SEASON_RD, DAY
} from '../js/progression/rating.js';
import { seasonId, seasonLabel, seasonEnds } from '../js/progression/season.js';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);

console.log('rating.js');

test('Glickman example: 1500/200/.06 vs 1400/30 (W), 1550/100 (L), 1700/300 (L)', () => {
  const out = glicko2({r:1500, rd:200, vol:0.06}, [
    {r:1400, rd:30, score:1}, {r:1550, rd:100, score:0}, {r:1700, rd:300, score:0}]);
  near(out.r, 1464.06, 0.01, 'rating');
  near(out.rd, 151.52, 0.01, 'RD');
  near(out.vol, 0.05999, 0.00001, 'volatility');
});

test('weight 1 everywhere is textbook; weight 0 games are ignored', () => {
  const a = glicko2({r:1500, rd:200, vol:0.06}, [{r:1400, rd:30, score:1, weight:1}, {r:1550, rd:100, score:0, weight:1}, {r:1700, rd:300, score:0, weight:1}]);
  const b = glicko2({r:1500, rd:200, vol:0.06}, [{r:1400, rd:30, score:1}, {r:1550, rd:100, score:0}, {r:1700, rd:300, score:0}, {r:900, rd:30, score:1, weight:0}]);
  near(a.r, b.r, 1e-9); near(a.rd, b.rd, 1e-9);
});

test('half-weight game moves rating less than a full one', () => {
  const p = {r:1500, rd:200, vol:0.06};
  const full = glicko2(p, [{r:1500, rd:50, score:1}]), half = glicko2(p, [{r:1500, rd:50, score:1, weight:.5}]);
  assert.ok(full.r - 1500 > half.r - 1500 && half.r > 1500, `${full.r} vs ${half.r}`);
});

test('no games: RD grows by volatility, rating unchanged', () => {
  const out = glicko2({r:1600, rd:100, vol:0.06}, []);
  assert.equal(out.r, 1600);
  near(out.rd, Math.sqrt((100 / 173.7178) ** 2 + 0.06 ** 2) * 173.7178, 1e-9);
});

test('idle(): RD inflates per period, capped at 350', () => {
  const a = idle({r:1500, rd:60, vol:0.06}, 30);
  assert.ok(a.rd > 60 && a.rd < 350);
  assert.equal(idle({r:1500, rd:340, vol:0.06}, 10000).rd, RD_MAX);
});

test('expected(): symmetric and 0.5 for equals', () => {
  near(expected({r:1500, rd:50}, {r:1500, rd:50}), 0.5, 1e-12);
  near(expected({r:1700, rd:50}, {r:1500, rd:50}) + expected({r:1500, rd:50}, {r:1700, rd:50}), 1, 1e-12);
});

test('pairScore and multiWeight', () => {
  assert.deepEqual([pairScore(3, 1), pairScore(1, 3), pairScore(2, 2)], [1, 0, .5]);
  assert.equal(multiWeight(2), 1);
  near(multiWeight(6), 1 / Math.sqrt(5), 1e-12);
});

const solo = {online:false, diff:'legend', table:[
  {name:'KESTREL', score:5, bot:true}, {name:'NOVA', score:3, me:true}, {name:'JUNO', score:3, bot:true}, {name:'RIVET', score:0, bot:true}]};

test('matchGames: bots use the difficulty rating, ties are draws, AI weight applies', () => {
  const g = matchGames(solo);
  assert.equal(g.length, 3);
  assert.deepEqual(g.map(x => x.score), [0, .5, 1]);
  g.forEach(x => { assert.equal(x.r, BOT_RATINGS.legend.r); near(x.weight, AI_WEIGHT / Math.sqrt(3), 1e-12); });
});

test('matchGames: humans use their supplied rating, unknown humans count as provisional', () => {
  const s = {online:true, diff:'rider', table:[{name:'A', score:5}, {name:'ME', score:4, me:true}, {name:'B', score:1}, {name:'BOT', score:0, bot:true}]};
  const g = matchGames(s, [{r:1820, rd:60}, null, undefined, null]);
  assert.deepEqual(g.map(x => [x.r, x.rd, x.score]), [[1820, 60, 0], [1500, 350, 1], [1500, 50, 1]]);
  near(g[0].weight, 1 / Math.sqrt(3), 1e-12);
  near(g[2].weight, AI_WEIGHT / Math.sqrt(3), 1e-12);
});

test('rateMatch: first match from scratch, n counts, no board key before placement', () => {
  const now = Date.UTC(2026, 9, 30);
  const { before, after, delta } = rateMatch(null, solo, {season:'2026-Q4', now});
  assert.equal(before, 1500); assert.equal(after.n, 1); assert.equal(after.season, '2026-Q4'); assert.equal(after.updated, now);
  assert.ok(after.rd < DEFAULT.rd && after.rd >= RD_MIN);
  assert.equal(delta, Math.round(after.r - 1500));
  assert.equal(after.board, undefined);
});

test('rateMatch: placement on the 5th match adds the season board key', () => {
  const now = Date.UTC(2026, 9, 30);
  let r = null;
  for (let i = 0; i < PLACEMENT; i++) r = rateMatch(r, solo, {season:'2026-Q4', now}).after;
  assert.equal(r.n, PLACEMENT);
  assert.match(r.board, /^2026-Q4:\d{4}$/);
  assert.equal(r.board, boardKey('2026-Q4', r.r, r.n));
});

test('board keys sort like ratings', () => {
  const keys = [980.4, 1500, 1499.6, 2210].map(r => boardKey('2026-Q4', r, 9));
  assert.deepEqual([...keys].sort(), [keys[0], keys[2], keys[1], keys[3]].sort());
  assert.ok(boardKey('2026-Q4', 980, 9) < boardKey('2026-Q4', 1200, 9));
});

test('carry(): new season resets placement and raises RD; idle days inflate RD', () => {
  const t0 = Date.UTC(2026, 8, 20), t1 = Date.UTC(2026, 9, 2);
  const c = carry({r:1700, rd:60, vol:0.06, n:12, season:'2026-Q3', updated:t0}, '2026-Q4', t1);
  assert.equal(c.n, 0); assert.equal(c.season, '2026-Q4'); assert.equal(c.r, 1700);
  assert.ok(c.rd >= SEASON_RD);
  const d = carry({r:1700, rd:60, vol:0.06, n:3, season:'2026-Q4', updated:t1}, '2026-Q4', t1 + 20 * DAY);
  assert.ok(d.rd > 60 && d.n === 3);
});

test('rateMatch: winning a duel against a strong human gains more than against a weak one', () => {
  const duel = {online:true, diff:'rider', table:[{name:'ME', score:5, me:true}, {name:'X', score:2}]};
  const st = {r:1500, rd:120, vol:0.06, n:6, season:'2026-Q4', updated:0};
  const opts = r => ({opponents:[null, {r, rd:80}], season:'2026-Q4', now:0});
  const strong = rateMatch(st, duel, opts(1800)).delta, weak = rateMatch(st, duel, opts(1200)).delta;
  assert.ok(strong > weak && weak > 0, `${strong} vs ${weak}`);
});

test('rateMatch: a match with no rateable games leaves n alone', () => {
  const r = rateMatch({r:1600, rd:80, vol:.06, n:2, season:'2026-Q4', updated:0}, {table:[{name:'ME', score:0, me:true}]}, {season:'2026-Q4', now:0});
  assert.equal(r.after.n, 2); assert.equal(r.delta, 0);
});

test('stored numbers stay in rule bounds after long streaks', () => {
  let st = null;
  const win = {online:false, diff:'legend', table:[{name:'ME', score:7, me:true}, ...Array.from({length:5}, (_, i) => ({name:'B' + i, score:0, bot:true}))]};
  for (let i = 0; i < 400; i++) st = rateMatch(st, win, {season:'2026-Q4', now:i}).after;
  assert.ok(st.r <= 3999 && st.rd >= 30 && st.vol > 0 && st.vol <= 0.15, JSON.stringify(st));
});

test('seasons are UTC calendar quarters', () => {
  assert.equal(seasonId(new Date(Date.UTC(2026, 9, 30))), '2026-Q4');
  assert.equal(seasonId(new Date(Date.UTC(2027, 0, 1))), '2027-Q1');
  assert.equal(seasonId(new Date(Date.UTC(2026, 5, 30, 23, 59))), '2026-Q2');
  assert.equal(seasonLabel('2026-Q4'), 'Season 2026 · Q4');
  assert.equal(seasonEnds(new Date(Date.UTC(2026, 10, 5))), Date.UTC(2027, 0, 1));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
