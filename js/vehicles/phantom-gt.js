/*
 * Phantom GT: an original anti-gravity single-seat racing craft for Three.js (r128+).
 *
 * Design: one sculpted body. A long, low teardrop fuselage with a sharp drooped nose and a
 * creased, high-tension shoulder line; the two hover sponsons are blended into its lower flanks
 * (a smooth union, so they read as one moulding), with a venturi channel between the shoulder
 * and each sponson that breathes through a lit intake mouth and ends in a thruster. A set-back
 * teardrop canopy with the rider tucked in, a shark-fin spine, a split carbon diffuser and a
 * third, central thruster finish the long tapering tail.
 *
 * Units: 1 = 1 metre, about 4.4 long, 0.88 wide, 1.0 tall. Forward is -Z, up is +Y, the origin
 * is on the floor and the body hovers. Looks best with scene.environment (RoomEnvironment) and bloom.
 *
 * root.userData matches createVanta (js/vanta.js): update(dt, speed), setLean(rad), setColor(hex),
 * craft, trailOrigin, nozzles, wheels, length, height, wheelRadius, hover.
 * Fixed paints are sRGB hex constants; every accent-driven material starts exactly equal to the
 * accent colour, so a caller can linearise the fixed ones by colour (see js/visuals/riders.js).
 */

function spow(v, e) { return (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), e); }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smooth(a, b, v) { var t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); }
function cr(a, b, c, d, t) {
  return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
}
// polynomial smooth minimum: a rounded fillet of size k where two distance fields meet
function smin(a, b, k) {
  var h = clamp01(0.5 + 0.5 * (b - a) / k);
  return b + (a - b) * h - k * h * (1 - h);
}

/* Rows of numbers keyed by z (column 0), Catmull-Rom interpolated. sample(z, out) fills out[k]. */
function Table(rows) { this.rows = rows; this.n = rows.length; this.w = rows[0].length; }
Table.prototype.sample = function (z, out) {
  var R = this.rows, N = this.n, i = 0;
  if (z <= R[0][0]) z = R[0][0];
  if (z >= R[N - 1][0]) { i = N - 2; z = R[N - 1][0]; } else while (i < N - 2 && R[i + 1][0] < z) i++;
  var a = R[Math.max(i - 1, 0)], b = R[i], c = R[i + 1], d = R[Math.min(i + 2, N - 1)];
  // segment parameter for this z (stations are unevenly spaced, so invert the z curve itself)
  var lo = 0, hi = 1, t = (z - b[0]) / (c[0] - b[0]);
  for (var it = 0; it < 12; it++) { if (cr(a[0], b[0], c[0], d[0], t) < z) lo = t; else hi = t; t = (lo + hi) / 2; }
  for (var k = 0; k < this.w; k++) out[k] = cr(a[k], b[k], c[k], d[k], t);
  return out;
};

/* Indexed grid surface from fn(i, j, out) over (L + 1) x (M + 1) vertices.
   uv is in metres (for tiling textures); uv2 is the normalised grid (for the panel-gap map).
   closed: weld the seam normals. The winding is flipped if needed so faces point outward. */
function gridGeometry(THREE, L, M, fn, closed) {
  var n = (L + 1) * (M + 1), pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), uv2 = new Float32Array(n * 2);
  var p = [0, 0, 0], i, j, v = 0;
  for (i = 0; i <= L; i++) {
    for (j = 0; j <= M; j++, v++) {
      fn(i, j, p);
      pos[v * 3] = p[0]; pos[v * 3 + 1] = p[1]; pos[v * 3 + 2] = p[2];
      uv2[v * 2] = i / L; uv2[v * 2 + 1] = j / M;
    }
  }
  function dist(a, b) { var x = pos[a] - pos[b], y = pos[a + 1] - pos[b + 1], z = pos[a + 2] - pos[b + 2]; return Math.sqrt(x * x + y * y + z * z); }
  var along = 0;
  for (i = 0; i <= L; i++) {
    var b0 = i * (M + 1);
    if (i > 0) along += dist(b0 * 3, (b0 - M - 1) * 3);
    var around = 0;
    for (j = 0; j <= M; j++) {
      if (j > 0) around += dist((b0 + j) * 3, (b0 + j - 1) * 3);
      uv[(b0 + j) * 2] = along; uv[(b0 + j) * 2 + 1] = around;
    }
  }
  var idx = new (n > 65535 ? Uint32Array : Uint16Array)(L * M * 6), q = 0, vol = 0;
  for (i = 0; i < L; i++) {
    for (j = 0; j < M; j++) {
      var a = i * (M + 1) + j, b = a + M + 1, c = a + 1, d = b + 1;
      idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c;
    }
  }
  for (i = 0; i < idx.length; i += 3) {
    var A = idx[i] * 3, B = idx[i + 1] * 3, C = idx[i + 2] * 3;
    vol += pos[A] * (pos[B + 1] * pos[C + 2] - pos[B + 2] * pos[C + 1]) -
      pos[A + 1] * (pos[B] * pos[C + 2] - pos[B + 2] * pos[C]) +
      pos[A + 2] * (pos[B] * pos[C + 1] - pos[B + 1] * pos[C]);
  }
  if (vol < 0) for (i = 0; i < idx.length; i += 3) { var tmp = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = tmp; }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('uv2', new THREE.BufferAttribute(uv2, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  if (closed) {
    var nr = g.attributes.normal.array;
    for (i = 0; i <= L; i++) {
      var f = i * (M + 1) * 3, l = (i * (M + 1) + M) * 3;
      for (var k = 0; k < 3; k++) { var m = (nr[f + k] + nr[l + k]) / 2; nr[f + k] = nr[l + k] = m; }
    }
  }
  return g;
}

/* A round tube through a list of points ([x,y,z,...], Catmull-Rom smoothed to `segs` segments),
   with parallel-transported frames. uv.x runs 0..1 along the tube (the light-vein shader uses it). */
function tubeGeometry(THREE, pts, segs, radius, radial, closed) {
  var np = pts.length / 3, path = new Float32Array((segs + 1) * 3), k, i, j;
  function at(n, c) { n = closed ? ((n % np) + np) % np : n < 0 ? 0 : n > np - 1 ? np - 1 : n; return pts[n * 3 + c]; }
  for (i = 0; i <= segs; i++) {
    var u = i / segs * (closed ? np : np - 1), s = Math.min(Math.floor(u), closed ? np - 1 : np - 2), t = u - s;
    for (k = 0; k < 3; k++) path[i * 3 + k] = cr(at(s - 1, k), at(s, k), at(s + 1, k), at(s + 2, k), t);
  }
  var R = radial + 1, n = (segs + 1) * R, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  var T = [0, 0, 0], N = [0, 0, 0], B = [0, 0, 0];
  for (i = 0; i <= segs; i++) {
    var a = Math.max(0, i - 1), b = Math.min(segs, i + 1);
    if (closed && (i === 0 || i === segs)) { a = segs - 1; b = 1; }
    T[0] = path[b * 3] - path[a * 3]; T[1] = path[b * 3 + 1] - path[a * 3 + 1]; T[2] = path[b * 3 + 2] - path[a * 3 + 2];
    var tl = Math.sqrt(T[0] * T[0] + T[1] * T[1] + T[2] * T[2]) || 1; T[0] /= tl; T[1] /= tl; T[2] /= tl;
    if (i === 0) {   // start from any direction not parallel to the tangent
      var ax = Math.abs(T[0]) < 0.9 ? 0 : 1;
      N[0] = ax ? T[2] : 0; N[1] = ax ? 0 : T[2]; N[2] = ax ? -T[0] : -T[1];
    } else {         // parallel transport: drop the tangent component of the previous normal
      var dd = N[0] * T[0] + N[1] * T[1] + N[2] * T[2];
      N[0] -= dd * T[0]; N[1] -= dd * T[1]; N[2] -= dd * T[2];
    }
    var nl = Math.sqrt(N[0] * N[0] + N[1] * N[1] + N[2] * N[2]) || 1; N[0] /= nl; N[1] /= nl; N[2] /= nl;
    B[0] = T[1] * N[2] - T[2] * N[1]; B[1] = T[2] * N[0] - T[0] * N[2]; B[2] = T[0] * N[1] - T[1] * N[0];
    for (j = 0; j <= radial; j++) {
      var ang = j / radial * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang), v = i * R + j;
      for (k = 0; k < 3; k++) {
        var d = cs * N[k] + sn * B[k];
        nor[v * 3 + k] = d; pos[v * 3 + k] = path[i * 3 + k] + d * radius;
      }
      uv[v * 2] = i / segs; uv[v * 2 + 1] = j / radial;
    }
  }
  var idx = new Uint16Array(segs * radial * 6), q = 0;
  for (i = 0; i < segs; i++) for (j = 0; j < radial; j++) {
    var p0 = i * R + j, p1 = p0 + R, p2 = p0 + 1, p3 = p1 + 1;
    idx[q++] = p0; idx[q++] = p2; idx[q++] = p1; idx[q++] = p1; idx[q++] = p2; idx[q++] = p3;
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

/* ---------- The body ----------
   Fuselage stations: [z, centreY, halfWidth, halfHeightTop, halfHeightBottom, roundTop, roundBottom]
   (superellipse sections; roundness 2 = ellipse, higher = fuller). */
var FUSE = new Table([
  [-2.28, 0.418, 0.004, 0.003, 0.003, 2.2, 2.6],
  [-2.25, 0.420, 0.062, 0.012, 0.010, 2.2, 2.8],
  [-2.15, 0.428, 0.140, 0.026, 0.022, 2.3, 3.0],
  [-1.95, 0.444, 0.205, 0.048, 0.040, 2.4, 3.2],
  [-1.66, 0.466, 0.245, 0.076, 0.060, 2.5, 3.4],
  [-1.30, 0.494, 0.264, 0.108, 0.078, 2.6, 3.6],
  [-0.90, 0.522, 0.270, 0.144, 0.094, 2.7, 3.8],
  [-0.48, 0.542, 0.258, 0.178, 0.104, 2.8, 3.8],
  [-0.06, 0.552, 0.234, 0.196, 0.110, 2.8, 3.8],
  [0.36, 0.558, 0.205, 0.186, 0.110, 2.7, 3.6],
  [0.80, 0.568, 0.190, 0.158, 0.100, 2.6, 3.4],
  [1.22, 0.584, 0.165, 0.126, 0.086, 2.5, 3.2],
  [1.60, 0.602, 0.126, 0.098, 0.072, 2.4, 3.0],
  [1.90, 0.618, 0.096, 0.076, 0.058, 2.3, 2.7],
  [2.12, 0.630, 0.080, 0.062, 0.050, 2.2, 2.5]
]);
// Sponsons: [z, halfWidth, halfHeight, centreX, centreY]. They start and end with a flat face
// (the intake mouth and the thruster outlet), so the body has rings exactly at both ends.
var POD_Z0 = -1.46, POD_Z1 = 1.72;
var POD = new Table([
  [POD_Z0, 0.066, 0.056, 0.282, 0.418],
  [-1.32, 0.078, 0.066, 0.296, 0.414],
  [-0.95, 0.088, 0.074, 0.314, 0.410],
  [-0.40, 0.094, 0.078, 0.326, 0.408],
  [0.25, 0.094, 0.078, 0.326, 0.408],
  [0.85, 0.086, 0.072, 0.316, 0.412],
  [1.35, 0.072, 0.062, 0.296, 0.418],
  [POD_Z1, 0.058, 0.052, 0.276, 0.424]
]);
// Rings along the body: [z0, z1, count]; the one-ring spans 1 mm long are the sponson faces.
var RINGS = [[-2.28, POD_Z0 - 0.001, 26], [POD_Z0 - 0.001, POD_Z0, 1], [POD_Z0, -1.38, 3], [-1.38, 1.64, 62],
  [1.64, POD_Z1, 3], [POD_Z1, POD_Z1 + 0.001, 1], [POD_Z1 + 0.001, 2.12, 14]];
var ZS = [];
RINGS.forEach(function (r, k) { for (var i = k ? 1 : 0; i <= r[2]; i++) ZS.push(r[0] + (r[1] - r[0]) * i / r[2]); });
// Columns around each ring: M + 1 with the seam underneath. Column HALF is the spine; the right
// side runs HALF + k for k = 0 (spine) .. HALF (keel), the left side mirrors it. The shoulder
// crease always sits on k = KC, so it stays a crisp line.
var M = 112, HALF = 56, KC = 14, CREASE = 0.95;

/* Cross-sections. Each ring is the zero contour of a distance field: the fuselage (superellipse
   with the crease and the channel scoop as radial modulations) smoothly unioned with the sponson
   ellipses. The right half is traced from the spine to the keel, then resampled by arc length. */
var F = [0, 0, 0, 0, 0, 0, 0], PD = [0, 0, 0, 0, 0];
var ring = { z: 0, yc: 0, w: 0, hT: 0, hB: 0, nT: 2, nB: 2, pod: false, pw: 0, ph: 0, px: 0, py: 0, crease: 0, scoop: 0 };
function podOn(z) { return z >= POD_Z0 - 1e-7 && z <= POD_Z1 + 1e-7; }
function setRing(z, pods) {
  FUSE.sample(z, F);
  ring.z = z; ring.yc = F[1]; ring.w = F[2]; ring.hT = F[3]; ring.hB = F[4]; ring.nT = F[5]; ring.nB = F[6];
  ring.pod = pods;
  if (pods) { POD.sample(z, PD); ring.pw = PD[1]; ring.ph = PD[2]; ring.px = PD[3]; ring.py = PD[4]; }
  ring.crease = 0.055 * smooth(-2.25, -1.8, z) * (1 - 0.4 * smooth(1.2, 2.1, z));
  ring.scoop = 0.09 * smooth(-1.6, -1.2, z) * (1 - smooth(1.0, 1.7, z));
}
function rFuse(theta) {
  var dx = Math.sin(theta), dy = Math.cos(theta), top = dy >= 0, h = top ? ring.hT : ring.hB, n = top ? ring.nT : ring.nB;
  var r = 1 / Math.pow(Math.pow(Math.abs(dx / ring.w), n) + Math.pow(Math.abs(dy / h), n), 1 / n);
  var a = Math.abs(theta), d = Math.abs(a - CREASE) / 0.36;
  if (d < 1) r *= 1 + ring.crease * (1 - d) * (1 - d);
  d = (a - 1.62) / 0.36;
  if (d * d < 1) r *= 1 - ring.scoop * (1 - d * d) * (1 - d * d);
  return r;
}
function fFuse(x, y) { var dy = y - ring.yc; return Math.sqrt(x * x + dy * dy) - rFuse(Math.atan2(x, dy)); }
function fField(x, y) {
  var f = fFuse(x, y);
  if (!ring.pod) return f;
  var X = (Math.abs(x) - ring.px) / ring.pw, Y = (y - ring.py) / ring.ph;
  var k0 = Math.sqrt(X * X + Y * Y), k1 = Math.sqrt(X * X / (ring.pw * ring.pw) + Y * Y / (ring.ph * ring.ph));
  var fp = k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -ring.ph;   // ellipse distance estimate
  // blade web tying the sponson to the fuselage: a rounded slab, the floor of the channel
  var ax = 0.08, ay = Math.max(ring.py + 0.026, ring.yc - ring.hB + 0.035), bx = ring.px, by = ring.py + 0.012;
  var vx = bx - ax, vy = by - ay, t = clamp01(((Math.abs(x) - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy));
  var wx = Math.abs(x) - ax - vx * t, wy = y - ay - vy * t, fw = Math.sqrt(wx * wx + wy * wy) - 0.03;
  return smin(smin(f, fw, 0.035), fp, 0.04);
}
var G = [0, 0];
function grad(fn, x, y) {
  var e = 1e-4, f0 = fn(x, y);
  G[0] = (fn(x + e, y) - f0) / e; G[1] = (fn(x, y + e) - f0) / e;
  return f0;
}
// skin point along a ray from the ring centre (outermost crossing), written to out[0..1]
function rayPoint(theta, out) {
  var dx = Math.sin(theta), dy = Math.cos(theta), lo = 0, hi = 0.7;
  for (var i = 0; i < 22; i++) { var m = (lo + hi) / 2; if (fField(dx * m, ring.yc + dy * m) < 0) lo = m; else hi = m; }
  out[0] = dx * lo; out[1] = ring.yc + dy * lo;
  return out;
}
var RP = [0, 0];
function traceRing() {
  var xs = [], ys = [], kc = -1;
  rayPoint(0, RP);
  var x = RP[0], y = RP[1];
  xs.push(x); ys.push(y);
  var h = Math.max(0.0005, Math.min(0.012, (ring.w + ring.hT + ring.hB) * 0.03));
  for (var it = 0; it < 900; it++) {
    grad(fField, x, y);
    var gl = Math.sqrt(G[0] * G[0] + G[1] * G[1]) || 1;
    var qx = x + h * G[1] / gl, qy = y - h * G[0] / gl;
    var f = fField(qx, qy);
    qx -= f * G[0] / (gl * gl); qy -= f * G[1] / (gl * gl);
    if (kc < 0 && Math.atan2(qx, qy - ring.yc) > CREASE) { rayPoint(CREASE, RP); qx = RP[0]; qy = RP[1]; kc = xs.length; }
    else if (qx <= 0 && it > 4) { rayPoint(Math.PI, RP); xs.push(0); ys.push(RP[1]); break; }
    xs.push(qx); ys.push(qy); x = qx; y = qy;
  }
  // resample: spine..crease evenly, crease..keel weighted toward tight curves (the sponsons)
  var out = { x: new Float32Array(HALF + 1), y: new Float32Array(HALF + 1) };
  function resample(i0, i1, k0, k1, bend) {
    var cum = [0], i;
    for (i = i0 + 1; i <= i1; i++) {
      var ds = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]), turn = 0;
      if (bend && i < i1 && i > i0) {
        var a1 = Math.atan2(ys[i] - ys[i - 1], xs[i] - xs[i - 1]), a2 = Math.atan2(ys[i + 1] - ys[i], xs[i + 1] - xs[i]);
        turn = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      }
      cum.push(cum[cum.length - 1] + ds + bend * turn);
    }
    var total = cum[cum.length - 1] || 1, s = 0;
    for (var k = k0; k <= k1; k++) {
      var target = (k - k0) / (k1 - k0) * total;
      while (s < cum.length - 2 && cum[s + 1] < target) s++;
      var f = (target - cum[s]) / ((cum[s + 1] - cum[s]) || 1);
      out.x[k] = xs[i0 + s] + (xs[i0 + s + 1] - xs[i0 + s]) * f;
      out.y[k] = ys[i0 + s] + (ys[i0 + s + 1] - ys[i0 + s]) * f;
    }
  }
  if (kc < 0) kc = Math.min(1, xs.length - 2);
  resample(0, kc, 0, KC, 0);
  resample(kc, xs.length - 1, KC, HALF, 0.03);
  out.x[HALF] = 0;
  return out;
}
// Snap a sponson ring onto the bare fuselage (the ring just ahead of / behind a sponson face)
function snapToFuselage(src) {
  var out = { x: new Float32Array(HALF + 1), y: new Float32Array(HALF + 1) };
  for (var k = 0; k <= HALF; k++) {
    var x = src.x[k], y = src.y[k];
    for (var it = 0; it < 6; it++) {
      var f = grad(fFuse, x, y), g2 = G[0] * G[0] + G[1] * G[1] || 1;
      x -= f * G[0] / g2; y -= f * G[1] / g2;
    }
    out.x[k] = k === HALF ? 0 : Math.max(0, x); out.y[k] = y;
  }
  return out;
}
/* Ring cache, shared by every craft (the shape never changes). Each entry also holds unit normals. */
var RING_CACHE = {};
function getRing(z) {
  var key = z.toFixed(5), r = RING_CACHE[key];
  if (r) return r;
  var faceAhead = Math.abs(z - (POD_Z0 - 0.001)) < 1e-7, faceBehind = Math.abs(z - (POD_Z1 + 0.001)) < 1e-7;
  if (faceAhead || faceBehind) {
    var src = getRing(faceAhead ? POD_Z0 : POD_Z1);
    setRing(z, false);
    r = snapToFuselage(src);
  } else {
    setRing(z, podOn(z));
    r = traceRing();
  }
  r.nx = new Float32Array(HALF + 1); r.ny = new Float32Array(HALF + 1); r.yc = ring.yc;
  for (var k = 0; k <= HALF; k++) {
    grad(fField, r.x[k], r.y[k]);
    var gl = Math.hypot(G[0], G[1]) || 1;
    r.nx[k] = G[0] / gl; r.ny[k] = G[1] / gl;
  }
  RING_CACHE[key] = r;
  return r;
}
// column j (0..M) of a ring: position and normal, mirrored for the left side
function col(r, j, off, out) {
  var k = j >= HALF ? j - HALF : HALF - j, s = j >= HALF ? 1 : -1;
  out[0] = s * (r.x[k] + r.nx[k] * off); out[1] = r.y[k] + r.ny[k] * off;
  return out;
}
// a skin point at (z, polar angle) pushed out along its normal
function skin(z, theta, off, out) {
  setRing(z, podOn(z));
  rayPoint(theta, RP);
  grad(fField, RP[0], RP[1]);
  var gl = Math.hypot(G[0], G[1]) || 1;
  out[0] = RP[0] + G[0] / gl * off; out[1] = RP[1] + G[1] / gl * off; out[2] = z;
  return out;
}

// Procedural textures are identical for every craft, so they are built once and shared.
var TEX = null;
function makeTextures(THREE) {
  function canvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  var seed = 1234567;
  function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

  // Metallic flake (tilted normals) and a faint roughness grain
  var N = 128, fc = canvas(N, N), fx = fc.getContext('2d'), fd = fx.createImageData(N, N);
  var rc = canvas(N, N), rx = rc.getContext('2d'), rd = rx.createImageData(N, N);
  for (var i = 0; i < N * N; i++) {
    var nx = (rnd() - 0.5) * 0.9, ny = (rnd() - 0.5) * 0.9, l = Math.sqrt(nx * nx + ny * ny + 1);
    fd.data[i * 4] = (nx / l * 0.5 + 0.5) * 255; fd.data[i * 4 + 1] = (ny / l * 0.5 + 0.5) * 255;
    fd.data[i * 4 + 2] = (1 / l * 0.5 + 0.5) * 255; fd.data[i * 4 + 3] = 255;
    rd.data[i * 4] = rd.data[i * 4 + 1] = rd.data[i * 4 + 2] = 205 + rnd() * 50; rd.data[i * 4 + 3] = 255;
  }
  fx.putImageData(fd, 0, 0); rx.putImageData(rd, 0, 0);
  var flake = new THREE.CanvasTexture(fc), grain = new THREE.CanvasTexture(rc);
  [flake, grain].forEach(function (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 4); });

  // Carbon fibre: 2x2 twill, each tow shaded across its width so the weave catches the light
  var C = 64, S = 8, cc = canvas(C, C), cx = cc.getContext('2d'), cd = cx.createImageData(C, C);
  for (var y = 0; y < C; y++) for (var x = 0; x < C; x++) {
    var a = (x / S) | 0, b = (y / S) | 0, horiz = ((a + b) & 3) < 2;
    var f = horiz ? (y % S + 0.5) / S : (x % S + 0.5) / S, along = horiz ? (x % S + 0.5) / S : (y % S + 0.5) / S;
    var v = 14 + (horiz ? 44 : 30) * Math.sin(f * Math.PI) * (0.8 + 0.2 * Math.sin(along * Math.PI));
    var o = (y * C + x) * 4;
    cd.data[o] = v; cd.data[o + 1] = v * 1.04; cd.data[o + 2] = v * 1.12; cd.data[o + 3] = 255;
  }
  cx.putImageData(cd, 0, 0);
  var carbon = new THREE.CanvasTexture(cc);
  carbon.wrapS = carbon.wrapT = THREE.RepeatWrapping;
  carbon.repeat.set(9, 9);
  carbon.encoding = THREE.sRGBEncoding;
  carbon.anisotropy = 4;

  // Panel gaps, painted into an ambient-occlusion map over the body's (ring, column) grid
  var W = 1024, H = 512, gc = canvas(W, H), g2 = gc.getContext('2d'), L = ZS.length - 1;
  g2.fillStyle = '#fff'; g2.fillRect(0, 0, W, H);
  function U(z) { for (var r = 1; r < ZS.length; r++) if (ZS[r] >= z) return (r - 1 + (z - ZS[r - 1]) / (ZS[r] - ZS[r - 1])) / L * W; return W; }
  function V(sd, k) { return (HALF + sd * k) / M * H; }
  var gr = g2.createLinearGradient(0, 0, 0, H);      // soft occlusion along the keel
  gr.addColorStop(0, 'rgba(0,0,0,0.35)'); gr.addColorStop(0.12, 'rgba(0,0,0,0)');
  gr.addColorStop(0.88, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.35)');
  g2.fillStyle = gr; g2.fillRect(0, 0, W, H);
  g2.strokeStyle = 'rgba(0,0,0,0.95)'; g2.lineWidth = 2.2; g2.lineCap = 'round';
  function seg(z0, k0, z1, k1, sd) { g2.beginPath(); g2.moveTo(U(z0), V(sd, k0)); g2.lineTo(U(z1), V(sd, k1)); g2.stroke(); }
  [-1.56, 1.8].forEach(function (z) { g2.beginPath(); g2.moveTo(U(z), 0); g2.lineTo(U(z), H); g2.stroke(); });   // nose and tail cone cuts
  [-1, 1].forEach(function (sd) {
    seg(-1.56, KC + 4, 1.8, KC + 4, sd);                                                   // flank panel under the crease
    seg(0.86, 2, 0.86, KC - 3, sd); seg(0.86, KC - 3, 1.62, KC - 4, sd); seg(1.62, KC - 4, 1.62, 2, sd);   // engine cover
    seg(-2.0, KC - 4, -1.66, KC - 4, sd); seg(-2.0, KC - 6, -1.7, KC - 6, sd);            // nose vents
  });
  g2.strokeRect(U(1.18), V(1, KC + 8), U(1.32) - U(1.18), V(1, KC + 11) - V(1, KC + 8)); // charge port flap
  var gaps = new THREE.CanvasTexture(gc);
  gaps.flipY = false;
  gaps.anisotropy = 4;

  // Ground wash under the sponsons
  var wc = canvas(128, 128), wx = wc.getContext('2d'), wg = wx.createRadialGradient(64, 64, 0, 64, 64, 64);
  wg.addColorStop(0, 'rgba(255,255,255,0.9)'); wg.addColorStop(0.35, 'rgba(255,255,255,0.35)'); wg.addColorStop(1, 'rgba(255,255,255,0)');
  wx.fillStyle = wg; wx.fillRect(0, 0, 128, 128);
  var wash = new THREE.CanvasTexture(wc);

  return { flake: flake, grain: grain, carbon: carbon, gaps: gaps, wash: wash };
}

function createPhantomGT(THREE, opts) {
  opts = opts || {};
  var accent = new THREE.Color(opts.color !== undefined ? opts.color : 0xff2a3d);
  var hover = opts.hover !== false;
  var PIVOT = 0.56;           // banking centre, on the fuselage centre line
  var WHITE = new THREE.Color(0xffffff);
  if (!TEX) TEX = makeTextures(THREE);

  var root = new THREE.Group();
  root.name = 'PhantomGT';
  var craft = new THREE.Group();
  craft.position.y = PIVOT;
  root.add(craft);
  var group = new THREE.Group();
  group.position.y = -PIVOT;
  craft.add(group);

  // ---------- Materials ----------
  var paint = new THREE.MeshPhysicalMaterial({
    color: opts.bodyColor !== undefined ? opts.bodyColor : 0x161a22,
    metalness: 0.7, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.035,
    envMapIntensity: 1.5,
    normalMap: TEX.flake, normalScale: new THREE.Vector2(0.2, 0.2), roughnessMap: TEX.grain,
    aoMap: TEX.gaps, aoMapIntensity: 1
  });
  var carbon = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: TEX.carbon, metalness: 0.35, roughness: 0.4, clearcoat: 0.9, clearcoatRoughness: 0.1
  });
  var satin = new THREE.MeshStandardMaterial({ color: 0x14171d, metalness: 0.8, roughness: 0.34 });
  var suit = new THREE.MeshStandardMaterial({ color: 0x17181c, metalness: 0.2, roughness: 0.62 });
  var glass = new THREE.MeshPhysicalMaterial({
    color: 0x0b1724, metalness: 0.1, roughness: 0.02, clearcoat: 1, clearcoatRoughness: 0.02,
    transparent: true, opacity: 0.42, depthWrite: false
  });
  var headMat = new THREE.MeshBasicMaterial({ color: 0xeef6ff, toneMapped: false });
  var glowMat = new THREE.MeshBasicMaterial({ color: accent.clone(), toneMapped: false });
  var nozzleMat = new THREE.MeshBasicMaterial({ color: accent.clone(), toneMapped: false });
  var podMat = new THREE.MeshBasicMaterial({ color: accent.clone(), toneMapped: false });
  var coreMats = [0, 1, 2].map(function () { return new THREE.MeshBasicMaterial({ color: accent.clone(), toneMapped: false }); });
  var veinMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: accent.clone() }, uTime: { value: 0 }, uBoost: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform vec3 uColor; uniform float uTime; uniform float uBoost; varying vec2 vUv;',
      'void main(){',
      '  float p = fract(vUv.x * 1.6 - uTime);',
      '  float pulse = pow(p, 10.0);',
      '  float ends = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.9, vUv.x);',
      '  vec3 c = uColor * (0.7 + 2.6 * pulse * uBoost) + vec3(1.0) * pulse * 0.5 * uBoost;',
      '  gl_FragColor = vec4(c * ends, 1.0);',
      '}'
    ].join('\n')
  });

  function add(mesh, parent) { mesh.castShadow = true; mesh.receiveShadow = true; (parent || group).add(mesh); return mesh; }
  function glow(mesh, parent) { (parent || group).add(mesh); return mesh; }
  function flatUv2(g) {
    g.setAttribute('uv2', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2).fill(0.002), 2));
    return g;
  }

  // ---------- Body ----------
  var L = ZS.length - 1, rings = ZS.map(getRing), P = [0, 0, 0];
  add(new THREE.Mesh(gridGeometry(THREE, L, M, function (i, j, out) { col(rings[i], j, 0, out); out[2] = ZS[i]; }, true), paint));
  function topY(z) { setRing(z, podOn(z)); return rayPoint(0, RP)[1]; }
  function underY(z) { setRing(z, podOn(z)); return rayPoint(Math.PI, RP)[1]; }
  function line(z0, z1, n, theta, off) {
    var pts = [];
    for (var i = 0; i <= n; i++) { skin(z0 + (z1 - z0) * i / n, theta, off, P); pts.push(P[0], P[1], P[2]); }
    return pts;
  }
  // points along columns k0..k1 of the ring at z, on side sd
  function arc(z, k0, k1, sd, off) {
    var r = getRing(z), pts = [];
    for (var k = k0; k <= k1; k++) { col(r, HALF + sd * k, off, P); pts.push(P[0], P[1], z); }
    return pts;
  }

  // ---------- Canopy and rider ----------
  var CAN = new Table([
    [-0.94, 0.690, 0.004, 0.003, 0.003],
    [-0.80, 0.708, 0.095, 0.060, 0.050],
    [-0.56, 0.728, 0.160, 0.140, 0.070],
    [-0.26, 0.742, 0.185, 0.205, 0.080],
    [0.08, 0.744, 0.170, 0.172, 0.080],
    [0.42, 0.736, 0.125, 0.110, 0.070],
    [0.70, 0.726, 0.058, 0.050, 0.050],
    [0.90, 0.720, 0.004, 0.003, 0.003]
  ]);
  var CA = [0, 0, 0, 0, 0], cz = [];
  for (var ci = 0; ci <= 44; ci++) cz.push(-0.94 + 1.84 * (0.5 - 0.5 * Math.cos(ci / 44 * Math.PI)));
  add(new THREE.Mesh(flatUv2(gridGeometry(THREE, 44, 40, function (i, j, out) {
    if (j === 0) CAN.sample(cz[i], CA);
    var th = j / 40 * Math.PI * 2, s = Math.sin(th), c = Math.cos(th);
    out[0] = CA[2] * spow(s, 0.88); out[1] = CA[1] + (c >= 0 ? CA[3] * spow(c, 0.88) : CA[4] * c); out[2] = cz[i];
  }, true)), glass));
  var helmet = add(new THREE.Mesh(flatUv2(new THREE.SphereGeometry(1, 24, 16)), paint));
  helmet.scale.set(0.094, 0.098, 0.124);
  helmet.position.set(0, 0.835, -0.34);
  helmet.rotation.x = 0.22;
  var visor = glow(new THREE.Mesh(new THREE.SphereGeometry(1, 20, 4, -Math.PI * 0.82, Math.PI * 0.64, Math.PI * 0.43, Math.PI * 0.1), glowMat));
  visor.scale.set(0.098, 0.102, 0.128);
  visor.position.copy(helmet.position);
  visor.rotation.x = 0.22;
  var torso = add(new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), suit));
  torso.scale.set(0.155, 0.09, 0.32);
  torso.position.set(0, 0.765, 0.02);
  [-1, 1].forEach(function (sd) {
    var arm = add(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), suit));
    arm.scale.set(0.044, 0.044, 0.21);
    arm.position.set(sd * 0.118, 0.742, -0.46);
    arm.rotation.y = -sd * 0.12;
  });

  // ---------- Fin, splitter, floor, diffuser, sponson blades ----------
  // A flat plate in the YZ plane from a 2D outline [[z, y], [ctrlZ, ctrlY, z, y] ...], extruded in X
  function plate(pts, thick, mat, x) {
    var sh = new THREE.Shape();
    sh.moveTo(-pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) {
      if (pts[i].length === 4) sh.quadraticCurveTo(-pts[i][0], pts[i][1], -pts[i][2], pts[i][3]);
      else sh.lineTo(-pts[i][0], pts[i][1]);
    }
    var bev = Math.min(0.005, thick * 0.3);
    var g = new THREE.ExtrudeGeometry(sh, { depth: thick - bev * 2, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 1, curveSegments: 12 });
    g.translate(0, 0, -(thick - bev * 2) / 2);
    g.rotateY(Math.PI / 2);
    var m = add(new THREE.Mesh(mat === paint ? flatUv2(g) : g, mat));
    m.position.x = x || 0;
    return m;
  }
  var finTip = [1.94, topY(1.94) + 0.17], finCtl = [1.3, topY(1.3) + 0.045];
  plate([[0.6, topY(0.6) - 0.03], finCtl.concat(finTip), [2.08, topY(2.08) - 0.005, 2.08, topY(2.08) - 0.03], [1.3, topY(1.3) - 0.03]], 0.024, paint);

  // rear aero blade: an inverted carbon wing through the tail cone, carried on swept endplates
  // rising from the sponson tails, with a full-width light bar on its trailing edge
  (function () {
    var up = [], lo = [], c = 0.26, le = 1.5;
    for (var i = 0; i <= 12; i++) {
      var xc = 0.5 - 0.5 * Math.cos(i / 12 * Math.PI), z = le + c * xc;
      var cam = 0.68 + 0.035 * xc - 0.014 * 4 * xc * (1 - xc);
      var t = 5 * 0.07 * c * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc * xc * xc - 0.1036 * xc * xc * xc * xc);
      up.push([z, cam + t]); lo.push([z, cam - t]);
    }
    plate(up.reverse().concat(lo.slice(1)), 0.7, carbon);
    [-1, 1].forEach(function (sd) {
      plate([[1.33, 0.44], [1.47, 0.665], [1.5, 0.735, 1.62, 0.742], [1.79, 0.75], [1.77, 0.66], [1.66, 0.6, 1.6, 0.44]], 0.012, paint, sd * 0.346);
    });
    var bar = [];
    for (var k = 0; k <= 8; k++) bar.push(-0.34 + 0.68 * k / 8, 0.716, le + c + 0.004);
    glow(new THREE.Mesh(tubeGeometry(THREE, bar, 24, 0.0075, 5, false), glowMat));
  })();

  // splitter blade under the nose running into a flat floor (carbon)
  var UNDER = new Table([
    [-2.24, 0.408, 0.03],
    [-2.12, 0.413, 0.16],
    [-1.90, 0.424, 0.235],
    [-1.55, 0.440, 0.262],
    [-1.20, 0.448, 0.230],
    [-0.90, 0.444, 0.180],
    [0.20, 0.446, 0.180],
    [1.00, 0.468, 0.160],
    [1.30, 0.488, 0.120]
  ]);
  var UN = [0, 0, 0], uz = [];
  for (var ui = 0; ui <= 40; ui++) uz.push(-2.24 + 3.54 * ui / 40);
  add(new THREE.Mesh(gridGeometry(THREE, 40, 20, function (i, j, out) {
    if (j === 0) UNDER.sample(uz[i], UN);
    var th = j / 20 * Math.PI * 2;
    out[0] = UN[2] * spow(Math.sin(th), 0.25); out[1] = UN[1] + 0.006 * spow(Math.cos(th), 0.25); out[2] = uz[i];
  }, true), carbon));
  // split diffuser: a tall centre keel and two outer strakes
  [-0.09, 0, 0.09].forEach(function (x) {
    var deep = x === 0 ? 0.075 : 0.045;
    plate([[1.22, underY(1.22) + 0.03], [2.06, underY(2.06) + 0.03], [2.04, underY(2.04) - deep], [1.32, underY(1.32) - 0.012]], 0.012, carbon, x);
  });
  // knife-edge blades along the outer waist of each sponson
  [-1, 1].forEach(function (sd) {
    var blade = new THREE.Shape(), outer = [], inner = [];
    for (var i = 0; i <= 24; i++) {
      var z = -1.25 + 2.8 * i / 24;
      POD.sample(z, PD);
      var reach = 0.028 * Math.sin(Math.PI * Math.pow(i / 24, 0.8));
      outer.push([PD[3] + PD[1] - 0.012 + reach, z]);
      inner.push([PD[3] + PD[1] - 0.03, z]);
    }
    blade.moveTo(outer[0][0], outer[0][1]);
    outer.forEach(function (p) { blade.lineTo(p[0], p[1]); });
    inner.reverse().forEach(function (p) { blade.lineTo(p[0], p[1]); });
    var g = new THREE.ExtrudeGeometry(blade, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1 });
    g.rotateX(Math.PI / 2);   // shape (x, z) -> (x, -depth, z)
    var m = add(new THREE.Mesh(g, carbon));
    m.scale.x = sd;
    m.position.y = 0.405;
  });

  // ---------- Light veins along the character lines ----------
  function vein(pts, segs, r) { return glow(new THREE.Mesh(tubeGeometry(THREE, pts, segs, r, 5, false), veinMat)); }
  [-1, 1].forEach(function (sd) {
    vein(line(-2.15, 2.04, 64, sd * CREASE, 0.004), 120, 0.0085);          // shoulder line
    // channel edge: the upper outer shoulder of each sponson
    var pts = [];
    for (var i = 0; i <= 44; i++) {
      var z = POD_Z0 + 0.03 + (1.66 - POD_Z0 - 0.03) * i / 44;
      setRing(z, true);
      var x = ring.px + ring.pw * 0.55, y = ring.py + ring.ph * 0.83;
      for (var it = 0; it < 5; it++) { var f = grad(fField, x, y), g2 = G[0] * G[0] + G[1] * G[1] || 1; x -= f * G[0] / g2; y -= f * G[1] / g2; }
      var gl = Math.sqrt(G[0] * G[0] + G[1] * G[1]) || 1;
      pts.push(sd * (x + G[0] / gl * 0.003), y + G[1] / gl * 0.003, z);
    }
    vein(pts, 80, 0.007);
  });
  (function () {   // fin leading edge
    var pts = [], q0 = [0.66, topY(0.66)];
    for (var i = 0; i <= 24; i++) {
      var t = i / 24, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t;
      pts.push(0, a * q0[1] + b * finCtl[1] + c * finTip[1] + 0.004, a * q0[0] + b * finCtl[0] + c * finTip[0]);
    }
    vein(pts, 60, 0.008);
  })();

  // ---------- Lit details ----------
  function ellipsePts(cx, cy, z, rx, ry, n) {
    var pts = [];
    for (var i = 0; i < n; i++) { var a = i / n * Math.PI * 2; pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, z); }
    return pts;
  }
  function disc(cx, cy, z, rx, ry, mat, back) {
    var m = glow(new THREE.Mesh(new THREE.CircleGeometry(1, 28), mat));
    m.scale.set(rx, ry, 1); m.position.set(cx, cy, z);
    if (back) m.rotation.y = Math.PI;
    return m;
  }
  var nozzles = [];
  function marker(x, y, z) { var o = new THREE.Object3D(); o.position.set(x, y, z); group.add(o); nozzles.push(o); }
  [-1, 1].forEach(function (sd) {
    // intake mouth: dark throat and a lit lip on the sponson's front face
    POD.sample(POD_Z0, PD);
    disc(sd * PD[3], PD[4], POD_Z0 - 0.003, PD[1] * 0.82, PD[2] * 0.78, satin, true);
    glow(new THREE.Mesh(tubeGeometry(THREE, ellipsePts(sd * PD[3], PD[4], POD_Z0 - 0.006, PD[1] * 0.86, PD[2] * 0.82, 16), 48, 0.0075, 5, true), glowMat));
    // thruster outlet on the rear face
    POD.sample(POD_Z1, PD);
    disc(sd * PD[3], PD[4], POD_Z1 + 0.003, PD[1] * 0.8, PD[2] * 0.78, satin);
    disc(sd * PD[3], PD[4], POD_Z1 + 0.005, PD[1] * 0.6, PD[2] * 0.58, nozzleMat);
    glow(new THREE.Mesh(tubeGeometry(THREE, ellipsePts(sd * PD[3], PD[4], POD_Z1 + 0.006, PD[1] * 0.8, PD[2] * 0.78, 16), 40, 0.008, 5, true), satin));
    marker(sd * PD[3], PD[4], POD_Z1 + 0.02);
  });
  // central thruster in the open tail
  setRing(2.12, false);
  var tw = ring.w, th0 = (ring.hT + ring.hB) / 2, ty = ring.yc + (ring.hT - ring.hB) / 2;
  disc(0, ty, 2.07, tw, th0, satin);
  disc(0, ty, 2.09, tw * 0.74, th0 * 0.72, nozzleMat);
  glow(new THREE.Mesh(tubeGeometry(THREE, arc(2.115, -HALF, HALF, 1, -0.004).slice(0, -3), 48, 0.008, 5, true), satin));
  marker(0, ty, 2.13);
  // headlight blades on the nose shoulders
  [-1, 1].forEach(function (sd) { glow(new THREE.Mesh(tubeGeometry(THREE, line(-2.06, -1.7, 8, sd * 1.18, 0.002), 16, 0.006, 5, false), headMat)); });
  // tail light wrapping the tail cone either side of the fin
  [-1, 1].forEach(function (sd) { glow(new THREE.Mesh(tubeGeometry(THREE, arc(1.99, 2, 36, sd, 0.003), 36, 0.0075, 5, false), glowMat)); });
  // energy core: three ribs across the engine cover, pulsing front to back
  [1.0, 1.17, 1.34].forEach(function (z, i) {
    [-1, 1].forEach(function (sd) { glow(new THREE.Mesh(tubeGeometry(THREE, arc(z, 2, KC - 3, sd, 0.003), 20, 0.009, 5, false), coreMats[i])); });
  });

  // ---------- Hover plates and ground wash ----------
  var washMats = [];
  [-1, 1].forEach(function (sd) {
    var plateMesh = glow(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 6), podMat));
    plateMesh.scale.set(0.06, 0.008, 1.2);
    plateMesh.position.set(sd * 0.32, 0.335, 0.15);
    var wm = new THREE.MeshBasicMaterial({ map: TEX.wash, color: accent.clone(), transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    var wash = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 3.2), wm);
    wash.rotation.x = -Math.PI / 2;
    wash.position.set(sd * 0.3, 0.012, 0.15);
    root.add(wash);
    washMats.push(wm);
  });

  var trailOrigin = new THREE.Object3D();
  trailOrigin.name = 'trailOrigin';
  trailOrigin.position.set(0, 0, 2.0);
  root.add(trailOrigin);

  if (opts.scale) root.scale.setScalar(opts.scale);

  // ---------- Animation ----------
  var time = 0;
  root.userData = {
    hover: true,
    craft: craft,
    wheels: [],
    trailOrigin: trailOrigin,
    nozzles: nozzles,
    length: 4.4, height: 1.0, wheelRadius: 0,
    setColor: function (hex) {
      accent.setHex(hex);
      veinMat.uniforms.uColor.value.setHex(hex);
      glowMat.color.setHex(hex);
      nozzleMat.color.setHex(hex);
      podMat.color.setHex(hex);
      for (var i = 0; i < 3; i++) coreMats[i].color.setHex(hex);
      for (i = 0; i < washMats.length; i++) washMats[i].color.setHex(hex);
    },
    // roll angle in radians, positive leans left; the craft banks around its own centre
    setLean: function (a) { craft.rotation.z = a; },
    // speed in units per second, forward positive
    update: function (dt, speed) {
      time += dt;
      var v = Math.abs(speed);
      veinMat.uniforms.uTime.value += dt * (0.3 + v * 0.05);
      veinMat.uniforms.uBoost.value = 1 + v / 30;
      var bob = 0;
      if (hover) {
        bob = Math.sin(time * 2.1) * 0.03 + Math.sin(time * 5.3) * 0.007 * (1 + v / 20);
        craft.position.y = PIVOT + bob;
        craft.rotation.x = Math.sin(time * 1.3) * 0.01 - Math.min(0.02, v / 3000);
      }
      var thrust = 0.6 + 0.1 * Math.sin(time * 9) + Math.min(0.5, v / 60);
      podMat.color.copy(accent).lerp(WHITE, 0.2 + 0.15 * Math.sin(time * 14)).multiplyScalar(thrust);
      for (var w = 0; w < washMats.length; w++) {
        washMats[w].opacity = (0.36 + 0.1 * Math.sin(time * 7 + w * 1.7)) * (1 - bob * 4) + Math.min(0.25, v / 120);
      }
      for (var i = 0; i < 3; i++) {
        var k = 0.4 + 0.6 * Math.pow(0.5 + 0.5 * Math.sin(time * (3 + v * 0.15) - i * 1.4), 3);
        coreMats[i].color.copy(accent).multiplyScalar(k);
      }
      var flick = (0.55 + Math.min(0.45, v / 50)) * (0.85 + Math.random() * 0.15);
      nozzleMat.color.copy(accent).lerp(WHITE, 0.3).multiplyScalar(flick);
    }
  };
  return root;
}

export { createPhantomGT };
export default createPhantomGT;
