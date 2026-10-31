/* Circuit geometry, built once per track from its data file (js/sim/tracks/*.js). Pure: no THREE,
   no DOM, no randomness, so host, guests and a future server build the identical track.

   Track data (see js/sim/tracks/stadium.js):
     {id, name, width, ds, ctrl:[[x, z, width?], ...], gates:[ctrl index, ...], pickups:[{u, o, kind}], grid}
     ctrl     closed centreline through these points in race direction (centripetal Catmull-Rom);
              point 0 is the start / finish line. Optional per-point road width (cells).
     gates    checkpoint gates at these control points (the start / finish line is always gate 0)
     pickups  u = fraction of the lap from the start line, o = lateral offset as a fraction of the
              half-width (-1 left .. +1 right of the race direction), kind = boost|shield|recharge|phase
     grid     {gap, back, row}: grid slot spacing (cells) behind the start line

   Built track (buildTrack):
     M samples every ds cells round the loop, L = lap length. Per sample: centre X/Z, unit tangent
     TX/TZ, right-hand normal NX/NZ (right of the race direction), road width W, signed curvature K
     (> 0 turning right), racing line offset LINE (along the normal) and the speed the racing
     line can be taken at, VMAX. left / right: closed barrier polylines (flat x,z). gates: [{i, s,
     ax, az, bx, bz}] lines across the road from barrier to barrier. pickups: [{x, z, kind, i}].

   Heading convention matches js/sim/free.js: forward = (cos h, sin h), right of it = (-sin h, cos h). */

const cache = new Map();

export function buildTrack(def, cfg){
  const key = def.id + '|' + (cfg ? [cfg.base, cfg.yawLo, cfg.yawHi, cfg.vLo, cfg.vHi].join(',') : '');
  if (cache.has(key)) return cache.get(key);
  const T = build(def, cfg);
  cache.set(key, T);
  return T;
}

function build(def, cfg){
  const P = def.ctrl, n = P.length, w0 = def.width || 12, ds = def.ds || 1;
  const px = i => P[(i + n) % n][0], pz = i => P[(i + n) % n][1], pw = i => P[(i + n) % n][2] || w0;
  // Dense centripetal Catmull-Rom, closed; remember where each control point lands
  const dx = [], dz = [], dw = [], ctrlAt = [];
  const SUB = 64;
  for (let i = 0; i < n; i++) {
    const x0 = px(i - 1), z0 = pz(i - 1), x1 = px(i), z1 = pz(i), x2 = px(i + 1), z2 = pz(i + 1), x3 = px(i + 2), z3 = pz(i + 2);
    const t0 = 0, t1 = t0 + Math.pow(Math.hypot(x1 - x0, z1 - z0), .5), t2 = t1 + Math.pow(Math.hypot(x2 - x1, z2 - z1), .5), t3 = t2 + Math.pow(Math.hypot(x3 - x2, z3 - z2), .5);
    ctrlAt.push(dx.length);
    for (let k = 0; k < SUB; k++) {
      const t = t1 + (t2 - t1) * k / SUB;
      const a1x = (t1 - t) / (t1 - t0) * x0 + (t - t0) / (t1 - t0) * x1, a1z = (t1 - t) / (t1 - t0) * z0 + (t - t0) / (t1 - t0) * z1;
      const a2x = (t2 - t) / (t2 - t1) * x1 + (t - t1) / (t2 - t1) * x2, a2z = (t2 - t) / (t2 - t1) * z1 + (t - t1) / (t2 - t1) * z2;
      const a3x = (t3 - t) / (t3 - t2) * x2 + (t - t2) / (t3 - t2) * x3, a3z = (t3 - t) / (t3 - t2) * z2 + (t - t2) / (t3 - t2) * z3;
      const b1x = (t2 - t) / (t2 - t0) * a1x + (t - t0) / (t2 - t0) * a2x, b1z = (t2 - t) / (t2 - t0) * a1z + (t - t0) / (t2 - t0) * a2z;
      const b2x = (t3 - t) / (t3 - t1) * a2x + (t - t1) / (t3 - t1) * a3x, b2z = (t3 - t) / (t3 - t1) * a2z + (t - t1) / (t3 - t1) * a3z;
      dx.push((t2 - t) / (t2 - t1) * b1x + (t - t1) / (t2 - t1) * b2x);
      dz.push((t2 - t) / (t2 - t1) * b1z + (t - t1) / (t2 - t1) * b2z);
      const u = k / SUB, sm = u * u * (3 - 2 * u);
      dw.push(pw(i) + (pw(i + 1) - pw(i)) * sm);
    }
  }
  // Arc length along the dense polyline, then resample every ds
  const D = dx.length, acc = new Float64Array(D + 1);
  for (let i = 0; i < D; i++) { const j = (i + 1) % D; acc[i + 1] = acc[i] + Math.hypot(dx[j] - dx[i], dz[j] - dz[i]); }
  const total = acc[D], M = Math.round(total / ds), step = total / M;
  const X = new Float64Array(M), Z = new Float64Array(M), W = new Float64Array(M);
  let j = 0;
  for (let i = 0; i < M; i++) {
    const s = i * step;
    while (acc[j + 1] < s) j++;
    const k = (s - acc[j]) / Math.max(1e-9, acc[j + 1] - acc[j]), j1 = (j + 1) % D;
    X[i] = dx[j] + (dx[j1] - dx[j]) * k; Z[i] = dz[j] + (dz[j1] - dz[j]) * k; W[i] = dw[j] + (dw[j1] - dw[j]) * k;
  }
  const L = total, idx = i => ((i % M) + M) % M;
  const TX = new Float64Array(M), TZ = new Float64Array(M), NX = new Float64Array(M), NZ = new Float64Array(M), K = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const a = idx(i - 1), b = idx(i + 1), tx = X[b] - X[a], tz = Z[b] - Z[a], l = Math.hypot(tx, tz) || 1;
    TX[i] = tx / l; TZ[i] = tz / l; NX[i] = -TZ[i]; NZ[i] = TX[i];
  }
  curvature(X, Z, M, step, K, 3);
  const ctrlS = ctrlAt.map(d => acc[d]), ctrlI = ctrlS.map(s => Math.round(s / step) % M);

  // Barriers: the road edges, closed
  const left = [], right = [];
  for (let i = 0; i <= M; i++) {
    const k = i % M, h = W[k] / 2;
    left.push(X[k] - NX[k] * h, Z[k] - NZ[k] * h);
    right.push(X[k] + NX[k] * h, Z[k] + NZ[k] * h);
  }

  // Gates: start / finish (control point 0) then the checkpoints, in race order
  const gi = [0, ...(def.gates || []).filter(g => g > 0 && g < n)].sort((a, b) => a - b);
  const gates = gi.map(c => {
    const i = ctrlI[c], h = W[i] / 2 + .6;
    return {i, s:i * step, ctrl:c, ax:X[i] - NX[i] * h, az:Z[i] - NZ[i] * h, bx:X[i] + NX[i] * h, bz:Z[i] + NZ[i] * h};
  });

  // Racing line: an elastic band pulled tight inside the road (minimum curvature, roughly)
  const LINE = new Float64Array(M), tmp = new Float64Array(M), margin = def.lineMargin || 1.6, reach = Math.max(2, Math.round(6 / step));
  for (let it = 0; it < 400; it++) {
    for (let i = 0; i < M; i++) {
      const a = idx(i - reach), b = idx(i + reach);
      const mx = (X[a] + NX[a] * LINE[a] + X[b] + NX[b] * LINE[b]) / 2, mz = (Z[a] + NZ[a] * LINE[a] + Z[b] + NZ[b] * LINE[b]) / 2;
      const o = (mx - X[i]) * NX[i] + (mz - Z[i]) * NZ[i], lim = Math.max(0, W[i] / 2 - margin);
      const v = LINE[i] + (o - LINE[i]) * .5;
      tmp[i] = v < -lim ? -lim : v > lim ? lim : v;
    }
    LINE.set(tmp);
  }
  // Speed the line allows: radius v / yaw(v) must fit the line's curvature (with some margin)
  const LX = new Float64Array(M), LZ = new Float64Array(M), LK = new Float64Array(M), VMAX = new Float64Array(M);
  for (let i = 0; i < M; i++) { LX[i] = X[i] + NX[i] * LINE[i]; LZ[i] = Z[i] + NZ[i] * LINE[i]; }
  curvature(LX, LZ, M, step, LK, 4);
  const C = cfg || {base:15, yawLo:4.4, yawHi:2.9, vLo:12, vHi:26};
  const yaw = v => { const k = Math.max(0, Math.min(1, (v - C.vLo) / (C.vHi - C.vLo))); return C.yawLo + (C.yawHi - C.yawLo) * k; };
  for (let i = 0; i < M; i++) {
    // the tightest of the next few samples counts (the rider needs the whole corner)
    let k = 0;
    for (let d = -2; d <= 2; d++) k = Math.max(k, Math.abs(LK[idx(i + d)]));
    let v = 40;
    if (k > 1e-4) { const R = .85 / k; v = 4; while (v < 40 && (v + .25) / yaw(v + .25) <= R) v += .25; }
    VMAX[i] = v;
  }

  // Pickups
  const pickups = (def.pickups || []).map(p => {
    const i = idx(Math.round(p.u * M)), off = (p.o || 0) * Math.max(0, W[i] / 2 - 1.4);
    return {i, x:X[i] + NX[i] * off, z:Z[i] + NZ[i] * off, kind:p.kind};
  });

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < left.length; i += 2) for (const A of [left, right]) {
    minX = Math.min(minX, A[i]); maxX = Math.max(maxX, A[i]); minZ = Math.min(minZ, A[i + 1]); maxZ = Math.max(maxZ, A[i + 1]);
  }
  const size = def.size || Math.ceil((Math.max(maxX - minX, maxZ - minZ, Math.abs(minX) * 2, Math.abs(maxX) * 2, Math.abs(minZ) * 2, Math.abs(maxZ) * 2) + 24) / 8) * 8;
  return {id:def.id, name:def.name, def, M, L, ds:step, X, Z, W, TX, TZ, NX, NZ, K, LINE, VMAX, left, right, gates, pickups,
    ctrlS, ctrlI, size, bounds:{minX, maxX, minZ, maxZ}, grid:Object.assign({gap:5, back:6, row:.24}, def.grid || {})};
}

// Signed curvature from the turning of the chord directions `r` samples apart (> 0: turning right)
function curvature(X, Z, M, step, out, r){
  const idx = i => ((i % M) + M) % M;
  for (let i = 0; i < M; i++) {
    const a = idx(i - r), b = idx(i + r);
    const h1 = Math.atan2(Z[i] - Z[a], X[i] - X[a]), h2 = Math.atan2(Z[b] - Z[i], X[b] - X[i]);
    let d = h2 - h1; d -= Math.PI * 2 * Math.floor((d + Math.PI) / (Math.PI * 2));
    out[i] = d / (r * step);
  }
}

/* Nearest sample to (x, z): searches `win` samples either side of the hint i (-1: the whole loop).
   Returns the sample index; along / lat (lateral offset, + right) via frameOf. */
export function nearest(T, x, z, hint = -1, win = 10){
  let best = -1, bd = Infinity;
  const M = T.M;
  if (hint >= 0) for (let d = -win; d <= win; d++) {
    const i = ((hint + d) % M + M) % M, ex = x - T.X[i], ez = z - T.Z[i], q = ex * ex + ez * ez;
    if (q < bd) { bd = q; best = i; }
  }
  // Lost (a respawn, a teleport, a long hint gap): scan everything
  if (best < 0 || bd > T.W[best] * T.W[best]) for (let i = 0; i < M; i++) {
    const ex = x - T.X[i], ez = z - T.Z[i], q = ex * ex + ez * ez;
    if (q < bd) { bd = q; best = i; }
  }
  return best;
}
// Arc position (0..L) and lateral offset of (x, z) relative to sample i
export function frameOf(T, i, x, z){
  const ex = x - T.X[i], ez = z - T.Z[i];
  let s = i * T.ds + ex * T.TX[i] + ez * T.TZ[i];
  if (s < 0) s += T.L; else if (s >= T.L) s -= T.L;
  return {s, lat:ex * T.NX[i] + ez * T.NZ[i]};
}
// Signed shortest arc difference a - b round the loop
export const arcDiff = (T, a, b) => { let d = a - b; d -= T.L * Math.floor((d + T.L / 2) / T.L); return d; };
