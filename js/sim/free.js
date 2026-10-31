/* Free-steering simulation: continuous position and heading, every rider leaves a polyline wall.
   Pure module (no THREE, no DOM): fixed 1/60 s steps, seeded RNG whose state lives on the world,
   so the same inputs always give the same world. Runs the race in solo / host, predicts the local
   rider on guests, and can later run unchanged on an authoritative server.

   Coordinates: world units = grid cells, arena centred on the origin, perimeter at +-size/2.
   Heading h: forward = (cos h, sin h); h grows when turning right (the grid's +1 turn).

   API
     createWorld({seed, cfg})          new world (cfg overrides SIM_CONFIG, cfg.ai = difficulty preset)
     addRider(w, {x, z, h, ai, ghost, trail})   rider record (trail:false = start with no points)
     spawn(w, r, x, z, h, trail)       reset a rider in place (fresh world only, or rebuild after)
     spawnRing(w, n)                   n start poses on a ring, facing the centre (uses the world RNG)
     step(w, inputs)                   one tick; inputs[id] = {steer:-1|0|1, boost, snap:-1|0|1} or an
                                       array of them (several sub-steps, for a host catching up)
     advance(w, dt, inputs)            fixed-step accumulator; inputs may be a function(w) -> inputs
     drive(w, r, input)                movement only (no walls laid, no crash): guest prediction
     collides(w, r, x0, z0, x1, z1)    would the rider's circle sweeping x0,z0 -> x1,z1 touch a wall?
     ray(w, r, x, z, dx, dz, max)      distance to the first wall along a unit ray (r: rider to ignore)
     setPoints(w, r, start, flat)      add wall points received from the network (index start)
     addWall(w, flat)                  static wall that never clears
     clearTrail(w, r), kill(w, r), rebuild(w)
     pack(r) / unpack(r, a)            compact integer rider state for snapshots
     stateHash(w)                      hash of the full simulated state (determinism checks)
   Events (crash, snap) collect in w.events for the caller to drain. */
import { SIM_CONFIG } from './config.js';

export const DT = 1 / 60;
const TAU = Math.PI * 2, HALF_PI = Math.PI / 2;
export const wrap = a => a - TAU * Math.floor((a + Math.PI) / TAU);
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const IDLE = Object.freeze({steer:0, boost:false, snap:0});

// mulberry32; the whole RNG state is one integer on the world, so it hashes and serialises
export function rand(w){
  let t = (w.rs = (w.rs + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createWorld(o = {}){
  const cfg = Object.assign({}, SIM_CONFIG, o.cfg || {});
  const nb = Math.ceil(cfg.size / cfg.bucket);
  return {cfg, half:cfg.size / 2, nb, tick:0, acc:0, rs:(o.seed >>> 0) || 1, riders:[], events:[],
    // spatial hash: each bucket lists the wall segments crossing it; segments live in parallel arrays
    buckets:Array.from({length:nb * nb}, () => []), S:{ax:[], az:[], bx:[], bz:[], own:[], i:[], mark:[]}, q:0};
}

export function addRider(w, o = {}){
  const r = {id:w.riders.length, ai:!!o.ai, ghost:!!o.ghost, pts:[], pd:[], n:0, pend:null,
    in:{steer:0, boost:false, snap:0}, aiIn:{steer:0, boost:false, snap:0}};
  w.riders.push(r);
  spawn(w, r, o.x || 0, o.z || 0, o.h || 0, o.trail !== false);
  return r;
}

export function spawn(w, r, x, z, h, trail = true){
  const v = w.cfg.base;
  Object.assign(r, {x, z, h, px:x, pz:z, ph:h, vx:Math.cos(h) * v, vz:Math.sin(h) * v, sv:0, mul:1,
    energy:w.cfg.energy, grind:0, boosting:false, alive:true, deathT:0, cleared:false, snapQ:[], snapCool:0,
    hp:h, held:false, wantBoost:false, think:0, aim:h});
  r.pts.length = 0; r.pd.length = 0; r.n = 0; r.pend = null;
  if (trail) addPoint(w, r, x, z);
}

export function spawnRing(w, n, frac = .34){
  const rad = Math.floor(w.cfg.size * frac), off = rand(w) * TAU;
  return Array.from({length:n}, (_, i) => {
    const a = off + i * TAU / n;
    return {x:Math.cos(a) * rad, z:Math.sin(a) * rad, h:wrap(a + Math.PI)};
  });
}

/* ---------- Walls ---------- */
function addPoint(w, r, x, z){
  const n = r.n;
  r.pts.push(x, z); r.n++; r.hp = r.h;
  if (!n) { r.pd.push(0); return; }
  const lx = r.pts[2 * n - 2], lz = r.pts[2 * n - 1], dx = x - lx, dz = z - lz;
  r.pd.push(r.pd[n - 1] + Math.sqrt(dx * dx + dz * dz));
  insert(w, r.id, n - 1, lx, lz, x, z);
}

function bucketRange(w, x0, z0, x1, z1, pad){
  const B = w.cfg.bucket, h = w.half, m = w.nb - 1;
  const c = v => v < 0 ? 0 : v > m ? m : v;
  return [c(Math.floor((Math.min(x0, x1) - pad + h) / B)), c(Math.floor((Math.min(z0, z1) - pad + h) / B)),
          c(Math.floor((Math.max(x0, x1) + pad + h) / B)), c(Math.floor((Math.max(z0, z1) + pad + h) / B))];
}

function insert(w, own, i, ax, az, bx, bz){
  const S = w.S, k = S.ax.length;
  S.ax.push(ax); S.az.push(az); S.bx.push(bx); S.bz.push(bz); S.own.push(own); S.i.push(i); S.mark.push(0);
  const [i0, j0, i1, j1] = bucketRange(w, ax, az, bx, bz, 0);
  for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) w.buckets[ii + j * w.nb].push(k);
}

export function rebuild(w){
  const S = w.S;
  for (const key in S) S[key].length = 0;
  w.buckets.forEach(b => { b.length = 0; });
  for (const r of w.riders) {
    if (r.cleared) continue;
    for (let i = 1; i < r.n; i++) insert(w, r.id, i - 1, r.pts[2 * i - 2], r.pts[2 * i - 1], r.pts[2 * i], r.pts[2 * i + 1]);
  }
}

export function clearTrail(w, r){
  r.cleared = true; r.pts.length = 0; r.pd.length = 0; r.n = 0; r.pend = null;
  rebuild(w);
}

export function kill(w, r){ if (r.alive) { r.alive = false; r.deathT = 0; } }

// A static wall (flat x,z list) that never clears: arena features and tests
export function addWall(w, flat){
  const r = addRider(w, {ghost:true, trail:false});
  r.alive = false; r.deathT = -Infinity; r.wall = true;
  setPoints(w, r, 0, flat);
  return r;
}

// Network walls: points [start, start+1, ...] as a flat x,z list; out-of-order chunks wait their turn
export function setPoints(w, r, start, flat){
  if (r.cleared) return;
  if (start > r.n) { (r.pend || (r.pend = {}))[start] = flat; return; }
  for (let j = (r.n - start) * 2; j + 1 < flat.length; j += 2) addPoint(w, r, flat[j], flat[j + 1]);
  if (r.pend && r.pend[r.n]) { const f = r.pend[r.n], s = r.n; delete r.pend[s]; setPoints(w, r, s, f); }
}

// Own wall closer than ownIgnore to the head (along the trail) is still being laid: it never counts
function recentFrom(w, r){
  if (!r || !r.n) return Infinity;
  const n = r.n, dx = r.x - r.pts[2 * n - 2], dz = r.z - r.pts[2 * n - 1];
  return r.pd[n - 1] + Math.sqrt(dx * dx + dz * dz) - w.cfg.ownIgnore;
}

// Squared distance between segments a-b and c-d (Ericson, Real-Time Collision Detection 5.1.9)
export function segDist2(ax, az, bx, bz, cx, cz, dx, dz){
  const ux = bx - ax, uz = bz - az, vx = dx - cx, vz = dz - cz, rx = ax - cx, rz = az - cz;
  const a = ux * ux + uz * uz, e = vx * vx + vz * vz, f = vx * rx + vz * rz;
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) return rx * rx + rz * rz;
  if (a <= 1e-12) t = clamp01(f / e);
  else {
    const c = ux * rx + uz * rz;
    if (e <= 1e-12) s = clamp01(-c / a);
    else {
      const b = ux * vx + uz * vz, den = a * e - b * b;
      s = den > 1e-12 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const px = rx + ux * s - vx * t, pz = rz + uz * s - vz * t;
  return px * px + pz * pz;
}

// Ray o + t*d against segment a-b: t, or -1 for a miss
function raySeg(x, z, dx, dz, ax, az, bx, bz){
  const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
  if (den > -1e-12 && den < 1e-12) return -1;
  const qx = ax - x, qz = az - z, t = (qx * ez - qz * ex) / den, u = (qx * dz - qz * dx) / den;
  return t >= 0 && u >= 0 && u <= 1 ? t : -1;
}

/* The rider's circle sweeping from x0,z0 to x1,z1: does it touch the perimeter, any wall in the
   hash (minus its own newest stretch) or another live rider's wall tip (last point -> head)? */
export function collides(w, r, x0, z0, x1, z1){
  const rad = w.cfg.radius, rr = rad * rad, lim = w.half - rad;
  if (x1 < -lim || x1 > lim || z1 < -lim || z1 > lim) return true;
  const S = w.S, q = ++w.q, rec = recentFrom(w, r), [i0, j0, i1, j1] = bucketRange(w, x0, z0, x1, z1, rad);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const bk = w.buckets[i + j * w.nb];
    for (let n = 0; n < bk.length; n++) {
      const k = bk[n];
      if (S.mark[k] === q) continue;
      S.mark[k] = q;
      if (S.own[k] === r.id && r.pd[S.i[k] + 1] > rec) continue;
      if (segDist2(x0, z0, x1, z1, S.ax[k], S.az[k], S.bx[k], S.bz[k]) < rr) return true;
    }
  }
  for (const o of w.riders) {
    if (o === r || !o.alive || !o.n) continue;
    const m = o.n * 2;
    if (segDist2(x0, z0, x1, z1, o.pts[m - 2], o.pts[m - 1], o.x, o.z) < rr) return true;
  }
  return false;
}

/* Distance along a unit ray to the first wall (perimeter included), capped at max. Walks the hash
   buckets the ray crosses (Amanatides-Woo) and stops once a hit is closer than the next bucket. */
export function ray(w, r, x, z, dx, dz, max){
  const h = w.half, B = w.cfg.bucket, nb = w.nb, S = w.S;
  let best = max;
  if (dx > 1e-9) best = Math.min(best, (h - x) / dx); else if (dx < -1e-9) best = Math.min(best, (-h - x) / dx);
  if (dz > 1e-9) best = Math.min(best, (h - z) / dz); else if (dz < -1e-9) best = Math.min(best, (-h - z) / dz);
  if (best <= 0) return 0;
  const q = ++w.q, rec = recentFrom(w, r), id = r ? r.id : -1;
  let ix = Math.min(nb - 1, Math.max(0, Math.floor((x + h) / B))), iz = Math.min(nb - 1, Math.max(0, Math.floor((z + h) / B)));
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx ? Math.abs(B / dx) : Infinity, tdz = dz ? Math.abs(B / dz) : Infinity;
  let tx = dx ? ((ix + (dx > 0 ? 1 : 0)) * B - (x + h)) / dx : Infinity;
  let tz = dz ? ((iz + (dz > 0 ? 1 : 0)) * B - (z + h)) / dz : Infinity;
  for (;;) {
    const bk = w.buckets[ix + iz * nb];
    for (let n = 0; n < bk.length; n++) {
      const k = bk[n];
      if (S.mark[k] === q) continue;
      S.mark[k] = q;
      if (S.own[k] === id && r.pd[S.i[k] + 1] > rec) continue;
      const t = raySeg(x, z, dx, dz, S.ax[k], S.az[k], S.bx[k], S.bz[k]);
      if (t >= 0 && t < best) best = t;
    }
    const next = Math.min(tx, tz);
    if (next >= best) break;
    if (tx < tz) { ix += sx; tx += tdx; } else { iz += sz; tz += tdz; }
    if (ix < 0 || iz < 0 || ix >= nb || iz >= nb) break;
  }
  for (const o of w.riders) {
    if (o === r || !o.alive || !o.n) continue;
    const m = o.n * 2, t = raySeg(x, z, dx, dz, o.pts[m - 2], o.pts[m - 1], o.x, o.z);
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

/* ---------- Riding ---------- */
function queueSnap(r, t){ if (r.snapQ.length < 2) r.snapQ.push(t > 0 ? 1 : -1); }

/* One tick of movement for one rider: steering, grip, boost/slipstream energy, snap turns and lane
   assist. Lays no wall and never crashes (stepRider does). Returns the snap direction taken, or 0. */
export function drive(w, r, inp = IDLE, dt = DT){
  const C = w.cfg;
  if (inp.snap) queueSnap(r, inp.snap);
  const steer = inp.steer || 0;
  r.sv += (steer - r.sv) * Math.min(1, dt * C.steerResp);
  // Boost and slipstream exactly as grid mode
  const boosting = r.boosting = !!inp.boost && r.energy > .02;
  if (boosting) r.energy = Math.max(0, r.energy - dt * C.drain);
  if (r.grind > 0) r.energy = Math.min(1, r.energy + dt * C.recharge);
  r.grind = Math.max(0, r.grind - dt);
  r.mul += ((boosting ? C.boost : 1) + (r.grind > 0 ? C.slipBonus : 0) - r.mul) * Math.min(1, dt * C.ease);
  const speed = C.base * r.mul;
  let snapped = 0;
  r.snapCool -= speed * dt;
  if (r.snapQ.length && r.snapCool <= 0) {
    // Snap turn: an instant 90 degree corner; the slide is dropped along with the old heading
    snapped = r.snapQ.shift(); r.h += snapped * HALF_PI; r.snapCool = C.snapGap;
    r.vx = Math.cos(r.h) * speed; r.vz = Math.sin(r.h) * speed;
  } else {
    // Yaw rate falls with speed: tight carving when slow, wider arcs at boost
    const k = clamp01((speed - C.vLo) / (C.vHi - C.vLo));
    r.h += r.sv * (C.yawLo + (C.yawHi - C.yawLo) * k) * dt;
    if (C.assist > 0 && !steer) laneAssist(w, r, dt);
  }
  // Grip: forward speed follows the throttle, the sideways slide bleeds off (less grip when fast)
  const fx = Math.cos(r.h), fz = Math.sin(r.h);
  const lat = (fx * r.vz - fz * r.vx) * Math.exp(-C.grip / Math.pow(r.mul, C.gripFall) * dt);
  r.vx = fx * speed - fz * lat; r.vz = fz * speed + fx * lat;
  r.x += r.vx * dt; r.z += r.vz * dt;
  // Slipstream: a wall (or the perimeter) within reach on either side
  if (ray(w, r, r.x, r.z, -fz, fx, C.slip) < C.slip || ray(w, r, r.x, r.z, fz, -fx, C.slip) < C.slip) r.grind = C.grindHold;
  return snapped;
}

/* Lane assist: if the way ahead is clear but walls close in on both sides a little further on,
   nudge the heading toward the middle of that gap. Only while the rider isn't steering. */
function laneAssist(w, r, dt){
  const C = w.cfg, L = C.assistAhead, W = C.assistWidth, fx = Math.cos(r.h), fz = Math.sin(r.h);
  if (ray(w, r, r.x, r.z, fx, fz, L) < L) return;
  const px = r.x + fx * L, pz = r.z + fz * L;
  const dl = ray(w, r, px, pz, fz, -fx, W), dr = ray(w, r, px, pz, -fz, fx, W);
  if (dl >= W || dr >= W) return;
  const a = Math.atan2((dr - dl) / 2, L);   // > 0: the gap's centre lies to the right
  r.h += Math.max(-.25, Math.min(.25, a)) * C.assist * C.assistRate * dt;
}

/* Authoritative tick for one rider: move, then sweep its circle against the walls. A crash backs
   the rider to the first contact and lays the wall right up to it. */
export function stepRider(w, r, inp){
  if (!r.alive) return;
  const C = w.cfg, x0 = r.x, z0 = r.z;
  const snapped = drive(w, r, inp || IDLE, DT);
  if (snapped) { addPoint(w, r, x0, z0); w.events.push({type:'snap', id:r.id, dir:snapped}); }
  if (!r.ghost && collides(w, r, x0, z0, r.x, r.z)) {
    const ex = r.x - x0, ez = r.z - z0; let lo = 0, hi = 1;
    for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (collides(w, r, x0, z0, x0 + ex * m, z0 + ez * m)) hi = m; else lo = m; }
    r.x = x0 + ex * lo; r.z = z0 + ez * lo;
    addPoint(w, r, r.x, r.z);
    r.alive = false; r.deathT = 0;
    w.events.push({type:'crash', id:r.id, x:r.x, z:r.z});
    return;
  }
  const m = r.n * 2, dx = r.x - r.pts[m - 2], dz = r.z - r.pts[m - 1];
  if (!r.n || Math.abs(wrap(r.h - r.hp)) > C.ptAngle || dx * dx + dz * dz >= C.ptDist * C.ptDist) addPoint(w, r, r.x, r.z);
}

export function step(w, inputs){
  const rs = w.riders;
  for (const r of rs) { r.px = r.x; r.pz = r.z; r.ph = r.h; }
  for (const r of rs) if (r.alive && r.ai) think(w, r);
  for (const r of rs) {
    if (!r.alive) continue;
    const inp = r.ai ? r.aiIn : (inputs && inputs[r.id]) || r.in;
    if (Array.isArray(inp)) { for (const i of inp) stepRider(w, r, i); } else stepRider(w, r, inp);
  }
  for (const r of rs) if (!r.alive && !r.cleared && (r.deathT += DT) > w.cfg.deathWindow) clearTrail(w, r);
  w.tick++;
}

export function advance(w, dt, inputs){
  w.acc = Math.min(w.acc + dt, DT * 8);
  let n = 0;
  while (w.acc >= DT) { w.acc -= DT; step(w, typeof inputs === 'function' ? inputs(w) : inputs); n++; }
  return n;
}

/* ---------- AI ---------- */
/* Feelers: rays fanned around the heading; long clear ones also look around the corner (open
   space). Difficulty: react sets look-ahead and how often it re-plans, noise blurs its judgement,
   hunt makes it cut in ahead of the nearest human, boost how keen it is to spend charge. */
const FEEL = [-2.3, -1.7, -1.25, -.8, -.45, -.2, 0, .2, .45, .8, 1.25, 1.7, 2.3];
function think(w, r){
  const I = r.aiIn;
  I.snap = 0;
  if (--r.think <= 0) plan(w, r, w.cfg.ai, I);
  const d = wrap(r.aim - r.h);
  I.steer = d > .05 ? 1 : d < -.05 ? -1 : 0;
}
function plan(w, r, A, I){
  const C = w.cfg, react = A.react[1];
  r.think = Math.max(2, Math.round(12 - react)) + Math.floor(rand(w) * 3);
  const look = 6 + react * 3, speed = C.base * r.mul;
  // Riders nearby also cast a short virtual wall along where they are heading, so rivals don't
  // cut straight across each other's noses
  const ghosts = [], lead = .25 + react * .06;
  for (const o of w.riders) {
    if (o === r || !o.alive || Math.abs(o.x - r.x) + Math.abs(o.z - r.z) > look * 1.5) continue;
    ghosts.push(o.x, o.z, o.x + o.vx * lead, o.z + o.vz * lead);
  }
  const cast = (a, max, x = r.x, z = r.z) => {
    const dx = Math.cos(r.h + a), dz = Math.sin(r.h + a);
    let d = ray(w, r, x, z, dx, dz, max);
    for (let g = 0; g < ghosts.length; g += 4) {
      const t = raySeg(x, z, dx, dz, ghosts[g], ghosts[g + 1], ghosts[g + 2], ghosts[g + 3]);
      if (t >= 0 && t < d) d = t;
    }
    return d;
  };
  const ahead = cast(0, 40);
  let hunt = null;
  if (A.hunt > 0 && rand(w) < A.hunt * .25) {
    let prey = null, pd = 1e9;
    for (const o of w.riders) {
      if (o === r || !o.alive || o.ai) continue;
      const d = Math.abs(o.x - r.x) + Math.abs(o.z - r.z); if (d < pd) { pd = d; prey = o; }
    }
    if (prey) {
      const tx = prey.x + Math.cos(prey.h) * 10 - r.x, tz = prey.z + Math.sin(prey.h) * 10 - r.z;
      if (Math.abs(tx) + Math.abs(tz) < 34) hunt = wrap(Math.atan2(tz, tx) - r.h);
    }
  }
  // Turning circle at this speed: a feeler shorter than about two of these is a trap
  const k = clamp01((speed - C.vLo) / (C.vHi - C.vLo)), turnR = speed / (C.yawLo + (C.yawHi - C.yawLo) * k);
  let best = 0, bs = -Infinity;
  for (const a of FEEL) {
    const d = cast(a, look);
    let s = d;
    if (d >= look * .5) {
      // open space: look around the corner from part-way down the feeler
      const px = r.x + Math.cos(r.h + a) * d * .6, pz = r.z + Math.sin(r.h + a) * d * .6;
      s += (cast(a - .7, look, px, pz) + cast(a, look, px, pz) + cast(a + .7, look, px, pz)) * .15;
    }
    s -= Math.max(0, turnR * (1.5 + Math.abs(a) * .5) - d) * 3;
    s *= 1 + (rand(w) - .5) * 2 * A.noise;
    s -= Math.abs(a) * 1.2;
    if (hunt !== null && Math.abs(wrap(a - hunt)) < .5 && d > look * .6) s *= 1.3;
    if (s > bs) { bs = s; best = a; }
  }
  r.aim = r.h + best + (rand(w) < A.turn * 2 ? (rand(w) - .5) * .6 : 0);
  // Too close to carve away: snap 90 degrees toward the more open side
  if (ahead < speed * .22 + .8) {
    const L = cast(-HALF_PI, 30), R = cast(HALF_PI, 30);
    if (Math.max(L, R) > ahead + 1) { I.snap = R >= L ? 1 : -1; r.aim = r.h + I.snap * HALF_PI; }
  }
  if (!r.wantBoost && ahead > 18 && r.energy > .55 && rand(w) < A.boost * .16) r.wantBoost = true;
  else if (r.wantBoost && (ahead < 9 || r.energy < .08)) r.wantBoost = false;
  I.boost = r.wantBoost;
}

/* ---------- Snapshots ---------- */
const qz = (v, s) => Math.round(v * s);
// [x, z, h, vx, vz, mul, alive, energy, grind, steer, snapCool, points]
export function pack(r){
  return [qz(r.x, 100), qz(r.z, 100), qz(wrap(r.h), 1e4), qz(r.vx, 100), qz(r.vz, 100), qz(r.mul, 1e3), r.alive ? 1 : 0,
    qz(r.energy, 1e3), qz(r.grind, 1e3), qz(r.sv, 1e3), qz(Math.max(0, r.snapCool), 1e3), r.n];
}
// Kinematic state only: life and death stay with the caller
export function unpack(r, a){
  r.x = a[0] / 100; r.z = a[1] / 100; r.h = a[2] / 1e4; r.vx = a[3] / 100; r.vz = a[4] / 100; r.mul = a[5] / 1e3;
  r.energy = a[7] / 1e3; r.grind = a[8] / 1e3; r.sv = a[9] / 1e3; r.snapCool = a[10] / 1e3; r.snapQ.length = 0;
  return a[11];
}
// Wall points from index `from` as [from, x*100, z*100, ...]
export function packPoints(r, from){
  const out = [from];
  for (let i = from * 2; i < r.n * 2; i++) out.push(qz(r.pts[i], 100));
  return out;
}

export function stateHash(w){
  const f = new Float64Array(1), u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  const mix = v => { f[0] = v; h = Math.imul(h ^ u[0], 16777619); h = Math.imul(h ^ u[1], 16777619); };
  mix(w.tick); mix(w.rs);
  for (const r of w.riders) {
    [r.x, r.z, r.h, r.vx, r.vz, r.mul, r.energy, r.grind, r.sv, r.alive ? 1 : 0, r.n, r.snapCool].forEach(mix);
    for (let i = 0; i < r.pts.length; i++) mix(r.pts[i]);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
