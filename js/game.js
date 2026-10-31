/* Phantom Run engine: scene, riders, simulation, audio, HUD and camera.
   One engine, three roles:
     solo  - simulates everything locally
     host  - simulates everything, streams snapshots + turn points to guests
     guest - renders host snapshots, dead-reckons between them and predicts
             its own turns so steering feels instant
   Two steering modes (cfg.steer):
     grid  - the original cell-by-cell race with 90 degree turns (everything below marked grid)
     free  - continuous steering run by js/sim/free.js (fixed 1/60 s steps); online, guests send
             per-tick inputs, predict their own rider and reconcile against host snapshots,
             and see everyone else interpolated ~100 ms behind (the "Free steering" section)
   Two events (cfg.event):
     arena    the above: last rider standing, rounds to win
     circuit  laps of a track (always free steering): light walls only while a rider holds
              Light Burst, a smash respawns you at your last checkpoint, pickups on the road
              (the "Circuit" section; the race itself is js/sim/free.js with a track)

   Input state lives in `keys` (exported as Game.keys so other input modules can drive it):
     keys.l / keys.r   steer left / right held (free) - grid uses queueTurn via keyboard / buttons
     keys.boost        boost held
     keys.snapQ        snap turns waiting for a tick (push -1 / 1; arena free steering only)
     keys.burst        Light Burst held (circuit)
     keys.brake        brake held (circuit) */
import { VISUAL_CONFIG as VC } from './visuals/config.js';
import { createRiderVisual, disposeRiderVisual, resetPose, updatePose, updatePoseFree, headingYaw } from './visuals/riders.js';
import { createPipeline, lin, linHex, defaultQuality } from './visuals/renderer.js';
import { SFX } from './audio.js';
import { emit } from './platform.js';   // achievements / rich presence on desktop; no-op in the browser
import { createArena } from './visuals/arena.js';
import { createTrails } from './visuals/trails.js';
import { createEffects } from './visuals/effects.js';
import { createCameraRig, CAMS } from './visuals/camera.js';
import { createTrackView } from './visuals/track.js';
import * as FS from './sim/free.js';
import { trackOf, DEFAULT_TRACK } from './sim/tracks/index.js';
import { encodeIn, inputQueue, queuePush, queueTake } from './sim/link.js';
const THREE = window.THREE;
const $ = id => document.getElementById(id);
const N = 128, H = N / 2, BASE = 15, DEATH_WINDOW = 1.4;
const SNAP_DT = 1 / 15, REWIND = 6, GRACE = .2, HIST = 8;
const DIRS = [[1,0],[0,1],[-1,0],[0,-1]];
export const RIDERS = ['YOU', 'KESTREL', 'JUNO', 'RIVET', 'ORCA', 'SABLE']
  .map((name, i) => ({name, color:VC.riders[i].hex, css:VC.riders[i].css}));
export const DIFF = {
  rookie:{react:[1,3], bfs:40,  noise:.4,  turn:.012, hunt:0,   boost:.15, hint:'Reacts late and is easy to trap'},
  rider: {react:[3,6], bfs:180, noise:.15, turn:.02,  hunt:.35, boost:.5,  hint:'Reads the arena and hunts you now and then'},
  legend:{react:[5,9], bfs:480, noise:.04, turn:.025, hunt:.8,  boost:.9,  hint:'Plans ahead and cuts across your path'}
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let coarse = matchMedia('(pointer: coarse)').matches;
if (coarse) document.body.classList.add('coarse');
addEventListener('touchstart', () => {
  if (coarse) return;
  coarse = true; document.body.classList.add('coarse');
  if (playing()) $('touch').hidden = false;
}, {once:true, passive:true});

export const hooks = {end:null, quit:null, quality:null};
let cfg = {diff:'rider', win:5, steer:'free', event:'arena', laps:3, track:DEFAULT_TRACK};
const isCircuit = () => cfg.event === 'circuit';
const isFree = () => cfg.steer === 'free' || isCircuit();
let mode = 'solo', net = null, matchId = '', me = 0, lastW = -1, snapAcc = 0, sentBoost = false;
let turnLog = {};

/* ---------- Scene ---------- */
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 1400);
let savedQuality = null;
try { savedQuality = localStorage.getItem('pr-quality'); } catch (e) {}
// Renderer, colour pipeline, reflections, lights, fog, bloom and quality levels (js/visuals/renderer.js)
const pipe = createPipeline({mount:$('stage'), scene, camera, quality:savedQuality || defaultQuality(),
  onAutoDrop:q => hooks.quality && hooks.quality(q, true)});
const renderer = pipe.renderer;

// Floor, perimeter, skyline and ambient detail (js/visuals/arena.js)
const arena = createArena(scene, N);
// Light walls: one shader ribbon per rider (js/visuals/trails.js)
const trails = createTrails(scene);
// Heat, crash shards, boost streaks, spawn scan (js/visuals/effects.js) and the camera rig (js/visuals/camera.js)
const fx = createEffects(scene, camera, reduceMotion);
const rig = createCameraRig(camera, reduceMotion);
// Circuit road, barriers, gates, pickups (js/visuals/track.js)
const trackView = createTrackView(scene);
renderer.localClippingEnabled = true;   // spawn scan clips each craft above a rising plane
let slowT = 0, wasBoosting = 0;                           // visual-only slow motion after the local rider's own crash

/* ---------- Grid occupancy ---------- */
const grid = new Int8Array(N * N), stamp = new Uint32Array(N * N); let stampId = 1;
const blocked = (x, z) => x < 0 || z < 0 || x >= N || z >= N || grid[x + z * N] !== 0;
const wx = c => c - H + .5;
function area(sx, sz, limit){
  if (blocked(sx, sz)) return 0;
  if (++stampId > 4e9) { stamp.fill(0); stampId = 1; }
  const q = [sx + sz * N]; stamp[q[0]] = stampId; let head = 0;
  while (head < q.length && q.length < limit) {
    const c = q[head++], x = c % N, z = (c / N) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d][0], nz = z + DIRS[d][1];
      if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
      const ni = nx + nz * N;
      if (grid[ni] !== 0 || stamp[ni] === stampId) continue;
      stamp[ni] = stampId; q.push(ni);
    }
  }
  return q.length;
}
function freeAhead(x, z, d, max){
  let n = 0; const [dx, dz] = DIRS[d];
  while (n < max && !blocked(x + dx * (n + 1), z + dz * (n + 1))) n++;
  return n;
}
// Mark a straight run of cells as trail (guests rebuild occupancy from turn points)
function raster(id, x0, z0, x1, z1){
  const dx = Math.sign(x1 - x0), dz = Math.sign(z1 - z0);
  if (dx && dz) return;
  for (let x = x0, z = z0, i = 0; i <= N; i++, x += dx, z += dz) {
    if (x >= 0 && z >= 0 && x < N && z < N) grid[x + z * N] = id + 1;
    if (x === x1 && z === z1) break;
  }
}

/* ---------- Bikes ---------- */
const headingOf = d => headingYaw(DIRS[d][0], DIRS[d][1]);

let bikes = [], player = null, scores = [], round = 0;
let state = 'demo', cd = 0, overT = 0, spectT = 0, deadT = 0, demoT = 0, paused = false, msgT = 0;
let camMode = 0, lastCd = 4;
const keys = {boost:false, l:false, r:false, snapQ:[], burst:false, brake:false};   // see the header comment
const steerKey = () => (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
const humansAlive = () => bikes.some(b => b.alive && !b.ai);

// A rider's wall is a list of segment start cells; the ribbon in trails.js draws it
function startSegAt(b, x, z){ const s = {x0:x, z0:z}; b.segs.push(s); return s; }
function startSeg(b){ b.nt++; return startSegAt(b, b.cx, b.cz); }

// Point on a rider's path, d cells back from its simulated head (extends straight back past the spawn)
function pathPoint(b, d, out){
  let ex = b.pos.x, ez = b.pos.z;
  for (let i = b.segs.length - 1; i >= 0; i--) {
    const s = b.segs[i], sx = wx(s.x0), sz = wx(s.z0), len = Math.abs(ex - sx) + Math.abs(ez - sz);
    if (d <= len) { const k = len > 0 ? d / len : 0; return out.set(ex + (sx - ex) * k, 0, ez + (sz - ez) * k); }
    if (i === 0) {
      const [dx, dz] = len > 0 ? [Math.sign(ex - sx), Math.sign(ez - sz)] : DIRS[b.dir];
      return out.set(sx - dx * (d - len), 0, sz - dz * (d - len));
    }
    d -= len; ex = sx; ez = sz;
  }
  return out.copy(b.pos);
}
/* Rider colours come from each rider's chosen colour key (the Garage), never duplicated:
   riders without a valid, free choice take the first free colour in palette order. */
export const colourOf = key => VC.riders.find(c => c.key === key);
function paint(roster){
  const used = new Set();
  roster.forEach(p => { if (colourOf(p.color) && !used.has(p.color)) used.add(p.color); else p.color = null; });
  roster.forEach(p => { if (!p.color) { p.color = VC.riders.find(c => !used.has(c.key)).key; used.add(p.color); } });
  roster.forEach(p => { const c = colourOf(p.color); p.paint = {color:c.hex, css:c.css, key:c.key}; });
  return roster;
}
function buildRiders(roster){
  paint(roster);
  bikes.forEach(b => {
    scene.remove(b.mesh.group); trails.remove(b); fx.detachScan(b); disposeRiderVisual(b.mesh);
  });
  bikes = [];
  roster.forEach((p, i) => {
    const r = p.paint, mesh = createRiderVisual(r.color);
    mesh.group.visible = false; scene.add(mesh.group);
    bikes.push({id:i, r, name:String(p.name || r.name).toUpperCase(), ai:!!p.bot, remote:!!p.remote, gone:false,
      mesh, segs:[], pos:new THREE.Vector3(), vpos:new THREE.Vector3(), alive:false, cleared:true, nt:0, k:0, local:[], gq:[], sched:[], queue:[],
      cx:H, cz:H, dir:0, p:0, mul:1, energy:.35, grind:0, vyaw:0, lean:0, snapT:0, lastLocalK:-1, localT:0,
      hist:new Int16Array(HIST * 2), trim:0, deathT:0,
      fr:null, wpts:null, wn:0, wtail:null, wtn:0, fq:null, sent:0, ex:0, ez:0, ip:null, in0:0,   // free steering
      wlist:null,                                                                                  // circuit burst walls
    });
  });
  trackView.clearShells();
  bikes.forEach(b => { trails.add(b); fx.attachScan(b); });
  player = bikes[me] || bikes[0]; scores = bikes.map(() => 0); round = 0;
}

function revive(b){ b.mesh.group.visible = b.alive; }

function resetRound(){
  if (isFree()) return freeReset();
  grid.fill(0);
  bikes.forEach(b => { b.segs = []; });
  const n = bikes.length, rad = Math.floor(N * .34), off = Math.random() * Math.PI * 2;
  bikes.forEach((b, i) => {
    const a = off + i * Math.PI * 2 / n;
    b.cx = Math.round(H + Math.cos(a) * rad); b.cz = Math.round(H + Math.sin(a) * rad);
    const vx = H - b.cx, vz = H - b.cz; let best = 0, bd = -1e9;
    DIRS.forEach(([dx, dz], d) => { const s = dx * vx + dz * vz; if (s > bd) { bd = s; best = d; } });
    Object.assign(b, {dir:best, p:0, mul:1, energy:.35, grind:0, queue:[], sched:[], local:[], gq:[], alive:!b.gone, deathT:0, cleared:b.gone,
      wantBoost:false, react:2, k:0, nt:0, grace:0, lastTurnK:-1});
    b.hist[0] = b.cx; b.hist[1] = b.cz;
    resetPose(b, headingOf(best));
    revive(b);
    if (!b.alive) return;
    grid[b.cx + b.cz * N] = b.id + 1;
    fx.startScan(b);
    startSeg(b);
    if (mode === 'host') net.turn(round, b.id, 0, b.cx, b.cz);
    placeBike(b, 0);
  });
  spectT = 0; deadT = 0;
}

function placeBike(b, dt){
  const [dx, dz] = DIRS[b.dir];
  b.pos.set(wx(b.cx) + dx * b.p, 0, wx(b.cz) + dz * b.p);
  // Visual layer: the craft rides the path a little behind the head, eased and banked through turns
  const moving = state === 'run' || state === 'over' || state === 'demo';
  pathPoint(b, VC.vehicle.originBehindHead, b.vpos);
  b.powerT = Math.max(0, (b.powerT || 0) - dt);
  b.visualSpeed = (moving ? BASE * b.mul / VC.vehicle.scale : 0) + VC.effects.powerOn.speed * (b.powerT / VC.effects.powerOn.duration);
  b.particleScale = pipe.particleScale;
  updatePose(b, dt, b.vpos, headingOf(b.dir), b.visualSpeed);
  b.trim = VC.vehicle.originBehindHead + b.mesh.tail;   // the wall appears to leave the craft's tail
}

function turn(b, t){
  b.dir = (b.dir + (t > 0 ? 1 : 3)) % 4;
  startSeg(b);
  b.lastTurnK = b.k; b.grace = 0;
  if (b === player && !b.ai) SFX.whoosh(t > 0 ? 1 : -1);
  if (mode === 'host') net.turn(round, b.id, b.nt - 1, b.cx, b.cz);
}

function update(b, dt){
  if (!b.alive) return;
  // A remote rider that hit a wall is held for a moment: a late turn from them can still save it
  if (b.grace > 0) { b.grace -= dt; if (b.grace <= 0) { b.grace = 0; b.p = .45; crash(b); } return; }
  const boosting = b.wantBoost && b.energy > .02;
  if (boosting) b.energy = Math.max(0, b.energy - dt * .42);
  if (b.grind > 0) b.energy = Math.min(1, b.energy + dt * .3);
  b.grind = Math.max(0, b.grind - dt);
  const target = (boosting ? 1.7 : 1) + (b.grind > 0 ? .3 : 0);
  b.mul += (target - b.mul) * Math.min(1, dt * 4);
  b.p += BASE * b.mul * dt;
  while (b.p >= 1 && b.alive && !b.grace) { b.p -= 1; step(b); }
}

function step(b){
  const [dx, dz] = DIRS[b.dir], nx = b.cx + dx, nz = b.cz + dz;
  if (blocked(nx, nz)) {
    b.p = .45;
    if (b.remote && mode === 'host') b.grace = GRACE; else crash(b);
    return;
  }
  grid[nx + nz * N] = b.id + 1; b.cx = nx; b.cz = nz; b.k++;
  const j = (b.k % HIST) * 2; b.hist[j] = nx; b.hist[j + 1] = nz;
  for (const side of [1, 3]) {
    const [sx, sz] = DIRS[(b.dir + side) % 4];
    for (let d = 1; d <= 2; d++) if (blocked(nx + sx * d, nz + sz * d)) b.grind = .22;
  }
  if (b.ai) think(b);
  if (b.sched.length && b.sched[0].at <= b.k) turn(b, b.sched.shift().t);
  else if (b.queue.length) turn(b, b.queue.shift());
}

function think(b){
  const D = DIFF[cfg.diff];
  const ahead = freeAhead(b.cx, b.cz, b.dir, 40);
  let huntDir = -1, prey = null, pd = 1e9;
  bikes.forEach(o => {
    if (o === b || !o.alive || o.ai) return;
    const d = Math.abs(o.cx - b.cx) + Math.abs(o.cz - b.cz); if (d < pd) { pd = d; prey = o; }
  });
  if (prey && Math.random() < D.hunt * .18) {
    const [pdx, pdz] = DIRS[prey.dir];
    const tx = prey.cx + pdx * 10 - b.cx, tz = prey.cz + pdz * 10 - b.cz;
    if (Math.abs(tx) + Math.abs(tz) < 34) huntDir = Math.abs(tx) > Math.abs(tz) ? (tx > 0 ? 0 : 2) : (tz > 0 ? 1 : 3);
  }
  const consider = ahead <= b.react || Math.random() < D.turn || (huntDir >= 0 && huntDir !== b.dir);
  if (consider) {
    let best = null;
    for (const t of [0, 1, 3]) {
      const d = (b.dir + t) % 4, nx = b.cx + DIRS[d][0], nz = b.cz + DIRS[d][1];
      let s = area(nx, nz, D.bfs);
      if (s > 0) s += Math.min(freeAhead(b.cx, b.cz, d, 20), 20);
      s *= 1 + (Math.random() - .5) * 2 * D.noise;
      if (t === 0) s *= 1.04;
      if (d === huntDir && s > D.bfs * .6) s *= 1.3;
      if (!best || s > best.s) best = {t, s};
    }
    if (best && best.t !== 0 && best.s > 0) b.queue.push(best.t === 1 ? 1 : -1);
    b.react = D.react[0] + Math.random() * (D.react[1] - D.react[0]);
  }
  if (!b.wantBoost && ahead > 18 && b.energy > .55 && Math.random() < D.boost * .08) b.wantBoost = true;
  else if (b.wantBoost && (ahead < 9 || b.energy < .08)) b.wantBoost = false;
}

function crash(b, by){
  b.alive = false; b.grace = 0; b.mesh.group.visible = false;
  b.trim = 0;   // show the wall right up to the crash point
  fx.crash(b.vpos.x, b.vpos.z, b.r.color, pipe.particleScale);
  if (state !== 'demo') {
    const dist = player.alive ? player.pos.distanceTo(b.pos) : 20;
    SFX.boom(b === player ? 1 : Math.max(.12, .6 - dist / 120));
  }
  if (b === player && state === 'run' && isCircuit()) {
    // Circuit: a smash costs time, not the race; back at the checkpoint in a moment
    emit('crash');
    rig.impact(VC.camera.shake.crash);
    if (!reduceMotion) slowT = VC.effects.slowMotion.duration;
    const o = by >= 0 && by !== b.id ? bikes[by] : null;
    flash('SMASHED', o ? `${o.name}'s light wall` : by === b.id ? 'your own light wall' : 'back to the last checkpoint', 1.1);
  } else if (b === player && state === 'run') {
    emit('crash');
    rig.impact(VC.camera.shake.crash);
    if (!reduceMotion) slowT = VC.effects.slowMotion.duration;
    const others = bikes.filter(o => o.alive).length;
    SFX.hit('fall');
    const canSkip = mode !== 'guest' && !humansAlive() && others > 1;
    setMsg('WIPED OUT', canSkip ? (coarse ? 'Tap to skip' : 'Space to skip') : others > 1 ? 'Spectating' : '');
  }
  if (state !== 'demo') updateBoard();
  if (mode === 'host') pushState();
}

function fadeDead(b, dt){
  if (b.cleared || isCircuit()) return;
  if (isFree()) {
    // Solo / host: the sim clears its own walls (freeUpdate mirrors it); guests follow the same clock
    if (mode !== 'guest') return;
    b.deathT += dt;
    if (b.deathT > DEATH_WINDOW) { if (b.fr) FS.clearTrail(fw, b.fr); b.cleared = true; }
    return;
  }
  b.deathT += dt;
  if (b.deathT > DEATH_WINDOW) {
    b.segs = [];
    const v = b.id + 1; for (let i = 0; i < grid.length; i++) if (grid[i] === v) grid[i] = 0;
    b.cleared = true;
  }
}

/* ---------- Online: host side ---------- */
function snapshot(){
  // Free: each rider's packed sim state plus the last input of theirs the host has applied (ack)
  // Circuit: plus FS.packRace per rider, pickups ('1' = taken) and the results once the race is over
  if (isFree() && fw) {
    const c = isCircuit(), o = {m:matchId, r:round, s:state, cd:Math.max(0, +cd.toFixed(2)), sc:scores.slice(), w:lastW, f:1, t:fw.tick,
      b:bikes.map(b => { const a = FS.pack(b.fr); a.push(b.fq ? b.fq.ack : -1); if (c) a.push(...FS.packRace(b.fr)); return a; })};
    if (c) { o.c = 1; o.pk = Array.from(fw.pk, v => v > fw.tick ? 1 : 0).join(''); if (raceRes) o.res = raceRes; }
    return o;
  }
  return {m:matchId, r:round, s:state, cd:Math.max(0, +cd.toFixed(2)), sc:scores.slice(), w:lastW,
    b:bikes.map(b => [b.cx | 0, b.cz | 0, b.dir | 0, Math.round(b.p * 100), Math.round(b.mul * 100), b.alive ? 1 : 0,
      Math.round(b.energy * 100), b.grind > 0 ? 1 : 0, b.k | 0, b.nt | 0])};
}
function pushState(){ if (mode === 'host' && net) { snapAcc = 0; if (isFree()) sendPoints(); net.state(snapshot()); } }

/* A guest's turn names the step it was pressed on. If the host has already
   driven that bike a few cells past it, rewind the bike to that cell and
   replay forward, so the turn lands where the guest saw it. */
function remoteTurn(id, t, at, r){
  const b = bikes[id];
  if (mode !== 'host' || !b || !b.alive || r !== round) return;
  if (state === 'countdown' || at < 0) { if (b.queue.length < 2) b.queue.push(t); return; }
  if (state !== 'run') return;
  const target = Math.max(at, b.lastTurnK + 1);
  if (target > b.k) { b.sched.push({t, at:target}); b.sched.sort((x, y) => x.at - y.at); return; }
  const back = b.k - target;
  if (back === 0 || back > REWIND) { turn(b, t); return; }
  for (let s = b.k; s > target; s--) { const j = (s % HIST) * 2; grid[b.hist[j] + b.hist[j + 1] * N] = 0; }
  const j = (target % HIST) * 2;
  b.cx = b.hist[j]; b.cz = b.hist[j + 1]; b.k = target; b.grace = 0;
  turn(b, t);
  for (let i = 0; i < back && b.alive && !b.grace; i++) step(b);
}
function remoteBoost(id, v){ const b = bikes[id]; if (mode === 'host' && b) b.wantBoost = !!v; }
function removeRider(id){
  const b = bikes[id]; if (!b || mode !== 'host') return;
  b.gone = true; b.remote = false;
  if (isFree() && b.fr && fw) FS.kill(fw, b.fr);
  if (b.alive) crash(b);
}

/* ---------- Online: guest side ---------- */
function guestPts(b){
  const L = (turnLog[round] || {})[b.id] || [], pts = [];
  if (!L[0]) pts.push(b.spawn);
  for (let i = 0; i < L.length && L[i]; i++) pts.push(L[i]);
  return b.local.length ? pts.concat(b.local) : pts;
}
function addTurnPoint(r, id, n, x, z){
  if (mode !== 'guest') return;
  const R = turnLog[r] || (turnLog[r] = {}), L = R[id] || (R[id] = []);
  L[n] = {x, z};
  if (r !== round) return;
  const b = bikes[id]; if (!b || !b.alive) return;
  if (L[n - 1]) raster(id, L[n - 1].x, L[n - 1].z, x, z);
  if (b === player && n > 0 && b.local.length) b.local.shift();
}
function guestRound(st){
  round = st.r; grid.fill(0);
  bikes.forEach(b => { b.segs = []; });
  st.b.forEach((a, i) => {
    const b = bikes[i]; if (!b) return;
    Object.assign(b, {cx:a[0], cz:a[1], dir:a[2], p:a[3] / 100, mul:a[4] / 100, alive:!!a[5], energy:a[6] / 100, grind:a[7] ? .22 : 0,
      k:a[8], nt:a[9], spawn:{x:a[0], z:a[1]}, local:[], gq:[], lastLocalK:-1, snapT:0, deathT:0, cleared:!a[5]});
    resetPose(b, headingOf(a[2]));
    revive(b);
    if (!b.alive) return;
    fx.startScan(b);
    const pts = guestPts(b);
    for (let k = 1; k < pts.length; k++) raster(b.id, pts[k - 1].x, pts[k - 1].z, pts[k].x, pts[k].z);
    grid[b.cx + b.cz * N] = b.id + 1;
    placeBike(b, 0);
  });
  state = 'countdown'; cd = st.cd; lastCd = 4; spectT = 0; deadT = 0;
  SFX.riser(Math.max(.6, st.cd));
  rig.intro(player);
  updateBoard();
}
function applySnapshot(st){
  if (mode !== 'guest' || !st || st.m !== matchId || !Array.isArray(st.b)) return;
  if (Array.isArray(st.sc)) scores = st.sc;
  if (Array.isArray(st.res)) raceRes = st.res;
  if (st.s === 'end') { matchOver(bikes[st.w] || null); return; }
  if (st.r !== round) (st.f ? freeGuestRound : guestRound)(st);
  const now = performance.now();
  if (st.f) freeSnapshot(st, now);
  else st.b.forEach((a, i) => {
    const b = bikes[i]; if (!b) return;
    if (!a[5]) { if (b.alive) crash(b); return; }
    if (!b.alive) return;
    b.energy = a[6] / 100; b.grind = a[7] ? .22 : 0; b.mul = a[4] / 100;
    // Keep our own predicted turn until the host confirms it (or it times out)
    if (b === player && (b.local.length || b.gq.length) && now - b.localT < 900) { b.snapT = 0; return; }
    if (b === player) { b.local.length = 0; b.gq.length = 0; }
    b.cx = a[0]; b.cz = a[1]; b.dir = a[2]; b.p = a[3] / 100; b.k = a[8]; b.nt = a[9]; b.snapT = 0;
    const pts = guestPts(b), last = pts[pts.length - 1];
    if (last) raster(b.id, last.x, last.z, b.cx, b.cz);
  });
  if (st.s !== state) {
    const prev = state; state = st.s;
    if (state === 'run' && prev === 'countdown') { flash('GO', '', .6); SFX.hit('go'); powerOn(); }
    else if (state === 'over') { if (isCircuit()) { lastW = st.w; raceOverMsg(); } else roundMsg(st.w >= 0 ? bikes[st.w] : null); }
  }
  if (state === 'countdown') cd = st.cd;
  updateBoard();
}
function guestTurnNow(b, t){
  net.turn(t, b.k, round);
  b.dir = (b.dir + (t > 0 ? 1 : 3)) % 4;
  b.local.push({x:b.cx, z:b.cz}); b.localT = performance.now(); b.lastLocalK = b.k;
  SFX.whoosh(t > 0 ? 1 : -1);
}
// Dead-reckon a bike forward from its last snapshot
function glide(b, dt){
  if (!b.alive || (state !== 'run' && state !== 'over')) return;
  b.snapT += dt; if (b.snapT > .4) return;
  b.p += BASE * b.mul * dt;
  for (;;) {
    const [dx, dz] = DIRS[b.dir], nx = b.cx + dx, nz = b.cz + dz;
    if (blocked(nx, nz)) { b.p = Math.min(b.p, .45); break; }
    if (b.p < 1) break;
    b.p -= 1; b.cx = nx; b.cz = nz; b.k++; grid[nx + nz * N] = b.id + 1;
    if (b === player && b.gq.length) guestTurnNow(b, b.gq.shift());
  }
}
// Guest: mirror the known turn points (host-confirmed plus locally predicted) into the rider's segments
function syncSegs(b){
  const pts = guestPts(b);
  if (b.segs.length > pts.length) b.segs.length = pts.length;
  for (let i = Math.max(0, b.segs.length - 3); i < b.segs.length; i++) { const s = b.segs[i], p = pts[i]; s.x0 = p.x; s.z0 = p.z; }
  while (b.segs.length < pts.length) { const p = pts[b.segs.length]; startSegAt(b, p.x, p.z); }
}

/* ---------- Free steering ---------- */
/* The race itself is js/sim/free.js: solo and host step one world at a fixed 1/60 s. Online the
   host stays authoritative. Each guest tick produces one input (steer, boost, snap) with a sequence
   number; the guest applies it to its own rider at once (prediction), keeps it in phist and sends
   it in small batches. The host consumes one per tick in order (js/sim/link.js) and every snapshot
   says which input it applied last (ack): the guest resets its rider to the host's state and
   replays the inputs after the ack. Walls stream as appended points (fp); everyone else is drawn
   INTERP ticks behind the newest snapshot, interpolated. */
let fw = null;                                        // this round's world
const FDT = FS.DT, INTERP = 6;                        // 6 ticks = 100 ms
let fpSeq = 0, fpLog = {}, fsnaps = [], fclk = null;  // host: wall chunk counter. guest: chunks by round, snapshots, clock offset (ms)
let pSeq = -1, pOut = '', pOutQ = 0, pOutT = 0;       // guest: newest input number, unsent batch (first number, age)
const phist = new Array(256), tailBuf = new Float32Array(128);   // guest: {input, predicted x, z} per tick
const yawOf = h => headingYaw(Math.cos(h), Math.sin(h));

function freeReset(){
  if (isCircuit()) return circuitReset();
  fw = FS.createWorld({seed:(Math.random() * 4294967296) >>> 0, cfg:{ai:DIFF[cfg.diff]}});
  const sp = FS.spawnRing(fw, bikes.length);
  bikes.forEach((b, i) => {
    const s = sp[i], r = FS.addRider(fw, {ai:b.ai, x:s.x, z:s.z, h:s.h});
    if (b.gone) { FS.kill(fw, r); FS.clearTrail(fw, r); }
    Object.assign(b, {fr:r, segs:[], wpts:r.pts, wn:r.n, wtail:null, wtn:0, wlist:null, fq:inputQueue(), sent:0, ip:null, ex:0, ez:0,
      mul:1, energy:r.energy, grind:0, queue:[], sched:[], local:[], gq:[], alive:!b.gone, deathT:0, cleared:b.gone,
      wantBoost:false, k:0, nt:0, grace:0});
    resetPose(b, yawOf(s.h));
    revive(b);
    if (!b.alive) return;
    fx.startScan(b);
    placeFree(b, 0);
  });
  keys.snapQ.length = 0;
  spectT = 0; deadT = 0;
}

// Solo / host: this tick's inputs for the humans (the sim drives its own AI)
function freeInputs(){
  const inp = [];
  for (const b of bikes) {
    if (b.ai || !b.alive) continue;
    if (b === player) inp[b.id] = {steer:steerKey(), boost:keys.boost, snap:keys.snapQ.shift() || 0, burst:keys.burst, brake:keys.brake};
    else if (b.remote && b.fq) inp[b.id] = queueTake(b.fq);
  }
  return inp;
}
function freeUpdate(dt){
  FS.advance(fw, dt, freeInputs);
  for (const e of fw.events) {
    const b = bikes[e.id]; if (!b) continue;
    if (e.type === 'crash' && b.alive) { b.pos.set(e.x, 0, e.z); crash(b, e.by); }
    else if (e.type === 'snap' && b === player && !b.ai) SFX.whoosh(e.dir);
    else if (isCircuit()) raceEvent(b, e);
  }
  fw.events.length = 0;
  for (const b of bikes) {
    const r = b.fr; if (!r) continue;
    b.mul = r.mul; b.energy = r.energy; b.grind = r.grind; b.deathT = r.deathT; b.cleared = r.cleared;
  }
}

// The craft's nose sits at the simulated head, pointing along the sim heading
function placeFree(b, dt){
  const r = b.fr; if (!r) return;
  let x, z, h;
  if (b.ip) ({x, z, h} = b.ip);   // guest: another rider, interpolated between snapshots
  else {
    const a = fw.acc / FDT, dh = FS.wrap(r.h - r.ph);
    x = r.px + (r.x - r.px) * a + b.ex; z = r.pz + (r.z - r.pz) * a + b.ez;   // ex / ez: a guest's reconciliation error, easing out
    h = Math.abs(dh) > .5 ? r.h : r.ph + dh * a;   // snap turns aren't interpolated: the pose eases them
  }
  b.pos.set(x, 0, z);
  const c = Math.cos(h), sn = Math.sin(h), back = VC.vehicle.originBehindHead;
  b.vpos.set(x - c * back, 0, z - sn * back);
  const moving = state === 'run' || state === 'over' || state === 'demo';
  b.powerT = Math.max(0, (b.powerT || 0) - dt);
  b.visualSpeed = (moving ? fw.cfg.base * b.mul / VC.vehicle.scale : 0) + VC.effects.powerOn.speed * (b.powerT / VC.effects.powerOn.duration);
  b.particleScale = pipe.particleScale;
  updatePoseFree(b, dt, b.vpos, headingYaw(c, sn), b.visualSpeed);
  b.trim = back + b.mesh.tail;
  // Circuit: a respawned rider blinks while it ghosts
  if (r.race) b.mesh.group.visible = !(r.ghostT > 0) || Math.floor(performance.now() / 1000 * VC.track.ghostBlink) % 2 === 0;
}

// Feed trails.js / the minimap: the sim's polyline (guests: up to what the drawn head has reached)
function freeWalls(b){
  const r = b.fr; if (!r) return;
  b.wpts = r.pts; b.wtail = null; b.wtn = 0;
  b.wn = mode === 'guest' && b.ip && b.alive ? Math.min(r.n, b.in0) : r.n;
  if (mode !== 'guest' || b !== player || !b.alive || pSeq < 0 || !r.n) return;
  // Our own wall: host-confirmed points, then the predicted path from where they end
  const lx = r.pts[2 * r.n - 2], lz = r.pts[2 * r.n - 1];
  let from = -1, bd = 4;
  for (let q = Math.max(0, pSeq - 60); q <= pSeq; q++) {
    const H = phist[q & 255]; if (!H) continue;
    const d = (H.x - lx) * (H.x - lx) + (H.z - lz) * (H.z - lz); if (d < bd) { bd = d; from = q; }
  }
  if (from < 0) return;
  let m = 0;
  for (let q = from + 1; q <= pSeq && m < 60; q++) { const H = phist[q & 255]; tailBuf[2 * m] = H.x; tailBuf[2 * m + 1] = H.z; m++; }
  b.wtail = tailBuf; b.wtn = m;
}

/* Host: new wall points since the last snapshot, one chunk for everyone: {i<id>: [from, x*100, z*100, ...]} */
function sendPoints(){
  if (!fw || !net.points) return;
  const out = {}; let any = false;
  for (const b of bikes) {
    const r = b.fr; if (!r || r.cleared || r.n <= b.sent) continue;
    out['i' + b.id] = FS.packPoints(r, b.sent); b.sent = r.n; any = true;
  }
  if (any) net.points(round, fpSeq++, out);
}
function remoteInput(id, r, q, s){
  const b = bikes[id];
  if (mode !== 'host' || !b || !b.fq || r !== round || typeof s !== 'string') return;
  queuePush(b.fq, q, s);
}

/* Guest */
function freeChunk(v){
  for (const k in v) {
    const b = bikes[+k.slice(1)], a = v[k];
    if (!b || !b.fr || !Array.isArray(a) || a.length < 3) continue;
    const flat = new Array(a.length - 1), st = isCircuit() ? 3 : 0;   // circuit: x, z, tick (raw)
    for (let j = 1; j < a.length; j++) flat[j - 1] = st && (j - 1) % 3 === 2 ? a[j] : a[j] / 100;
    FS.setPoints(fw, b.fr, a[0], flat);
  }
}
function addFreePoints(r, v){
  if (mode !== 'guest' || !v) return;
  (fpLog[r] || (fpLog[r] = [])).push(v);
  if (r === round && fw) freeChunk(v);
}
function freeGuestRound(st){
  round = st.r;
  const c = isCircuit();
  fw = c ? circuitWorld(1) : FS.createWorld({cfg:{ai:DIFF[cfg.diff]}});
  if (c) { trackView.show(fw.track); hudReset(); fw.tick = st.t || 0; }
  fsnaps = []; fclk = null; pSeq = -1; pOut = ''; pOutT = 0; keys.snapQ.length = 0;
  st.b.forEach((a, i) => {
    const b = bikes[i]; if (!b) return;
    const r = FS.addRider(fw, {ghost:true, trail:false});
    FS.unpack(r, a); r.px = r.x; r.pz = r.z; r.ph = r.h; r.alive = !!a[6]; r.cleared = !r.alive && !c;
    if (c) FS.unpackRace(fw, r, a, 13);
    Object.assign(b, {fr:r, segs:[], wpts:c ? null : r.pts, wn:0, wtail:null, wtn:0, wlist:c ? newWlist() : null, ex:0, ez:0, ip:b === player ? null : {x:r.x, z:r.z, h:r.h}, in0:0,
      mul:r.mul, energy:r.energy, grind:r.grind, alive:r.alive, deathT:0, cleared:r.cleared, snapT:0});
    resetPose(b, yawOf(r.h));
    revive(b);
    if (!b.alive) return;
    fx.startScan(b);
    placeFree(b, 0);
  });
  for (const k in fpLog) if (+k < round) delete fpLog[k];
  (fpLog[round] || []).forEach(freeChunk);
  state = 'countdown'; cd = st.cd; lastCd = 4; spectT = 0; deadT = 0;
  SFX.riser(Math.max(.6, st.cd));
  rig.intro(player);
  updateBoard();
}
function freeSnapshot(st, now){
  // Host tick -> local clock: the smallest offset seen (least delayed snapshot), drifting slowly
  if (st.t > 0) { const off = now - st.t * 1000 / 60; fclk = fclk === null || off < fclk ? off : fclk + (off - fclk) * .02; }
  st.at = now;
  fsnaps.push(st); if (fsnaps.length > 16) fsnaps.shift();
  const c = isCircuit();
  if (c) {
    fw.tick = Math.max(fw.tick, st.t);
    if (typeof st.pk === 'string') for (let k = 0; k < fw.pk.length; k++) fw.pk[k] = st.pk[k] === '1' ? 2e9 : 0;
  }
  st.b.forEach((a, i) => {
    const b = bikes[i]; if (!b || !b.fr) return;
    const r = b.fr;
    if (c) {
      // Circuit: smashed riders come back (respawn); timing, meter and items ride along
      if (!a[6]) { if (b.alive) { r.alive = false; r.lay = false; crash(b, -1); } FS.unpackRace(fw, r, a, 13); return; }
      if (!b.alive) { FS.unpack(r, a); r.px = r.x; r.pz = r.z; r.ph = r.h; r.alive = true; r.held = false; FS.unpackRace(fw, r, a, 13); respawnBike(b); return; }
      if (b === player) reconcile(b, a);
      else { FS.unpack(r, a); b.mul = r.mul; b.energy = r.energy; b.grind = r.grind; }
      FS.unpackRace(fw, r, a, 13);
      return;
    }
    if (!a[6]) { if (b.alive) { FS.kill(fw, r); crash(b); } return; }
    if (!b.alive) return;
    if (b === player) { reconcile(b, a); return; }
    FS.unpack(r, a);   // newest known head: other riders' wall tips for our own collision checks
    b.mul = r.mul; b.energy = r.energy; b.grind = r.grind;
  });
}
// One predicted tick of our own rider. Walls the guest knows about hold it in place (the host decides crashes)
function predictTick(r, inp){
  if (r.held) return 0;
  const x0 = r.x, z0 = r.z, snapped = FS.drive(fw, r, inp);
  if (FS.collides(fw, r, x0, z0, r.x, r.z)) { r.x = x0; r.z = z0; r.held = true; }
  return snapped;
}
// Host state at the ack, then our inputs since; the visible jump eases out through ex / ez
function reconcile(b, a){
  const r = b.fr, ack = a[12], x0 = r.x, z0 = r.z, h0 = r.h;
  FS.unpack(r, a); r.held = false;
  for (let q = Math.max(ack + 1, pSeq - 255); q <= pSeq; q++) {
    const H = phist[q & 255]; if (!H) continue;
    predictTick(r, H.i); H.x = r.x; H.z = r.z;
  }
  b.ex += x0 - r.x; b.ez += z0 - r.z;
  if (b.ex * b.ex + b.ez * b.ez > 25) b.ex = b.ez = 0;
  r.px += r.x - x0; r.pz += r.z - z0; r.ph += r.h - h0;
  b.mul = r.mul; b.energy = r.energy; b.grind = r.grind;
}
function freeGuestFrame(dt){
  if (!fw || !player) return;
  const r = player.fr;
  if (isCircuit()) fw.tick = Math.max(fw.tick, Math.floor(nowTick()));   // burst walls expire on the host's clock
  if (r && player.alive && (state === 'run' || state === 'over')) {
    fw.acc = Math.min(fw.acc + dt, FDT * 8);
    while (fw.acc >= FDT) {
      fw.acc -= FDT;
      const inp = {steer:steerKey(), boost:keys.boost, snap:keys.snapQ.shift() || 0, burst:keys.burst, brake:keys.brake}, q = ++pSeq;
      r.px = r.x; r.pz = r.z; r.ph = r.h;
      const snapped = predictTick(r, inp);
      if (snapped) SFX.whoosh(snapped);
      phist[q & 255] = {i:inp, x:r.x, z:r.z};
      if (!pOut) pOutQ = q;
      pOut += encodeIn(inp.steer, inp.boost, inp.snap, inp.burst, inp.brake);
      if (inp.snap) pOutT = 1;   // send snap turns right away
    }
    pOutT += dt;
    if (pOut && pOutT >= .05) { net.input(round, pOutQ, pOut); pOut = ''; pOutT = 0; }
    player.mul = r.mul; player.energy = r.energy; player.grind = r.grind;
  }
  const k = Math.exp(-dt * 8); player.ex *= k; player.ez *= k;
  const tick = fclk === null ? -1 : (performance.now() - fclk) * 60 / 1000 - INTERP;
  for (const b of bikes) if (b !== player && b.alive && b.ip) interp(b, tick);
}
// Another rider, drawn at host tick `tick`: between the two snapshots around it, or a short extrapolation
function interp(b, tick){
  const i = b.id, ip = b.ip; let s0 = null, s1 = null;
  for (const s of fsnaps) { if (s.t <= tick) s0 = s; else { s1 = s; break; } }
  if (s0 && s1 && s0.b[i][6] !== s1.b[i][6]) s0 = null;   // died or respawned in between: no sliding across the track
  if (s0 && s1) {
    const a = s0.b[i], c = s1.b[i], k = (tick - s0.t) / Math.max(1, s1.t - s0.t), dh = FS.wrap((c[2] - a[2]) / 1e4);
    ip.x = (a[0] + (c[0] - a[0]) * k) / 100; ip.z = (a[1] + (c[1] - a[1]) * k) / 100;
    ip.h = Math.abs(dh) > .5 ? (k < .5 ? a[2] : c[2]) / 1e4 : a[2] / 1e4 + dh * k;
    b.in0 = a[11];
  } else {
    const s = s0 || s1; if (!s) return;
    const a = s.b[i], e = s0 ? Math.min(Math.max(0, tick - s.t), 15) / 60 : 0;
    ip.x = (a[0] + a[3] * e) / 100; ip.z = (a[1] + a[4] * e) / 100; ip.h = a[2] / 1e4; b.in0 = a[11];
  }
}

/* ---------- Circuit ---------- */
/* Laps of a track on the free-steering sim (createWorld({track})). Solo and host step it like any
   free round; the sim reports gates, laps, crashes, respawns and pickups as events. Guests get the
   circuit extras (FS.packRace) in every snapshot, the pickup states as a '0'/'1' string (pk) and the
   results (res) once the race is over. HUD timing (lap, best, splits) reads the rider's sim state,
   so it works the same for solo, host and guests. */
const WL = 640;                                       // burst wall points drawn per rider
let graceT = null, raceRes = null, hud = null, noteT = 0, radarBg = null;
const newWlist = () => ({x:new Float32Array(WL), z:new Float32Array(WL), a:new Float32Array(WL), n:0, live:false});
const fmtT = ticks => { const t = Math.max(0, ticks) / 60, m = Math.floor(t / 60), sec = t - m * 60; return `${m}:${sec.toFixed(3).padStart(6, '0')}`; };
// Host tick now: solo / host read the world; guests estimate it from the snapshot clock
// (the newest snapshot's tick plus a little extrapolation, so a slow host never runs the clock ahead)
const nowTick = () => {
  if (mode !== 'guest') return fw.tick + fw.acc / FDT;
  const st = fsnaps[fsnaps.length - 1];
  return st ? st.t + Math.min(12, (performance.now() - st.at) * 60 / 1000) : fw.tick;
};
function chime(f0, f1, vol = .05){ if (SFX.ctx) SFX.tone('sine', f0, f1, .16, vol, SFX.ctx.currentTime, SFX.fxG); }
const hexOf = css => parseInt(css.slice(1), 16);

function circuitWorld(seed){
  return FS.createWorld({seed, track:trackOf(cfg.track), cfg:{ai:DIFF[cfg.diff], circuit:{laps:cfg.laps}}});
}
function circuitReset(){
  fw = circuitWorld((Math.random() * 4294967296) >>> 0);
  const sp = FS.gridSlots(fw, bikes.length);
  trackView.show(fw.track);
  bikes.forEach((b, i) => {
    const s = sp[i], r = FS.addRider(fw, {ai:b.ai, x:s.x, z:s.z, h:s.h});
    if (b.gone) FS.kill(fw, r);
    Object.assign(b, {fr:r, segs:[], wpts:null, wn:0, wtail:null, wtn:0, wlist:newWlist(), fq:inputQueue(), sent:0, ip:null, ex:0, ez:0,
      mul:1, energy:r.energy, grind:0, queue:[], sched:[], local:[], gq:[], alive:!b.gone, deathT:0, cleared:false,
      wantBoost:false, k:0, nt:0, grace:0});
    resetPose(b, yawOf(s.h));
    revive(b);
    if (!b.alive) return;
    fx.startScan(b);
    placeFree(b, 0);
  });
  keys.snapQ.length = 0;
  spectT = 0; deadT = 0;
  hudReset();
}
function hudReset(){
  graceT = null; raceRes = null; noteT = 0;
  hud = {gp:0, best:[], cur:[], bestLap:0, wrong:false, boardT:0, splitT:0};
  $('split').textContent = ''; $('raceNote').textContent = '';
}

// Burst walls for trails.js: every live point with its age fade, zero-intensity joins between walls
function circuitWalls(b){
  const r = b.fr, L = b.wlist; if (!L) return;
  L.n = 0; L.live = false;
  if (!r || !r.n) return;
  const K = fw.cfg.circuit, life = K.burstLife * 60, fade = K.burstFade * 60, tick = nowTick();
  const alpha = i => Math.max(0, Math.min(1, ((r.pt[i] >> 1) + life - tick) / fade));
  let i0 = r.n;
  while (i0 > 0 && alpha(i0 - 1) > 0) i0--;
  if (i0 >= r.n && !(b.alive && r.lay)) return;
  const push = (x, z, a) => { if (L.n >= WL) return; L.x[L.n] = x; L.z[L.n] = z; L.a[L.n] = a; L.n++; };
  for (let i = Math.max(0, i0 - 1); i < r.n; i++) {
    const x = r.pts[2 * i], z = r.pts[2 * i + 1];
    if ((r.pt[i] & 1) && L.n) { push(L.x[L.n - 1], L.z[L.n - 1], 0); push(x, z, 0); }
    push(x, z, i < i0 ? 0 : alpha(i));
  }
  if (b.alive && r.lay && L.n) { push(b.pos.x, b.pos.z, 1); L.live = true; }
}

// The sim's circuit events (solo / host)
function raceEvent(b, e){
  const me = b === player;
  if (e.type === 'respawn') respawnBike(b);
  else if (e.type === 'pickup') {
    if (me) { chime(880, 1760); note({boost:'BOOST CELL', shield:'SHIELD ARMED', recharge:'BURST RECHARGED', phase:'PHASE'}[e.kind]); }
  } else if (e.type === 'shield') {
    fx.crash(e.x, e.z, hexOf(VC.track.pickups.colors.shield), .25);
    if (me) { note('SHIELD TOOK THE HIT'); rig.impact(.3); }
  } else if (e.type === 'burst') { if (me && e.on) SFX.whoosh(0); }
  else if (e.type === 'scrape') { if (me) { rig.impact(.12 + e.k * .3); SFX.flyby(.25 + e.k * .5, 0); } }
  else if (e.type === 'finish') {
    if (graceT === null) graceT = fw.cfg.circuit.grace;
    if (me) { SFX.hit(e.place === 1 ? 'win' : 'go'); setMsg('FINISHED', `P${e.place} · ${fmtT(e.t)}`); msgT = 3; }
    else if (e.place === 1 && player && !player.fr.done) flash(b.name, 'takes the flag', 1.6);
  }
}
function note(text){ $('raceNote').textContent = text; noteT = 1.6; }

// Back on the track after a smash (sim respawn, or a guest seeing the rider alive again)
function respawnBike(b){
  const r = b.fr;
  b.alive = true; b.cleared = false; b.deathT = 0; b.ex = b.ez = 0;
  if (b.ip) { b.ip.x = r.x; b.ip.z = r.z; b.ip.h = r.h; }
  resetPose(b, yawOf(r.h));
  b.mesh.group.visible = true;
  fx.startScan(b);
  placeFree(b, 0);
  updateBoard();
}

// Host / solo: is the race over? (everyone done, every human done, or the grace after the winner ran out)
function circuitRun(dt){
  if (graceT !== null) graceT -= dt;
  const humans = bikes.filter(b => !b.ai && !b.gone);
  const all = bikes.every(b => b.gone || b.fr.done), humansDone = humans.length > 0 && humans.every(b => b.fr.done);
  if (all || humansDone || (graceT !== null && graceT <= 0)) endRace();
}
// [id, position, total ticks (-1: not finished), best lap ticks, laps] in race order
function results(){
  return FS.raceOrder(fw).map((r, i) => [r.id, i + 1, r.done ? r.finT : -1, r.best, Math.min(cfg.laps, FS.lapOf(fw, r))]);
}
function endRace(){
  if (state !== 'run') return;
  state = 'over'; overT = 4;
  raceRes = results();
  lastW = raceRes[0] ? raceRes[0][0] : -1;
  raceOverMsg();
  updateBoard();
  pushState();
}
function raceOverMsg(){
  const res = raceRes || [], mine = res.find(x => x[0] === player.id), w = bikes[lastW];
  if (w === player) { SFX.hit('win'); emit('round-win'); }
  setMsg(w === player ? 'VICTORY' : 'RACE OVER', mine ? `P${mine[1]}${mine[2] >= 0 ? ' · ' + fmtT(mine[2]) : ' · ' + mine[4] + ' / ' + cfg.laps + ' laps'}` : '');
}

/* HUD: lap x / N, current lap time, best lap, split against your best lap at each checkpoint,
   position, burst meter and the item you carry. Runs off the rider's sim state in every role. */
function circuitHud(dt){
  const r = player.fr; if (!r || !fw || !hud) return;
  const G = fw.track.gates.length, tick = nowTick();
  // gates passed since last frame (usually one): splits and lap times
  while (hud.gp < r.gp) {
    hud.gp++;
    const k = (hud.gp - 1) % G, fresh = hud.gp === r.gp;
    trackView.flashGate(k);
    if (k !== 0) {
      const t = r.gateT - r.lapT0;
      hud.cur[k] = t;
      if (hud.best[k] && fresh) showSplit(t - hud.best[k]);
      if (fresh) chime(1200, 1400, .03);
    } else if (hud.gp > 1) {
      const t = r.lastLap, prev = hud.bestLap;
      if (!prev || t < prev) { hud.bestLap = t; hud.best = hud.cur.slice(); }
      hud.cur = [];
      if (fresh && !r.done) {
        if (prev) showSplit(t - prev); else { $('split').textContent = fmtT(t); $('split').className = 'split num'; hud.splitT = 3; }
        const lap = FS.lapOf(fw, r);
        flash(lap === cfg.laps - 1 ? 'FINAL LAP' : `LAP ${lap + 1}`, `last lap ${fmtT(t)}${!prev || t < prev ? ' · best' : ''}`, 1.4);
        chime(700, 1400, .05);
      }
    }
  }
  if (hud.splitT > 0 && (hud.splitT -= dt) <= 0) $('split').textContent = '';
  if (noteT > 0 && (noteT -= dt) <= 0) $('raceNote').textContent = '';
  $('lapNow').textContent = r.done ? fmtT(r.finT) : r.gp ? fmtT(tick - r.lapT0) : fmtT(0);
  $('lapBest').textContent = r.best ? fmtT(r.best) : '–:––.–––';
  const order = FS.raceOrder(fw), pos = order.indexOf(r) + 1;
  $('racePos').textContent = `P${r.done ? r.place : pos}`; $('raceOf').textContent = `/ ${order.filter(o => !o.out).length}`;
  $('brst').style.width = (r.meter * 100).toFixed(1) + '%';
  $('brst').parentNode.classList.toggle('on', !!r.lay);
  const item = r.phaseT > 0 ? 'phase' : r.shield ? 'shield' : '', itemEl = $('item');
  if (itemEl.dataset.k !== item) {
    itemEl.dataset.k = item;
    itemEl.textContent = item === 'phase' ? 'PHASE' : item === 'shield' ? 'SHIELD' : 'NO ITEM';
    itemEl.classList.toggle('on', !!item);
    itemEl.style.setProperty('--c', item ? VC.track.pickups.colors[item] : 'var(--faint)');
  }
  // wrong way
  const wrong = r.wrongT > 45 && player.alive && state === 'run';
  if (wrong && !hud.wrong) setMsg('WRONG WAY', 'turn around');
  else if (!wrong && hud.wrong) setMsg('', '');
  hud.wrong = wrong;
  if ((hud.boardT -= dt) <= 0) { hud.boardT = .25; updateBoard(); }
}
function showSplit(d){
  $('split').textContent = `${d <= 0 ? '−' : '+'}${(Math.abs(d) / 60).toFixed(3)}`;
  $('split').className = 'split num ' + (d <= 0 ? 'good' : 'bad');
  hud.splitT = 3;
}
function circuitBoard(){
  const order = FS.raceOrder(fw);
  order.forEach((r, pos) => {
    const b = bikes[r.id], el = $('chip' + r.id); if (!b || !el) return;
    el.style.order = pos;
    el.classList.toggle('dead', !b.alive || b.gone);
    const t = el.querySelector('.lapc');
    if (t) t.textContent = b.gone ? 'OUT' : r.done ? `P${r.place}` : `L${Math.min(cfg.laps, FS.lapOf(fw, r) + 1)}`;
  });
  $('aliveLabel').textContent = 'Circuit';
  const r = player.fr;
  if (r) $('roundLabel').textContent = r.done ? 'FINISHED' : `LAP ${Math.min(cfg.laps, FS.lapOf(fw, r) + 1)}/${cfg.laps}`;
}
// Minimap: the track outline (drawn once), burst walls, pickups and riders
function circuitRadar(){
  const W = radar.width, T = fw.track, bd = T.bounds, pad = 10;
  const S = (W - pad * 2) / Math.max(bd.maxX - bd.minX, bd.maxZ - bd.minZ);
  const ox = pad + ((W - pad * 2) - (bd.maxX - bd.minX) * S) / 2 - bd.minX * S, oz = pad + ((W - pad * 2) - (bd.maxZ - bd.minZ) * S) / 2 - bd.minZ * S;
  if (!radarBg || radarBg.id !== T.id) {
    const c = document.createElement('canvas'); c.width = c.height = W;
    const g = c.getContext('2d');
    g.lineJoin = g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i <= T.M; i++) { const k = i % T.M, x = T.X[k] * S + ox, y = T.Z[k] * S + oz; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.strokeStyle = 'rgba(127,135,150,.3)'; g.lineWidth = Math.max(3, 12 * S); g.stroke();
    g.strokeStyle = 'rgba(228,232,239,.35)'; g.lineWidth = 1; g.stroke();
    const g0 = T.gates[0];
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2; g.beginPath(); g.moveTo(g0.ax * S + ox, g0.az * S + oz); g.lineTo(g0.bx * S + ox, g0.bz * S + oz); g.stroke();
    radarBg = {id:T.id, c};
  }
  rctx.clearRect(0, 0, W, W);
  rctx.drawImage(radarBg.c, 0, 0);
  rctx.lineCap = rctx.lineJoin = 'round';
  bikes.forEach(b => {
    const L = b.wlist; if (!L || L.n < 2) return;
    rctx.strokeStyle = b.r.css; rctx.lineWidth = 2;
    rctx.beginPath();
    for (let i = 0; i < L.n; i++) { const x = L.x[i] * S + ox, y = L.z[i] * S + oz; if (i && L.a[i] > 0 && L.a[i - 1] > 0) rctx.lineTo(x, y); else rctx.moveTo(x, y); }
    rctx.stroke();
  });
  const tick = nowTick();
  rctx.globalAlpha = .75;
  T.pickups.forEach((p, k) => {
    if (fw.pk[k] > tick) return;
    rctx.fillStyle = VC.track.pickups.colors[p.kind];
    rctx.fillRect(p.x * S + ox - 1.5, p.z * S + oz - 1.5, 3, 3);
  });
  rctx.globalAlpha = 1;
  bikes.forEach(b => {
    if (!b.alive) return;
    const x = b.pos.x * S + ox, y = b.pos.z * S + oz;
    rctx.fillStyle = b.r.css; rctx.beginPath(); rctx.arc(x, y, b === player ? 6 : 4.5, 0, Math.PI * 2); rctx.fill();
    if (b === player) { rctx.strokeStyle = '#ffffff'; rctx.lineWidth = 2; rctx.stroke(); }
  });
}

/* ---------- Crash particles ---------- */
/* ---------- HUD ---------- */
function setMsg(m, s){ $('msg').textContent = m || ''; $('sub').textContent = s || ''; msgT = 0; }
function flash(m, s, t){ setMsg(m, s); msgT = t; }
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function buildBoard(){
  $('board').innerHTML = bikes.map(b =>
    `<div class="chip cut${b === player ? ' me' : ''}" id="chip${b.id}" style="--c:${b.r.css}"><span class="dot"></span><span class="name">${esc(b.name)}</span>${isCircuit() ? '<span class="lapc num">L1</span>' : `<span class="pips">${'<span class="pip"></span>'.repeat(cfg.win)}</span>`}</div>`).join('');
  updateBoard();
}
function updateBoard(){
  if (isCircuit()) { if (fw && fw.track && player) circuitBoard(); return; }
  bikes.forEach(b => {
    const el = $('chip' + b.id); if (!el) return;
    el.classList.toggle('dead', !b.alive);
    el.querySelectorAll('.pip').forEach((p, i) => p.classList.toggle('on', i < (scores[b.id] || 0)));
  });
  const alive = bikes.filter(b => b.alive).length;
  $('aliveLabel').textContent = `${alive} / ${bikes.length} riders`;
  $('roundLabel').textContent = `ROUND ${round}`;
}
// Minimap: walls as thin lines, riders as dots (you get a white ring)
const radar = $('radar'), rctx = radar.getContext('2d'); let radarT = 0;
function drawRadar(){
  if (isCircuit()) { if (fw && fw.track) circuitRadar(); return; }
  const W = radar.width, S = W / N;
  rctx.clearRect(0, 0, W, W);
  rctx.lineCap = rctx.lineJoin = 'round';
  bikes.forEach(b => {
    if (b.wpts) {
      // Free steering: the dense polyline
      if (b.cleared || !b.wn) return;
      const P = b.wpts;
      rctx.globalAlpha = b.alive ? .8 : .3; rctx.strokeStyle = b.r.css; rctx.lineWidth = 2;
      rctx.beginPath();
      for (let i = 0; i < b.wn; i++) { const x = (P[2 * i] + H) * S, y = (P[2 * i + 1] + H) * S; if (i) rctx.lineTo(x, y); else rctx.moveTo(x, y); }
      if (b.alive) rctx.lineTo((b.pos.x + H) * S, (b.pos.z + H) * S);
      rctx.stroke();
      return;
    }
    if (b.cleared || !b.segs.length) return;
    rctx.globalAlpha = b.alive ? .8 : .3; rctx.strokeStyle = b.r.css; rctx.lineWidth = 2;
    rctx.beginPath();
    b.segs.forEach((g, i) => { const x = (g.x0 + .5) * S, y = (g.z0 + .5) * S; if (i) rctx.lineTo(x, y); else rctx.moveTo(x, y); });
    rctx.lineTo((b.pos.x + H) * S, (b.pos.z + H) * S);
    rctx.stroke();
  });
  rctx.globalAlpha = 1;
  bikes.forEach(b => {
    if (!b.alive) return;
    const x = (b.pos.x + H) * S, y = (b.pos.z + H) * S;
    rctx.fillStyle = b.r.css; rctx.beginPath(); rctx.arc(x, y, b === player ? 6 : 4.5, 0, Math.PI * 2); rctx.fill();
    if (b === player) { rctx.strokeStyle = '#ffffff'; rctx.lineWidth = 2; rctx.stroke(); }
  });
}
/* Side awareness: riders near you but off-screen (beside or behind) get an arrow at the screen edge,
   pointing toward them, in their colour, fading with distance */
const threatEls = [], threatV = new THREE.Vector3();
function updateThreats(){
  const box = $('threats'), H = VC.hud, show = playing() && player && player.alive && state !== 'wait';
  let n = 0;
  if (show) for (const b of bikes) {
    if (b === player || !b.alive || n >= H.threatMax) continue;
    const d = player.vpos.distanceTo(b.vpos);
    if (d > H.threatRange) continue;
    threatV.copy(b.vpos).setY(.5).project(camera);
    const behind = threatV.z > 1;
    let x = behind ? -threatV.x : threatV.x, y = behind ? -threatV.y : threatV.y;
    if (!behind && Math.abs(x) < .92 && Math.abs(y) < .88) continue;   // already on screen
    const a = Math.atan2(y, x);
    let el = threatEls[n];
    if (!el) { el = document.createElement('i'); el.className = 'threat'; box.appendChild(el); threatEls[n] = el; }
    el.style.setProperty('--c', b.r.css);
    el.style.left = (50 + Math.cos(a) * 46) + '%'; el.style.top = (50 - Math.sin(a) * 42) + '%';
    el.style.transform = `rotate(${-a}rad)`;
    el.style.opacity = (1 - d / H.threatRange) * .9 + .1;
    n++;
  }
  for (let i = n; i < threatEls.length; i++) threatEls[i].style.opacity = 0;
}
function updateHud(dt){
  updateThreats();
  if (state === 'demo' || !player) return;
  $('spd').textContent = Math.round((isFree() && fw ? fw.cfg.base : BASE) * player.mul * 11 * (player.alive && state !== 'countdown' && state !== 'wait' ? 1 : 0));
  if (isCircuit() && state !== 'wait') circuitHud(dt);
  $('nrg').style.width = (player.energy * 100).toFixed(1) + '%';
  $('slip').classList.toggle('on', player.alive && player.grind > 0);
  if (msgT > 0) { msgT -= dt; if (msgT <= 0) setMsg('', ''); }
  radarT -= dt; if (radarT <= 0) { radarT = .08; drawRadar(); }
}

/* ---------- Camera ---------- */
/* ---------- Showroom Phantom (title + garage) ---------- */
// A turntable craft held in front of the camera, kept upright in world space whatever the camera does
const hero = createRiderVisual(VC.riders[0].hex);
hero.group.scale.multiplyScalar(VC.showroom.scale); hero.group.visible = false; camera.add(hero.group);
const heroLight = new THREE.SpotLight(0xffffff, 0, 18, .55, .9, 1.2);
heroLight.position.set(...VC.showroom.light); camera.add(heroLight); heroLight.target = hero.group;
let heroOn = false, heroSpin = .6, heroDrop = VC.showroom.drop;
const heroQ = new THREE.Quaternion(), heroYaw = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
function showcase(on, hex, drop){
  heroDrop = drop !== undefined ? drop : VC.showroom.drop;
  heroOn = !!on; hero.group.visible = heroOn; heroLight.intensity = heroOn ? VC.showroom.lightIntensity : 0;
  if (hex !== undefined) hero.ud.setColor(linHex(hex));
}
function updateHero(dt){
  if (!heroOn) return;
  heroSpin += dt * VC.showroom.spin;
  const d = VC.showroom.distance * Math.max(1, VC.showroom.minAspect / camera.aspect);
  hero.group.position.set(0, -d * heroDrop, -d);
  heroQ.copy(camera.quaternion).invert().multiply(heroYaw.setFromAxisAngle(UP, heroSpin));
  hero.group.quaternion.copy(heroQ);
  hero.ud.update(dt, 0);
}

// Thrusters power on at GO: a short spike in the craft's visual speed
function powerOn(){ bikes.forEach(b => { b.powerT = VC.effects.powerOn.duration; }); }

/* ---------- Flow ---------- */
function startDemo(){
  mode = 'solo'; net = null; me = 0; paused = false; $('pausebox').hidden = true; cfg.steer = 'free'; cfg.event = 'arena';
  arena.setCircuit(false); trackView.show(null); document.body.classList.remove('circuit');
  state = 'demo'; buildRiders(RIDERS.slice(0, 4).map((r, i) => ({name:r.name, bot:true, color:VC.riders[i].key}))); resetRound(); demoT = 0;
  $('hud').hidden = true; $('touch').hidden = true; $('menu').hidden = false;
}
function begin(){
  buildBoard();
  document.documentElement.style.setProperty('--accent', player.r.css);   // your colour is the only UI accent
  const c = isCircuit();
  $('winLabel').textContent = c ? `${trackOf(cfg.track).name} · ${cfg.laps} laps` : `First to ${cfg.win} rounds`;
  arena.setCircuit(c);
  document.body.classList.toggle('circuit', c);
  $('lapPanel').hidden = !c; $('burstRow').hidden = !c; $('tX').hidden = !c;
  if (!c) trackView.show(null);
  $('menu').hidden = true; $('hud').hidden = false; $('touch').hidden = !coarse;
  keys.boost = keys.l = keys.r = keys.burst = keys.brake = false; keys.snapQ.length = 0; sentBoost = false; lastW = -1; snapAcc = 0;
  $('tL').setAttribute('aria-label', isFree() ? 'Steer left' : 'Turn left');
  $('tR').setAttribute('aria-label', isFree() ? 'Steer right' : 'Turn right');
  emit('match-start', {online:mode !== 'solo', host:mode === 'host', riders:bikes.length, diff:cfg.diff, event:cfg.event});
  if (mode === 'guest') { state = 'wait'; setMsg('SYNCING', 'linking to the host grid'); }
  else nextRound();
}
function startSolo(o){
  SFX.init(); mode = 'solo'; net = null; me = 0; cfg = {diff:o.diff, win:o.win, steer:o.steer === 'grid' ? 'grid' : 'free', ...eventCfg(o)};
  buildRiders([{name:o.name || 'YOU', color:o.color}, ...RIDERS.slice(1, 1 + o.bots).map(r => ({name:r.name, bot:true}))]);
  begin();
}
function startOnline(o){
  SFX.init(); mode = o.role; net = o.net; me = o.me; matchId = o.id; turnLog = {};
  fpLog = {}; fpSeq = 0;
  cfg = {diff:o.diff, win:o.win, steer:o.steer === 'free' ? 'free' : 'grid', ...eventCfg(o)};   // rooms from before free steering race on the grid
  buildRiders(o.roster.map((p, i) => ({name:p.name, bot:p.bot, color:p.color, remote:o.role === 'host' && !p.bot && i !== o.me})));
  begin();
}
// Event settings from the menu or the room: anything but 'circuit' is the arena
function eventCfg(o){
  return {event:o.event === 'circuit' ? 'circuit' : 'arena', laps:[3, 5, 7].includes(+o.laps) ? +o.laps : 3, track:o.track || DEFAULT_TRACK};
}
function nextRound(){
  round++; lastW = -1; resetRound(); updateBoard(); SFX.riser(3); lastCd = 4;
  state = 'countdown'; cd = 3;
  rig.intro(player);
  pushState();
}
function roundMsg(w){
  if (w === player) { SFX.hit('win'); emit('round-win'); setMsg('ROUND WON', `${scores[player.id]} of ${cfg.win} to own the grid`); }
  else if (w) setMsg(w.name, 'takes the round');
  else setMsg('NO WINNER', 'the grid keeps this one');
}
function endRound(w){
  if (state !== 'run') return;
  state = 'over'; overT = 2.8;
  if (w) scores[w.id]++;
  lastW = w ? w.id : -1;
  updateBoard();
  roundMsg(w);
  pushState();
}
function afterRound(){
  if (isCircuit()) return matchOver(bikes[lastW] || null);
  const top = scores.indexOf(Math.max(...scores));
  if (scores[top] >= cfg.win) matchOver(bikes[top]); else nextRound();
}
function matchOver(w){
  if (isCircuit()) return circuitOver();
  const summary = {online:mode !== 'solo', host:mode === 'host', won:!!w && w === player, winner:w ? w.name : '', winnerCss:w ? w.r.css : VC.palette.textDim,
    roundsWon:scores[player.id] || 0, rounds:round, diff:cfg.diff,
    table:bikes.map(b => ({name:b.name, css:b.r.css, score:scores[b.id] || 0, me:b === player, bot:b.ai})).sort((a, b) => b.score - a.score)};
  if (mode === 'host') { state = 'end'; lastW = w ? w.id : -1; pushState(); }
  SFX.hit(summary.won ? 'win' : 'fall');
  setMsg('', '');
  startDemo();
  if (hooks.end) hooks.end(summary);
}
// Circuit results: finishing order (laps, then time), total and best lap times
function circuitOver(){
  const res = raceRes || (fw && fw.track ? results() : []), n = res.length, w = res[0] ? bikes[res[0][0]] : null;
  const summary = {online:mode !== 'solo', host:mode === 'host', won:!!w && w === player, winner:w ? w.name : '', winnerCss:w ? w.r.css : VC.palette.textDim,
    roundsWon:w === player ? 1 : 0, rounds:1, diff:cfg.diff, event:'circuit', laps:cfg.laps, track:trackOf(cfg.track).name,
    table:res.filter(x => bikes[x[0]]).map(([id, place, total, best, laps]) => {
      const b = bikes[id];
      return {name:b.name, css:b.r.css, score:n - place, place, total:total >= 0 ? total / 60 : null, best:best ? best / 60 : null, laps, me:b === player, bot:b.ai};
    })};
  if (mode === 'host') { state = 'end'; lastW = w ? w.id : -1; pushState(); }
  SFX.hit(summary.won ? 'win' : 'fall');
  setMsg('', '');
  startDemo();
  if (hooks.end) hooks.end(summary);
}
function togglePause(force){
  if (!playing()) return;
  const open = force !== undefined ? force : $('pausebox').hidden;
  $('pausebox').hidden = !open;
  paused = open && mode === 'solo';
  $('pauseTitle').textContent = mode === 'solo' ? 'PAUSED' : 'MENU';
  $('pauseHint').textContent = mode === 'solo' ? 'Press P or tap Resume' : 'The race keeps running while this is open';
  if (open) keys.boost = keys.l = keys.r = keys.burst = keys.brake = false;
}
function quit(){
  const wasOnline = mode !== 'solo';
  setMsg('', ''); startDemo();
  if (hooks.quit) hooks.quit(wasOnline);
}
function cycleCam(){ camMode = (camMode + 1) % 3; $('camLabel').textContent = CAMS[camMode]; }
function queueTurn(t){
  if (paused || !player || !player.alive || player.ai || isCircuit()) return;   // no snap turns on a circuit
  if (!['countdown', 'run'].includes(state)) return;
  if (isFree()) { if (keys.snapQ.length < 2) keys.snapQ.push(t); return; }   // free: a snap turn on the next tick
  if (mode === 'guest') {
    if (state === 'countdown') { net.turn(t, -1, round); return; }
    if (player.k === player.lastLocalK) { if (player.gq.length < 2) { player.gq.push(t); player.localT = performance.now(); } }
    else guestTurnNow(player, t);
    return;
  }
  if (player.queue.length < 2) player.queue.push(t);
}
function trySkip(){ if (mode !== 'guest' && state === 'run' && !isCircuit() && !humansAlive()) endRound(null); }

/* ---------- Input ---------- */
function playing(){ return ['countdown', 'run', 'over', 'wait'].includes(state); }
addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.code;
  if (playing() && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space'].includes(k)) e.preventDefault();
  if (k === 'KeyM' && !e.repeat) { SFX.toggle(); return; }
  if (!playing()) return;
  if (e.repeat && k !== 'Space' && k !== 'KeyW' && k !== 'ArrowUp') return;
  // Free steering: hold to steer, Shift + arrow snaps 90 degrees. Grid: every press turns.
  // Circuit: Shift (or E) holds Light Burst, Down / S brakes, no snap turns
  const c = isCircuit();
  if (k === 'ArrowLeft' || k === 'KeyA') { if (isFree() && (!e.shiftKey || c)) keys.l = true; else queueTurn(-1); }
  else if (k === 'ArrowRight' || k === 'KeyD') { if (isFree() && (!e.shiftKey || c)) keys.r = true; else queueTurn(1); }
  else if (c && (k === 'ShiftLeft' || k === 'ShiftRight' || k === 'KeyE')) keys.burst = true;
  else if (c && (k === 'ArrowDown' || k === 'KeyS')) keys.brake = true;
  else if (k === 'Space' || k === 'KeyW' || k === 'ArrowUp') { keys.boost = true; if (!e.repeat) trySkip(); }
  else if (k === 'KeyC') cycleCam();
  else if (k === 'KeyP' || k === 'Escape') togglePause();
});
addEventListener('keyup', e => {
  if (['Space','KeyW','ArrowUp'].includes(e.code)) keys.boost = false;
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.l = false;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.r = false;
  if (['ShiftLeft', 'ShiftRight', 'KeyE'].includes(e.code)) keys.burst = false;
  if (e.code === 'ArrowDown' || e.code === 'KeyS') keys.brake = false;
});
addEventListener('blur', () => { keys.boost = keys.l = keys.r = keys.burst = keys.brake = false; if (state === 'run' && mode === 'solo') togglePause(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'run' && mode === 'solo') togglePause(true); });
$('resumeBtn').addEventListener('click', () => togglePause(false));
$('quitBtn').addEventListener('click', quit);
$('menuBtn').addEventListener('click', () => togglePause(true));
$('pausebox').addEventListener('pointerdown', e => { if (e.target === $('pausebox')) togglePause(false); });
const hold = (el, down, up) => {
  el.addEventListener('pointerdown', e => { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch (_) {} down(); });
  if (up) ['pointerup','pointercancel','lostpointercapture'].forEach(t => el.addEventListener(t, up));
  el.addEventListener('contextmenu', e => e.preventDefault());
};
// ◀ ▶ turn 90 degrees per press on the grid, and steer while held in free mode
const steerBtn = (t, on) => { if (isFree()) keys[t < 0 ? 'l' : 'r'] = on; else if (on) queueTurn(t); };
hold($('tL'), () => { steerBtn(-1, true); trySkip(); }, () => steerBtn(-1, false));
hold($('tR'), () => { steerBtn(1, true); trySkip(); }, () => steerBtn(1, false));
hold($('tB'), () => { keys.boost = true; trySkip(); }, () => keys.boost = false);
hold($('tX'), () => { keys.burst = true; }, () => keys.burst = false);   // circuit: Light Burst
document.querySelectorAll('[data-mute]').forEach(el => el.addEventListener('click', () => { SFX.init(); SFX.toggle(); }));
$('camBtn').addEventListener('click', cycleCam);
// Swipe left / right anywhere on the arena to turn (free mode: snap turn); a plain tap skips while spectating
let swipe = null;
const cv = renderer.domElement;
cv.addEventListener('pointerdown', e => { swipe = {x:e.clientX, y:e.clientY, done:false}; });
cv.addEventListener('pointermove', e => {
  if (!swipe || swipe.done) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  if (Math.abs(dx) > 34 && Math.abs(dx) > Math.abs(dy) * 1.3) { swipe.done = true; queueTurn(dx > 0 ? 1 : -1); }
});
cv.addEventListener('pointerup', () => { if (swipe && !swipe.done) trySkip(); swipe = null; });
cv.addEventListener('pointercancel', () => { swipe = null; });

addEventListener('resize', () => {
  pipe.resize();
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

/* Close-pass audio: a fly-by when you start riding a wall's slipstream or skim past another rider */
const passTmp = new THREE.Vector3();
function closePasses(now){
  const grinding = player.grind > 0;
  if (grinding && !player.wasGrinding) SFX.flyby(.55, 0);
  player.wasGrinding = grinding;
  const fx = -Math.sin(player.vyaw), fz = -Math.cos(player.vyaw);
  for (const b of bikes) {
    if (b === player || !b.alive) continue;
    const d = player.pos.distanceTo(b.pos);
    if (d > 3.2 || (b.passCool || 0) > now) continue;
    passTmp.subVectors(b.pos, player.pos);
    // which side they pass on: positive = right of your heading
    const side = Math.sign(-fz * passTmp.x + fx * passTmp.z);
    SFX.flyby(1.2 - d / 3.2, side * .7);
    b.passCool = now + 1200;
  }
}

/* ---------- Loop ---------- */
let last = performance.now();
const glowSlots = RIDERS.map(() => ({pos:null, colorHex:0, on:false}));
function frame(now){
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000, real = Math.min(.05, raw); last = now;
  const dt = paused ? 0 : real;
  // Visual clock: slows briefly after your own crash; the simulation always uses dt
  if (slowT > 0) slowT -= real;
  const vdt = slowT > 0 ? dt * VC.effects.slowMotion.scale : dt;
  if (state === 'countdown') {
    cd -= dt;
    const s = Math.ceil(cd);
    const how = isCircuit() ? (coarse ? 'hold ◀ ▶ to steer · BURST lays a light wall' : 'arrows steer · Shift lays a light wall · ↓ brakes')
      : isFree() ? (coarse ? 'hold ◀ ▶ to steer · swipe to snap' : 'hold arrows to steer · Shift snaps 90°') : (coarse ? 'buttons or swipe' : 'arrows or A / D to turn');
    if (cd > 0) setMsg(String(s), isCircuit() ? `${cfg.laps} laps · ${how}` : `Round ${round} · ${how}`);
    else if (mode !== 'guest') { state = 'run'; flash('GO', '', .6); SFX.hit('go'); powerOn(); pushState(); }
    else setMsg('GO', '');
    if (cd > 0 && Math.ceil(cd) !== lastCd) { lastCd = Math.ceil(cd); SFX.hit('tick'); }
  }
  if (mode === 'guest') {
    if (isFree()) freeGuestFrame(dt);
    else {
      const want = keys.boost && player.alive && state === 'run';
      if (want !== sentBoost) { sentBoost = want; net.boost(want); }
      bikes.forEach(b => { glide(b, dt); if (b.alive) syncSegs(b); });
    }
  } else if (state === 'run' || state === 'over' || state === 'demo') {
    if (isFree()) freeUpdate(dt);
    else {
      if (state !== 'demo') player.wantBoost = keys.boost && player.alive;
      bikes.forEach(b => update(b, dt));
    }
  }
  bikes.forEach(b => b.alive ? (isFree() ? placeFree(b, vdt) : placeBike(b, vdt)) : fadeDead(b, dt));
  trails.tick(vdt);
  if (isCircuit()) bikes.forEach(circuitWalls);
  else if (isFree()) bikes.forEach(freeWalls);
  bikes.forEach(b => trails.update(b, wx, b.alive ? b.trim : 0, DEATH_WINDOW));
  if (mode !== 'guest') {
    if (state === 'run' && isCircuit()) circuitRun(dt);
    else if (state === 'run') {
      const alive = bikes.filter(b => b.alive);
      if (alive.length <= 1) endRound(alive[0] || null);
      else if (!humansAlive()) { spectT += dt; if (spectT > 7) endRound(null); }
    } else if (state === 'over') {
      overT -= dt; if (overT <= 0) afterRound();
    } else if (state === 'demo') {
      if (bikes.filter(b => b.alive).length <= 1) { demoT += dt; if (demoT > 1.6) { demoT = 0; resetRound(); } }
    }
  }
  if (mode === 'host' && playing()) { snapAcc += real; if (snapAcc >= SNAP_DT) pushState(); }
  const pl = player && player.alive;
  const boosting = pl && state === 'run' && keys.boost && player.energy > .02 ? 1 : 0;
  if (boosting && !wasBoosting) emit('boost');
  wasBoosting = boosting;
  const speedK = pl && state === 'run' ? Math.max(0, Math.min(1, (player.mul - 1) / .7)) : 0;
  fx.update(vdt, bikes, boosting);
  // Camera follows you; once you're out it switches to a surviving rider
  if (!pl && playing()) deadT += real; else deadT = 0;
  const follow = !player ? null : pl || deadT < 1.3 ? player : bikes.find(o => o.alive) || player;
  rig.update(vdt, {mode:camMode, focus:follow, player, boost:Math.max(speedK, boosting * .6), countdown:state === 'countdown', menu:state === 'demo' || state === 'wait'});
  updateHero(vdt);
  updateHud(dt);
  SFX.mood(paused ? .15 : state === 'run' ? (pl ? 1 : .6) : state === 'countdown' ? .55 : state === 'over' ? .5 : .25);
  SFX.engine(state === 'run' && pl && !paused ? 1 : (state === 'countdown' && !paused ? .45 : 0), player ? player.mul : 1, boosting);
  if (pl && state === 'run' && !paused) closePasses(now);
  // Lights follow the local rider (or the arena centre during the attract demo)
  const focus = state === 'demo' || !player ? bikes[0] : player;
  if (focus) pipe.follow(state === 'demo' ? rig.look : focus.vpos, focus.r.color);
  glowSlots.forEach((g, i) => { const b = bikes[i]; g.on = !!b && b.alive; if (g.on) { g.pos = b.vpos; g.colorHex = b.r.color; } });
  pipe.setGlows(glowSlots);
  arena.update(vdt, glowSlots, camera.position, pipe.particleScale);
  if (isCircuit() && fw && fw.track) trackView.update(vdt, fw.pk, nowTick(), bikes);
  pipe.render(raw, Math.max(speedK, boosting));
}
['pointerdown', 'keydown'].forEach(t => addEventListener(t, () => SFX.init(), {once:true}));
startDemo();
requestAnimationFrame(frame);

export const Game = {
  hooks, startSolo, startOnline, toDemo:() => { setMsg('', ''); startDemo(); },
  remoteTurn, remoteBoost, removeRider, applySnapshot, addTurnPoint, remoteInput, addFreePoints,
  initAudio:() => SFX.init(),
  keys,   // input state other modules (gamepad) may set: l, r, boost, snapQ, burst, brake
  showcase, colourOf,
  setQuality:q => { const l = pipe.setQuality(q); try { localStorage.setItem('pr-quality', l); } catch (e) {} return l; },
  get quality(){ return pipe.quality; },
  debug:() => ({state, round, mode, me, steer:cfg.steer, scores:scores.slice(), bikes:bikes.map(b => ({name:b.name, cx:b.cx, cz:b.cz, dir:b.dir, k:b.k, nt:b.nt, alive:b.alive, segs:b.segs.length,
    ...(b.fr ? {x:+b.pos.x.toFixed(2), z:+b.pos.z.toFixed(2), h:+FS.wrap(b.fr.h).toFixed(3), n:b.fr.n, sx:+b.fr.x.toFixed(2), sz:+b.fr.z.toFixed(2)} : {})})),
    ...(fw ? {tick:fw.tick, pSeq, wallSegs:fw.S.ax.length} : {}),
    ...(isCircuit() && fw && fw.track ? {event:'circuit', laps:cfg.laps, track:fw.track.id, pk:Array.from(fw.pk, v => v > nowTick() ? 1 : 0).join(''), res:raceRes,
      race:bikes.map(b => b.fr ? {gp:b.fr.gp, lap:FS.lapOf(fw, b.fr), meter:+b.fr.meter.toFixed(3), lay:b.fr.lay, ghost:b.fr.ghostT, phase:b.fr.phaseT, shield:b.fr.shield,
        done:b.fr.done, place:b.fr.place, best:b.fr.best, prog:+b.fr.prog.toFixed(1), crashes:b.fr.crashes, burstPts:b.wlist ? b.wlist.n : 0} : null)} : {event:cfg.event})}),
  get state(){ return state; },
  get mode(){ return mode; }
};
