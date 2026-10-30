// node tests/colour.test.mjs
import assert from 'node:assert/strict';
import {
  CLASSIC, CLASSIC_KEYS, CLASH_DE, MIN_L, ACCENTS, cssOf, numOf, hexToOklch, oklchToHex, hexToOklab, oklabToRgb,
  deltaE, isReadable, readable, resolveClashes, riderColours, accentFromHue, defaultAccent
} from '../js/progression/colour.js';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);
const hueDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const pairwiseMin = list => { let m = Infinity; for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) m = Math.min(m, deltaE(list[i], list[j])); return m; };

console.log('colour.js');

test('cssOf / numOf normalise hex forms', () => {
  assert.equal(cssOf(0xff2a3d), '#ff2a3d');
  assert.equal(cssOf('#FF2A3D'), '#ff2a3d');
  assert.equal(cssOf('ff2a3d'), '#ff2a3d');
  assert.equal(cssOf('#f23'), '#ff2233');
  assert.equal(cssOf(0x00000f), '#00000f');
  assert.equal(cssOf('nope'), null); assert.equal(cssOf(null), null);
  assert.equal(numOf('#21d4ff'), 0x21d4ff);
});

test('OKLab reference values (white, red)', () => {
  const w = hexToOklab('#ffffff'); near(w[0], 1, 1e-4); near(w[1], 0, 1e-4); near(w[2], 0, 1e-4);
  const r = hexToOklch('#ff0000'); near(r.L, 0.6280, 1e-3); near(r.C, 0.2577, 1e-3); near(r.h, 29.23, 0.05);
});

test('OKLCH round trip is stable', () => {
  for (const hex of [...Object.values(CLASSIC), ...ACCENTS, '#123456', '#808080']) assert.equal(oklchToHex(hexToOklch(hex)), hex);
});

test('out-of-gamut OKLCH is chroma-reduced into sRGB, keeping hue', () => {
  const hex = oklchToHex({L:0.7, C:0.4, h:200});
  const rgb = oklabToRgb(hexToOklab(hex));
  rgb.forEach(v => assert.ok(v >= -0.003 && v <= 1.003));
  assert.ok(hueDiff(hexToOklch(hex).h, 200) < 3);
});

test('classic colours are readable and mutually distinct', () => {
  CLASSIC_KEYS.forEach(k => assert.ok(isReadable(CLASSIC[k]), k));
  assert.ok(pairwiseMin(Object.values(CLASSIC)) >= CLASH_DE);
  assert.deepEqual(resolveClashes(Object.values(CLASSIC)), Object.values(CLASSIC));
});

test('readable() lifts dark colours and greys, leaves good ones alone', () => {
  assert.equal(readable('#21d4ff'), '#21d4ff');
  for (const hex of ['#000000', '#200010', '#303030', '#0a1f44', '#5a5a5a']) {
    const out = readable(hex);
    assert.ok(isReadable(out), `${hex} -> ${out}`);
    assert.ok(hexToOklch(out).L >= MIN_L - 1e-3);
  }
});

test('identical colours: the later rider is hue-shifted just past the threshold', () => {
  const [a, b] = resolveClashes(['#ff2a3d', '#ff2a3d']);
  assert.equal(a, '#ff2a3d');
  const d = deltaE(a, b);
  assert.ok(d >= CLASH_DE, `distance ${d}`);
  assert.ok(d < CLASH_DE + 0.03, `shift should be minimal, got ${d}`);
  near(hexToOklch(b).L, hexToOklch(a).L, 0.02, 'lightness kept');
  assert.ok(hueDiff(hexToOklch(a).h, hexToOklch(b).h) < 45);
});

test('near-identical signatures are separated, distinct ones untouched', () => {
  const out = resolveClashes(['#3fd0c9', '#45d4c4', '#ff9f1c']);
  assert.equal(out[0], '#3fd0c9'); assert.equal(out[2], '#ff9f1c');
  assert.notEqual(out[1], '#45d4c4');
  assert.ok(pairwiseMin(out) >= CLASH_DE);
});

test('six riders on the same colour all end up distinct and readable', () => {
  const out = resolveClashes(Array(6).fill('#8cff2e'));
  assert.equal(new Set(out).size, 6);
  assert.ok(pairwiseMin(out) >= CLASH_DE, `min ${pairwiseMin(out)}`);
  out.forEach(c => assert.ok(isReadable(c), c));
});

test('six near-whites (no hue to turn) still separate', () => {
  const out = resolveClashes(['#e8eef8', '#eef0f4', '#f4f4f4', '#ffffff', '#e0e8f0', '#f0f8ff']);
  assert.ok(pairwiseMin(out) >= CLASH_DE, `min ${pairwiseMin(out)}`);
  out.forEach(c => assert.ok(isReadable(c), c));
});

test('dark and null entries: dark is made readable, null takes a free classic', () => {
  const out = resolveClashes(['#ff2a3d', null, '#101010', 0x21d4ff]);
  out.forEach(c => assert.match(c, /^#[0-9a-f]{6}$/));
  assert.equal(out[1], CLASSIC.ion);   // crimson is taken, ion is the first free classic
  assert.ok(isReadable(out[2]));
  assert.ok(pairwiseMin(out) >= CLASH_DE);
});

test('random lobbies: always separated and readable (deterministic sweep)', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 300; t++) {
    const n = 2 + Math.floor(rnd() * 5);
    const list = Array.from({length:n}, () => '#' + Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0'));
    const out = resolveClashes(list);
    assert.ok(pairwiseMin(out) >= CLASH_DE, `${list} -> ${out}`);
    out.forEach(c => assert.ok(isReadable(c), c));
  }
});

test('accent palette: 24 readable colours; slider gives readable colours at every hue', () => {
  assert.equal(ACCENTS.length, 24);
  ACCENTS.forEach(c => assert.ok(isReadable(c), c));
  for (let h = 0; h < 360; h += 15) { const c = accentFromHue(h); assert.ok(isReadable(c), `${h} ${c}`); }
});

test('riderColours: signature > classic key > crimson; accent chosen or derived', () => {
  assert.deepEqual(riderColours(null).primaryHex, CLASSIC.crimson);
  assert.equal(riderColours({color:'ion'}).primaryHex, CLASSIC.ion);
  const p = {color:'ion', signature:{hex:'#3fd0c9', name:'Signal Tide'}, accent:{hex:'#FFC23D'}};
  assert.deepEqual(riderColours(p), {primaryHex:'#3fd0c9', accentHex:'#ffc23d'});
  const d = riderColours({signature:{hex:'#3fd0c9'}});
  assert.equal(d.accentHex, defaultAccent('#3fd0c9'));
  assert.ok(isReadable(d.accentHex));
  assert.equal(riderColours({signature:{hex:'#000000'}}).primaryHex, readable('#000000'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
