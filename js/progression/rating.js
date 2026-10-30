/* Glicko-2 skill rating (Glickman, "Example of the Glicko-2 system", 2013), plus the rules Phantom Run
   uses to turn a multi-rider match into rated games. Pure: no DOM, no Firebase, runs in Node.

   Rating shape: {r, rd, vol} on the familiar 1500 scale. A stored rating also carries
   n (rated matches this season, used for placement), season and updated (ms). */

export const SCALE = 173.7178;           // Glicko <-> Glicko-2 scale factor
export const TAU = 0.5;                  // system constant: how fast volatility may change
export const EPSILON = 1e-6;             // volatility iteration tolerance
export const DEFAULT = Object.freeze({r:1500, rd:350, vol:0.06});
export const RD_MIN = 30, RD_MAX = 350, VOL_MAX = 0.15, R_MIN = 100, R_MAX = 3999;
export const PLACEMENT = 5;              // rated matches in a season before a rider is placed (and their signature revealed)
export const SEASON_RD = 150;            // a new season raises RD to at least this, so placements matter again
export const DAY = 864e5;                // idle time inflates RD by one rating period per day

/* AI rivals are fixed, well-known opponents. A game against one counts at AI_WEIGHT.
   Solo matches therefore move the same rating, at half weight (see docs/progression.md). */
export const BOT_RATINGS = Object.freeze({
  rookie:Object.freeze({r:1200, rd:50}),
  rider:Object.freeze({r:1500, rd:50}),
  legend:Object.freeze({r:1800, rd:50})
});
export const AI_WEIGHT = 0.5;
// An opponent whose rating we could not read is treated as a brand-new rider: high RD, so it barely counts
export const UNKNOWN_OPPONENT = Object.freeze({r:1500, rd:350});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const g = phi => 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
const E = (mu, muj, phij) => 1 / (1 + Math.exp(-g(phij) * (mu - muj)));
const toMu = r => (r - 1500) / SCALE, toPhi = rd => rd / SCALE;

/** Expected score of a against b (0..1), Glicko-2 style (uses b's RD). */
export function expected(a, b){
  return E(toMu(a.r), toMu(b.r), toPhi(b.rd ?? DEFAULT.rd));
}

/** One rating period. games: [{r, rd, score (1 win, .5 draw, 0 loss), weight? (default 1)}].
    Weights scale each game's contribution to v and delta, so weight 1 everywhere is textbook Glicko-2.
    Returns the unclamped textbook result {r, rd, vol}. */
export function glicko2(player, games, tau = TAU){
  const mu = toMu(player.r), phi = toPhi(player.rd), sigma = player.vol ?? DEFAULT.vol;
  const gs = (games || []).filter(x => (x.weight ?? 1) > 0);
  if (!gs.length) return {r:player.r, rd:Math.sqrt(phi * phi + sigma * sigma) * SCALE, vol:sigma};
  let vInv = 0, sum = 0;
  for (const x of gs) {
    const w = x.weight ?? 1, muj = toMu(x.r), phij = toPhi(x.rd), gj = g(phij), e = E(mu, muj, phij);
    vInv += w * gj * gj * e * (1 - e);
    sum += w * gj * (x.score - e);
  }
  const v = 1 / vInv, delta = v * sum;
  // Step 5: new volatility (Illinois algorithm)
  const a = Math.log(sigma * sigma), phi2 = phi * phi, d2 = delta * delta;
  const f = x => { const ex = Math.exp(x), t = phi2 + v + ex; return ex * (d2 - phi2 - v - ex) / (2 * t * t) - (x - a) / (tau * tau); };
  let A = a, B;
  if (d2 > phi2 + v) B = Math.log(d2 - phi2 - v);
  else { let k = 1; while (f(a - k * tau) < 0) k++; B = a - k * tau; }
  let fA = f(A), fB = f(B);
  for (let i = 0; Math.abs(B - A) > EPSILON && i < 100; i++) {
    const C = A + (A - B) * fA / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  const sigma2 = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi2 + sigma2 * sigma2);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * sum;
  return {r:muNew * SCALE + 1500, rd:phiNew * SCALE, vol:sigma2};
}

/** Periods without games: RD grows (phi* = sqrt(phi^2 + sigma^2) per period), capped at RD_MAX. */
export function idle(player, periods){
  let phi = toPhi(player.rd);
  const s = player.vol ?? DEFAULT.vol;
  for (let i = 0; i < periods && phi * SCALE < RD_MAX; i++) phi = Math.sqrt(phi * phi + s * s);
  return {...player, rd:Math.min(RD_MAX, phi * SCALE)};
}

/** Keep stored numbers tidy and inside the bounds the database rules enforce. */
export function tidy(x){
  return {r:+clamp(x.r, R_MIN, R_MAX).toFixed(2), rd:+clamp(x.rd, RD_MIN, RD_MAX).toFixed(2), vol:+clamp(x.vol, 0.01, VOL_MAX).toFixed(6)};
}

/** Score of a against b from rounds won: finishing order, equal rounds = draw. */
export const pairScore = (mine, theirs) => mine > theirs ? 1 : mine < theirs ? 0 : 0.5;

/** Weight of each pairwise game in an N-rider match. 1 for a duel; 1/sqrt(N-1) otherwise, so a
    six-rider match counts as ~2.2 duels instead of 5 (pairwise results within one match are correlated). */
export const multiWeight = riders => riders > 2 ? 1 / Math.sqrt(riders - 1) : 1;

/** Turn a match summary into rated games for the local rider.
    summary: {diff, table:[{name, score, me, bot}]}; opponents: array aligned with summary.table holding
    {r, rd} for human rivals (null/undefined where unknown). Bots use BOT_RATINGS[summary.diff]. */
export function matchGames(summary, opponents = []){
  const table = (summary && summary.table) || [];
  const meRow = table.find(t => t.me);
  if (!meRow) return [];
  const w = multiWeight(table.length), bot = BOT_RATINGS[summary.diff] || BOT_RATINGS.rider;
  const games = [];
  table.forEach((row, i) => {
    if (row === meRow) return;
    const opp = row.bot ? bot : (opponents[i] && Number.isFinite(opponents[i].r) ? opponents[i] : UNKNOWN_OPPONENT);
    games.push({r:opp.r, rd:clamp(opp.rd ?? RD_MAX, RD_MIN, RD_MAX), score:pairScore(meRow.score || 0, row.score || 0),
      weight:w * (row.bot ? AI_WEIGHT : 1), bot:!!row.bot});
  });
  return games;
}

/** Board key: lexicographic order equals rating order within a season, so the leaderboard can range-query
    one season ("2026-Q4:1623"). Only placed riders get one. */
export const boardKey = (season, r, n) => n >= PLACEMENT ? `${season}:${String(Math.round(clamp(r, R_MIN, R_MAX))).padStart(4, '0')}` : null;

/** Bring a stored rating up to date before a match: new season (n resets, RD raised) and idle RD growth. */
export function carry(stored, season, now){
  const base = stored && Number.isFinite(stored.r) ? stored : {...DEFAULT, n:0, season, updated:now};
  let x = {r:base.r, rd:base.rd ?? DEFAULT.rd, vol:base.vol ?? DEFAULT.vol, n:base.n || 0, season:base.season || season, updated:base.updated || now};
  const days = Math.floor(Math.max(0, now - x.updated) / DAY);
  if (days > 0) x = idle(x, days);
  if (x.season !== season) x = {...x, rd:Math.max(x.rd, SEASON_RD), n:0, season};
  return x;
}

/** Rate one finished match. Returns {before, after, delta, games}. `after` is the stored shape
    {r, rd, vol, n, season, updated, board?}; n only counts matches that had at least one rated game. */
export function rateMatch(stored, summary, {opponents = [], season, now = Date.now()} = {}){
  const prior = carry(stored, season, now);
  const games = matchGames(summary, opponents);
  const before = stored && Number.isFinite(stored.r) ? stored.r : DEFAULT.r;
  if (!games.length) return {before, after:{...prior, ...tidy(prior), updated:now}, delta:0, games};
  const next = tidy(glicko2(prior, games));
  const n = prior.n + 1;
  const after = {...next, n, season, updated:now};
  const board = boardKey(season, next.r, n);
  if (board) after.board = board;
  return {before, after, delta:Math.round(next.r - before), games};
}
