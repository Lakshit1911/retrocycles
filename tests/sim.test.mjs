// Unit tests for the free-steering simulation. Run: node tests/sim.test.mjs
import * as F from '../js/sim/free.js';
import { encodeIn, decodeIn, inputQueue, queuePush, queueTake } from '../js/sim/link.js';

let pass = 0, fail = 0;
function test(name, fn){
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const near = (a, b, eps, m) => assert(Math.abs(a - b) <= eps, `${m || ''} expected ${b} +- ${eps}, got ${a}`);
const run = (w, ticks, inputs) => { for (let i = 0; i < ticks; i++) F.step(w, typeof inputs === 'function' ? inputs(w) : inputs); };
const wrap = F.wrap;
const solo = (o = {}, cfg = {}) => { const w = F.createWorld({seed:7, cfg}); const r = F.addRider(w, o); return {w, r}; };

console.log('free.js');

test('determinism: same seed and inputs give the identical state hash', () => {
  const make = seed => {
    const w = F.createWorld({seed, cfg:{ai:{react:[5, 9], bfs:480, noise:.04, turn:.025, hunt:.8, boost:.9}}});
    const sp = F.spawnRing(w, 6);
    sp.forEach((s, i) => F.addRider(w, {...s, ai:i > 0}));
    return w;
  };
  // a scripted human: weaving, boosting in bursts, snapping now and then
  const human = w => [{steer:Math.sin(w.tick / 40) > .3 ? 1 : Math.sin(w.tick / 40) < -.3 ? -1 : 0, boost:(w.tick % 180) < 50, snap:w.tick % 97 === 0 ? 1 : 0}];
  const a = make(1234), b = make(1234), c = make(99);
  const hashes = [];
  for (let k = 0; k < 6; k++) { run(a, 200, human); run(b, 200, human); run(c, 200, human); hashes.push(F.stateHash(a)); assert(F.stateHash(a) === F.stateHash(b), `diverged at tick ${a.tick}`); }
  assert(F.stateHash(a) !== F.stateHash(c), 'a different seed should give a different race');
  assert(a.riders.some(r => r.n > 50), 'riders should have laid long walls');
  assert(new Set(hashes).size === hashes.length, 'state should keep changing');
});

test('advance(): accumulator gives the same result as fixed steps', () => {
  const a = F.createWorld({seed:5}), b = F.createWorld({seed:5});
  [a, b].forEach(w => F.spawnRing(w, 4).forEach(s => F.addRider(w, {...s, ai:true})));
  let t = 0; const frames = [.016, .021, .007, .033, .05, .011];
  for (let i = 0; i < 300; i++) { const dt = frames[i % frames.length]; t += dt; F.advance(a, dt); }
  run(b, a.tick);
  assert(F.stateHash(a) === F.stateHash(b), 'accumulated and stepped worlds differ');
});

test('collision: running into a wall segment crashes at the wall', () => {
  const {w, r} = solo({x:0, z:0, h:0});
  F.addWall(w, [5, -5, 5, 5]);
  run(w, 60);
  assert(!r.alive, 'rider should have crashed');
  near(r.x, 5 - w.cfg.radius, .02, 'crash x');
  assert(w.events.some(e => e.type === 'crash' && e.id === r.id), 'crash event');
  // the wall is laid right up to the crash point
  near(r.pts[r.n * 2 - 2], r.x, 1e-9, 'last wall point');
});

test('collision: a fast rider cannot tunnel through a thin wall', () => {
  const {w, r} = solo({x:0, z:0, h:0});
  r.mul = 2; r.energy = 1;
  F.addWall(w, [3.3, -2, 3.3, 2]);
  run(w, 30, [{steer:0, boost:true, snap:0}]);
  assert(!r.alive && r.x < 3.3, `tunnelled to x=${r.x}`);
});

test('collision: head-on into another rider\'s fresh wall tip', () => {
  const w = F.createWorld({seed:1});
  const a = F.addRider(w, {x:-10, z:0, h:0}), b = F.addRider(w, {x:10, z:0, h:Math.PI});
  run(w, 60);
  assert(!a.alive && !b.alive, 'both should crash head-on');
});

test('narrow lanes: threads a 0.8-unit gap between two walls', () => {
  for (const [z, assist] of [[0, .5], [.1, .5], [.1, 0], [-.12, .5]]) {
    const {w, r} = solo({x:0, z, h:0}, {assist});
    F.addWall(w, [3, .4, 30, .4]); F.addWall(w, [3, -.4, 30, -.4]);
    run(w, 150);
    assert(r.alive && r.x > 30, `z=${z} assist=${assist}: crashed at ${r.x.toFixed(2)},${r.z.toFixed(2)}`);
  }
});

test('narrow lanes: lane assist pulls toward the centre of the gap', () => {
  const offs = {};
  for (const assist of [0, .5]) {
    const {w, r} = solo({x:0, z:.12, h:0}, {assist});
    F.addWall(w, [3, .4, 40, .4]); F.addWall(w, [3, -.4, 40, -.4]);
    run(w, 90);
    offs[assist] = Math.abs(r.z);
  }
  assert(offs[.5] < offs[0] * .6, `assist should centre the rider (off ${offs[0].toFixed(3)} vs on ${offs[.5].toFixed(3)})`);
});

test('narrow lanes: a 0.45-unit gap is too narrow', () => {
  const {w, r} = solo({x:0, z:0, h:0});
  F.addWall(w, [3, .225, 30, .225]); F.addWall(w, [3, -.225, 30, -.225]);
  run(w, 150);
  assert(!r.alive, 'should crash');
});

test('snap turn: instant 90 degrees with a corner point; one per snapGap', () => {
  const {w, r} = solo({x:0, z:0, h:0});
  run(w, 150);   // 37 units out, so there is a wall to ride back along
  const n = r.n;
  run(w, 1, [{steer:0, boost:false, snap:1}]);
  near(r.h, Math.PI / 2, 1e-9, 'heading');
  near(r.vx, 0, 1e-9, 'no slide after a snap');
  assert(r.n >= n + 1, 'corner point added');
  assert(w.events.some(e => e.type === 'snap' && e.dir === 1), 'snap event');
  // a second snap right away waits for the gap, then completes the U-turn
  const z0 = r.z;
  run(w, 1, [{steer:0, boost:false, snap:1}]);
  near(r.h, Math.PI / 2, 1e-9, 'second snap must wait');
  run(w, 10);
  near(Math.abs(wrap(r.h - Math.PI)), 0, 1e-9, 'second snap applied');
  near(r.z - z0, w.cfg.snapGap, .3, 'U-turn spacing');
  run(w, 60);   // 15 units back beside the outbound wall
  assert(r.alive, 'a U-turn beside your own wall is legal');
  assert(r.grind > 0, 'and it gives slipstream');
});
test('steering: holding steer turns, and boost carves wider than cruise', () => {
  const radius = boost => {
    const {w, r} = solo({x:0, z:0, h:0}, {assist:0});
    r.energy = 1;
    run(w, 60, [{steer:1, boost, snap:0}]);
    const h0 = r.h; run(w, 20, [{steer:1, boost, snap:0}]);
    return (15 * r.mul) / ((r.h - h0) / (20 / 60));
  };
  const slow = radius(false), fast = radius(true);
  assert(slow > 2 && slow < 8, `cruise radius ${slow.toFixed(2)}`);
  assert(fast > slow * 1.5, `boost radius ${fast.toFixed(2)} vs ${slow.toFixed(2)}`);
});

test('grip: hard steering at boost slides (lateral velocity), cruise barely', () => {
  const slide = boost => {
    const {w, r} = solo({x:0, z:0, h:0}, {assist:0});
    r.energy = 1; run(w, 40, [{steer:1, boost, snap:0}]);
    const fx = Math.cos(r.h), fz = Math.sin(r.h);
    return Math.abs(fx * r.vz - fz * r.vx) / Math.hypot(r.vx, r.vz);
  };
  const a = slide(false), b = slide(true);
  assert(b > a && b > .1, `slip angle cruise ${a.toFixed(3)} boost ${b.toFixed(3)}`);
});

test('boundary: riding off the arena crashes at the perimeter', () => {
  const {w, r} = solo({x:60, z:0, h:0});
  run(w, 30);
  assert(!r.alive, 'should crash');
  near(r.x, 64 - w.cfg.radius, .02, 'crash x');
});

test('own trail: the newest stretch is ignored, an old loop is not', () => {
  const {w, r} = solo({x:0, z:0, h:0}, {assist:0});
  run(w, 180, [{steer:1, boost:false, snap:0}]);   // tight circle: comes back round onto its own wall
  assert(!r.alive, 'closing a full circle onto your own wall crashes');
  assert(r.pd[r.n - 1] > 10, 'but only after a lap');
});

test('dead riders\' walls clear after the death window', () => {
  const {w, r} = solo({x:60, z:0, h:0});
  const other = F.addRider(w, {x:0, z:0, h:Math.PI / 2});
  run(w, 20);
  assert(!r.alive && r.n > 1, 'crashed with a wall');
  run(w, Math.ceil(w.cfg.deathWindow * 60) + 2);
  assert(r.cleared && r.n === 0, 'cleared');
  assert(w.S.own.every(o => o === other.id), 'hash rebuilt without it');
});

test('spatial hash: ray() matches a brute-force scan', () => {
  const w = F.createWorld({seed:3});
  const R = () => F.rand(w);
  for (let i = 0; i < 60; i++) { const x = R() * 120 - 60, z = R() * 120 - 60, a = R() * 6.3, l = 1 + R() * 20; F.addWall(w, [x, z, x + Math.cos(a) * l, z + Math.sin(a) * l]); }
  for (let i = 0; i < 400; i++) {
    const x = R() * 120 - 60, z = R() * 120 - 60, a = R() * 6.3, dx = Math.cos(a), dz = Math.sin(a), max = 5 + R() * 60;
    let best = max;
    for (let k = 0; k < w.S.ax.length; k++) {
      const ax = w.S.ax[k], az = w.S.az[k], ex = w.S.bx[k] - ax, ez = w.S.bz[k] - az, den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const qx = ax - x, qz = az - z, t = (qx * ez - qz * ex) / den, u = (qx * dz - qz * dx) / den;
      if (t >= 0 && u >= 0 && u <= 1 && t < best) best = t;
    }
    const h = 64; if (dx > 0) best = Math.min(best, (h - x) / dx); else best = Math.min(best, (-h - x) / dx);
    if (dz > 0) best = Math.min(best, (h - z) / dz); else best = Math.min(best, (-h - z) / dz);
    near(F.ray(w, null, x, z, dx, dz, max), best, 1e-9, `ray ${i}`);
  }
});

test('AI: rivals survive a while on an open arena and lay walls', () => {
  for (const preset of [{react:[1, 3], bfs:40, noise:.4, turn:.012, hunt:0, boost:.15}, {react:[5, 9], bfs:480, noise:.04, turn:.025, hunt:.8, boost:.9}]) {
    const w = F.createWorld({seed:11, cfg:{ai:preset}});
    F.spawnRing(w, 4).forEach(s => F.addRider(w, {...s, ai:true}));
    run(w, 300);
    assert(w.riders.filter(r => r.alive).length >= 3, `react ${preset.react}: too many early crashes`);
    assert(w.riders.every(r => !r.alive || r.n > 5), 'walls laid');
  }
});

test('performance: 6 riders, long trails, 60 s of racing', () => {
  const w = F.createWorld({seed:21});
  F.spawnRing(w, 6).forEach(s => F.addRider(w, {...s, ai:true}));
  const t0 = performance.now(); let ticks = 0;
  while (ticks < 3600 && w.riders.filter(r => r.alive).length > 1) { F.step(w); ticks++; }
  const ms = (performance.now() - t0) / ticks;
  console.log(`        ${ticks} ticks, ${ms.toFixed(3)} ms/tick, ${w.S.ax.length} wall segments`);
  assert(ms < 2, 'a tick should cost well under 2 ms');
});

test('pack/unpack round trip and network points', () => {
  const {w, r} = solo({x:3, z:-4, h:1});
  run(w, 50, [{steer:1, boost:true, snap:0}]);
  const g = F.createWorld({seed:1}), gr = F.addRider(g, {ghost:true, trail:false});
  F.unpack(gr, F.pack(r));
  near(gr.x, r.x, .006); near(gr.z, r.z, .006); near(gr.h, wrap(r.h), 1e-4); near(gr.mul, r.mul, 1e-3);
  // points arrive out of order: the later chunk waits for the earlier one
  const all = F.packPoints(r, 0), cut = 1 + 2 * 3;
  const late = [3, ...all.slice(cut)].map((v, i) => i ? v / 100 : v), early = all.slice(1, cut).map(v => v / 100);
  F.setPoints(g, gr, 3, late.slice(1));
  assert(gr.n === 0, 'waits for points 0..2');
  F.setPoints(g, gr, 0, early);
  assert(gr.n === r.n, `all points in (${gr.n} of ${r.n})`);
});

console.log('link.js');
test('input codes round-trip', () => {
  for (const s of [-1, 0, 1]) for (const b of [false, true]) for (const n of [-1, 0, 1]) {
    const d = decodeIn(encodeIn(s, b, n));
    assert(d.steer === s && d.boost === b && d.snap === n, JSON.stringify([s, b, n, d]));
  }
});
test('host input queue: in order, starving holds steering, backlog catches up', () => {
  const Q = inputQueue();
  queuePush(Q, 0, encodeIn(1, true, 0) + encodeIn(1, false, 1));
  let i = queueTake(Q); assert(i.steer === 1 && i.boost && Q.ack === 0);
  i = queueTake(Q); assert(i.snap === 1 && Q.ack === 1);
  i = queueTake(Q); assert(i.steer === 1 && !i.boost && i.snap === 0 && Q.ack === 1, 'starved: keep steering, no snap');
  queuePush(Q, 2, 'b'.repeat(12));
  i = queueTake(Q); assert(Array.isArray(i) && i.length === 2 && Q.ack === 3, 'backlog: two per tick');
  queuePush(Q, 0, 'zz');   // stale duplicates are ignored
  assert(!Q.buf.has(0));
});
test('prediction + reconciliation: the guest lands where the host has it (latency, batching)', () => {
  // Host world and guest world with the same static walls; batches reach the host LAT ticks late
  const LAT = 7, host = F.createWorld({seed:2}), guest = F.createWorld({seed:2});
  for (const w of [host, guest]) { F.addWall(w, [-60, -7, 60, -7]); F.addWall(w, [-60, 6, 60, 6]); }
  const hr = F.addRider(host, {x:-55, z:0, h:0}), gr = F.addRider(guest, {x:-55, z:0, h:0, ghost:true});
  const Q = inputQueue(), hist = [], wire = [];
  let seq = -1, out = '', outQ = 0, snaps = [];
  for (let t = 0; t < 320; t++) {
    // guest: predict one tick, batch the input every 3 ticks
    const inp = {steer:[1, -1, -1, 1, 0][Math.floor(t / 12) % 5], boost:t % 200 > 150, snap:t === 250 ? -1 : t === 254 ? 1 : 0};
    hist[++seq] = inp; F.drive(guest, gr, inp);
    if (!out) outQ = seq;
    out += encodeIn(inp.steer, inp.boost, inp.snap);
    if (out.length >= 3) { wire.push({at:t + LAT, q:outQ, s:out}); out = ''; }
    // host: deliver, step one tick, snapshot every 4 ticks (arrives LAT ticks later)
    while (wire.length && wire[0].at <= t) { const m = wire.shift(); queuePush(Q, m.q, m.s); }
    { const inp = []; inp[hr.id] = queueTake(Q); F.step(host, inp); }
    if (t % 4 === 0) snaps.push({at:t + LAT, a:F.pack(hr).concat(Q.ack)});
    while (snaps.length && snaps[0].at <= t) {
      const a = snaps.shift().a;
      F.unpack(gr, a);
      for (let q = a[12] + 1; q <= seq; q++) F.drive(guest, gr, hist[q]);
    }
  }
  assert(hr.alive, `host rider crashed at ${hr.x.toFixed(1)},${hr.z.toFixed(1)}`);
  // Flush: let the host consume everything, then the guest reconciles once more
  if (out) queuePush(Q, outQ, out);
  for (const m of wire) queuePush(Q, m.q, m.s);
  let extra = 0;
  while (Q.buf.size) { const inp = []; inp[hr.id] = queueTake(Q, 1e9); F.step(host, inp); extra++; }
  const a = F.pack(hr).concat(Q.ack);
  F.unpack(gr, a);
  for (let q = a[12] + 1; q <= seq; q++) F.drive(guest, gr, hist[q]);
  // the host starved at the start (no inputs yet): those ticks put it slightly ahead on the same path
  const starve = 320 + extra - (seq + 1);
  assert(starve >= 0 && starve <= 2 * LAT + 3, `starved ticks ${starve}`);
  near(Math.abs(wrap(gr.h - hr.h)), 0, .02, 'heading');
  near(Math.hypot(gr.x - hr.x, gr.z - hr.z), 0, .05, 'position after reconciling');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
