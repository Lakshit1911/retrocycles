/* Colour maths for rider light: OKLab / OKLCH conversions, readability on the near-black arena,
   perceptual clash resolution for a lobby, and the helpers the renderer uses to pick a rider's colours.
   Pure: no DOM, no Firebase, runs in Node. Colours are '#rrggbb' strings unless noted. */

// The six classic Garage colours (mirrors VISUAL_CONFIG.riders in js/visuals/config.js; kept here so
// this module stays dependency-free). Riders without a signature still ride one of these.
export const CLASSIC = Object.freeze({
  crimson:'#ff2a3d', ion:'#21d4ff', solar:'#ffa21f', venom:'#8cff2e', violet:'#b44dff', platinum:'#e8eef8'
});
export const CLASSIC_KEYS = Object.keys(CLASSIC);

/* Readability on the arena (background #040508, heavy fog and bloom): walls need light, and mid-light
   colours need some chroma or they read as fog. Every classic colour already passes. */
export const MIN_L = 0.6;          // OKLab lightness floor
export const MAX_L = 0.95;
export const MID_L = 0.78;         // below this lightness ...
export const MIN_C = 0.08;         // ... a colour needs at least this much chroma
/* Two riders closer than this (Euclidean OKLab distance, the "deltaE OK" unit, 0..~0.5) are treated
   as clashing. The closest classic pair (ion / platinum) is ~0.19; 0.12 keeps colours apart through fog and
   bloom while still letting thousands of signatures coexist. */
export const CLASH_DE = 0.12;

export const HEX_RE = /^#[0-9a-f]{6}$/;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = h => ((h % 360) + 360) % 360;

/** Normalise 0xff2a3d / '#FF2A3D' / 'ff2a3d' / '#f23' to '#ff2a3d'. Returns null for anything else. */
export function cssOf(hex){
  if (typeof hex === 'number' && Number.isFinite(hex)) return '#' + (hex & 0xffffff).toString(16).padStart(6, '0');
  if (typeof hex !== 'string') return null;
  let s = hex.trim().toLowerCase().replace(/^#/, '').replace(/^0x/, '');
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map(c => c + c).join('');
  return /^[0-9a-f]{6}$/.test(s) ? '#' + s : null;
}
/** '#ff2a3d' -> 0xff2a3d (for three.js). */
export const numOf = hex => { const c = cssOf(hex); return c ? parseInt(c.slice(1), 16) : null; };

const toLin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const toGam = c => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** sRGB [0..1]^3 -> OKLab [L, a, b] (Björn Ottosson's matrices). */
export function rgbToOklab([R, G, B]){
  const r = toLin(R), g = toLin(G), b = toLin(B);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
/** OKLab -> sRGB [0..1]^3, unclamped (values outside 0..1 mean out of gamut). */
export function oklabToRgb([L, a, b]){
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [toGam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
          toGam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
          toGam(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
}
const hexToRgb = hex => { const c = cssOf(hex); return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255); };
const rgbToHex = rgb => '#' + rgb.map(v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
const inGamut = rgb => rgb.every(v => v >= -1e-4 && v <= 1 + 1e-4);

export const hexToOklab = hex => rgbToOklab(hexToRgb(hex));
/** '#rrggbb' -> {L, C, h} (h in degrees). */
export function hexToOklch(hex){
  const [L, a, b] = hexToOklab(hex);
  return {L, C:Math.hypot(a, b), h:wrap(Math.atan2(b, a) * 180 / Math.PI)};
}
/** {L, C, h} -> '#rrggbb', reducing chroma (keeping L and h) until it fits in sRGB. */
export function oklchToHex({L, C, h}){
  L = clamp(L, 0, 1); C = Math.max(0, C);
  const rad = h * Math.PI / 180, lab = c => [L, c * Math.cos(rad), c * Math.sin(rad)];
  if (inGamut(oklabToRgb(lab(C)))) return rgbToHex(oklabToRgb(lab(C)));
  let lo = 0, hi = C;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(oklabToRgb(lab(mid)))) lo = mid; else hi = mid; }
  return rgbToHex(oklabToRgb(lab(lo)));
}

/** Perceptual distance between two colours (Euclidean OKLab). */
export function deltaE(x, y){
  const p = hexToOklab(x), q = hexToOklab(y);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** True when a colour is light (and, if mid-light, colourful) enough to read as a light wall on the arena. */
export function isReadable(hex){
  const { L, C } = hexToOklch(hex);
  return L >= MIN_L - 1e-3 && L <= MAX_L + 1e-3 && (L >= MID_L || C >= MIN_C - 1e-3);
}
/** Nudge a colour into the readable range: raise lightness to MIN_L, give mid-light greys some chroma. */
export function readable(hex){
  const c = cssOf(hex);
  if (!c) return CLASSIC.crimson;
  if (isReadable(c)) return c;
  const lch = hexToOklch(c);
  lch.L = clamp(lch.L, MIN_L + 0.005, MAX_L);
  if (lch.L < MID_L) lch.C = Math.max(lch.C, MIN_C + 0.01);
  let out = oklchToHex(lch);
  // Gamut mapping can trim chroma below the floor at some hues: lift lightness until it reads
  for (let i = 0; !isReadable(out) && i < 40; i++) { lch.L = Math.min(MAX_L, lch.L + 0.01); out = oklchToHex(lch); }
  return out;
}

const minDist = (hex, placed) => placed.reduce((m, p) => Math.min(m, deltaE(hex, p)), Infinity);

/** Make every rider in a lobby distinguishable. colours: array (rider order = priority; earlier riders keep
    their colour) of hex strings/numbers (null = no preference, gets a classic colour). Each later rider that is
    within `threshold` of an earlier one has its hue rotated by the smallest angle that clears every earlier rider,
    keeping its lightness (so it stays readable). Returns an array of '#rrggbb' of the same length. */
export function resolveClashes(colours, {threshold = CLASH_DE, step = 1} = {}){
  const out = [];
  for (const raw of colours) {
    let hex = cssOf(raw);
    if (!hex) hex = CLASSIC_KEYS.map(k => CLASSIC[k]).find(c => minDist(c, out) >= threshold) || CLASSIC.crimson;
    hex = readable(hex);
    if (minDist(hex, out) < threshold) hex = shiftClear(hex, out, threshold, step);
    out.push(hex);
  }
  return out;
}
function shiftClear(hex, placed, threshold, step){
  const base = hexToOklch(hex);
  // Near-greys have no hue to turn: give them enough chroma for a hue shift to separate them
  const C = Math.max(base.C, 0.1);
  let best = hex, bestD = minDist(hex, placed);
  const tryLch = lch => {
    const cand = readable(oklchToHex(lch)), d = minDist(cand, placed);
    if (d > bestD) { best = cand; bestD = d; }
    return d >= threshold ? cand : null;
  };
  for (let d = step; d <= 180; d += step) {
    for (const s of [1, -1]) { const hit = tryLch({L:base.L, C, h:wrap(base.h + s * d)}); if (hit) return hit; }
  }
  // Hue alone was not enough (crowded lobby): also step lightness within the readable range
  for (const dL of [0.08, -0.08, 0.16, -0.16, 0.24]) {
    const L = clamp(base.L + dL, MIN_L + 0.005, MAX_L);
    for (let d = 0; d <= 180; d += 6) {
      for (const s of [1, -1]) { const hit = tryLch({L, C, h:wrap(base.h + s * d)}); if (hit) return hit; }
    }
  }
  return best;   // the most distinct option found
}

/* Secondary accent: 24 curated colours, all readable on the arena, plus any hue from the slider. */
export const ACCENTS = Object.freeze([
  '#ff4d5e', '#ff7a45', '#ff9f1c', '#ffc23d', '#ffe066', '#d4f05a', '#8cff2e', '#3ee07a',
  '#2ee6b8', '#21d4ff', '#4ab3ff', '#5b8cff', '#7a6cff', '#9b5cff', '#c45cff', '#ec5cff',
  '#ff5cc8', '#ff6f9c', '#f2a7c3', '#c9b8ff', '#9fe6ff', '#b8f5d0', '#f5e6c8', '#e8eef8'
]);
/** Accent colour for a hue-slider position (degrees): a bright, fairly saturated light. */
export const accentFromHue = h => readable(oklchToHex({L:0.8, C:0.15, h:wrap(h)}));
/** Hue (degrees) of a colour, for placing the slider. */
export const hueOf = hex => hexToOklch(hex).h;
/** Default accent when a rider has not chosen one: same hue as the primary, paler. */
export function defaultAccent(primary){
  const { L, C, h } = hexToOklch(primary);
  return readable(oklchToHex({L:Math.min(0.92, L + 0.12), C:C * 0.45, h}));
}

/** A rider's colours for the renderer. profile: users/{uid} (or any object with signature / accent / color).
    primary = signature light if revealed, else the Garage classic key, else crimson. Returns '#rrggbb' strings. */
export function riderColours(profile){
  const p = profile || {};
  const sig = p.signature && cssOf(p.signature.hex);
  const primaryHex = readable(sig || CLASSIC[p.color] || CLASSIC.crimson);
  const acc = p.accent && cssOf(p.accent.hex);
  return {primaryHex, accentHex:acc ? readable(acc) : defaultAccent(primaryHex)};
}
