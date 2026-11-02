/* Light walls: one shader ribbon per rider plus a soft glow strip on the floor beneath it.
   The ribbon follows the rider's path (any polyline, not just 90 degree corners), starts at the
   craft's tail and is rebuilt into fixed-size buffers each frame: no per-frame allocation.
   Purely visual: the occupied cells in game.js (grid) or js/sim/free.js stay the source of truth for collisions.
   Circuit Light Burst walls come in as b.wlist: several separate walls per rider, fading with age. */
import { VISUAL_CONFIG as VC } from './config.js';
import { lin } from './renderer.js';
const THREE = window.THREE;
const MAX = VC.trail.maxPoints;

const wallVertex = `
  attribute float aV; attribute float aDist; attribute float aA;
  uniform float uHeight; uniform float uCollapse;
  varying float vV; varying float vD; varying float vA;
  #include <fog_pars_vertex>
  void main(){
    vV = aV; vD = aDist; vA = aA;
    vec3 p = position; p.y = aV * uHeight * (1.0 - uCollapse) * (0.3 + 0.7 * aA);
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const wallFragment = `
  uniform vec3 uColor; uniform float uTime; uniform float uLen; uniform float uFade;
  varying float vV; varying float vD; varying float vA;
  #include <fog_pars_fragment>
  void main(){
    float body = mix(${VC.trail.bodyBottom.toFixed(3)}, ${VC.trail.bodyTop.toFixed(3)}, vV);
    float bandStart = 1.0 - ${VC.trail.band.toFixed(3)};
    float band = smoothstep(bandStart, bandStart + 0.04, vV);
    float core = smoothstep(bandStart + 0.06, 0.97, vV) * (1.0 - smoothstep(0.985, 1.0, vV));
    // slow shimmer travelling along the wall, plus a sparse brighter glint
    float shimmer = 0.86 + 0.14 * sin(vD * 1.3 - uTime * 2.4) + 0.3 * pow(0.5 + 0.5 * sin(vD * 0.32 - uTime * 3.6), 14.0);
    // emitted look: hotter right behind the craft's tail
    float tip = 1.0 + ${VC.trail.tipBoost.toFixed(2)} * exp(-max(uLen - vD, 0.0) / ${VC.trail.tipLength.toFixed(2)});
    float base = 1.0 - smoothstep(0.0, ${VC.trail.baseLine.toFixed(3)}, vV);   // where the wall meets the floor
    vec3 c = uColor * (body + band * ${VC.trail.bandIntensity.toFixed(2)} + base * ${VC.trail.baseIntensity.toFixed(2)}) * shimmer * tip + vec3(1.0) * core * ${VC.trail.whiteCore.toFixed(2)} * tip;
    gl_FragColor = vec4(c * uFade * vA, 1.0);
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * fogDepth * fogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, fogDepth);
      #endif
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor * ${VC.trail.fogKeep.toFixed(2)});   // walls keep reading through the haze
    #endif
  }`;
const glowVertex = `
  attribute float aS; attribute float aDist; attribute float aA;
  varying float vS; varying float vD; varying float vA; varying float vNear;
  #include <fog_pars_vertex>
  void main(){
    vS = aS; vD = aDist; vA = aA;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNear = smoothstep(${VC.trail.glowNear[0].toFixed(2)}, ${VC.trail.glowNear[1].toFixed(2)}, -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const glowFragment = `
  uniform vec3 uColor; uniform float uLen; uniform float uFade;
  varying float vS; varying float vD; varying float vA; varying float vNear;
  #include <fog_pars_fragment>
  void main(){
    float s = 1.0 - abs(vS);
    float tip = 1.0 + 1.2 * exp(-max(uLen - vD, 0.0) / 2.0);
    gl_FragColor = vec4(uColor * s * s * ${VC.trail.glowIntensity.toFixed(2)} * tip * uFade * vA * vNear, 1.0);
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * fogDepth * fogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, fogDepth);
      #endif
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor * ${VC.trail.fogKeep.toFixed(2)});   // walls keep reading through the haze
    #endif
  }`;

// Static index data: quad k joins points k and k+1 (two vertices each). Each ribbon wraps it in
// its own BufferAttribute, since disposing a geometry frees its index's GL buffer.
const INDEX = (() => {
  const idx = new Uint32Array((MAX - 1) * 6);
  for (let k = 0; k < MAX - 1; k++) { const a = k * 2; idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], k * 6); }
  return idx;
})();
const SIDE = (() => { const a = new Float32Array(MAX * 2); for (let k = 0; k < MAX; k++) { a[k * 2] = -1; a[k * 2 + 1] = 1; } return a; })();
const UPDOWN = (() => { const a = new Float32Array(MAX * 2); for (let k = 0; k < MAX; k++) { a[k * 2] = 0; a[k * 2 + 1] = 1; } return a; })();

function ribbonGeometry(extra){
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aDist', new THREE.BufferAttribute(new Float32Array(MAX * 2), 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute(extra.name, new THREE.BufferAttribute(extra.data, 1));
  // per-vertex intensity: 1 for ordinary walls; circuit burst walls fade with age and use 0 for gaps
  g.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(MAX * 2).fill(1), 1).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(new THREE.BufferAttribute(INDEX, 1));
  g.setDrawRange(0, 0);
  return g;
}

export function createTrails(scene){
  const time = {value:0};
  // Scratch polyline, reused every frame (PA: per-point intensity)
  const PX = new Float32Array(MAX), PZ = new Float32Array(MAX), PD = new Float32Array(MAX), PA = new Float32Array(MAX);
  const QX = new Float32Array(MAX), QZ = new Float32Array(MAX), QA = new Float32Array(MAX);

  /* Grid wall breaks: b.cuts = [{x0, x1, z0, z1 (world box), k (path length from the spawn)}]. The part of
     the rider's wall inside a box that was laid before the break (path distance <= k) is cut out: the
     polyline gets zero-intensity points around each gap (as burst walls do). Returns the new point count. */
  function cutLine(n, cuts){
    let m = 0, d0 = 0;
    const put = (x, z, a) => { if (m < MAX - 1) { QX[m] = x; QZ[m] = z; QA[m] = a; m++; } };
    const gapAt = (x, z, d) => cuts.some(c => d <= c.k && x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1);
    put(PX[0], PZ[0], gapAt(PX[0], PZ[0], 0) ? 0 : 1);
    for (let i = 0; i < n - 1; i++) {
      const ax = PX[i], az = PZ[i], bx = PX[i + 1], bz = PZ[i + 1], dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
      const iv = [];
      if (L > 1e-6) for (const c of cuts) {
        let t0 = 0, t1 = Math.min(1, (c.k - d0) / L);
        for (const [p, dp, lo, hi] of [[ax, dx, c.x0, c.x1], [az, dz, c.z0, c.z1]]) {
          if (Math.abs(dp) < 1e-9) { if (p < lo || p > hi) t1 = -1; continue; }
          let u = (lo - p) / dp, v = (hi - p) / dp; if (u > v) [u, v] = [v, u];
          t0 = Math.max(t0, u); t1 = Math.min(t1, v);
        }
        if (t1 > t0) iv.push([t0, t1]);
      }
      iv.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const v of iv) { const last = merged[merged.length - 1]; if (last && v[0] <= last[1]) last[1] = Math.max(last[1], v[1]); else merged.push(v.slice()); }
      for (const [a, b] of merged) {
        if (a > 0) { put(ax + dx * a, az + dz * a, 1); put(ax + dx * a, az + dz * a, 0); }
        put(ax + dx * b, az + dz * b, 0);
        if (b < 1) put(ax + dx * b, az + dz * b, 1);
      }
      const endGap = merged.length && merged[merged.length - 1][1] >= 1;
      put(bx, bz, endGap ? 0 : 1);
      d0 += L;
    }
    PX.set(QX.subarray(0, m)); PZ.set(QZ.subarray(0, m)); PA.set(QA.subarray(0, m));
    return m;
  }

  function add(b){
    const color = lin(b.r.color);
    const common = {transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, fog:true};
    const wallMat = new THREE.ShaderMaterial(Object.assign({
      uniforms:THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {uColor:{value:color}, uLen:{value:0}, uFade:{value:1}, uHeight:{value:VC.wall.height}, uCollapse:{value:0}}]),
      vertexShader:wallVertex, fragmentShader:wallFragment}, common));
    wallMat.uniforms.uTime = time;
    const glowMat = new THREE.ShaderMaterial(Object.assign({
      uniforms:THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {uColor:{value:color.clone()}, uLen:{value:0}, uFade:{value:1}}]),
      vertexShader:glowVertex, fragmentShader:glowFragment}, common));
    const wall = new THREE.Mesh(ribbonGeometry({name:'aV', data:UPDOWN}), wallMat);
    const glow = new THREE.Mesh(ribbonGeometry({name:'aS', data:SIDE}), glowMat);
    wall.frustumCulled = glow.frustumCulled = false;
    wall.renderOrder = 2; glow.renderOrder = 1;
    scene.add(glow, wall);
    b.trail = {wall, glow};
  }

  /* Free steering walls arrive as b.wpts (flat x,z world points, b.wn of them in use), plus an
     optional uncached tail b.wtail (b.wtn points: a guest's predicted wall) and the head b.pos.
     Points are folded into a per-rider cache as they arrive: straight runs collapse to their ends,
     and when the cache fills its older half is thinned, so long rounds fit the fixed buffers. */
  const TAIL = 64;
  function keep(t, x, z){
    let k = t.fn;
    if (k >= 2) {
      const ux = t.fx[k - 1] - t.fx[k - 2], uz = t.fz[k - 1] - t.fz[k - 2], vx = x - t.fx[k - 1], vz = z - t.fz[k - 1];
      const uu = ux * ux + uz * uz, vv = vx * vx + vz * vz, cr = ux * vz - uz * vx;
      if (ux * vx + uz * vz > 0 && cr * cr < 2.5e-5 * uu * vv && uu < 256) { t.fx[k - 1] = x; t.fz[k - 1] = z; return; }
    }
    if (k >= MAX - 2 - TAIL) {
      let j = 0;
      for (let i = 0; i < k; i++) if (i >= k / 2 || i % 2 === 0) { t.fx[j] = t.fx[i]; t.fz[j] = t.fz[i]; j++; }
      k = j;
    }
    t.fx[k] = x; t.fz[k] = z; t.fn = k + 1;
  }
  function freeLine(t, b){
    const P = b.wpts, n = b.wn;
    if (!t.fx) { t.fx = new Float32Array(MAX); t.fz = new Float32Array(MAX); t.fn = 0; t.fsrc = 0; }
    if (t.fref !== P || n < t.fsrc) { t.fref = P; t.fsrc = 0; t.fn = 0; }
    for (; t.fsrc < n; t.fsrc++) keep(t, P[2 * t.fsrc], P[2 * t.fsrc + 1]);
    let m = t.fn;
    PX.set(t.fx.subarray(0, m)); PZ.set(t.fz.subarray(0, m));
    const T = b.wtail;
    if (T) for (let i = 0; i < b.wtn && m < MAX - 1; i++) { PX[m] = T[2 * i]; PZ[m] = T[2 * i + 1]; m++; }
    if (b.alive) { PX[m] = b.pos.x; PZ[m] = b.pos.z; m++; }   // a dead rider's wall already ends at the crash
    return m;
  }

  function remove(b){
    if (!b.trail) return;
    const {wall, glow} = b.trail;
    scene.remove(wall, glow);
    [wall, glow].forEach(m => { m.geometry.dispose(); m.material.dispose(); });
    b.trail = null;
  }

  /* Circuit burst walls arrive ready-made as b.wlist = {x, z, a, n, live}: world points with a
     per-point intensity (age fade; 0 around the gaps between separate walls). live: the last point
     is the craft's head (trimmed like any wall); otherwise the list ends where that wall ended. */
  function burstLine(b){
    const L = b.wlist, n = Math.min(L.n, MAX);
    PX.set(L.x.subarray(0, n)); PZ.set(L.z.subarray(0, n)); PA.set(L.a.subarray(0, n));
    return n;
  }

  /* Rebuild one rider's ribbon (grid: b.segs, free steering: b.wpts, circuit: b.wlist). wx: cell -> world. trim: cells hidden behind the head (the craft
     covers them). deathWindow: seconds a dead rider's wall stays before its cells clear. */
  function update(b, wx, trim, deathWindow){
    const t = b.trail; if (!t) return;
    let n = 0, cut = false;
    const burst = !!b.wlist;
    if (burst) {
      if (!(n = burstLine(b))) { t.wall.visible = t.glow.visible = false; return; }
      if (!b.wlist.live) trim = 0;
    } else if (b.wpts) {
      // Free steering: dense world-space polyline (see freeLine)
      if (b.cleared || !(n = freeLine(t, b))) { t.wall.visible = t.glow.visible = false; return; }
    } else {
      if (b.cleared || b.segs.length === 0) { t.wall.visible = t.glow.visible = false; return; }
      // Polyline: every segment start, then the head
      for (let i = 0; i < b.segs.length && n < MAX - 1; i++) { PX[n] = wx(b.segs[i].x0); PZ[n] = wx(b.segs[i].z0); n++; }
      PX[n] = b.pos.x; PZ[n] = b.pos.z; n++;
      if (b.cuts && b.cuts.length) { n = cutLine(n, b.cuts); cut = true; }
    }
    // Trim from the head end
    let remain = trim;
    while (n >= 2 && remain > 0 && !((burst || cut) && PA[n - 2] === 0)) {   // a burst trim stops at the gap before the live wall
      const dx = PX[n - 1] - PX[n - 2], dz = PZ[n - 1] - PZ[n - 2], len = Math.hypot(dx, dz);
      if (len <= remain) { remain -= len; n--; }
      else { const k = (len - remain) / len; PX[n - 1] = PX[n - 2] + dx * k; PZ[n - 1] = PZ[n - 2] + dz * k; remain = 0; }
    }
    if (n < 2) { t.wall.visible = t.glow.visible = false; return; }
    PD[0] = 0;
    for (let i = 1; i < n; i++) PD[i] = PD[i - 1] + Math.hypot(PX[i] - PX[i - 1], PZ[i] - PZ[i - 1]);

    const wp = t.wall.geometry.attributes.position.array, wd = t.wall.geometry.attributes.aDist.array;
    const gp = t.glow.geometry.attributes.position.array, gd = t.glow.geometry.attributes.aDist.array;
    const useA = burst || cut;
    if (useA || t.aDirty) {
      const wa = t.wall.geometry.attributes.aA, ga = t.glow.geometry.attributes.aA;
      if (!useA) { wa.array.fill(1); ga.array.fill(1); }
      else for (let i = 0; i < n; i++) wa.array[2 * i] = wa.array[2 * i + 1] = ga.array[2 * i] = ga.array[2 * i + 1] = PA[i];
      wa.needsUpdate = ga.needsUpdate = true;
      t.aDirty = useA;
    }
    const half = VC.trail.glowWidth / 2;
    for (let i = 0; i < n; i++) {
      const j = i * 6, d = i * 2;
      wp[j] = wp[j + 3] = PX[i]; wp[j + 1] = wp[j + 4] = 0; wp[j + 2] = wp[j + 5] = PZ[i];
      wd[d] = wd[d + 1] = gd[d] = gd[d + 1] = PD[i];
      // Floor glow: offset sideways, mitred at corners
      const a = Math.max(0, i - 1), c = Math.min(n - 1, i + 1);
      let tx = PX[c] - PX[a], tz = PZ[c] - PZ[a]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      let miter = 1;
      if (i > 0 && i < n - 1) {
        const sx = PX[i] - PX[i - 1], sz = PZ[i] - PZ[i - 1], sl = Math.hypot(sx, sz) || 1;
        miter = 1 / Math.max(.5, (tx * sx + tz * sz) / sl);
      }
      const nx = -tz * half * miter, nz = tx * half * miter;
      gp[j] = PX[i] - nx; gp[j + 1] = .012; gp[j + 2] = PZ[i] - nz;
      gp[j + 3] = PX[i] + nx; gp[j + 4] = .012; gp[j + 5] = PZ[i] + nz;
    }
    for (const m of [t.wall, t.glow]) {
      const g = m.geometry;
      g.attributes.position.needsUpdate = g.attributes.aDist.needsUpdate = true;
      g.attributes.position.updateRange.count = n * 6; g.attributes.aDist.updateRange.count = n * 2;
      g.setDrawRange(0, (n - 1) * 6);
      m.visible = true;
      m.material.uniforms.uLen.value = b.alive && (!burst || b.wlist.live) ? PD[n - 1] : -1e3;   // no hot tip once dead
    }
    if (burst) {
      // burst walls fade per point with age; dying riders don't fold them away
      t.wall.material.uniforms.uCollapse.value = 0;
      t.wall.material.uniforms.uFade.value = t.glow.material.uniforms.uFade.value = 1;
      return;
    }
    // Crash: hold, then collapse downward and fade in the last part of the death window
    const C = VC.trail.collapse;
    const collapse = b.alive ? 0 : Math.min(1, Math.max(0, (b.deathT - (deathWindow - C)) / C));
    const fade = 1 - collapse;
    t.wall.material.uniforms.uCollapse.value = collapse * collapse;
    t.wall.material.uniforms.uFade.value = b.alive ? 1 : fade * (.75 + .25 * Math.sin(b.deathT * 40));
    t.glow.material.uniforms.uFade.value = fade;
  }

  return {add, remove, update, tick:dt => { time.value += dt; }};
}
