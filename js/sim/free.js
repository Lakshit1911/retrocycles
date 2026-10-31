/* Free-steering simulation: continuous position and heading, every rider leaves a polyline wall.
   Pure module (no THREE, no DOM): fixed 1/60 s steps, seeded RNG whose state lives on the world,
   so the same inputs always give the same world. Runs the race in solo / host, predicts the local
   rider on guests, and can later run unchanged on an authoritative server.

   Coordinates: world units = grid cells, arena centred on the origin, perimeter at +-size/2.
   Heading h: forward = (cos h, sin h); h grows when turning right (the grid's +1 turn).

   Two kinds of world:
     arena    (no track) every rider lays a wall all the time; a crash is out for the round
     circuit  (createWorld({track})) a closed track with barriers, checkpoint gates and pickups.
              Riders lay a wall only while they hold Light Burst (input.burst); each wall segment
              expires burstLife seconds after it was laid. Barriers are solid but not deadly (you
              scrape along them); a light wall smashes you and you respawn at your last checkpoint.

   API
     createWorld({seed, cfg, track})   new world (cfg overrides SIM_CONFIG, cfg.ai = difficulty preset,
                                       cfg.circuit.laps = race length; track = js/sim/tracks/*.js data)
     addRider(w, {x, z, h, ai, ghost, trail})   rider record (trail:false = start with no points)
     spawn(w, r, x, z, h, trail)       reset a rider in place (fresh world only, or rebuild after)
     spawnRing(w, n)                   arena: n start poses on a ring, facing the centre (uses the world RNG)
     gridSlots(w, n)                   circuit: n grid poses behind the start line, order shuffled (world RNG)
     step(w, inputs)                   one tick; inputs[id] = {steer:-1|0|1, boost, snap:-1|0|1, burst, brake}
                                       or an array of them (several sub-steps, for a host catching up)
     advance(w, dt, inputs)            fixed-step accumulator; inputs may be a function(w) -> inputs
     drive(w, r, input)                movement only (barrier scrapes included, no walls laid, no crash):
                                       guest prediction
     collides(w, r, x0, z0, x1, z1)    would the rider's circle sweeping x0,z0 -> x1,z1 touch a (light) wall?
     ray(w, r, x, z, dx, dz, max, skipStatic)  distance to the first wall along a unit ray (r: rider to ignore)
     setPoints(w, r, start, flat)      add wall points received from the network (index start)
     addWall(w, flat)                  static wall that never clears
     clearTrail(w, r), kill(w, r), rebuild(w)
     raceOrder(w)                      circuit: riders in race order (finished by place, then progress)
     lapOf(w, r)                       circuit: completed laps
     pack(r) / unpack(r, a)            compact integer rider state for snapshots
     packRace(r) / unpackRace(w, r, a, off)   circuit extras (gates, meter, timers, laps) for snapshots
     packPoints(r, from)               wall points for the network (circuit: with the tick each was laid)
     stateHash(w)                      hash of the full simulated state (determinism checks)
   Events collect in w.events for the caller to drain: crash, snap; circuit also gate, lap, finish,
   respawn, pickup, shield, burst, scrape. */
import { SIM_CONFIG } from './config.js';
import { buildTrack, nearest, frameOf, arcDiff } from './track.js';

export const DT = 1 / 60;
const TAU = Math.PI * 2, HALF_PI = Math.PI / 2;
export const wrap = a => a - TAU * Math.floor((a + Math.PI) / TAU);
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const IDLE = Object.freeze({steer:0, boost:false, snap:0, burst:false, brake:false});
export const PICKUPS = ['boost', 'shield', 'recharge', 'phase'];

// mulberry32; the whole RNG state is one integer on the world, so it hashes and serialises
export function rand(w){
  let t = (w.rs = (w.rs + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createWorld(o = {}){
  const over = o.cfg || {};
  const cfg = Object.assign({}, SIM_CONFIG, over);
  cfg.circuit = Object.assign({}, SIM_CONFIG.circuit, over.circuit || {});
  cfg.circuit.ai = Object.assign({}, SIM_CONFIG.circuit.ai, (over.circuit || {}).ai || {});
  if (o.track) cfg.base = cfg.circuit.base;
  const track = o.track ? buildTrack(o.track, cfg) : null;
  if (track) cfg.size = Math.max(cfg.size, track.size);
  const nb = Math.ceil(cfg.size / cfg.bucket);
  const w = {cfg, half:cfg.size / 2, nb, tick:0, acc:0, rs:(o.seed >>> 0) || 1, riders:[], events:[],
    // spatial hash: each bucket lists the wall segments crossing it; segments live in parallel arrays
    // (own: rider id, or -1 for a track barrier; exp: tick the segment stops counting)
    buckets:Array.from({length:nb * nb}, () => []), S:{ax:[], az:[], bx:[], bz:[], own:[], i:[], mark:[], exp:[]}, q:0,
    track, statics:[], pk:null, laps:cfg.circuit.laps, finished:0, lastBurst:-1e9};
  if (track) {
    w.pk = new Int32Array(track.pickups.length);
    for (const B of [track.left, track.right]) for (let i = 2; i < B.length; i += 2) w.statics.push(B[i - 2], B[i - 1], B[i], B[i + 1]);
    insertStatics(w);
  }
  return w;
}

export function addRider(w, o = {}){
  const r = {id:w.riders.length, ai:!!o.ai, ghost:!!o.ghost, pts:[], pd:[], pt:[], n:0, pend:null, race:!!w.track,
    in:{steer:0, boost:false, snap:0}, aiIn:{steer:0, boost:false, snap:0, burst:false, brake:false}};
  w.riders.push(r);
  spawn(w, r, o.x || 0, o.z || 0, o.h || 0, o.trail !== false && !w.track);
  return r;
}

export function spawn(w, r, x, z, h, trail = true){
  const v = w.cfg.base;
  Object.assign(r, {x, z, h, px:x, pz:z, ph:h, vx:Math.cos(h) * v, vz:Math.sin(h) * v, sv:0, mul:1,
    energy:w.cfg.energy, grind:0, boosting:false, alive:true, deathT:0, cleared:false, snapQ:[], snapCool:0,
    hp:h, held:false, wantBoost:false, think:0, aim:h, lay:!w.track});
  if (w.track) {
    const K = w.cfg.circuit;
    Object.assign(r, {gp:0, lap:0, lapT0:0, best:0, lastLap:0, gateT:0, finT:0, place:0, done:false, out:false,
      meter:K.burstStart, layT:0, ghostT:0, phaseT:0, shield:0, wrongT:0, scr:0, scrCool:0, crashes:0,
      fi:nearest(w.track, x, z), lat:0, prog:0, aiOff:0, aiNoise:0, aiBest:-1e9, aiStuck:0, burstHold:0, braking:false, dodge:0, dodgeT:0});
    raceFrame(w, r);
  }
  r.pts.length = 0; r.pd.length = 0; r.pt.length = 0; r.n = 0; r.pend = null;
  if (trail) addPoint(w, r, x, z);
}

export function spawnRing(w, n, frac = .34){
  const rad = Math.floor(w.cfg.size * frac), off = rand(w) * TAU;
  return Array.from({length:n}, (_, i) => {
    const a = off + i * TAU / n;
    return {x:Math.cos(a) * rad, z:Math.sin(a) * rad, h:wrap(a + Math.PI)};
  });
}

/* Circuit grid: two staggered columns behind the start line, facing the race direction. Which rider
   gets which slot is shuffled with the world RNG (seeded, so host and tests agree). */
export function gridSlots(w, n){
  const T = w.track, G = T.grid, g0 = T.gates[0];
  const slots = Array.from({length:n}, (_, k) => {
    const row = k >> 1, col = k & 1, back = G.back + row * G.gap + col * G.gap / 2;
    const i = ((g0.i - Math.round(back / T.ds)) % T.M + T.M) % T.M, lat = (col ? 1 : -1) * T.W[i] * G.row;
    return {x:T.X[i] + T.NX[i] * lat, z:T.Z[i] + T.NZ[i] * lat, h:Math.atan2(T.TZ[i], T.TX[i])};
  });
  for (let k = n - 1; k > 0; k--) { const j = Math.floor(rand(w) * (k + 1)); [slots[k], slots[j]] = [slots[j], slots[k]]; }
  return slots;
}

/* ---------- Walls ---------- */
const lifeTicks = w => Math.round(w.cfg.circuit.burstLife * 60);
// Circuit riders' points carry the tick they were laid (pt = tick * 2 + pen); pen = 1 starts a new
// piece (no segment joins it to the previous point). Arena points: pen 0, never expire.
function addPoint(w, r, x, z, pen = 0, tick = w.tick){
  const n = r.n;
  r.pts.push(x, z); r.n++; r.hp = r.h;
  if (r.race) r.pt.push(tick * 2 + (pen ? 1 : 0));
  if (!n) { r.pd.push(0); return; }
  const lx = r.pts[2 * n - 2], lz = r.pts[2 * n - 1], dx = x - lx, dz = z - lz;
  r.pd.push(r.pd[n - 1] + Math.sqrt(dx * dx + dz * dz));
  if (pen) return;
  const exp = r.race && !r.wall ? tick + lifeTicks(w) : Infinity;
  if (exp > w.tick) insert(w, r.id, n - 1, lx, lz, x, z, exp);
  if (r.race && !r.wall) w.lastBurst = Math.max(w.lastBurst, tick);
}

function bucketRange(w, x0, z0, x1, z1, pad){
  const B = w.cfg.bucket, h = w.half, m = w.nb - 1;
  const c = v => v < 0 ? 0 : v > m ? m : v;
  return [c(Math.floor((Math.min(x0, x1) - pad + h) / B)), c(Math.floor((Math.min(z0, z1) - pad + h) / B)),
          c(Math.floor((Math.max(x0, x1) + pad + h) / B)), c(Math.floor((Math.max(z0, z1) + pad + h) / B))];
}

function insert(w, own, i, ax, az, bx, bz, exp = Infinity){
  const S = w.S, k = S.ax.length;
  S.ax.push(ax); S.az.push(az); S.bx.push(bx); S.bz.push(bz); S.own.push(own); S.i.push(i); S.mark.push(0); S.exp.push(exp);
  const [i0, j0, i1, j1] = bucketRange(w, ax, az, bx, bz, 0);
  for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) w.buckets[ii + j * w.nb].push(k);
}
function insertStatics(w){
  const s = w.statics;
  for (let k = 0; k < s.length; k += 4) insert(w, -1, k >> 2, s[k], s[k + 1], s[k + 2], s[k + 3]);
}

export function rebuild(w){
  const S = w.S, life = w.track ? lifeTicks(w) : 0;
  for (const key in S) S[key].length = 0;
  w.buckets.forEach(b => { b.length = 0; });
  insertStatics(w);
  for (const r of w.riders) {
    if (r.cleared) continue;
    for (let i = 1; i < r.n; i++) {
      let exp = Infinity;
      if (r.race) {
        if (r.pt[i] & 1) continue;                   // pen up: a gap between two burst walls
        if (!r.wall) { exp = (r.pt[i] >> 1) + life; if (exp <= w.tick) continue; }
      }
      insert(w, r.id, i - 1, r.pts[2 * i - 2], r.pts[2 * i - 1], r.pts[2 * i], r.pts[2 * i + 1], exp);
    }
  }
}

export function clearTrail(w, r){
  r.cleared = true; r.pts.length = 0; r.pd.length = 0; r.pt.length = 0; r.n = 0; r.pend = null;
  rebuild(w);
}

export function kill(w, r){ if (r.alive) { r.alive = false; r.deathT = 0; } if (r.race) { r.out = true; r.lay = false; } }

// A static wall (flat x,z list) that never clears: arena features and tests
export function addWall(w, flat){
  const r = addRider(w, {ghost:true, trail:false});
  r.alive = false; r.deathT = -Infinity; r.wall = true; r.out = true;
  setPoints(w, r, 0, r.race ? flat.flatMap((v, i) => i % 2 ? [v, 0] : [v]) : flat);
  return r;
}

// Network walls: points [start, start+1, ...] as a flat x,z list (circuit: x,z,pt triplets);
// out-of-order chunks wait their turn
export function setPoints(w, r, start, flat){
  if (r.cleared) return;
  if (start > r.n) { (r.pend || (r.pend = {}))[start] = flat; return; }
  if (r.race) for (let j = (r.n - start) * 3; j + 2 < flat.length; j += 3) addPoint(w, r, flat[j], flat[j + 1], flat[j + 2] & 1, flat[j + 2] >> 1);
  else for (let j = (r.n - start) * 2; j + 1 < flat.length; j += 2) addPoint(w, r, flat[j], flat[j + 1]);
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

/* The rider's circle sweeping from x0,z0 to x1,z1: does it touch the perimeter, any light wall in
   the hash (minus its own newest stretch and expired burst walls) or another live rider's wall tip
   (last point -> head, while that rider is laying)? Track barriers are not light walls: drive()
   resolves those as scrapes. */
export const collides = (w, r, x0, z0, x1, z1) => hitBy(w, r, x0, z0, x1, z1) !== -1;
// Whose wall the sweep touches: a rider id, -2 for the perimeter, -1 for nothing
export function hitBy(w, r, x0, z0, x1, z1){
  const rad = w.cfg.radius, rr = rad * rad, lim = w.half - rad, tick = w.tick;
  if (x1 < -lim || x1 > lim || z1 < -lim || z1 > lim) return -2;
  const S = w.S, q = ++w.q, rec = recentFrom(w, r), [i0, j0, i1, j1] = bucketRange(w, x0, z0, x1, z1, rad);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const bk = w.buckets[i + j * w.nb];
    for (let n = 0; n < bk.length; n++) {
      const k = bk[n];
      if (S.mark[k] === q) continue;
      S.mark[k] = q;
      if (S.own[k] < 0 || S.exp[k] <= tick) continue;
      if (S.own[k] === r.id && r.pd[S.i[k] + 1] > rec) continue;
      if (segDist2(x0, z0, x1, z1, S.ax[k], S.az[k], S.bx[k], S.bz[k]) < rr) return S.own[k];
    }
  }
  for (const o of w.riders) {
    if (o === r || !o.alive || !o.n || !o.lay) continue;
    const m = o.n * 2;
    if (segDist2(x0, z0, x1, z1, o.pts[m - 2], o.pts[m - 1], o.x, o.z) < rr) return o.id;
  }
  return -1;
}

/* Distance along a unit ray to the first wall (perimeter included), capped at max. Walks the hash
   buckets the ray crosses (Amanatides-Woo) and stops once a hit is closer than the next bucket.
   skipStatic: light walls only (no track barriers). */
export function ray(w, r, x, z, dx, dz, max, skipStatic = false){
  const h = w.half, B = w.cfg.bucket, nb = w.nb, S = w.S, tick = w.tick;
  let best = max;
  if (dx > 1e-9) best = Math.min(best, (h - x) / dx); else if (dx < -1e-9) best = Math.min(best, (-h - x) / dx);
  if (dz > 1e-9) best = Math.min(best, (h - z) / dz); else if (dz < -1e-9) best = Math.min(best, (-h - z) / dz);
  if (best <= 0) return 0;
  const q = ++w.q, rec = recentFrom(w, r), id = r ? r.id : -2;
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
      if (S.exp[k] <= tick || (skipStatic && S.own[k] < 0)) continue;
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
    if (o === r || !o.alive || !o.n || !o.lay) continue;
    const m = o.n * 2, t = raySeg(x, z, dx, dz, o.pts[m - 2], o.pts[m - 1], o.x, o.z);
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

/* ---------- Track barriers (circuit) ---------- */
// Does a circle of the rider's radius sweeping a -> b touch a barrier? Returns the closest
// barrier segment's index in the hash, or -1.
function hitStatic(w, x0, z0, x1, z1, rad){
  const S = w.S, rr = rad * rad, q = ++w.q, [i0, j0, i1, j1] = bucketRange(w, x0, z0, x1, z1, rad);
  let best = -1, bd = rr;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const bk = w.buckets[i + j * w.nb];
    for (let n = 0; n < bk.length; n++) {
      const k = bk[n];
      if (S.mark[k] === q) continue;
      S.mark[k] = q;
      if (S.own[k] >= 0) continue;
      const d = segDist2(x0, z0, x1, z1, S.ax[k], S.az[k], S.bx[k], S.bz[k]);
      if (d < bd) { bd = d; best = k; }
    }
  }
  return best;
}
// Unit normal from barrier segment k toward the point (x, z)
function awayFrom(w, k, x, z){
  const S = w.S, ax = S.ax[k], az = S.az[k], ex = S.bx[k] - ax, ez = S.bz[k] - az, ll = ex * ex + ez * ez || 1;
  const t = clamp01(((x - ax) * ex + (z - az) * ez) / ll), px = ax + ex * t, pz = az + ez * t;
  let nx = x - px, nz = z - pz, l = Math.sqrt(nx * nx + nz * nz);
  if (l < 1e-6) { nx = -ez; nz = ex; l = Math.sqrt(ll); }
  return [nx / l, nz / l, l];
}
/* Scrape: the move x0,z0 -> r.x,r.z ran into a barrier. Stop at the contact, slide the rest of
   the move along the barrier, drop the velocity into it, turn the heading parallel to it and lose
   speed with the impact angle. Deterministic, and shared by the host sim and guest prediction. */
function scrape(w, r, x0, z0){
  const rad = w.cfg.radius, K = w.cfg.circuit;
  // Already overlapping (rounding, a respawn): push out first
  let k = hitStatic(w, x0, z0, x0, z0, rad);
  if (k >= 0) { const [nx, nz, d] = awayFrom(w, k, x0, z0); x0 += nx * (rad - d + 1e-3); z0 += nz * (rad - d + 1e-3); }
  k = hitStatic(w, x0, z0, r.x, r.z, rad);
  r.scr = 0;
  if (k < 0) return;
  const ex = r.x - x0, ez = r.z - z0; let lo = 0, hi = 1;
  for (let i = 0; i < 10; i++) { const m = (lo + hi) / 2; if (hitStatic(w, x0, z0, x0 + ex * m, z0 + ez * m, rad) >= 0) hi = m; else lo = m; }
  const cx = x0 + ex * lo, cz = z0 + ez * lo;
  const kk = hitStatic(w, cx, cz, x0 + ex * hi, z0 + ez * hi, rad + 1e-3);
  const [nx, nz] = awayFrom(w, kk >= 0 ? kk : k, cx, cz);
  let sx = ex * (1 - lo), sz = ez * (1 - lo);
  const into = sx * nx + sz * nz;
  if (into < 0) { sx -= nx * into; sz -= nz * into; }
  let fx = cx + sx, fz = cz + sz;
  if (hitStatic(w, cx, cz, fx, fz, rad) >= 0) { fx = cx; fz = cz; }
  r.x = fx; r.z = fz;
  const v = Math.sqrt(r.vx * r.vx + r.vz * r.vz) || 1, vn = r.vx * nx + r.vz * nz, impact = Math.max(0, -vn / v);
  if (vn < 0) { r.vx -= nx * vn * (1 + K.bounce); r.vz -= nz * vn * (1 + K.bounce); }
  const fxh = Math.cos(r.h), fzh = Math.sin(r.h);
  if (fxh * nx + fzh * nz < 0) {
    // heading swings parallel to the barrier, keeping its direction along it
    const tx = -nz, tz = nx, s = fxh * tx + fzh * tz >= 0 ? 1 : -1;
    r.h += wrap(Math.atan2(tz * s, tx * s) - r.h);
  }
  r.mul = Math.max(K.scrapeMin, r.mul * (1 - K.scrapeLoss * impact));
  r.scr = Math.max(impact, .05);
}

/* ---------- Riding ---------- */
function queueSnap(r, t){ if (r.snapQ.length < 2) r.snapQ.push(t > 0 ? 1 : -1); }

/* One tick of movement for one rider: steering, grip, boost/slipstream energy, snap turns and lane
   assist (circuit: brake and barrier scrapes, no snap turns). Lays no wall and never crashes
   (stepRider does). Returns the snap direction taken, or 0. */
export function drive(w, r, inp = IDLE, dt = DT){
  const C = w.cfg, T = w.track, x0 = r.x, z0 = r.z;
  if (inp.snap && !T) queueSnap(r, inp.snap);
  const steer = inp.steer || 0;
  // ramp in progressively, but let go (or reverse) quicker, so arcs end where you meant them to
  const resp = steer === 0 || steer * r.sv < 0 ? C.steerRelease : C.steerResp;
  r.sv += (steer - r.sv) * Math.min(1, dt * resp);
  // Boost and slipstream exactly as grid mode; circuit adds a brake
  const braking = r.braking = !!T && !!inp.brake;
  const boosting = r.boosting = !!inp.boost && !braking && r.energy > .02;
  if (boosting) r.energy = Math.max(0, r.energy - dt * C.drain);
  if (r.grind > 0) r.energy = Math.min(1, r.energy + dt * C.recharge);
  r.grind = Math.max(0, r.grind - dt);
  if (braking) r.mul += (C.circuit.brake - r.mul) * Math.min(1, dt * C.circuit.brakeResp);
  else r.mul += ((boosting ? C.boost : 1) + (r.grind > 0 ? C.slipBonus : 0) - r.mul) * Math.min(1, dt * C.ease);
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
    if (C.assist > 0 && !steer && !T) laneAssist(w, r, dt);
  }
  // Grip: forward speed follows the throttle, the sideways slide bleeds off (less grip when fast)
  let fx = Math.cos(r.h), fz = Math.sin(r.h);
  const lat = (fx * r.vz - fz * r.vx) * Math.exp(-C.grip / Math.pow(r.mul, C.gripFall) * dt);
  r.vx = fx * speed - fz * lat; r.vz = fz * speed + fx * lat;
  r.x += r.vx * dt; r.z += r.vz * dt;
  if (T) {
    scrape(w, r, x0, z0); fx = Math.cos(r.h); fz = Math.sin(r.h);
    // Circuit: slipstream from drafting a rider or riding beside a light wall (never the barriers),
    // plus a slow trickle of boost charge
    if (!boosting) r.energy = Math.min(1, r.energy + dt * C.circuit.regen);
    if (draft(w, r, fx, fz) || ray(w, r, r.x, r.z, -fz, fx, C.slip, true) < C.slip || ray(w, r, r.x, r.z, fz, -fx, C.slip, true) < C.slip) r.grind = C.grindHold;
    return snapped;
  }
  // Slipstream: a wall (or the perimeter) within reach on either side
  if (ray(w, r, r.x, r.z, -fz, fx, C.slip) < C.slip || ray(w, r, r.x, r.z, fz, -fx, C.slip) < C.slip) r.grind = C.grindHold;
  return snapped;
}
// Tucked in behind another live rider: within draft cells ahead and about a craft-width of your line
function draft(w, r, fx, fz){
  const D = w.cfg.circuit.draft;
  for (const o of w.riders) {
    if (o === r || !o.alive || o.wall) continue;
    const dx = o.x - r.x, dz = o.z - r.z, along = dx * fx + dz * fz;
    if (along > .8 && along < D && Math.abs(dz * fx - dx * fz) < 1.2) return true;
  }
  return false;
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

// Back the rider to the first contact on the move x0,z0 -> r.x,r.z
function toContact(w, r, x0, z0){
  const ex = r.x - x0, ez = r.z - z0; let lo = 0, hi = 1;
  for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (collides(w, r, x0, z0, x0 + ex * m, z0 + ez * m)) hi = m; else lo = m; }
  r.x = x0 + ex * lo; r.z = z0 + ez * lo;
}

/* Authoritative tick for one rider: move, then sweep its circle against the walls. A crash backs
   the rider to the first contact and lays the wall right up to it. */
export function stepRider(w, r, inp){
  if (!r.alive) return;
  if (w.track) return stepRace(w, r, inp || IDLE);
  const C = w.cfg, x0 = r.x, z0 = r.z;
  const snapped = drive(w, r, inp || IDLE, DT);
  if (snapped) { addPoint(w, r, x0, z0); w.events.push({type:'snap', id:r.id, dir:snapped}); }
  if (!r.ghost && collides(w, r, x0, z0, r.x, r.z)) {
    toContact(w, r, x0, z0);
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
  for (const r of rs) if (r.alive && r.ai) { if (w.track) thinkRace(w, r); else think(w, r); }
  for (const r of rs) {
    if (!r.alive) continue;
    const inp = r.ai ? r.aiIn : (inputs && inputs[r.id]) || r.in;
    if (Array.isArray(inp)) { for (const i of inp) stepRider(w, r, i); } else stepRider(w, r, inp);
  }
  if (w.track) {
    const K = w.cfg.circuit;
    for (const r of rs) if (!r.alive && !r.out && !r.wall && (r.deathT += DT) >= K.respawn) respawn(w, r);
    // Expired burst walls leave the hash now and then
    if (w.tick % 120 === 119) { const E = w.S.exp; for (let k = 0; k < E.length; k++) if (E[k] <= w.tick) { rebuild(w); break; } }
  } else for (const r of rs) if (!r.alive && !r.cleared && (r.deathT += DT) > w.cfg.deathWindow) clearTrail(w, r);
  w.tick++;
}

export function advance(w, dt, inputs){
  w.acc = Math.min(w.acc + dt, DT * 8);
  let n = 0;
  while (w.acc >= DT) { w.acc -= DT; step(w, typeof inputs === 'function' ? inputs(w) : inputs); n++; }
  return n;
}

/* ---------- Circuit race ---------- */
const sec = (w, s) => Math.round(s * 60);
// Segments a-b and c-d properly intersect
function crosses(ax, az, bx, bz, cx, cz, dx, dz){
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx), d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax), d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
export const lapOf = (w, r) => r.gp > 0 ? Math.floor((r.gp - 1) / w.track.gates.length) : 0;

function stepRace(w, r, inp){
  const C = w.cfg, K = C.circuit, x0 = r.x, z0 = r.z;
  drive(w, r, inp, DT);
  if (r.ghostT > 0) r.ghostT--;
  if (r.phaseT > 0) r.phaseT--;
  if (r.scrCool > 0) r.scrCool--;
  if (r.scr > .15 && r.scrCool <= 0) { w.events.push({type:'scrape', id:r.id, x:r.x, z:r.z, k:r.scr}); r.scrCool = 12; }
  // Light walls: a smash, unless ghosting, phasing, finished, or a shield takes it
  const immune = r.ghost || r.ghostT > 0 || r.phaseT > 0 || r.done, by = immune ? -1 : hitBy(w, r, x0, z0, r.x, r.z);
  if (by !== -1) {
    if (r.shield) { r.shield = 0; r.ghostT = sec(w, K.shieldSave); w.events.push({type:'shield', id:r.id, x:r.x, z:r.z, by}); }
    else {
      toContact(w, r, x0, z0);
      crash(w, r, by);
      return;
    }
  }
  // Light Burst: hold to lay a wall while the meter lasts (at least burstMinT once started)
  const want = !!inp.burst && r.ghostT <= 0 && !r.done;
  if (r.lay) {
    r.layT++; r.meter = Math.max(0, r.meter - K.burstDrain * DT);
    if ((!want && r.layT >= sec(w, K.burstMinT)) || r.meter <= 0 || r.ghostT > 0 || r.done) {
      addPoint(w, r, r.x, r.z); r.lay = false;
      w.events.push({type:'burst', id:r.id, on:false});
    } else {
      const m = r.n * 2, dx = r.x - r.pts[m - 2], dz = r.z - r.pts[m - 1];
      if (Math.abs(wrap(r.h - r.hp)) > C.ptAngle || dx * dx + dz * dz >= C.ptDist * C.ptDist) addPoint(w, r, r.x, r.z);
    }
  } else {
    r.meter = Math.min(1, r.meter + K.burstRecharge * DT);
    if (want && r.meter >= K.burstMin) {
      r.lay = true; r.layT = 0; r.hp = r.h;
      addPoint(w, r, x0, z0, 1);
      w.events.push({type:'burst', id:r.id, on:true});
    }
  }
  raceTick(w, r, x0, z0);
}

// by: whose light wall (rider id; the rider's own id for its own wall), -2 perimeter, -3 stuck reset
function crash(w, r, by){
  if (r.lay) addPoint(w, r, r.x, r.z);
  r.alive = false; r.deathT = 0; r.lay = false; r.crashes++;
  w.events.push({type:'crash', id:r.id, x:r.x, z:r.z, by});
}

// Gates, pickups, where on the loop, wrong way
function raceTick(w, r, x0, z0){
  const T = w.track, K = w.cfg.circuit, G = T.gates.length;
  const g = T.gates[r.gp % G];
  if (!r.done && crosses(x0, z0, r.x, r.z, g.ax, g.az, g.bx, g.bz) && (r.x - x0) * T.TX[g.i] + (r.z - z0) * T.TZ[g.i] > 0) passGate(w, r);
  if (!r.done) for (let k = 0; k < T.pickups.length; k++) {
    if (w.pk[k] > w.tick) continue;
    const p = T.pickups[k];
    if (segDist2(x0, z0, r.x, r.z, p.x, p.z, p.x, p.z) > K.pickR * K.pickR) continue;
    w.pk[k] = w.tick + sec(w, K.pickRespawn);
    if (p.kind === 'boost') r.energy = Math.min(1, r.energy + K.cell);
    else if (p.kind === 'shield') r.shield = 1;
    else if (p.kind === 'recharge') r.meter = 1;
    else if (p.kind === 'phase') r.phaseT = sec(w, K.phase);
    w.events.push({type:'pickup', id:r.id, k, kind:p.kind, x:p.x, z:p.z});
  }
  raceFrame(w, r);
  r.wrongT = !r.done && Math.cos(r.h) * T.TX[r.fi] + Math.sin(r.h) * T.TZ[r.fi] < -.3 ? r.wrongT + 1 : 0;
}

function passGate(w, r){
  const T = w.track, G = T.gates.length, k = r.gp % G;
  r.gp++; r.gateT = w.tick;
  if (k !== 0) { w.events.push({type:'gate', id:r.id, gate:k, t:w.tick - r.lapT0, lap:r.lap}); return; }
  if (r.gp === 1) { r.lapT0 = w.tick; w.events.push({type:'gate', id:r.id, gate:0, t:0, lap:0}); return; }   // timing starts at the line
  const t = w.tick - r.lapT0, best = !r.best || t < r.best;
  r.lap++; r.lastLap = t; r.lapT0 = w.tick;
  if (best) r.best = t;
  w.events.push({type:'lap', id:r.id, lap:r.lap, t, best});
  if (r.lap >= w.laps && !r.done) {
    r.done = true; r.place = ++w.finished; r.finT = w.tick;
    if (r.lay) { addPoint(w, r, r.x, r.z); r.lay = false; }
    w.events.push({type:'finish', id:r.id, place:r.place, t:w.tick});
  }
}

// Track sample, lateral offset and race progress (laps * L + distance past the start line)
function raceFrame(w, r){
  const T = w.track, G = T.gates.length;
  r.fi = nearest(T, r.x, r.z, r.fi);
  const f = frameOf(T, r.fi, r.x, r.z);
  r.lat = f.lat;
  if (r.gp === 0) { r.prog = arcDiff(T, f.s, T.gates[0].s); return; }
  const last = (r.gp - 1) % G, gs = T.gates[last].s;
  r.prog = Math.floor((r.gp - 1) / G) * T.L + ((gs - T.gates[0].s) % T.L + T.L) % T.L + arcDiff(T, f.s, gs);
}

// Back on track at the last checkpoint crossed (or just behind the start line), facing the race
// direction, ghosting for a moment. The rider's own light walls stay until they expire.
function respawn(w, r){
  const T = w.track, K = w.cfg.circuit, G = T.gates.length;
  const i = r.gp === 0 ? (T.gates[0].i - Math.round(3 / T.ds) + T.M) % T.M : (T.gates[(r.gp - 1) % G].i + Math.round(3 / T.ds)) % T.M;
  const lat = ((r.id % 3) - 1) * Math.min(2, T.W[i] / 2 - 1.5);
  const x = T.X[i] + T.NX[i] * lat, z = T.Z[i] + T.NZ[i] * lat, h = Math.atan2(T.TZ[i], T.TX[i]), v = w.cfg.base;
  Object.assign(r, {x, z, h, px:x, pz:z, ph:h, vx:Math.cos(h) * v, vz:Math.sin(h) * v, sv:0, mul:1, grind:0, boosting:false,
    alive:true, deathT:0, snapQ:[], snapCool:0, lay:false, ghostT:sec(w, K.ghost), wrongT:0, fi:i, aiStuck:0, burstHold:0, dodgeT:0});
  r.hp = h;
  raceFrame(w, r);
  r.aiBest = r.prog;
  w.events.push({type:'respawn', id:r.id, x, z, h});
}

// Riders in race order: finished riders by place, then everyone else by progress; out riders last
export function raceOrder(w){
  return w.riders.filter(r => !r.wall).sort((a, b) =>
    (a.out - b.out) || (b.done - a.done) || (a.done ? a.place - b.place : b.prog - a.prog) || a.id - b.id);
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

/* Circuit racers: chase a point on the racing line ahead (shifted by the rider's own wobble, a
   pickup worth taking or a gap past a light wall), brake for the slowest corner within reach,
   boost on the straights and fire Light Burst when a rival sits close behind in the same lane.
   Difficulty: react = look-ahead and re-plan rate, noise = wobble and corner-speed margin,
   boost = keenness to spend charge, hunt = how readily it bursts. */
function thinkRace(w, r){
  const T = w.track, C = w.cfg, K = C.circuit, KA = K.ai, A = C.ai, I = r.aiIn, M = T.M;
  I.snap = 0;
  if (--r.think <= 0) planRace(w, r, A, I);
  if (r.burstHold > 0) r.burstHold--;
  I.burst = r.burstHold > 0;
  const speed = C.base * r.mul, i = r.fi;
  const look = KA.look + speed * KA.lookT * (.8 + A.react[1] * .03);
  const j = (i + Math.round(look / T.ds)) % M, lim = Math.max(0, T.W[j] / 2 - 1);
  const o = Math.max(-lim, Math.min(lim, T.LINE[j] + r.aiOff));
  const tx = T.X[j] + T.NX[j] * o, tz = T.Z[j] + T.NZ[j] * o;
  const d = wrap(Math.atan2(tz - r.z, tx - r.x) - r.h);
  I.steer = d > .03 ? 1 : d < -.03 ? -1 : 0;
  // Slowest corner within braking reach (rookies take corners slower)
  const corner = 1 - A.noise * .8, reach = speed * 1.2 + 6;
  let vlim = 99;
  for (let k = 0; k < reach; k += 2) { const v = T.VMAX[(i + Math.round(k / T.ds)) % M] * corner + k * KA.decel; if (v < vlim) vlim = v; }
  I.brake = speed > vlim + 1.5;
  I.boost = r.wantBoost && !I.brake && speed < vlim - 1;
  // Pace: weaker presets lift off a little (feathering the brake) instead of running flat out
  const pace = 1 - A.noise * .25;
  if (pace < .99 && !I.boost && !I.brake && r.mul > pace + (r.grind > 0 ? C.slipBonus : 0) + .02) I.brake = true;
  // A light wall straight ahead: swerve toward the side with more room (better riders react more often)
  if (r.dodgeT > 0) { r.dodgeT--; I.steer = r.dodge; }
  else if (w.tick - w.lastBurst < sec(w, K.burstLife) + 30 && r.phaseT <= 0 && r.ghostT <= 0) {
    const reach = speed * .5 + 1, fx = Math.cos(r.h), fz = Math.sin(r.h);
    if (ray(w, r, r.x, r.z, fx, fz, reach, true) < reach && rand(w) < A.react[1] * .1) {
      const a = .6, L = ray(w, r, r.x, r.z, Math.cos(r.h - a), Math.sin(r.h - a), reach * 2, true), R = ray(w, r, r.x, r.z, Math.cos(r.h + a), Math.sin(r.h + a), reach * 2, true);
      r.dodge = R > L || (R === L && r.lat < 0) ? 1 : -1; r.dodgeT = 8; I.steer = r.dodge; I.brake = true;
    }
  }
  // Stuck (pinned, lost): reset at the checkpoint like a crash
  if (r.prog > r.aiBest + 2) { r.aiBest = r.prog; r.aiStuck = 0; }
  else if (++r.aiStuck > sec(w, KA.stuck) && !r.done) crash(w, r, -3);
}
function planRace(w, r, A, I){
  const T = w.track, C = w.cfg, K = C.circuit, KA = K.ai, M = T.M, react = A.react[1];
  r.think = Math.max(2, Math.round(10 - react)) + Math.floor(rand(w) * 3);
  r.aiNoise += ((rand(w) - .5) * 2 * A.noise * KA.wobble - r.aiNoise) * .3;
  let off = r.aiNoise;
  // A pickup worth taking, close to the line ahead
  let pick = null, pd = 30;
  for (let k = 0; k < T.pickups.length; k++) {
    if (w.pk[k] > w.tick + 30) continue;
    const p = T.pickups[k], ahead = ((p.i - r.fi) % M + M) % M * T.ds;
    if (ahead < 4 || ahead > pd) continue;
    const want = p.kind === 'boost' ? r.energy < .7 : p.kind === 'recharge' ? r.meter < .7 : p.kind === 'shield' ? !r.shield : true;
    const plat = (p.x - T.X[p.i]) * T.NX[p.i] + (p.z - T.Z[p.i]) * T.NZ[p.i];
    if (!want || Math.abs(plat - T.LINE[p.i]) > 4.5) continue;
    pick = plat - T.LINE[p.i]; pd = ahead;
  }
  if (pick !== null) off = pick;
  // Light walls ahead: pick the nearest lateral offset whose straight path is clear
  if (w.tick - w.lastBurst < sec(w, K.burstLife) + 30 && r.phaseT <= 0 && r.ghostT <= 0 && rand(w) < .3 + react * .08) {
    const speed = C.base * r.mul, look = Math.max(10, speed * .9), j = (r.fi + Math.round(look / T.ds)) % M;
    const lim = Math.max(0, T.W[j] / 2 - 1);
    let bestOff = off, bestD = -1;
    for (const dlt of [0, -2.5, 2.5, -5, 5, -7.5, 7.5]) {
      const o = Math.max(-lim, Math.min(lim, T.LINE[j] + off + dlt));
      const tx = T.X[j] + T.NX[j] * o - r.x, tz = T.Z[j] + T.NZ[j] * o - r.z, dist = Math.hypot(tx, tz) || 1;
      const free = ray(w, r, r.x, r.z, tx / dist, tz / dist, dist, true);
      if (free >= dist - .3) { bestOff = o - T.LINE[j]; bestD = dist; break; }
      if (free > bestD) { bestD = free; bestOff = o - T.LINE[j]; }
    }
    off = bestOff;
  }
  r.aiOff = off;
  if (!r.wantBoost && r.energy > 1 - A.boost * .7 && rand(w) < A.boost * .5) r.wantBoost = true;
  else if (r.wantBoost && r.energy < .05) r.wantBoost = false;
  // Light Burst: a rival tucked in close behind, in our lane
  if (!r.lay && r.burstHold <= 0 && r.meter > .35 && !r.done && r.ghostT <= 0) {
    for (const o of w.riders) {
      if (o === r || o.wall || !o.alive || o.done || o.ghostT > 0) continue;
      const gap = r.prog - o.prog;
      if (gap > 1.5 && gap < 9 && Math.abs(o.lat - r.lat) < 2.5 && rand(w) < A.hunt * .5 + .05) {
        r.burstHold = 18 + Math.floor(rand(w) * 30); break;
      }
    }
  }
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
// Circuit extras: [gates passed, meter, flags (1 laying, 2 shield, 4 finished, 8 out, 16 braking), ghost ticks,
// phase ticks, place, lap start tick, best lap ticks, last gate tick, last lap ticks, finish tick, wrong-way ticks]
export const RACE_FIELDS = 12;
export function packRace(r){
  return [r.gp, qz(r.meter, 1e3), (r.lay ? 1 : 0) | (r.shield ? 2 : 0) | (r.done ? 4 : 0) | (r.out ? 8 : 0) | (r.braking ? 16 : 0),
    r.ghostT, r.phaseT, r.place, r.lapT0, r.best, r.gateT, r.lastLap, r.finT, Math.min(r.wrongT, 999)];
}
export function unpackRace(w, r, a, off = 0){
  const f = a[off + 2];
  r.gp = a[off]; r.meter = a[off + 1] / 1e3; r.lay = !!(f & 1); r.shield = f & 2 ? 1 : 0; r.done = !!(f & 4); r.out = !!(f & 8); r.braking = !!(f & 16);
  r.ghostT = a[off + 3]; r.phaseT = a[off + 4]; r.place = a[off + 5]; r.lapT0 = a[off + 6]; r.best = a[off + 7];
  r.gateT = a[off + 8]; r.lastLap = a[off + 9]; r.finT = a[off + 10]; r.wrongT = a[off + 11];
  r.lap = lapOf(w, r);
  raceFrame(w, r);
}
// Wall points from index `from` as [from, x*100, z*100, ...] (circuit: [from, x*100, z*100, pt, ...])
export function packPoints(r, from){
  const out = [from];
  for (let i = from; i < r.n; i++) { out.push(qz(r.pts[2 * i], 100), qz(r.pts[2 * i + 1], 100)); if (r.race) out.push(r.pt[i]); }
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
    if (r.race) {
      [r.gp, r.lap, r.meter, r.lay ? 1 : 0, r.ghostT, r.phaseT, r.shield, r.lapT0, r.best, r.place, r.prog].forEach(mix);
      for (let i = 0; i < r.pt.length; i++) mix(r.pt[i]);
    }
  }
  if (w.pk) for (let k = 0; k < w.pk.length; k++) mix(w.pk[k]);
  return (h >>> 0).toString(16).padStart(8, '0');
}
