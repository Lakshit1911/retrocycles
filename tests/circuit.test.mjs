// Unit tests for circuit mode (js/sim/free.js with a track, js/sim/track.js, js/sim/tracks/*).
// Run: node tests/circuit.test.mjs
import * as F from '../js/sim/free.js';
import { buildTrack, nearest } from '../js/sim/track.js';
import { encodeIn, decodeIn, inputQueue, queuePush, queueTake } from '../js/sim/link.js';
import stadium from '../js/sim/tracks/stadium.js';

let pass = 0, fail = 0;
function test(name, fn){
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.stack.split('\n').slice(0, 3).join('\n        ')); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const near = (a, b, eps, m) => assert(Math.abs(a - b) <= eps, `${m || ''} expected ${b} +- ${eps}, got ${a}`);
const PRESETS = {rookie:{react:[1, 3], bfs:40, noise:.4, turn:.012, hunt:0, boost:.15}, rider:{react:[3, 6], bfs:180, noise:.15, turn:.02, hunt:.35, boost:.5}, legend:{react:[5, 9], bfs:480, noise:.04, turn:.025, hunt:.8, boost:.9}};
const world = (o = {}) => F.createWorld({seed:o.seed || 7, track:stadium, cfg:o.cfg || {}});
const T0 = world().track;
// Pose on the centreline `d` cells along the loop from the start line (lat: + right), facing the race direction (back: facing backwards)
function pose(d, lat = 0, back = false){
  const T = T0, i = ((Math.round(d / T.ds) % T.M) + T.M) % T.M;
  return {x:T.X[i] + T.NX[i] * lat, z:T.Z[i] + T.NZ[i] * lat, h:Math.atan2(T.TZ[i], T.TX[i]) + (back ? Math.PI : 0)};
}
// A human-style autopilot: steer toward the centreline (plus lat) `look` cells ahead in direction dir
function pilot(w, r, {dir = 1, lat = 0, look = 7, boost = false, burst = false, brake = false} = {}){
  const T = w.track, j = ((r.fi + dir * Math.round(look / T.ds)) % T.M + T.M) % T.M;
  const tx = T.X[j] + T.NX[j] * lat, tz = T.Z[j] + T.NZ[j] * lat, d = F.wrap(Math.atan2(tz - r.z, tx - r.x) - r.h);
  return {steer:d > .03 ? 1 : d < -.03 ? -1 : 0, boost, snap:0, burst, brake};
}
const run = (w, ticks, fn) => { const ev = []; for (let i = 0; i < ticks; i++) { F.step(w, fn ? fn(w) : undefined); ev.push(...w.events); w.events.length = 0; } return ev; };
const runUntil = (w, cond, max, fn) => { const ev = []; for (let i = 0; i < max && !cond(w); i++) { F.step(w, fn ? fn(w) : undefined); ev.push(...w.events); w.events.length = 0; } return ev; };

console.log('track.js');
test('stadium: a closed loop of 600-900 cells, clean barriers, gates in race order', () => {
  const T = buildTrack(stadium);
  assert(T.L >= 600 && T.L <= 900, `lap length ${T.L.toFixed(1)}`);
  assert(T.gates.length >= 6 && T.gates[0].s === 0, 'start line plus checkpoints');
  for (let k = 1; k < T.gates.length; k++) assert(T.gates[k].s > T.gates[k - 1].s, 'gates in order');
  // centreline radius always clears the inner half-width
  for (let i = 0; i < T.M; i++) assert(1 / Math.max(1e-9, Math.abs(T.K[i])) > T.W[i] / 2 + .5, `too tight at ${i}`);
  // barriers never cross themselves; separate parts of the loop stay apart
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const X = (a, b, c, d) => o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  for (const A of [T.left, T.right]) {
    const n = A.length / 2 - 1, P = i => [A[2 * i], A[2 * i + 1]];
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) if (!(i === 0 && j === n - 1)) assert(!X(P(i), P(i + 1), P(j), P(j + 1)), `barrier crosses itself at ${i}/${j}`);
  }
  for (let i = 0; i < T.M; i += 2) for (let j = i + 40; j < T.M; j += 2) {
    if (T.M - (j - i) < 40) continue;
    assert(Math.hypot(T.X[i] - T.X[j], T.Z[i] - T.Z[j]) - T.W[i] / 2 - T.W[j] / 2 > 8, `parts ${i} and ${j} too close`);
  }
  // the features the brief asks for: a long straight, a narrow chicane, tight corners
  let run = 0, longest = 0;
  for (let i = 0; i < T.M * 2; i++) { if (Math.abs(T.K[i % T.M]) < .004) run++; else run = 0; longest = Math.max(longest, run); }
  assert(longest * T.ds > 120, `longest straight ${longest}`);
  assert(Math.min(...T.W) <= 8, 'a narrow section');
  assert(Math.max(...Array.from(T.K, Math.abs)) > 1 / 12, 'a tight corner');
  assert(T.pickups.length >= 8 && F.PICKUPS.every(k => T.pickups.some(p => p.kind === k)), 'every pickup kind on track');
});
test('nearest(): tracks the rider locally and recovers when lost', () => {
  const T = T0;
  for (let i = 0; i < T.M; i += 37) {
    const lat = (i % 5 - 2), x = T.X[i] + T.NX[i] * lat, z = T.Z[i] + T.NZ[i] * lat;
    assert(Math.abs(nearest(T, x, z, (i + 5) % T.M) - i) <= 1, 'local search');
    assert(Math.abs(nearest(T, x, z, (i + T.M / 2) % T.M | 0) - i) <= 1, 'lost: full scan');
  }
});

console.log('circuit race');
test('grid: riders line up behind the start line facing the race direction, no trails', () => {
  const w = world(), slots = F.gridSlots(w, 6);
  slots.forEach(s => F.addRider(w, s));
  for (const r of w.riders) {
    assert(r.prog < -3 && r.prog > -40, `grid slot progress ${r.prog}`);
    assert(Math.abs(F.wrap(r.h - Math.atan2(w.track.TZ[r.fi], w.track.TX[r.fi]))) < 1e-6, 'facing the race direction');
    assert(r.n === 0 && !r.lay, 'no wall by default');
  }
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) assert(Math.hypot(slots[a].x - slots[b].x, slots[a].z - slots[b].z) > 2, 'slots apart');
});
test('laps: every gate in order, line to line timing, finish after N laps', () => {
  const w = world({cfg:{circuit:{laps:2}}}), r = F.addRider(w, pose(-5));
  const ev = runUntil(w, w => r.done, 60 * 200, w => [pilot(w, r)]);
  const G = w.track.gates.length, gates = ev.filter(e => e.type === 'gate').map(e => e.gate);
  // the line closing lap 1 is a 'lap' event, not a 'gate'
  assert(gates.join() === [...Array(G).keys(), ...[...Array(G).keys()].slice(1)].join(), `gate order ${gates}`);
  assert(gates.length === 2 * G - 1, `gates passed ${gates.length}`);
  const laps = ev.filter(e => e.type === 'lap');
  assert(laps.length === 2 && laps[0].lap === 1 && laps[1].lap === 2, 'two laps');
  const fin = ev.find(e => e.type === 'finish');
  assert(fin && fin.place === 1 && r.done && r.place === 1, 'finished first');
  assert(r.best === Math.min(laps[0].t, laps[1].t) && laps[0].best, 'best lap');
  const L = w.track.L;
  assert(laps[0].t / 60 > L / (15 * 1.4) && laps[0].t / 60 < L / 12, `a cruise lap takes ${(laps[0].t / 60).toFixed(1)} s`);
  console.log(`        cruise autopilot laps: ${laps.map(e => (e.t / 60).toFixed(2) + ' s').join(', ')}`);
});
test('laps: wrong way and skipped gates count for nothing', () => {
  // backwards round the whole loop
  const w = world(), r = F.addRider(w, pose(30, 0, true));
  run(w, 60 * 70, w => [pilot(w, r, {dir:-1})]);
  assert(r.alive && r.gp === 0 && r.lap === 0, `backwards: gp ${r.gp} lap ${r.lap}`);
  assert(r.wrongT > 60, 'flagged as wrong way');
  // jump past a checkpoint: the next ones and the line don't count until it is crossed
  const w2 = world(), q = F.addRider(w2, pose(-5));
  runUntil(w2, () => q.gp === 3, 60 * 60, w => [pilot(w, q)]);
  const g4 = w2.track.gates[4].s, p = pose(g4 + 6);
  Object.assign(q, {x:p.x, z:p.z, h:p.h}); q.fi = nearest(w2.track, p.x, p.z);
  const ev = runUntil(w2, () => q.prog < 0 && false, 60 * 25, w => [pilot(w, q)]);
  assert(q.gp === 3 && !ev.some(e => e.type === 'lap'), `skipped checkpoint: gp ${q.gp}`);
});
test('respawn: smashed into a light wall, back at the last checkpoint after ~1 s, ghosting', () => {
  const w = world(), r = F.addRider(w, pose(-5));
  w.pk.fill(1e9);   // no pickups (a shield would save it)
  runUntil(w, () => r.gp === 3, 60 * 60, w => [pilot(w, r)]);
  // a light wall across the road ahead
  const T = w.track, i = (r.fi + 12) % T.M, h = T.W[i] / 2;
  F.addWall(w, [T.X[i] - T.NX[i] * h, T.Z[i] - T.NZ[i] * h, T.X[i] + T.NX[i] * h, T.Z[i] + T.NZ[i] * h]);
  const ev = runUntil(w, () => !r.alive, 120, w => [pilot(w, r)]);
  const c = ev.find(e => e.type === 'crash');
  assert(c && c.id === r.id && c.by === w.riders.length - 1, 'smashed by the wall');
  const t0 = w.tick;
  const ev2 = runUntil(w, () => r.alive, 200);
  const sp = ev2.find(e => e.type === 'respawn');
  near((w.tick - t0) / 60, w.cfg.circuit.respawn, .05, 'respawn delay');
  const g = T.gates[2];
  assert(sp && Math.hypot(r.x - T.X[g.i], r.z - T.Z[g.i]) < 6, 'at the last checkpoint gate');
  near(Math.abs(F.wrap(r.h - Math.atan2(T.TZ[r.fi], T.TX[r.fi]))), 0, .1, 'facing the track');
  assert(r.ghostT > 0 && r.gp === 3, 'ghosting, progress kept');
  // ghosting: rides straight through the wall it hit
  const ev3 = run(w, 60, w => [pilot(w, r)]);
  assert(r.alive && !ev3.some(e => e.type === 'crash'), 'ghost passes the wall');
  run(w, 60 * 2, w => [pilot(w, r)]);
  assert(r.ghostT === 0, 'ghost wears off');
});
test('Light Burst: a solid wall behind the rider; the one behind smashes, its owner never does', () => {
  const w = world(), a = F.addRider(w, pose(40)), b = F.addRider(w, pose(34));
  let ev = run(w, 30, w => [pilot(w, a, {burst:true}), pilot(w, b)]);
  assert(ev.some(e => e.type === 'burst' && e.id === a.id && e.on), 'burst started');
  assert(a.lay && a.n >= 2, 'laying a wall');
  ev = ev.concat(runUntil(w, () => !b.alive, 120, w => [pilot(w, a, {burst:true}), pilot(w, b)]));
  const c = ev.find(e => e.type === 'crash');
  assert(c && c.id === b.id && c.by === a.id, `follower smashed by the leader's wall (${JSON.stringify(c)})`);
  assert(a.alive, 'own wall never smashes its owner (ownIgnore)');
  assert(a.meter < w.cfg.circuit.burstStart, 'meter drains');
  // held on, the meter runs dry and the wall stops
  ev = runUntil(w, () => !a.lay, 60 * 5, w => [pilot(w, a, {burst:true})]);
  assert(a.meter <= .001 && ev.some(e => e.type === 'burst' && !e.on), 'stops when the meter is empty');
  const m0 = a.meter; run(w, 60, w => [pilot(w, a)]);
  near(a.meter - m0, w.cfg.circuit.burstRecharge, .002, 'recharges');
});
test('Light Burst: segments expire after burstLife and leave the hash', () => {
  const w = world(), a = F.addRider(w, pose(40));
  run(w, 40, w => [pilot(w, a, {burst:true})]);
  run(w, 10, w => [pilot(w, a)]);
  const P = a.pts.slice(0, 4), live = () => F.collides(w, {id:99, x:0, z:0, n:0, pd:[]}, P[0] - .3, P[1] - .3, P[2] + .3, P[3] + .3);
  assert(live(), 'wall solid');
  run(w, Math.round(w.cfg.circuit.burstLife * 60), w => [pilot(w, a)]);
  assert(!live(), 'wall expired');
  run(w, 130, w => [pilot(w, a)]);
  assert(w.S.own.every(o => o < 0), 'compacted out of the hash');
});
test('Light Burst: a short tap still lays burstMinT; no burst while ghosting', () => {
  const w = world(), a = F.addRider(w, pose(40));
  run(w, 1, w => [pilot(w, a, {burst:true})]);
  run(w, 5, w => [pilot(w, a)]);
  assert(a.lay, 'still laying after release');
  run(w, 20, w => [pilot(w, a)]);
  assert(!a.lay, 'stopped after the minimum');
  a.ghostT = 30;
  run(w, 5, w => [pilot(w, a, {burst:true})]);
  assert(!a.lay, 'ghosts cannot burst');
});
test('pickups: boost cell, shield, recharge, phase; respawn after the delay', () => {
  const T = T0;
  for (const kind of F.PICKUPS) {
    const k = T.pickups.findIndex(p => p.kind === kind), p = T.pickups[k];
    const w = world(), i0 = (p.i - 8 + T.M) % T.M;
    const lat = (p.x - T.X[p.i]) * T.NX[p.i] + (p.z - T.Z[p.i]) * T.NZ[p.i];
    const r = F.addRider(w, {x:T.X[i0] + T.NX[i0] * lat, z:T.Z[i0] + T.NZ[i0] * lat, h:Math.atan2(T.TZ[i0], T.TX[i0])});
    r.energy = .2; r.meter = .1;
    const ev = runUntil(w, () => w.pk[k] > 0, 60, w => [pilot(w, r, {lat, look:4})]);
    const e = ev.find(e => e.type === 'pickup');
    assert(e && e.kind === kind && e.id === r.id, `${kind} picked up`);
    if (kind === 'boost') near(r.energy, .2 + w.cfg.circuit.cell, .02, 'energy');
    if (kind === 'recharge') near(r.meter, 1, 1e-9, 'meter full');
    if (kind === 'phase') near(r.phaseT, w.cfg.circuit.phase * 60, 1, 'phase time');
    if (kind === 'shield') assert(r.shield === 1, 'shield armed');
    if (kind === 'shield' || kind === 'phase') {
      // a light wall across the road: the shield absorbs the smash, phase rides through it
      const j = (r.fi + 10) % T.M, h = T.W[j] / 2;
      F.addWall(w, [T.X[j] - T.NX[j] * h, T.Z[j] - T.NZ[j] * h, T.X[j] + T.NX[j] * h, T.Z[j] + T.NZ[j] * h]);
      const ev2 = run(w, 50, w => [pilot(w, r)]);
      assert(r.alive && !ev2.some(e => e.type === 'crash'), `${kind}: survived the wall`);
      if (kind === 'shield') assert(ev2.some(e => e.type === 'shield') && r.shield === 0, 'shield used up');
    }
    // gone until it respawns
    const back = w.pk[k];
    assert(back > w.tick && back - w.tick <= w.cfg.circuit.pickRespawn * 60, 'taken until it respawns');
    run(w, back - w.tick + 1);
    assert(w.pk[k] <= w.tick, 'available again');
  }
});
test('barriers: contact scrapes along (no crash), keeps the rider on the road and costs speed', () => {
  const w = world(), p = pose(60), r = F.addRider(w, {...p, h:p.h + .7});
  r.mul = 1.5;
  const ev = run(w, 90);
  assert(r.alive && !ev.some(e => e.type === 'crash'), 'no crash');
  assert(ev.some(e => e.type === 'scrape'), 'scrape event');
  const i = nearest(w.track, r.x, r.z), lat = (r.x - w.track.X[i]) * w.track.NX[i] + (r.z - w.track.Z[i]) * w.track.NZ[i];
  assert(Math.abs(lat) <= w.track.W[i] / 2 - w.cfg.radius + .01, `on the road (lat ${lat.toFixed(3)})`);
  near(Math.abs(F.wrap(r.h - Math.atan2(w.track.TZ[i], w.track.TX[i]))), 0, .35, 'heading turned along the barrier');
  // a long hard scrape at boost never tunnels out, all the way round
  const w2 = world(), q = F.addRider(w2, pose(10));
  q.energy = 1;
  run(w2, 60 * 30, w => [{steer:1, boost:true, snap:0}]);
  const T = w2.track, k = nearest(T, q.x, q.z), lat2 = (q.x - T.X[k]) * T.NX[k] + (q.z - T.Z[k]) * T.NZ[k];
  assert(q.alive && Math.abs(lat2) <= T.W[k] / 2, `still inside after 30 s of steering into the wall (lat ${lat2.toFixed(2)})`);
});
test('brake: slows toward the brake speed, and cancels boost', () => {
  const w = world(), r = F.addRider(w, pose(40));
  r.energy = 1;
  run(w, 60, w => [pilot(w, r, {boost:true, brake:true})]);
  assert(r.mul < .7 && !r.boosting && r.energy > .99, `mul ${r.mul}`);
});
test('race order: finished by place, then progress; out riders last', () => {
  const w = world(), [a, b, c, d] = [0, 1, 2, 3].map(k => F.addRider(w, pose(-5 - k * 3)));
  a.prog = 100; b.prog = 300; c.done = true; c.place = 1; d.out = true; d.prog = 900;
  assert(F.raceOrder(w).map(r => r.id).join() === [c.id, b.id, a.id, d.id].join());
});
test('determinism: circuit, AI racers, a human bursting and braking, same seed -> same hash', () => {
  const make = seed => {
    const w = F.createWorld({seed, track:stadium, cfg:{ai:PRESETS.legend}});
    F.gridSlots(w, 6).forEach((s, i) => F.addRider(w, {...s, ai:i > 0}));
    return w;
  };
  const human = w => [{...pilot(w, w.riders[0]), boost:(w.tick % 300) < 90, burst:(w.tick % 400) > 340, brake:(w.tick % 500) > 470}];
  const a = make(4321), b = make(4321), c = make(77), hashes = [];
  for (let k = 0; k < 8; k++) {
    run(a, 400, human); run(b, 400, human); run(c, 400, human);
    assert(F.stateHash(a) === F.stateHash(b), `diverged at tick ${a.tick}`);
    hashes.push(F.stateHash(a));
  }
  assert(F.stateHash(a) !== F.stateHash(c), 'a different seed races differently');
  assert(new Set(hashes).size === hashes.length, 'state keeps changing');
  assert(a.riders.some(r => r.pt.length > 4), 'light walls were laid');
});
test('AI: every preset finishes 3 laps without getting stuck (lap times)', () => {
  for (const [name, ai] of Object.entries(PRESETS)) {
    const w = F.createWorld({seed:3, track:stadium, cfg:{ai}});
    F.gridSlots(w, 6).forEach(s => F.addRider(w, {...s, ai:true}));
    const laps = [], stuck = [], t0 = performance.now();
    while (w.finished < 6 && w.tick < 60 * 360) {
      F.step(w);
      for (const e of w.events) { if (e.type === 'lap') laps.push(e.t / 60); if (e.type === 'crash' && e.by === -3) stuck.push(e.id); }
      w.events.length = 0;
    }
    const ms = (performance.now() - t0) / w.tick;
    assert(w.finished === 6, `${name}: ${w.finished} of 6 finished in ${(w.tick / 60).toFixed(0)} s`);
    assert(!stuck.length, `${name}: stuck resets ${stuck}`);
    const best = Math.min(...laps), avg = laps.reduce((x, y) => x + y, 0) / laps.length;
    console.log(`        ${name.padEnd(6)} race ${(w.tick / 60).toFixed(1)} s, best lap ${best.toFixed(2)} s, mean lap ${avg.toFixed(2)} s, crashes ${w.riders.reduce((n, r) => n + r.crashes, 0)}, ${ms.toFixed(3)} ms/tick`);
    assert(best > 25 && avg < 70, 'sane lap times');
  }
});
test('AI: rivals pick up items and fire Light Burst', () => {
  const w = F.createWorld({seed:9, track:stadium, cfg:{ai:PRESETS.legend}});
  F.gridSlots(w, 6).forEach(s => F.addRider(w, {...s, ai:true}));
  const ev = run(w, 60 * 90);
  assert(ev.filter(e => e.type === 'pickup').length >= 6, 'pickups');
  assert(ev.filter(e => e.type === 'burst' && e.on).length >= 3, 'bursts');
});

console.log('snapshots / network');
test('packRace / unpackRace and circuit wall points (ticks, pen-up gaps) round-trip', () => {
  const w = world(), a = F.addRider(w, pose(40));
  run(w, 25, w => [pilot(w, a, {burst:true})]); run(w, 30, w => [pilot(w, a)]); run(w, 25, w => [pilot(w, a, {burst:true})]);
  a.shield = 1; a.phaseT = 12;
  const g = world(), ga = F.addRider(g, {ghost:true, trail:false});
  F.unpack(ga, F.pack(a)); F.unpackRace(g, ga, F.packRace(a));
  for (const k of ['gp', 'lap', 'ghostT', 'phaseT', 'shield', 'lay', 'lapT0', 'best', 'done']) assert(ga[k] === a[k], k);
  near(ga.meter, a.meter, 1e-3, 'meter'); near(ga.prog, a.prog, .05, 'progress');
  const P = F.packPoints(a, 0), flat = P.slice(1).map((v, i) => i % 3 === 2 ? v : v / 100);
  F.setPoints(g, ga, 0, flat);
  assert(ga.n === a.n && ga.pt.join() === a.pt.join(), 'points and ticks');
  g.tick = w.tick;
  F.rebuild(w);
  assert(g.S.ax.length === w.S.ax.length, `same live segments (${g.S.ax.length} vs ${w.S.ax.length}): the gap is not a wall`);
});
test('inputs: burst and brake ride the input stream; arena codes unchanged', () => {
  for (const s of [-1, 0, 1]) for (const b of [false, true]) for (const n of [-1, 0, 1]) for (const x of [false, true]) for (const k of [false, true]) {
    const d = decodeIn(encodeIn(s, b, n, x, k));
    assert(d.steer === s && d.boost === b && d.snap === n && d.burst === x && d.brake === k, JSON.stringify([s, b, n, x, k, d]));
  }
  for (const s of [-1, 0, 1]) for (const b of [false, true]) for (const n of [-1, 0, 1])
    assert(encodeIn(s, b, n) === String.fromCharCode(97 + (s + 1) + 3 * (b ? 1 : 0) + 6 * (n + 1)), 'old codes');
  const Q = inputQueue();
  queuePush(Q, 0, encodeIn(1, false, 0, true, false));
  queueTake(Q);
  const i = queueTake(Q);
  assert(i.burst && i.steer === 1 && i.snap === 0, 'starved host keeps holding burst');
});
test('guest prediction: drive() scrapes like the host, so prediction matches', () => {
  const host = world(), guest = world(), p = pose(80), hr = F.addRider(host, {...p, h:p.h + .5}), gr = F.addRider(guest, {...p, h:p.h + .5, ghost:true});
  for (let t = 0; t < 120; t++) { const inp = {steer:t % 40 < 20 ? 1 : 0, boost:false, snap:0}; F.step(host, [inp]); F.drive(guest, gr, inp); }
  near(Math.hypot(hr.x - gr.x, hr.z - gr.z), 0, 1e-9, 'same position');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
