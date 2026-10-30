/* Phantom Run engine: scene, riders, simulation, audio, HUD and camera.
   One engine, three roles:
     solo  - simulates everything locally
     host  - simulates everything, streams snapshots + turn points to guests
     guest - renders host snapshots, dead-reckons between them and predicts
             its own turns so steering feels instant */
import { VISUAL_CONFIG as VC } from './visuals/config.js';
import { createRiderVisual, disposeRiderVisual, resetPose, updatePose, headingYaw } from './visuals/riders.js';
import { createPipeline, lin, defaultQuality } from './visuals/renderer.js';
import { SFX } from './audio.js';
import { createArena } from './visuals/arena.js';
const THREE = window.THREE;
const $ = id => document.getElementById(id);
const N = 128, H = N / 2, WALL_H = VC.wall.height, T = 0.16, BASE = 15;
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
let cfg = {diff:'rider', win:5};
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
const UNIT = new THREE.BoxGeometry(1,1,1);
const headingOf = d => headingYaw(DIRS[d][0], DIRS[d][1]);

let bikes = [], player = null, scores = [], round = 0;
let state = 'demo', cd = 0, overT = 0, spectT = 0, deadT = 0, demoT = 0, paused = false, msgT = 0;
let camMode = 0, shake = 0, orbitT = 0, lastCd = 4;
const keys = {boost:false};
const camPos = new THREE.Vector3(0, 60, 90), camLook = new THREE.Vector3();
const humansAlive = () => bikes.some(b => b.alive && !b.ai);

function startSegAt(b, x, z){
  const s = {x0:x, z0:z,
    wall:new THREE.Mesh(UNIT, b.wallMat), cap:new THREE.Mesh(UNIT, b.capMat), fl:new THREE.Mesh(UNIT, b.floorMat)};
  scene.add(s.wall, s.cap, s.fl); b.segs.push(s); sizeSeg(s, wx(x), wx(z)); return s;
}
function startSeg(b){ b.nt++; return startSegAt(b, b.cx, b.cz); }
function sizeSeg(s, x1, z1){
  const ax = wx(s.x0), az = wx(s.z0);
  const lx = Math.abs(x1 - ax) + T, lz = Math.abs(z1 - az) + T, cx = (ax + x1) / 2, cz = (az + z1) / 2;
  s.wall.scale.set(lx, WALL_H, lz); s.wall.position.set(cx, WALL_H / 2, cz);
  s.cap.scale.set(lx + .03, .08, lz + .03); s.cap.position.set(cx, WALL_H, cz);
  s.fl.scale.set(lx + 1.2, .02, lz + 1.2); s.fl.position.set(cx, .015, cz);
}
const removeSeg = s => scene.remove(s.wall, s.cap, s.fl);
const segVisible = (s, v) => { s.wall.visible = s.cap.visible = s.fl.visible = v; };

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
/* Visual only: hide the last `trim` cells of wall so it appears to leave the craft's tail.
   The occupied cells (collisions) are untouched. */
function layWalls(b, trim){
  let remain = trim, ex = b.pos.x, ez = b.pos.z;
  for (let i = b.segs.length - 1; i >= 0; i--) {
    const s = b.segs[i], sx = wx(s.x0), sz = wx(s.z0), len = Math.abs(ex - sx) + Math.abs(ez - sz);
    if (remain > 0 && remain >= len) { segVisible(s, false); remain -= len; ex = sx; ez = sz; continue; }
    const k = len > 0 ? remain / len : 0;
    sizeSeg(s, ex + (sx - ex) * k, ez + (sz - ez) * k); segVisible(s, true);
    if (i > 0) { const prev = b.segs[i - 1]; sizeSeg(prev, sx, sz); segVisible(prev, true); }
    return;
  }
}

function buildRiders(roster){
  bikes.forEach(b => {
    scene.remove(b.mesh.group); b.segs.forEach(removeSeg);
    disposeRiderVisual(b.mesh); [b.wallMat, b.capMat, b.floorMat].forEach(m => m.dispose());
  });
  bikes = [];
  roster.forEach((p, i) => {
    const r = RIDERS[i], col = lin(r.color), mesh = createRiderVisual(r.color);
    mesh.group.visible = false; scene.add(mesh.group);
    bikes.push({id:i, r, name:String(p.name || r.name).toUpperCase(), ai:!!p.bot, remote:!!p.remote, gone:false,
      mesh, segs:[], pos:new THREE.Vector3(), vpos:new THREE.Vector3(), alive:false, cleared:true, nt:0, k:0, local:[], gq:[], sched:[], queue:[],
      cx:H, cz:H, dir:0, p:0, mul:1, energy:.35, grind:0, vyaw:0, lean:0, snapT:0, lastLocalK:-1, localT:0,
      hist:new Int16Array(HIST * 2),
      wallMat:new THREE.MeshBasicMaterial({color:col, transparent:true, opacity:.55, depthWrite:false, side:THREE.DoubleSide}),
      capMat:new THREE.MeshBasicMaterial({color:col.clone().lerp(new THREE.Color(0xffffff), .5), transparent:true, opacity:1, toneMapped:false}),
      floorMat:new THREE.MeshBasicMaterial({color:col, transparent:true, opacity:.16, blending:THREE.AdditiveBlending, depthWrite:false}),
      rgb:[(r.color >> 16) & 255, (r.color >> 8) & 255, r.color & 255]});
  });
  player = bikes[me] || bikes[0]; scores = bikes.map(() => 0); round = 0;
}

function revive(b){
  b.wallMat.opacity = .55; b.capMat.opacity = 1; b.floorMat.opacity = .16;
  b.mesh.group.visible = b.alive;
}

function resetRound(){
  grid.fill(0);
  bikes.forEach(b => { b.segs.forEach(removeSeg); b.segs = []; });
  bursts.forEach(killBurst); bursts.length = 0;
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
  updatePose(b, dt, b.vpos, headingOf(b.dir), moving ? BASE * b.mul / VC.vehicle.scale : 0);
  layWalls(b, VC.vehicle.originBehindHead + b.mesh.tail);
}

function turn(b, t){
  b.dir = (b.dir + (t > 0 ? 1 : 3)) % 4;
  const cur = b.segs[b.segs.length - 1]; if (cur) sizeSeg(cur, wx(b.cx), wx(b.cz));
  startSeg(b);
  b.lastTurnK = b.k; b.grace = 0;
  if (b === player && !b.ai) SFX.blip();
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

function crash(b){
  b.alive = false; b.grace = 0; b.mesh.group.visible = false;
  layWalls(b, 0);
  explode(b.vpos.x, b.vpos.z, b.r.color);
  if (state !== 'demo') {
    const dist = player.alive ? player.pos.distanceTo(b.pos) : 20;
    SFX.boom(b === player ? 1 : Math.max(.12, .6 - dist / 120));
  }
  if (b === player && state === 'run') {
    shake = reduceMotion ? .25 : 1;
    const others = bikes.filter(o => o.alive).length;
    SFX.hit('fall');
    const canSkip = mode !== 'guest' && !humansAlive() && others > 1;
    setMsg('WIPED OUT', canSkip ? (coarse ? 'Tap to skip' : 'Space to skip') : others > 1 ? 'Spectating' : '');
  }
  if (state !== 'demo') updateBoard();
  if (mode === 'host') pushState();
}

function fadeDead(b, dt){
  if (b.cleared) return;
  b.deathT += dt;
  const k = Math.max(0, 1 - b.deathT / 1.4);
  b.wallMat.opacity = .55 * k; b.capMat.opacity = k; b.floorMat.opacity = .16 * k;
  if (b.deathT > 1.4) {
    b.segs.forEach(removeSeg); b.segs = [];
    const v = b.id + 1; for (let i = 0; i < grid.length; i++) if (grid[i] === v) grid[i] = 0;
    b.cleared = true;
  }
}

/* ---------- Online: host side ---------- */
function snapshot(){
  return {m:matchId, r:round, s:state, cd:Math.max(0, +cd.toFixed(2)), sc:scores.slice(), w:lastW,
    b:bikes.map(b => [b.cx | 0, b.cz | 0, b.dir | 0, Math.round(b.p * 100), Math.round(b.mul * 100), b.alive ? 1 : 0,
      Math.round(b.energy * 100), b.grind > 0 ? 1 : 0, b.k | 0, b.nt | 0])};
}
function pushState(){ if (mode === 'host' && net) { snapAcc = 0; net.state(snapshot()); } }

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
  bikes.forEach(b => { b.segs.forEach(removeSeg); b.segs = []; });
  bursts.forEach(killBurst); bursts.length = 0;
  st.b.forEach((a, i) => {
    const b = bikes[i]; if (!b) return;
    Object.assign(b, {cx:a[0], cz:a[1], dir:a[2], p:a[3] / 100, mul:a[4] / 100, alive:!!a[5], energy:a[6] / 100, grind:a[7] ? .22 : 0,
      k:a[8], nt:a[9], spawn:{x:a[0], z:a[1]}, local:[], gq:[], lastLocalK:-1, snapT:0, deathT:0, cleared:!a[5]});
    resetPose(b, headingOf(a[2]));
    revive(b);
    if (!b.alive) return;
    const pts = guestPts(b);
    for (let k = 1; k < pts.length; k++) raster(b.id, pts[k - 1].x, pts[k - 1].z, pts[k].x, pts[k].z);
    grid[b.cx + b.cz * N] = b.id + 1;
    placeBike(b, 0);
  });
  state = 'countdown'; cd = st.cd; lastCd = 4; spectT = 0; deadT = 0;
  SFX.riser(Math.max(.6, st.cd));
  introCam();
  updateBoard();
}
function applySnapshot(st){
  if (mode !== 'guest' || !st || st.m !== matchId || !Array.isArray(st.b)) return;
  if (Array.isArray(st.sc)) scores = st.sc;
  if (st.s === 'end') { matchOver(bikes[st.w] || null); return; }
  if (st.r !== round) guestRound(st);
  const now = performance.now();
  st.b.forEach((a, i) => {
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
    if (state === 'run' && prev === 'countdown') { flash('GO', '', .6); SFX.hit('go'); }
    else if (state === 'over') roundMsg(st.w >= 0 ? bikes[st.w] : null);
  }
  if (state === 'countdown') cd = st.cd;
  updateBoard();
}
function guestTurnNow(b, t){
  net.turn(t, b.k, round);
  b.dir = (b.dir + (t > 0 ? 1 : 3)) % 4;
  b.local.push({x:b.cx, z:b.cz}); b.localT = performance.now(); b.lastLocalK = b.k;
  SFX.blip();
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
function syncSegs(b){
  const pts = guestPts(b);
  while (b.segs.length > pts.length) removeSeg(b.segs.pop());
  for (let i = Math.max(0, b.segs.length - 3); i < b.segs.length; i++) {
    const s = b.segs[i], p = pts[i];
    if (s.x0 !== p.x || s.z0 !== p.z) { s.x0 = p.x; s.z0 = p.z; if (i > 0) sizeSeg(b.segs[i - 1], wx(p.x), wx(p.z)); }
  }
  while (b.segs.length < pts.length) {
    const i = b.segs.length, p = pts[i];
    if (i > 0) sizeSeg(b.segs[i - 1], wx(p.x), wx(p.z));
    startSegAt(b, p.x, p.z);
  }
}

/* ---------- Crash particles ---------- */
const bursts = [];
function explode(x, z, hex){
  const color = lin(hex), n = Math.round(280 * pipe.particleScale), pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i*3] = x + (Math.random() - .5) * 1.6; pos[i*3+1] = .4 + Math.random() * .8; pos[i*3+2] = z + (Math.random() - .5) * 1.6;
    const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 13;
    vel[i*3] = Math.cos(a) * sp; vel[i*3+1] = 3 + Math.random() * 10; vel[i*3+2] = Math.sin(a) * sp;
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({color, size:.34, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false}));
  const ring = new THREE.Mesh(new THREE.RingGeometry(.6, .9, 56), new THREE.MeshBasicMaterial({color, transparent:true, opacity:.85, side:THREE.DoubleSide, blending:THREE.AdditiveBlending, depthWrite:false}));
  ring.rotation.x = -Math.PI / 2; ring.position.set(x, .06, z);
  scene.add(points, ring); bursts.push({points, ring, vel, t:0});
}
function killBurst(b){
  scene.remove(b.points, b.ring);
  b.points.geometry.dispose(); b.ring.geometry.dispose(); b.points.material.dispose(); b.ring.material.dispose();
}
function updateBursts(dt){
  for (let j = bursts.length - 1; j >= 0; j--) {
    const b = bursts[j]; b.t += dt;
    const p = b.points.geometry.attributes.position.array, v = b.vel;
    for (let i = 0; i < p.length; i += 3) {
      v[i+1] -= 16 * dt;
      p[i] += v[i] * dt; p[i+1] += v[i+1] * dt; p[i+2] += v[i+2] * dt;
      if (p[i+1] < .05) { p[i+1] = .05; v[i+1] *= -.3; v[i] *= .6; v[i+2] *= .6; }
    }
    b.points.geometry.attributes.position.needsUpdate = true;
    b.points.material.opacity = Math.max(0, 1 - b.t / 1.8);
    b.ring.scale.setScalar(1 + b.t * 28);
    b.ring.material.opacity = Math.max(0, .85 - b.t * 1.1);
    if (b.t > 2) { killBurst(b); bursts.splice(j, 1); }
  }
}

/* ---------- HUD ---------- */
function setMsg(m, s){ $('msg').textContent = m || ''; $('sub').textContent = s || ''; msgT = 0; }
function flash(m, s, t){ setMsg(m, s); msgT = t; }
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function buildBoard(){
  $('board').innerHTML = bikes.map(b =>
    `<div class="chip cut${b === player ? ' me' : ''}" id="chip${b.id}" style="--c:${b.r.css}"><span class="dot"></span><span class="name">${esc(b.name)}</span><span class="pips">${'<span class="pip"></span>'.repeat(cfg.win)}</span></div>`).join('');
  updateBoard();
}
function updateBoard(){
  bikes.forEach(b => {
    const el = $('chip' + b.id); if (!el) return;
    el.classList.toggle('dead', !b.alive);
    el.querySelectorAll('.pip').forEach((p, i) => p.classList.toggle('on', i < (scores[b.id] || 0)));
  });
  const alive = bikes.filter(b => b.alive).length;
  $('aliveLabel').textContent = `${alive} / ${bikes.length} riders`;
  $('roundLabel').textContent = `ROUND ${round}`;
}
const radar = $('radar'), rctx = radar.getContext('2d'), rimg = rctx.createImageData(N, N); let radarT = 0;
function drawRadar(){
  const d = rimg.data;
  for (let i = 0; i < N * N; i++) {
    const v = grid[i], o = i * 4;
    if (v && bikes[v - 1]) { const c = bikes[v - 1].rgb; d[o] = c[0] * .7; d[o+1] = c[1] * .7; d[o+2] = c[2] * .7; }
    else { const gl = (i % N) % 16 === 0 || ((i / N) | 0) % 16 === 0; d[o] = 8; d[o+1] = gl ? 26 : 16; d[o+2] = gl ? 34 : 24; }
    d[o+3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);
  bikes.forEach(b => { if (!b.alive) return; rctx.fillStyle = b === player ? '#ffffff' : b.r.css; rctx.fillRect(b.cx - 2, b.cz - 2, 5, 5); });
}
function updateHud(dt){
  if (state === 'demo' || !player) return;
  $('spd').textContent = Math.round(BASE * player.mul * 11 * (player.alive && state !== 'countdown' && state !== 'wait' ? 1 : 0));
  $('nrg').style.width = (player.energy * 100).toFixed(1) + '%';
  $('slip').classList.toggle('on', player.alive && player.grind > 0);
  if (msgT > 0) { msgT -= dt; if (msgT <= 0) setMsg('', ''); }
  radarT -= dt; if (radarT <= 0) { radarT = .08; drawRadar(); }
}

/* ---------- Camera ---------- */
const CAMS = ['Chase', 'Cockpit', 'Overhead'];
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
function introCam(){
  const fx = -Math.sin(player.vyaw), fz = -Math.cos(player.vyaw);
  camPos.set(player.vpos.x - fx * 30, 34, player.vpos.z - fz * 30); camLook.copy(player.vpos);
  camera.fov = 68; camera.updateProjectionMatrix();
}
function updateCamera(dt){
  if (state === 'demo' || state === 'wait') {
    orbitT += dt * .06;
    const O = VC.camera.orbit;
    tmpA.set(Math.cos(orbitT) * O.radius, O.height, Math.sin(orbitT) * O.radius); tmpB.set(0, 0, 0);
    camPos.lerp(tmpA, 1 - Math.exp(-dt * 2)); camLook.lerp(tmpB, 1 - Math.exp(-dt * 2));
    camera.position.copy(camPos); camera.lookAt(camLook); return;
  }
  let b = player;
  if (!player.alive) { deadT += dt; if (deadT > 1.3) b = bikes.find(o => o.alive) || player; }
  const fx = -Math.sin(b.vyaw), fz = -Math.cos(b.vyaw), P = b.vpos;
  let mode = camMode, k = 6;
  if (!b.alive) mode = 2;
  const C = VC.camera;
  if (mode === 0) { tmpA.set(P.x - fx * C.chase.back, C.chase.height, P.z - fz * C.chase.back); tmpB.set(P.x + fx * C.chase.ahead, C.chase.lookHeight, P.z + fz * C.chase.ahead); k = state === 'countdown' ? 2.2 : C.chase.follow; }
  else if (mode === 1) { tmpA.set(P.x + fx * .35, C.cockpit.height, P.z + fz * .35); tmpB.set(P.x + fx * C.cockpit.ahead, .7, P.z + fz * C.cockpit.ahead); k = 30; }
  else { tmpA.set(P.x, C.overhead.height, P.z + C.overhead.back); tmpB.copy(P); k = 3; }
  camPos.lerp(tmpA, 1 - Math.exp(-dt * k)); camLook.lerp(tmpB, 1 - Math.exp(-dt * k));
  camera.position.copy(camPos);
  if (shake > 0) { camera.position.x += (Math.random() - .5) * shake * .9; camera.position.y += (Math.random() - .5) * shake * .9; shake = Math.max(0, shake - dt * 2.2); }
  camera.lookAt(camLook);
  const fov = 68 + (player.alive ? (player.mul - 1) * 16 : 0);
  if (Math.abs(camera.fov - fov) > .05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 5); camera.updateProjectionMatrix(); }
}

/* ---------- Flow ---------- */
function startDemo(){
  mode = 'solo'; net = null; me = 0; paused = false; $('pausebox').hidden = true;
  state = 'demo'; buildRiders(RIDERS.slice(0, 4).map(r => ({name:r.name, bot:true}))); resetRound(); demoT = 0;
  $('hud').hidden = true; $('touch').hidden = true; $('menu').hidden = false;
}
function begin(){
  buildBoard();
  $('winLabel').textContent = `First to ${cfg.win} rounds`;
  $('menu').hidden = true; $('hud').hidden = false; $('touch').hidden = !coarse;
  keys.boost = false; sentBoost = false; lastW = -1; snapAcc = 0;
  if (mode === 'guest') { state = 'wait'; setMsg('SYNCING', 'linking to the host grid'); }
  else nextRound();
}
function startSolo(o){
  SFX.init(); mode = 'solo'; net = null; me = 0; cfg = {diff:o.diff, win:o.win};
  buildRiders([{name:o.name || 'YOU'}, ...RIDERS.slice(1, 1 + o.bots).map(r => ({name:r.name, bot:true}))]);
  begin();
}
function startOnline(o){
  SFX.init(); mode = o.role; net = o.net; me = o.me; matchId = o.id; turnLog = {};
  cfg = {diff:o.diff, win:o.win};
  buildRiders(o.roster.map((p, i) => ({name:p.name, bot:p.bot, remote:o.role === 'host' && !p.bot && i !== o.me})));
  begin();
}
function nextRound(){
  round++; lastW = -1; resetRound(); updateBoard(); SFX.riser(3); lastCd = 4;
  state = 'countdown'; cd = 3;
  introCam();
  pushState();
}
function roundMsg(w){
  if (w === player) { SFX.hit('win'); setMsg('ROUND WON', `${scores[player.id]} of ${cfg.win} to own the grid`); }
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
  const top = scores.indexOf(Math.max(...scores));
  if (scores[top] >= cfg.win) matchOver(bikes[top]); else nextRound();
}
function matchOver(w){
  const summary = {online:mode !== 'solo', host:mode === 'host', won:!!w && w === player, winner:w ? w.name : '',
    roundsWon:scores[player.id] || 0, rounds:round, diff:cfg.diff,
    table:bikes.map(b => ({name:b.name, css:b.r.css, score:scores[b.id] || 0, me:b === player, bot:b.ai})).sort((a, b) => b.score - a.score)};
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
  if (open) keys.boost = false;
}
function quit(){
  const wasOnline = mode !== 'solo';
  setMsg('', ''); startDemo();
  if (hooks.quit) hooks.quit(wasOnline);
}
function cycleCam(){ camMode = (camMode + 1) % 3; $('camLabel').textContent = CAMS[camMode]; }
function queueTurn(t){
  if (paused || !player || !player.alive || player.ai) return;
  if (!['countdown', 'run'].includes(state)) return;
  if (mode === 'guest') {
    if (state === 'countdown') { net.turn(t, -1, round); return; }
    if (player.k === player.lastLocalK) { if (player.gq.length < 2) { player.gq.push(t); player.localT = performance.now(); } }
    else guestTurnNow(player, t);
    return;
  }
  if (player.queue.length < 2) player.queue.push(t);
}
function trySkip(){ if (mode !== 'guest' && state === 'run' && !humansAlive()) endRound(null); }

/* ---------- Input ---------- */
function playing(){ return ['countdown', 'run', 'over', 'wait'].includes(state); }
addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.code;
  if (playing() && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space'].includes(k)) e.preventDefault();
  if (k === 'KeyM' && !e.repeat) { SFX.toggle(); return; }
  if (!playing()) return;
  if (e.repeat && k !== 'Space' && k !== 'KeyW' && k !== 'ArrowUp') return;
  if (k === 'ArrowLeft' || k === 'KeyA') queueTurn(-1);
  else if (k === 'ArrowRight' || k === 'KeyD') queueTurn(1);
  else if (k === 'Space' || k === 'KeyW' || k === 'ArrowUp') { keys.boost = true; if (!e.repeat) trySkip(); }
  else if (k === 'KeyC') cycleCam();
  else if (k === 'KeyP' || k === 'Escape') togglePause();
});
addEventListener('keyup', e => { if (['Space','KeyW','ArrowUp'].includes(e.code)) keys.boost = false; });
addEventListener('blur', () => { keys.boost = false; if (state === 'run' && mode === 'solo') togglePause(true); });
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
hold($('tL'), () => { queueTurn(-1); trySkip(); });
hold($('tR'), () => { queueTurn(1); trySkip(); });
hold($('tB'), () => { keys.boost = true; trySkip(); }, () => keys.boost = false);
document.querySelectorAll('[data-mute]').forEach(el => el.addEventListener('click', () => { SFX.init(); SFX.toggle(); }));
$('camBtn').addEventListener('click', cycleCam);
// Swipe left / right anywhere on the arena to turn; a plain tap skips while spectating
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

/* ---------- Loop ---------- */
let last = performance.now();
const glowSlots = RIDERS.map(() => ({pos:null, colorHex:0, on:false}));
function frame(now){
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000, real = Math.min(.05, raw); last = now;
  const dt = paused ? 0 : real;
  if (state === 'countdown') {
    cd -= dt;
    const s = Math.ceil(cd);
    if (cd > 0) setMsg(String(s), `Round ${round} · ${coarse ? 'buttons or swipe' : 'arrows or A / D to turn'}`);
    else if (mode !== 'guest') { state = 'run'; flash('GO', '', .6); SFX.hit('go'); pushState(); }
    else setMsg('GO', '');
    if (cd > 0 && Math.ceil(cd) !== lastCd) { lastCd = Math.ceil(cd); SFX.hit('tick'); }
  }
  if (mode === 'guest') {
    const want = keys.boost && player.alive && state === 'run';
    if (want !== sentBoost) { sentBoost = want; net.boost(want); }
    bikes.forEach(b => { glide(b, dt); if (b.alive) syncSegs(b); });
  } else if (state === 'run' || state === 'over' || state === 'demo') {
    if (state !== 'demo') player.wantBoost = keys.boost && player.alive;
    bikes.forEach(b => update(b, dt));
  }
  bikes.forEach(b => b.alive ? placeBike(b, dt) : fadeDead(b, dt));
  if (mode !== 'guest') {
    if (state === 'run') {
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
  updateBursts(dt);
  updateCamera(dt);
  updateHud(dt);
  const pl = player && player.alive;
  SFX.mood(paused ? .15 : state === 'run' ? (pl ? 1 : .6) : state === 'countdown' ? .55 : state === 'over' ? .5 : .25);
  SFX.engine(state === 'run' && pl && !paused ? 1 : (state === 'countdown' && !paused ? .45 : 0), player ? player.mul : 1);
  // Lights follow the local rider (or the arena centre during the attract demo)
  const focus = state === 'demo' || !player ? bikes[0] : player;
  if (focus) pipe.follow(state === 'demo' ? camLook : focus.vpos, focus.r.color);
  glowSlots.forEach((g, i) => { const b = bikes[i]; g.on = !!b && b.alive; if (g.on) { g.pos = b.vpos; g.colorHex = b.r.color; } });
  pipe.setGlows(glowSlots);
  arena.update(dt, glowSlots, camera.position, pipe.particleScale);
  pipe.render(raw, pl && state === 'run' ? (player.mul - 1) / .7 : 0);
}
['pointerdown', 'keydown'].forEach(t => addEventListener(t, () => SFX.init(), {once:true}));
startDemo();
requestAnimationFrame(frame);

export const Game = {
  hooks, startSolo, startOnline, toDemo:() => { setMsg('', ''); startDemo(); },
  remoteTurn, remoteBoost, removeRider, applySnapshot, addTurnPoint,
  initAudio:() => SFX.init(),
  setQuality:q => { const l = pipe.setQuality(q); try { localStorage.setItem('pr-quality', l); } catch (e) {} return l; },
  get quality(){ return pipe.quality; },
  debug:() => ({state, round, mode, me, scores:scores.slice(), bikes:bikes.map(b => ({name:b.name, cx:b.cx, cz:b.cz, dir:b.dir, k:b.k, nt:b.nt, alive:b.alive, segs:b.segs.length}))}),
  get state(){ return state; },
  get mode(){ return mode; }
};
