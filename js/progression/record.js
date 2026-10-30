/* Applying a finished match to a rider's users/{uid} record: lifetime counters, current-season stats,
   Glicko-2 rating and the signature colour. Pure (no Firebase), so the database transaction in
   js/firebase.js and the tests run exactly the same code. */
import { rateMatch, PLACEMENT } from './rating.js';
import { computeSignature } from './signature.js';
import { seasonId } from './season.js';

export const DIFF_INDEX = {rookie:0, rider:1, legend:2};

/* Optional per-match metrics from the game (all for the local rider, summed over every round of the match).
   Values are clamped to these bounds, which match the database rules. See docs/progression.md. */
export const METRIC_LIMITS = Object.freeze({trapped:40, survivalSec:3600, boostSec:3600, closePasses:500, crashesIntoOwnWall:64});
export function cleanMetrics(m){
  if (!m || typeof m !== 'object') return null;
  const out = {};
  for (const [k, max] of Object.entries(METRIC_LIMITS)) {
    const v = Number(m[k]);
    out[k] = Number.isFinite(v) ? Math.max(0, Math.min(max, k.endsWith('Sec') ? Math.round(v * 10) / 10 : Math.round(v))) : 0;
  }
  return out;
}

const num = v => (Number.isFinite(v) ? v : 0);

/** Apply a match. user: current users/{uid} value (may be null). summary: game summary (hooks.end), optionally
    with summary.metrics. ctx: {opponents (aligned with summary.table, {r, rd} or null), uid, name, now}.
    Returns {user, report}; report = {season, before, after, delta, placed, placement, signature, sigEvent}. */
export function applyMatch(user, summary, ctx = {}){
  const now = ctx.now ?? Date.now(), season = seasonId(new Date(now));
  const u = {...(user || {})};
  if (ctx.name) u.name = ctx.name;
  // Lifetime counters (unchanged behaviour)
  for (const k of ['wins', 'matches', 'rounds', 'soloWins', 'soloMatches']) u[k] = num(u[k]);
  const roundsWon = Math.max(0, Math.min(num(summary.roundsWon), 7));
  if (summary.online) { u.matches++; u.rounds += roundsWon; if (summary.won) u.wins++; }
  else { u.soloMatches++; if (summary.won) u.soloWins++; }

  // Rating (current season, Glicko-2)
  const rated = rateMatch(u.rating, summary, {opponents:ctx.opponents || [], season, now});
  u.rating = rated.after;

  // Current-season stats
  const seasons = {...(u.seasons || {})}, s = {...(seasons[season] || {})};
  for (const k of ['matches', 'wins', 'soloMatches', 'soloWins', 'roundsWon', 'roundsPlayed', 'diffN', 'diffSum']) s[k] = num(s[k]);
  if (summary.online) { s.matches++; if (summary.won) s.wins++; } else { s.soloMatches++; if (summary.won) s.soloWins++; }
  s.roundsWon += roundsWon;
  s.roundsPlayed += Math.max(0, Math.min(num(summary.rounds), 64));
  if ((summary.table || []).some(t => t.bot) && summary.diff in DIFF_INDEX) { s.diffN++; s.diffSum += DIFF_INDEX[summary.diff]; }
  const m = cleanMetrics(summary.metrics);
  if (m) {
    const st = {...(s.style || {})};
    st.n = num(st.n) + 1;
    st.rounds = num(st.rounds) + Math.max(1, Math.min(num(summary.rounds), 64));
    st.trapped = num(st.trapped) + m.trapped;
    st.survivalSec = Math.round((num(st.survivalSec) + m.survivalSec) * 10) / 10;
    st.boostSec = Math.round((num(st.boostSec) + m.boostSec) * 10) / 10;
    st.closePasses = num(st.closePasses) + m.closePasses;
    st.ownWall = num(st.ownWall) + m.crashesIntoOwnWall;
    s.style = st;
  }
  s.r = u.rating.r; s.rd = u.rating.rd; s.n = u.rating.n;
  s.peak = Math.max(num(s.peak), u.rating.n >= PLACEMENT ? u.rating.r : 0);
  seasons[season] = s;
  u.seasons = seasons;

  // Signature: revealed after placement; recomputed (with limited drift) once per season after placement
  let sigEvent = null;
  if (u.rating.n >= PLACEMENT && (!u.signature || u.signature.season !== season)) {
    sigEvent = u.signature ? 'evolve' : 'reveal';
    const sig = computeSignature({uid:ctx.uid || '', season, stats:s, r:u.rating.r, prev:u.signature});
    u.signature = {...sig, revealedAt:now};
  }
  const report = {season, before:rated.before, after:u.rating, delta:rated.delta, games:rated.games.length,
    placement:Math.min(u.rating.n, PLACEMENT), placed:u.rating.n >= PLACEMENT, signature:u.signature || null, sigEvent,
    previousSignature:sigEvent === 'evolve' ? (user && user.signature) || null : null};
  return {user:u, report};
}
