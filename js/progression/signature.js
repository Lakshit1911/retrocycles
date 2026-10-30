/* The colour ritual: a rider's signature light, derived deterministically from how they ride (hue) and how
   well (lightness and chroma), plus an evocative name generated from the colour. Pure: runs in Node.

   Hue comes from a 2D playstyle vector:
     x = aggression (+) vs caution (-)      y = composure (+) vs volatility (-)
   mapped around the OKLCH wheel, starting at a warm red for pure aggression:
     aggressive  -> red        aggressive + composed -> orange / amber   composed -> yellow-green
     cautious + composed -> green / teal   cautious -> cyan / blue   cautious + volatile -> blue / indigo
     volatile -> violet        aggressive + volatile -> magenta / rose
   Lightness and chroma come from the rating band: higher ratings burn brighter and hotter, the very top
   pales toward white-hot. A small per-rider offset (from the uid) separates riders with identical stats. */
import { oklchToHex, hexToOklch, readable, cssOf } from './colour.js';

export const HUE_ORIGIN = 25;                   // OKLCH hue for pure aggression (x = 1, y = 0)
export const DRIFT = Object.freeze({h:20, L:0.05, C:0.04});   // max change between seasons
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = h => ((h % 360) + 360) % 360;
const tanh = Math.tanh;

/** FNV-1a 32-bit hash -> unsigned int. */
export function hash(str){
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/* Metrics reported by the game (see docs/progression.md), summed per season under seasons/{id}/style. */
function metricsVector(st){
  const rounds = Math.max(1, st.rounds || 0), alive = Math.max(1, st.survivalSec || 0);
  const trapRate = (st.trapped || 0) / rounds;           // rivals who died on your walls, per round
  const closeRate = (st.closePasses || 0) / (alive / 60); // close passes per minute alive
  const boostShare = (st.boostSec || 0) / alive;          // share of time on boost
  const survival = (st.survivalSec || 0) / rounds;        // seconds alive per round
  const ownRate = (st.ownWall || 0) / rounds;             // rounds lost to your own wall
  const x = tanh((trapRate - 0.4) / 0.4) + 0.7 * tanh((closeRate - 3) / 3) + 0.5 * tanh((boostShare - 0.2) / 0.15);
  const y = tanh((survival - 30) / 20) - 0.8 * tanh((ownRate - 0.15) / 0.15);
  return {x:x / 2.2, y:y / 1.8};
}
/* Fallback from counters the game already records: appetite for hard rivals and online grids (aggression),
   win rate and how long matches run (composure). */
function statsVector(s){
  const total = (s.matches || 0) + (s.soloMatches || 0);
  if (!total) return {x:0, y:0};
  const onlineShare = (s.matches || 0) / total;
  const winRate = ((s.wins || 0) + (s.soloWins || 0)) / total;
  const roundShare = s.roundsPlayed ? (s.roundsWon || 0) / s.roundsPlayed : winRate;
  const diffAvg = s.diffN ? (s.diffSum || 0) / s.diffN : 1;       // rookie 0, rider 1, legend 2
  const perMatch = (s.roundsPlayed || 0) / total;
  // Each feature is centred on a typical rider (mostly solo, Rider difficulty, ~40% wins), so an average
  // rider sits near the middle and the per-rider offset spreads them around the whole wheel
  const x = 0.9 * (diffAvg - 1) + 0.6 * (onlineShare - 0.3) / 0.7 + 0.6 * clamp((roundShare - 0.35) / 0.35, -1, 1);
  const y = 0.9 * clamp((winRate - 0.4) / 0.4, -1, 1.5) + 0.5 * tanh((perMatch - 8) / 4);
  return {x:x / 2.1, y:y / 1.4};
}

/** Playstyle of a season: {x, y, source, archetype}. Metrics take over from the fallback as matches with
    metrics accumulate (fully after 5). */
export function styleVector(stats){
  const s = stats || {}, st = s.style || {};
  const wM = clamp((st.n || 0) / 5, 0, 1);
  const a = statsVector(s), b = wM > 0 ? metricsVector(st) : {x:0, y:0};
  const x = clamp(a.x * (1 - wM) + b.x * wM, -1, 1), y = clamp(a.y * (1 - wM) + b.y * wM, -1, 1);
  return {x, y, source:wM >= 1 ? 'metrics' : wM > 0 ? 'blend' : 'stats', archetype:archetype(x, y)};
}
/** One-word reading of a style vector, for the profile. */
export function archetype(x, y){
  if (Math.hypot(x, y) < 0.12) return 'Balanced';
  return x >= 0 ? (y >= 0 ? 'Hunter' : 'Daredevil') : (y >= 0 ? 'Sentinel' : 'Drifter');
}

/** Lightness and chroma for a rating. */
export function band(r){
  const t = clamp(((r || 1500) - 1000) / 1100, 0, 1);
  const L = 0.68 + 0.17 * t;
  const C = 0.12 + 0.1 * t - (t > 0.8 ? (t - 0.8) * 0.25 : 0);
  return {L, C, t, tier:t < 0.25 ? 'Ember' : t < 0.5 ? 'Spark' : t < 0.75 ? 'Flare' : t < 0.92 ? 'Nova' : 'White-hot'};
}

/** Target colour (no drift) as {L, C, h}. */
export function targetLch({uid = '', stats, r}){
  const v = styleVector(stats), seed = hash(String(uid));
  // personal bias: a short vector in a direction fixed by the uid, plus a few degrees of jitter
  const ang = (seed % 3600) / 3600 * Math.PI * 2, bias = 0.16;
  const x = v.x + bias * Math.cos(ang), y = v.y + bias * Math.sin(ang);
  const jitter = ((seed >>> 12) % 1601) / 100 - 8;          // -8 .. +8 degrees
  const h = wrap(HUE_ORIGIN + Math.atan2(y, x) * 180 / Math.PI + jitter);
  const { L, C } = band(r);
  return {L, C, h};
}

const hueStep = (from, to) => ((to - from + 540) % 360) - 180;   // shortest signed difference
/** Limit a seasonal change to DRIFT around the previous signature. */
export function drift(prevHex, target){
  const p = hexToOklch(prevHex);
  const dh = clamp(hueStep(p.h, target.h), -DRIFT.h, DRIFT.h);
  return {h:wrap(p.h + dh), L:clamp(target.L, p.L - DRIFT.L, p.L + DRIFT.L), C:clamp(target.C, Math.max(0, p.C - DRIFT.C), p.C + DRIFT.C)};
}

/** Compute a signature. prev: the stored signature from an earlier season (or null). Returns
    {hex, name, season} (the caller adds revealedAt). Same inputs always give the same colour and name. */
export function computeSignature({uid, season, stats, r, prev}){
  let lch = targetLch({uid, stats, r});
  const prevHex = prev && cssOf(prev.hex);
  if (prevHex && prev.season !== season) lch = drift(prevHex, lch);
  else if (prevHex && prev.season === season) return {hex:prevHex, name:prev.name || signatureName(prevHex), season};
  const hex = readable(oklchToHex(lch));
  return {hex, name:signatureName(hex), season};
}

/* ---------- Names ---------- */
// First word by brightness (deep / lit / bright), second word by hue family. Original, tasteful, single words.
const FIRST = {
  deep:['Midnight', 'Harbor', 'Velvet', 'Hollow', 'Undertow', 'Lantern', 'Dusk', 'Basalt', 'Nocturne', 'Moorland', 'Cellar', 'Quiet'],
  lit:['Signal', 'Meridian', 'Northern', 'Paper', 'Static', 'Copper', 'Distant', 'Fable', 'Winter', 'Canal', 'Orbit', 'Tempest'],
  bright:['Glacier', 'Halcyon', 'Zenith', 'Solstice', 'Daybreak', 'Crystal', 'Aurora', 'Summit', 'Lumen', 'Mirror', 'Skyline', 'Equinox']
};
const SECOND = {
  red:['Ember', 'Cinder', 'Verdict', 'Rally', 'Flare', 'Ruby', 'Vow', 'Pulse'],
  orange:['Kiln', 'Amber', 'Furnace', 'Ochre', 'Wager', 'Torch', 'Harvest', 'Comet'],
  yellow:['Gilt', 'Saffron', 'Beacon', 'Citrine', 'Halo', 'Brass', 'Honey', 'Chorus'],
  green:['Verdant', 'Fern', 'Jade', 'Canopy', 'Thicket', 'Moss', 'Sprig', 'Orchard'],
  cyan:['Tide', 'Current', 'Lagoon', 'Frost', 'Drift', 'Reef', 'Spindrift', 'Glass'],
  blue:['Cobalt', 'Verse', 'Sapphire', 'Monsoon', 'Indigo', 'Fathom', 'Echo', 'Vigil'],
  violet:['Orchid', 'Reverie', 'Amethyst', 'Hymn', 'Twilight', 'Iris', 'Mirage', 'Sonnet'],
  magenta:['Peony', 'Rosewood', 'Garnet', 'Fandango', 'Crush', 'Ballad', 'Bloom', 'Riot'],
  neutral:['Pearl', 'Pewter', 'Chalk', 'Mist', 'Silver', 'Quartz', 'Ash', 'Linen']
};
export function hueFamily({C, h}){
  if (C < 0.05) return 'neutral';
  if (h < 45 || h >= 345) return 'red';
  if (h < 80) return 'orange';
  if (h < 120) return 'yellow';
  if (h < 170) return 'green';
  if (h < 215) return 'cyan';
  if (h < 265) return 'blue';
  if (h < 310) return 'violet';
  return 'magenta';
}
/** Deterministic evocative name for a colour, e.g. "Midnight Ember", "Glacier Verdict". */
export function signatureName(hex){
  const c = cssOf(hex) || '#ffffff', lch = hexToOklch(c), h = hash(c);
  const first = FIRST[lch.L < 0.74 ? 'deep' : lch.L < 0.83 ? 'lit' : 'bright'];
  const second = SECOND[hueFamily(lch)];
  return `${first[h % first.length]} ${second[(h >>> 8) % second.length]}`;
}
