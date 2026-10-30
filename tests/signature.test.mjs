// node tests/signature.test.mjs  (signature colour + name, and applying a match to a rider record)
import assert from 'node:assert/strict';
import { computeSignature, signatureName, styleVector, targetLch, band, drift, DRIFT, HUE_ORIGIN } from '../js/progression/signature.js';
import { applyMatch, cleanMetrics } from '../js/progression/record.js';
import { hexToOklch, isReadable, HEX_RE } from '../js/progression/colour.js';
import { PLACEMENT } from '../js/progression/rating.js';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const hueDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

console.log('signature.js / record.js');

const hunter = {matches:8, wins:5, soloMatches:2, soloWins:2, roundsWon:40, roundsPlayed:70, diffN:4, diffSum:8,
  style:{n:6, rounds:70, trapped:60, survivalSec:2400, boostSec:900, closePasses:300, ownWall:2}};
const sentinel = {matches:0, wins:0, soloMatches:10, soloWins:3, roundsWon:20, roundsPlayed:90, diffN:10, diffSum:2,
  style:{n:10, rounds:90, trapped:6, survivalSec:5000, boostSec:150, closePasses:40, ownWall:3}};

test('style vectors: aggressive vs cautious riders land in different quadrants', () => {
  const a = styleVector(hunter), b = styleVector(sentinel);
  assert.ok(a.x > 0.3 && b.x < -0.3, `${a.x} ${b.x}`);
  assert.equal(a.source, 'metrics'); assert.equal(a.archetype, 'Hunter'); assert.equal(b.archetype, 'Sentinel');
});

test('fallback style from plain stats when no metrics are reported', () => {
  const s = {matches:0, wins:0, soloMatches:6, soloWins:1, roundsWon:6, roundsPlayed:40, diffN:6, diffSum:0};
  const v = styleVector(s);
  assert.equal(v.source, 'stats');
  assert.ok(v.x < 0, 'rookie-only solo rider reads as cautious');
  const blend = styleVector({...s, style:{n:2, rounds:10, trapped:9, survivalSec:200, boostSec:60, closePasses:50, ownWall:0}});
  assert.equal(blend.source, 'blend');
});

test('hue follows style: aggression is warm, caution is cool', () => {
  const a = targetLch({uid:'x', stats:hunter, r:1500}), b = targetLch({uid:'x', stats:sentinel, r:1500});
  assert.ok(hueDiff(a.h, HUE_ORIGIN) < 90, `hunter hue ${a.h}`);
  assert.ok(hueDiff(b.h, HUE_ORIGIN + 180) < 90, `sentinel hue ${b.h}`);
});

test('rating band: higher ratings are lighter and stay readable', () => {
  assert.ok(band(1900).L > band(1300).L);
  for (const r of [800, 1200, 1500, 1800, 2200, 2800]) {
    const sig = computeSignature({uid:'u' + r, season:'2026-Q4', stats:hunter, r});
    assert.match(sig.hex, HEX_RE); assert.ok(isReadable(sig.hex), `${r} ${sig.hex}`);
  }
});

test('deterministic: same inputs, same colour and name', () => {
  const a = computeSignature({uid:'abc', season:'2026-Q4', stats:hunter, r:1640});
  const b = computeSignature({uid:'abc', season:'2026-Q4', stats:hunter, r:1640});
  assert.deepEqual(a, b);
  assert.equal(a.name, signatureName(a.hex));
});

test('thousands of distinct colours across riders, stats and ratings', () => {
  const seen = new Set(), names = new Set();
  for (let i = 0; i < 4000; i++) {
    const stats = {matches:i % 13, wins:i % 7, soloMatches:(i * 7) % 11, soloWins:i % 5, roundsWon:i % 31, roundsPlayed:20 + i % 40, diffN:i % 6, diffSum:i % 9};
    const sig = computeSignature({uid:'rider' + i, season:'2026-Q4', stats, r:900 + (i * 37) % 1500});
    seen.add(sig.hex); names.add(sig.name);
  }
  assert.ok(seen.size > 3000, `distinct colours ${seen.size}`);
  assert.ok(names.size > 300, `distinct names ${names.size}`);
});

test('names: two capitalised words, short, tasteful charset', () => {
  for (const hex of ['#ff2a3d', '#21d4ff', '#ffa21f', '#8cff2e', '#b44dff', '#e8eef8', '#3fd0c9', '#ff5cc8']) {
    const n = signatureName(hex);
    assert.match(n, /^[A-Z][a-z]+(-[a-z]+)? [A-Z][a-z]+$/, n);
    assert.ok(n.length <= 24);
  }
});

test('seasonal drift is limited around the previous signature', () => {
  const prev = computeSignature({uid:'abc', season:'2026-Q3', stats:hunter, r:1500});
  const next = computeSignature({uid:'abc', season:'2026-Q4', stats:sentinel, r:2100, prev});
  const p = hexToOklch(prev.hex), q = hexToOklch(next.hex);
  assert.ok(hueDiff(p.h, q.h) <= DRIFT.h + 1.5, `hue moved ${hueDiff(p.h, q.h)}`);
  assert.ok(Math.abs(p.L - q.L) <= DRIFT.L + 0.01);
  assert.notEqual(next.hex, prev.hex);
  const same = computeSignature({uid:'abc', season:'2026-Q3', stats:sentinel, r:2100, prev});
  assert.equal(same.hex, prev.hex, 'same season keeps the colour');
  const d = drift('#ff0000', {L:0.9, C:0.05, h:200});
  assert.ok(hueDiff(d.h, hexToOklch('#ff0000').h) <= DRIFT.h + 1e-9);
});

test('cleanMetrics clamps and rounds', () => {
  assert.equal(cleanMetrics(null), null);
  assert.deepEqual(cleanMetrics({trapped:3.4, survivalSec:123.456, boostSec:-5, closePasses:9e9, crashesIntoOwnWall:'2'}),
    {trapped:3, survivalSec:123.5, boostSec:0, closePasses:500, crashesIntoOwnWall:2});
});

const T0 = Date.UTC(2026, 9, 30, 12);
const soloWin = {online:false, won:true, roundsWon:5, rounds:7, diff:'rider',
  table:[{name:'NOVA', score:5, me:true}, {name:'KESTREL', score:2, bot:true}, {name:'JUNO', score:0, bot:true}]};

test('applyMatch: keeps lifetime counters as before', () => {
  const { user } = applyMatch({name:'NOVA', wins:1, matches:2, rounds:6, soloWins:0, soloMatches:3, color:'ion'}, soloWin, {uid:'u1', now:T0});
  assert.deepEqual([user.wins, user.matches, user.rounds, user.soloWins, user.soloMatches, user.color], [1, 2, 6, 1, 4, 'ion']);
  const on = applyMatch(user, {...soloWin, online:true}, {uid:'u1', now:T0}).user;
  assert.deepEqual([on.wins, on.matches, on.rounds], [2, 3, 11]);
});

test('applyMatch: season stats, rating, placement, then signature reveal on match 5', () => {
  let u = {name:'NOVA'}, rep;
  for (let i = 1; i <= PLACEMENT; i++) {
    ({ user:u, report:rep } = applyMatch(u, {...soloWin, metrics:{trapped:2, survivalSec:80, boostSec:12, closePasses:6, crashesIntoOwnWall:0}}, {uid:'u1', now:T0 + i}));
    assert.equal(rep.placement, i);
    if (i < PLACEMENT) { assert.equal(rep.sigEvent, null); assert.equal(u.signature, undefined); }
  }
  assert.equal(rep.sigEvent, 'reveal'); assert.ok(rep.placed);
  assert.match(u.signature.hex, HEX_RE); assert.equal(u.signature.season, '2026-Q4'); assert.equal(u.signature.revealedAt, T0 + PLACEMENT);
  const s = u.seasons['2026-Q4'];
  assert.deepEqual([s.soloMatches, s.soloWins, s.roundsWon, s.roundsPlayed, s.diffN, s.diffSum], [5, 5, 25, 35, 5, 5]);
  assert.deepEqual(s.style, {n:5, rounds:35, trapped:10, survivalSec:400, boostSec:60, closePasses:30, ownWall:0});
  assert.equal(s.r, u.rating.r); assert.match(u.rating.board, /^2026-Q4:\d{4}$/);
  // match 6: no new ceremony in the same season
  const six = applyMatch(u, soloWin, {uid:'u1', now:T0 + 9});
  assert.equal(six.report.sigEvent, null); assert.equal(six.user.signature.hex, u.signature.hex);
});

test('applyMatch: next season resets placement; signature evolves after 5 more', () => {
  let u = {name:'NOVA'};
  for (let i = 0; i < PLACEMENT; i++) u = applyMatch(u, soloWin, {uid:'u1', now:T0}).user;
  const first = u.signature;
  const Q1 = Date.UTC(2027, 0, 10);
  let rep;
  for (let i = 1; i <= PLACEMENT; i++) {
    ({ user:u, report:rep } = applyMatch(u, {...soloWin, won:false, roundsWon:0, table:[{name:'NOVA', score:0, me:true}, {name:'K', score:5, bot:true}]}, {uid:'u1', now:Q1 + i}));
    assert.equal(rep.placement, i);
  }
  assert.equal(rep.sigEvent, 'evolve'); assert.equal(rep.previousSignature.hex, first.hex);
  assert.equal(u.signature.season, '2027-Q1');
  assert.ok(hueDiff(hexToOklch(first.hex).h, hexToOklch(u.signature.hex).h) <= DRIFT.h + 1.5);
  assert.ok(u.seasons['2026-Q4'] && u.seasons['2027-Q1']);
});

test('applyMatch: online match uses human opponent ratings from ctx', () => {
  const s = {online:true, won:false, roundsWon:3, rounds:8, diff:'rider', table:[{name:'ACE', score:5}, {name:'NOVA', score:3, me:true}]};
  const strong = applyMatch(null, s, {uid:'u1', now:T0, opponents:[{r:2000, rd:60}, null]}).report;
  const weak = applyMatch(null, s, {uid:'u1', now:T0, opponents:[{r:1100, rd:60}, null]}).report;
  assert.ok(strong.delta > weak.delta, `${strong.delta} vs ${weak.delta}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
