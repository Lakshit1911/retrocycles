/* Retrocycles 3D engine: scene, riders, simulation, audio, HUD and camera.
   One engine, three roles:
     solo  - simulates everything locally
     host  - simulates everything, streams snapshots + turn points to guests
     guest - renders host snapshots, dead-reckons between them and predicts
             its own turns so steering feels instant */
const THREE = window.THREE;
const $ = id => document.getElementById(id);
const N = 128, H = N / 2, WALL_H = 1.25, T = 0.16, BASE = 15;
const SNAP_DT = 1 / 15, REWIND = 6, GRACE = .2, HIST = 8;
const DIRS = [[1,0],[0,1],[-1,0],[0,-1]];
export const RIDERS = [
  {name:'YOU',     color:0x39e6ff, css:'#39e6ff'},
  {name:'KESTREL', color:0xff9d2e, css:'#ff9d2e'},
  {name:'JUNO',    color:0xff3fa4, css:'#ff3fa4'},
  {name:'RIVET',   color:0xb6ff3a, css:'#b6ff3a'},
  {name:'ORCA',    color:0x9d8cff, css:'#9d8cff'},
  {name:'SABLE',   color:0xffe14d, css:'#ffe14d'}
];
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

export const hooks = {end:null, quit:null};
let cfg = {diff:'rider', win:5};
let mode = 'solo', net = null, matchId = '', me = 0, lastW = -1, snapAcc = 0, sentBoost = false;
let turnLog = {};

/* ---------- Scene ---------- */
const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
$('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);
scene.fog = new THREE.FogExp2(0x05070d, 0.0062);
const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 1400);
scene.add(new THREE.AmbientLight(0x2a3b4a, .9));
scene.add(new THREE.HemisphereLight(0x4a8db0, 0x05070d, .55));
const sun = new THREE.DirectionalLight(0xc8eeff, .9); sun.position.set(40, 70, 25); scene.add(sun);
const rim = new THREE.DirectionalLight(0x6a5cff, .45); rim.position.set(-50, 20, -40); scene.add(rim);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.MeshBasicMaterial({color:0x050a10}));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
const outer = new THREE.GridHelper(640, 80, 0x0c2330, 0x0c2330); outer.position.y = 0.002; scene.add(outer);
const fine = new THREE.GridHelper(N, N, 0x0e2c38, 0x0e2c38); fine.material.transparent = true; fine.material.opacity = .45; fine.position.y = 0.006; scene.add(fine);
const major = new THREE.GridHelper(N, N / 8, 0x2a8fab, 0x1a5d72); major.position.y = 0.01; scene.add(major);

const borderMat = new THREE.MeshBasicMaterial({color:0x39e6ff, transparent:true, opacity:.07, side:THREE.DoubleSide, depthWrite:false});
const edgeMat = new THREE.MeshBasicMaterial({color:0x8ff3ff});
[[0,-H,0],[0,H,0],[-H,0,1],[H,0,1]].forEach(([x,z,r]) => {
  const w = new THREE.Mesh(new THREE.PlaneGeometry(N, 3.2), borderMat);
  w.position.set(x, 1.6, z); if (r) w.rotation.y = Math.PI / 2; scene.add(w);
  [3.2, 0.03].forEach(y => {
    const e = new THREE.Mesh(new THREE.BoxGeometry(N + .1, .07, .07), edgeMat);
    e.position.set(x, y, z); if (r) e.rotation.y = Math.PI / 2; scene.add(e);
  });
});

(function horizon(){
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d'); const gr = g.createLinearGradient(0,0,0,256);
  gr.addColorStop(0,'rgba(5,7,13,0)'); gr.addColorStop(.55,'rgba(40,40,120,.18)');
  gr.addColorStop(.85,'rgba(57,200,255,.35)'); gr.addColorStop(1,'rgba(57,230,255,.05)');
  g.fillStyle = gr; g.fillRect(0,0,4,256);
  const m = new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(c), transparent:true, side:THREE.BackSide, fog:false, depthWrite:false});
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(520, 520, 160, 48, 1, true), m);
  cyl.position.y = 58; scene.add(cyl);
})();

(function towers(){
  const n = 80, body = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshBasicMaterial({color:0x07101a}), n);
  const cap = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshBasicMaterial({color:0x1f6d86, fog:false}), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = 170 + Math.random() * 240;
    const w = 6 + Math.random() * 16, h = 14 + Math.random() * 80;
    q.setFromAxisAngle(new THREE.Vector3(0,1,0), Math.random() * Math.PI);
    p.set(Math.cos(a) * r, h / 2, Math.sin(a) * r); s.set(w, h, w); m.compose(p, q, s); body.setMatrixAt(i, m);
    p.y = h + .2; s.set(w * .96, .35, w * .96); m.compose(p, q, s); cap.setMatrixAt(i, m);
  }
  scene.add(body, cap);
})();

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
/* Shared bike geometry: a side profile extruded into a bevelled shell, with
   wheel wells cut through it so the wheels sit encased inside the body. */
const WHEELS = [.85, -.82];
const BIKE = (() => {
  const s = new THREE.Shape();
  s.moveTo(-1.32, .5);
  s.quadraticCurveTo(-1.34, 1.0, -.9, 1.04);
  s.lineTo(-.35, .95);
  s.quadraticCurveTo(.15, .86, .5, 1.0);
  s.quadraticCurveTo(1.15, 1.1, 1.36, .55);
  s.quadraticCurveTo(1.38, .08, .85, .06);
  s.quadraticCurveTo(.4, .06, .3, .3);
  s.lineTo(-.3, .3);
  s.quadraticCurveTo(-.4, .06, -.82, .06);
  s.quadraticCurveTo(-1.3, .08, -1.32, .5);
  WHEELS.forEach(x => { const h = new THREE.Path(); h.absarc(x, .5, .4, 0, Math.PI * 2, true); s.holes.push(h); });
  const shell = new THREE.ExtrudeGeometry(s, {depth:.3, bevelEnabled:true, bevelThickness:.05, bevelSize:.035, bevelSegments:3, curveSegments:28});
  shell.translate(0, 0, -.15);
  const tube = (pts, z, r) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(([x, y]) => new THREE.Vector3(x, y, z))), 48, r, 6, false);
  const spine = [[-1.24,.6],[-1.2,.84],[-.9,.96],[-.35,.88],[.15,.8],[.5,.91],[.98,.86],[1.25,.56]];
  const belly = [[.5,.2],[.37,.37],[0,.38],[-.37,.37],[-.5,.2]];
  const sph = new THREE.SphereGeometry(1, 18, 12);
  return {
    shell, sph,
    spine:[tube(spine, .205, .017), tube(spine, -.205, .017)],
    belly:[tube(belly, .205, .014), tube(belly, -.205, .014)],
    well:new THREE.TorusGeometry(.42, .024, 8, 44),
    tire:new THREE.TorusGeometry(.32, .075, 12, 36),
    hub:new THREE.TorusGeometry(.19, .03, 8, 28),
    disc:new THREE.CylinderGeometry(.24, .24, .22, 24),
    tread:new THREE.BoxGeometry(.07, .028, .17),
    lamp:new THREE.BoxGeometry(.05, .07, .3)
  };
})();

function makeBike(color){
  const group = new THREE.Group(), inner = new THREE.Group(); group.add(inner);
  const col = new THREE.Color(color);
  const body = new THREE.MeshPhongMaterial({color:0x0c131b, specular:0x7896a6, shininess:90, emissive:col.clone().multiplyScalar(.05)});
  const suit = new THREE.MeshPhongMaterial({color:0x111a23, specular:0x4a6878, shininess:60});
  const glow = new THREE.MeshBasicMaterial({color});
  const hot = new THREE.MeshBasicMaterial({color:col.clone().lerp(new THREE.Color(0xffffff), .55)});
  const add = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); inner.add(m); return m; };

  add(BIKE.shell, body);
  BIKE.spine.forEach(g => add(g, glow));
  BIKE.belly.forEach(g => add(g, glow));
  WHEELS.forEach(x => [.2, -.2].forEach(z => add(BIKE.well, glow, x, .5, z)));
  add(BIKE.lamp, hot, 1.33, .62, 0);
  add(BIKE.lamp, glow, -1.33, .64, 0);

  // Rider, tucked low over the shell
  const ell = (mat, x, y, z, sx, sy, sz, rz = 0) => { const m = add(BIKE.sph, mat, x, y, z); m.scale.set(sx, sy, sz); m.rotation.z = rz; return m; };
  ell(suit, -.06, 1.08, 0, .42, .13, .17, -.12);
  ell(suit, -.48, 1.03, 0, .2, .13, .17);
  [.17, -.17].forEach(z => {
    ell(suit, -.32, .93, z, .3, .075, .075, .45);
    ell(suit, .46, 1.06, z * .95, .26, .05, .05, .22);
  });
  ell(suit, .42, 1.18, 0, .17, .15, .14);
  const visor = add(new THREE.BoxGeometry(.1, .05, .24), hot, .55, 1.18, 0); visor.rotation.z = -.2;
  const back = add(new THREE.BoxGeometry(.62, .022, .04), glow, -.06, 1.215, 0); back.rotation.z = -.12;

  const wheels = [];
  WHEELS.forEach(x => {
    const w = new THREE.Group(); w.position.set(x, .5, 0); inner.add(w);
    w.add(new THREE.Mesh(BIKE.tire, body));
    w.add(new THREE.Mesh(BIKE.hub, glow));
    const disc = new THREE.Mesh(BIKE.disc, suit); disc.rotation.x = Math.PI / 2; w.add(disc);
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2, t = new THREE.Mesh(BIKE.tread, glow);
      t.position.set(Math.cos(a) * .32, Math.sin(a) * .32, 0); t.rotation.z = a + Math.PI / 2; w.add(t);
    }
    wheels.push(w);
  });

  const halo = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 1.6), new THREE.MeshBasicMaterial({color, transparent:true, opacity:.3, blending:THREE.AdditiveBlending, depthWrite:false}));
  halo.rotation.x = -Math.PI / 2; halo.position.y = .03; group.add(halo);
  return {group, inner, wheels};
}
const yawOf = d => Math.atan2(-DIRS[d][1], DIRS[d][0]);
const wrapAngle = a => ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;

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

function buildRiders(roster){
  bikes.forEach(b => { scene.remove(b.mesh.group); b.segs.forEach(removeSeg); });
  bikes = [];
  roster.forEach((p, i) => {
    const r = RIDERS[i], col = new THREE.Color(r.color), mesh = makeBike(r.color);
    mesh.group.visible = false; scene.add(mesh.group);
    bikes.push({id:i, r, name:String(p.name || r.name).toUpperCase(), ai:!!p.bot, remote:!!p.remote, gone:false,
      mesh, segs:[], pos:new THREE.Vector3(), alive:false, cleared:true, nt:0, k:0, local:[], gq:[], sched:[], queue:[],
      cx:H, cz:H, dir:0, p:0, mul:1, energy:.35, grind:0, yaw:0, lean:0, snapT:0, lastLocalK:-1, localT:0,
      hist:new Int16Array(HIST * 2),
      wallMat:new THREE.MeshBasicMaterial({color:col, transparent:true, opacity:.55, depthWrite:false, side:THREE.DoubleSide}),
      capMat:new THREE.MeshBasicMaterial({color:col.clone().lerp(new THREE.Color(0xffffff), .5), transparent:true, opacity:1}),
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
      wantBoost:false, react:2, yaw:yawOf(best), lean:0, k:0, nt:0, grace:0, lastTurnK:-1});
    b.hist[0] = b.cx; b.hist[1] = b.cz;
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
  const diff = wrapAngle(yawOf(b.dir) - b.yaw);
  b.yaw += diff * Math.min(1, dt * 16);
  b.lean += (Math.max(-.5, Math.min(.5, -diff * .6)) - b.lean) * Math.min(1, dt * 10);
  const g = b.mesh.group; g.position.copy(b.pos); g.rotation.y = b.yaw; b.mesh.inner.rotation.x = b.lean;
  const spin = BASE * b.mul * dt / .46 * (state === 'run' || state === 'over' || state === 'demo' ? 1 : 0);
  b.mesh.wheels.forEach(w => w.rotation.z -= spin);
  const cur = b.segs[b.segs.length - 1]; if (cur) sizeSeg(cur, b.pos.x, b.pos.z);
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
  explode(b.pos.x, b.pos.z, b.r.color);
  if (state !== 'demo') {
    const dist = player.alive ? player.pos.distanceTo(b.pos) : 20;
    SFX.boom(b === player ? 1 : Math.max(.12, .6 - dist / 120));
  }
  if (b === player && state === 'run') {
    shake = reduceMotion ? .25 : 1;
    const others = bikes.filter(o => o.alive).length;
    SFX.hit('fall');
    const canSkip = mode !== 'guest' && !humansAlive() && others > 1;
    setMsg('DEREZZED', canSkip ? (coarse ? 'Tap to skip' : 'Space to skip') : others > 1 ? 'Spectating' : '');
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
      k:a[8], nt:a[9], spawn:{x:a[0], z:a[1]}, local:[], gq:[], lastLocalK:-1, snapT:0, deathT:0, cleared:!a[5], yaw:yawOf(a[2]), lean:0});
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

/* ---------- Derez particles ---------- */
const bursts = [];
function explode(x, z, color){
  const n = 280, pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
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
function killBurst(b){ scene.remove(b.points, b.ring); b.points.geometry.dispose(); b.ring.geometry.dispose(); }
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

/* ---------- Audio ---------- */
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
/* Cinematic score: sub drone, string ostinato, low brass hits, big drums,
   a ticking pulse and a rising sweep, all through one long reverb. */
const SFX = {
  ctx:null, muted:false, level:-1, want:.25, lastBar:-1,
  PROG:[38, 34, 41, 36],          // D minor, B flat, F, C
  THIRD:[15, 16, 16, 16],
  init(){
    if (this.ctx) { this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const ctx = this.ctx = new C();
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : .85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = .01; comp.release.value = .3;
    this.master.connect(comp); comp.connect(ctx.destination);

    const len = Math.floor(ctx.sampleRate * 3.8), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
    const verb = ctx.createConvolver(); verb.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = .55; verb.connect(wet); wet.connect(this.master);
    const bus = (vol, send) => {
      const g = ctx.createGain(); g.gain.value = vol; g.connect(this.master);
      const s = ctx.createGain(); s.gain.value = send; g.connect(s); s.connect(verb); return g;
    };
    this.strG = bus(0, .4); this.percG = bus(0, .5); this.brassG = bus(.9, .65); this.droneG = bus(0, .5); this.fxG = bus(.9, .35);
    this.strF = ctx.createBiquadFilter(); this.strF.type = 'lowpass'; this.strF.frequency.value = 1500; this.strF.Q.value = .8; this.strF.connect(this.strG);

    this.d1 = ctx.createOscillator(); this.d1.type = 'sine';
    this.d2 = ctx.createOscillator(); this.d2.type = 'sawtooth';
    const dF = ctx.createBiquadFilter(); dF.type = 'lowpass'; dF.frequency.value = 170;
    const d2g = ctx.createGain(); d2g.gain.value = .4;
    this.d1.connect(this.droneG); this.d2.connect(d2g); d2g.connect(dF); dF.connect(this.droneG);
    this.d1.frequency.value = hz(26); this.d2.frequency.value = hz(38); this.d1.start(); this.d2.start();

    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 600; this.lp.Q.value = 5;
    this.eg = ctx.createGain(); this.eg.gain.value = 0; this.lp.connect(this.eg); this.eg.connect(this.master);
    this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth'; this.o1.frequency.value = 46;
    this.o2 = ctx.createOscillator(); this.o2.type = 'square'; this.o2.frequency.value = 46.5;
    const g2 = ctx.createGain(); g2.gain.value = .4;
    this.o1.connect(this.lp); this.o2.connect(g2); g2.connect(this.lp); this.o1.start(); this.o2.start();

    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1; this.noise = nb;
    const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) curve[i] = Math.tanh((i / 511.5 - 1) * 2.4); this.curve = curve;

    this.t = ctx.currentTime + .1; this.step = 0; setInterval(() => this.sched(), 30);
    this.level = -1; this.mood(this.want);
  },
  mood(l){
    this.want = l;
    if (!this.ctx || Math.abs(l - this.level) < .01) return;
    this.level = l; const t = this.ctx.currentTime;
    this.strG.gain.setTargetAtTime(.25 + .55 * l, t, .8);
    this.percG.gain.setTargetAtTime(l < .45 ? 0 : (l - .35) * 1.1, t, .6);
    this.droneG.gain.setTargetAtTime(.35 + .25 * l, t, 1);
    this.strF.frequency.setTargetAtTime(700 + 1500 * l, t, 1);
  },
  engine(level, mul){
    if (!this.ctx) return; const t = this.ctx.currentTime;
    this.eg.gain.setTargetAtTime(level * .08, t, .1);
    const f = 44 + (mul - 1) * 55;
    this.o1.frequency.setTargetAtTime(f, t, .08); this.o2.frequency.setTargetAtTime(f * 1.012, t, .08);
    this.lp.frequency.setTargetAtTime(420 + (mul - 1) * 1500, t, .1);
  },
  tone(type, f0, f1, dur, vol, when, dest){
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, when); if (f1) o.frequency.exponentialRampToValueAtTime(f1, when + dur);
    g.gain.setValueAtTime(.0001, when); g.gain.exponentialRampToValueAtTime(vol, when + .005); g.gain.exponentialRampToValueAtTime(.0001, when + dur);
    o.connect(g); g.connect(dest || this.master); o.start(when); o.stop(when + dur + .03);
  },
  hiss(dur, vol, type, f0, f1, when, dest){
    const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; f.type = type; f.frequency.setValueAtTime(f0, when); if (f1) f.frequency.exponentialRampToValueAtTime(f1, when + dur);
    g.gain.setValueAtTime(vol, when); g.gain.exponentialRampToValueAtTime(.0001, when + dur);
    s.connect(f); f.connect(g); g.connect(dest || this.master); s.start(when); s.stop(when + dur + .03);
  },
  string(f, when, dur, vol){
    const c = this.ctx, g = c.createGain();
    g.gain.setValueAtTime(.0001, when); g.gain.exponentialRampToValueAtTime(vol, when + .008); g.gain.exponentialRampToValueAtTime(.0001, when + dur);
    g.connect(this.strF);
    for (const d of [-8, 8]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d; o.connect(g); o.start(when); o.stop(when + dur + .03); }
  },
  taiko(when, vol, size){
    this.tone('sine', 92 * size, 40, .55, vol, when, this.percG);
    this.hiss(.14, vol * .4, 'lowpass', 900, 200, when, this.percG);
  },
  braam(root, when, dur, vol, bright, ints){
    const c = this.ctx, f = c.createBiquadFilter(), sh = c.createWaveShaper(), g = c.createGain();
    f.type = 'lowpass'; f.Q.value = 1.4;
    f.frequency.setValueAtTime(100, when);
    f.frequency.exponentialRampToValueAtTime(300 + 1500 * bright, when + .35);
    f.frequency.exponentialRampToValueAtTime(150, when + dur);
    sh.curve = this.curve;
    g.gain.setValueAtTime(.0001, when); g.gain.exponentialRampToValueAtTime(vol, when + .09);
    g.gain.setTargetAtTime(vol * .5, when + .45, .6); g.gain.exponentialRampToValueAtTime(.0001, when + dur);
    f.connect(sh); sh.connect(g); g.connect(this.brassG);
    for (const iv of ints || [0, 7, 12]) for (const d of [-14, 0, 14]) {
      const o = c.createOscillator(), og = c.createGain();
      o.type = 'sawtooth'; o.frequency.value = hz(root + iv); o.detune.value = d + (Math.random() - .5) * 6;
      og.gain.value = .1; o.connect(og); og.connect(f); o.start(when); o.stop(when + dur + .05);
    }
    const sub = c.createOscillator(), sg = c.createGain();
    sub.type = 'sine'; sub.frequency.value = hz(root - 12);
    sg.gain.setValueAtTime(.0001, when); sg.gain.exponentialRampToValueAtTime(vol * .9, when + .06); sg.gain.exponentialRampToValueAtTime(.0001, when + dur);
    sub.connect(sg); sg.connect(this.brassG); sub.start(when); sub.stop(when + dur + .05);
  },
  hit(kind){
    if (!this.ctx) return; const t = this.ctx.currentTime + .02;
    if (kind === 'go')   { this.braam(26, t, 4, .85, 1, [0, 7, 12, 19]); this.taiko(t, 1, 1.1); }
    if (kind === 'fall') { this.braam(24, t, 4.6, .9, .35, [0, 6, 12]); this.taiko(t, 1, .8); }
    if (kind === 'win')  { this.braam(38, t, 4.2, .75, 1, [0, 4, 7, 12, 16]); this.taiko(t, .9, 1.2); }
    if (kind === 'tick') { this.taiko(t, .7, 1.3); this.hiss(.05, .08, 'highpass', 5000, 0, t, this.fxG); }
  },
  riser(dur){
    if (!this.ctx) return; const c = this.ctx, t = c.currentTime, g = c.createGain();
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.12, t + dur * .95); g.gain.exponentialRampToValueAtTime(.0001, t + dur + .1);
    g.connect(this.fxG);
    for (const m of [50, 62, 74, 86]) {
      const o = c.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(hz(m), t); o.frequency.exponentialRampToValueAtTime(hz(m + 12), t + dur);
      o.connect(g); o.start(t); o.stop(t + dur + .15);
    }
    const s = c.createBufferSource(), f = c.createBiquadFilter(), ng = c.createGain();
    s.buffer = this.noise; s.loop = true; f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(7000, t + dur);
    ng.gain.setValueAtTime(.0001, t); ng.gain.exponentialRampToValueAtTime(.25, t + dur * .95); ng.gain.exponentialRampToValueAtTime(.0001, t + dur + .1);
    s.connect(f); f.connect(ng); ng.connect(this.fxG); s.start(t); s.stop(t + dur + .15);
  },
  blip(){ if (this.ctx) this.tone('square', 620, 930, .05, .025, this.ctx.currentTime, this.fxG); },
  boom(v){
    if (!this.ctx) return; const t = this.ctx.currentTime;
    this.hiss(.9, .6 * v, 'lowpass', 4000, 120, t, this.fxG);
    this.tone('sine', 170, 34, .8, .55 * v, t, this.fxG);
    this.tone('square', 1400, 70, .45, .04 * v, t, this.fxG);
  },
  sched(){
    if (!this.ctx || this.ctx.state !== 'running') return;
    const spb = 60 / 112 / 4;
    while (this.t < this.ctx.currentTime + .15) { this.note(this.step, this.t); this.t += spb; this.step = (this.step + 1) % 64; }
  },
  note(s, t){
    const bar = s >> 4, i = s & 15, r = this.PROG[bar], th = this.THIRD[bar], L = Math.max(0, this.level);
    if (i === 0) {
      this.d1.frequency.setTargetAtTime(hz(r - 12), t, .4);
      this.d2.frequency.setTargetAtTime(hz(r), t, .4);
      if (bar % 2 === 0 && L > .3) this.braam(r - 12, t, 4.2, .2 + .25 * L, .45 + .4 * L, [0, 7, 12]);
    }
    const pat = [12, 12, 19, 12, 24, 12, 19, 12, 12, 12, 19, 12, 24, 19, th + 12, 19];
    this.string(hz(r + pat[i]), t, .14, (i % 4 === 0 ? .06 : .035));
    if (i % 4 === 0) this.string(hz(r), t, .3, .05);
    const drums = {0:1, 6:.55, 8:.8, 11:.5, 14:.65};
    if (drums[i] !== undefined) this.taiko(t, drums[i] * (i === 0 && bar % 2 === 0 ? 1.2 : .85), i === 0 ? .9 : 1.1);
    if (i % 2 === 0) this.hiss(.025, .035, 'highpass', 6500, 0, t, this.percG);
  },
  toggle(){
    this.muted = !this.muted;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : .85, this.ctx.currentTime, .05);
    $('muteLabel').textContent = this.muted ? 'sound off' : 'sound on';
    document.querySelectorAll('[data-mute]').forEach(el => el.setAttribute('aria-pressed', String(this.muted)));
  }
};

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
  const fx = Math.cos(player.yaw), fz = -Math.sin(player.yaw);
  camPos.set(player.pos.x - fx * 30, 34, player.pos.z - fz * 30); camLook.copy(player.pos);
  camera.fov = 68; camera.updateProjectionMatrix();
}
function updateCamera(dt){
  if (state === 'demo' || state === 'wait') {
    orbitT += dt * .06;
    tmpA.set(Math.cos(orbitT) * 96, 42, Math.sin(orbitT) * 96); tmpB.set(0, 0, 0);
    camPos.lerp(tmpA, 1 - Math.exp(-dt * 2)); camLook.lerp(tmpB, 1 - Math.exp(-dt * 2));
    camera.position.copy(camPos); camera.lookAt(camLook); return;
  }
  let b = player;
  if (!player.alive) { deadT += dt; if (deadT > 1.3) b = bikes.find(o => o.alive) || player; }
  const fx = Math.cos(b.yaw), fz = -Math.sin(b.yaw);
  let mode = camMode, k = 6;
  if (!b.alive) mode = 2;
  if (mode === 0) { tmpA.set(b.pos.x - fx * 8.5, 4.2, b.pos.z - fz * 8.5); tmpB.set(b.pos.x + fx * 10, .8, b.pos.z + fz * 10); k = state === 'countdown' ? 2.2 : 7; }
  else if (mode === 1) { tmpA.set(b.pos.x + fx * .35, 1.2, b.pos.z + fz * .35); tmpB.set(b.pos.x + fx * 25, .9, b.pos.z + fz * 25); k = 30; }
  else { tmpA.set(b.pos.x, 72, b.pos.z + 30); tmpB.copy(b.pos); k = 3; }
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
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

/* ---------- Loop ---------- */
let last = performance.now();
function frame(now){
  requestAnimationFrame(frame);
  const real = Math.min(.05, (now - last) / 1000); last = now;
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
  renderer.render(scene, camera);
}
['pointerdown', 'keydown'].forEach(t => addEventListener(t, () => SFX.init(), {once:true}));
startDemo();
requestAnimationFrame(frame);

export const Game = {
  hooks, startSolo, startOnline, toDemo:() => { setMsg('', ''); startDemo(); },
  remoteTurn, remoteBoost, removeRider, applySnapshot, addTurnPoint,
  initAudio:() => SFX.init(),
  debug:() => ({state, round, mode, me, scores:scores.slice(), bikes:bikes.map(b => ({name:b.name, cx:b.cx, cz:b.cz, dir:b.dir, k:b.k, nt:b.nt, alive:b.alive, segs:b.segs.length}))}),
  get state(){ return state; },
  get mode(){ return mode; }
};
