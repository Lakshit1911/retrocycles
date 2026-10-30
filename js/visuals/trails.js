/* Light walls: one shader ribbon per rider plus a soft glow strip on the floor beneath it.
   The ribbon follows the rider's path (any polyline, not just 90 degree corners), starts at the
   craft's tail and is rebuilt into fixed-size buffers each frame: no per-frame allocation.
   Purely visual: the occupied cells in game.js stay the source of truth for collisions. */
import { VISUAL_CONFIG as VC } from './config.js';
import { lin } from './renderer.js';
const THREE = window.THREE;
const MAX = VC.trail.maxPoints;

const wallVertex = `
  attribute float aV; attribute float aDist;
  uniform float uHeight; uniform float uCollapse;
  varying float vV; varying float vD;
  #include <fog_pars_vertex>
  void main(){
    vV = aV; vD = aDist;
    vec3 p = position; p.y = aV * uHeight * (1.0 - uCollapse);
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const wallFragment = `
  uniform vec3 uColor; uniform float uTime; uniform float uLen; uniform float uFade;
  varying float vV; varying float vD;
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
    vec3 c = uColor * (body + band * ${VC.trail.bandIntensity.toFixed(2)}) * shimmer * tip + vec3(1.0) * core * ${VC.trail.whiteCore.toFixed(2)} * tip;
    gl_FragColor = vec4(c * uFade, 1.0);
    #include <fog_fragment>
  }`;
const glowVertex = `
  attribute float aS; attribute float aDist;
  varying float vS; varying float vD;
  #include <fog_pars_vertex>
  void main(){
    vS = aS; vD = aDist;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const glowFragment = `
  uniform vec3 uColor; uniform float uLen; uniform float uFade;
  varying float vS; varying float vD;
  #include <fog_pars_fragment>
  void main(){
    float s = 1.0 - abs(vS);
    float tip = 1.0 + 1.2 * exp(-max(uLen - vD, 0.0) / 2.0);
    gl_FragColor = vec4(uColor * s * s * ${VC.trail.glowIntensity.toFixed(2)} * tip * uFade, 1.0);
    #include <fog_fragment>
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
  g.setIndex(new THREE.BufferAttribute(INDEX, 1));
  g.setDrawRange(0, 0);
  return g;
}

export function createTrails(scene){
  const time = {value:0};
  // Scratch polyline, reused every frame
  const PX = new Float32Array(MAX), PZ = new Float32Array(MAX), PD = new Float32Array(MAX);

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

  function remove(b){
    if (!b.trail) return;
    const {wall, glow} = b.trail;
    scene.remove(wall, glow);
    [wall, glow].forEach(m => { m.geometry.dispose(); m.material.dispose(); });
    b.trail = null;
  }

  /* Rebuild one rider's ribbon. wx: cell -> world. trim: cells hidden behind the head (the craft
     covers them). deathWindow: seconds a dead rider's wall stays before its cells clear. */
  function update(b, wx, trim, deathWindow){
    const t = b.trail; if (!t) return;
    if (b.cleared || b.segs.length === 0) { t.wall.visible = t.glow.visible = false; return; }
    // Polyline: every segment start, then the head
    let n = 0;
    for (let i = 0; i < b.segs.length && n < MAX - 1; i++) { PX[n] = wx(b.segs[i].x0); PZ[n] = wx(b.segs[i].z0); n++; }
    PX[n] = b.pos.x; PZ[n] = b.pos.z; n++;
    // Trim from the head end
    let remain = trim;
    while (n >= 2 && remain > 0) {
      const dx = PX[n - 1] - PX[n - 2], dz = PZ[n - 1] - PZ[n - 2], len = Math.hypot(dx, dz);
      if (len <= remain) { remain -= len; n--; }
      else { const k = (len - remain) / len; PX[n - 1] = PX[n - 2] + dx * k; PZ[n - 1] = PZ[n - 2] + dz * k; remain = 0; }
    }
    if (n < 2) { t.wall.visible = t.glow.visible = false; return; }
    PD[0] = 0;
    for (let i = 1; i < n; i++) PD[i] = PD[i - 1] + Math.hypot(PX[i] - PX[i - 1], PZ[i] - PZ[i - 1]);

    const wp = t.wall.geometry.attributes.position.array, wd = t.wall.geometry.attributes.aDist.array;
    const gp = t.glow.geometry.attributes.position.array, gd = t.glow.geometry.attributes.aDist.array;
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
      m.material.uniforms.uLen.value = b.alive ? PD[n - 1] : -1e3;   // no hot tip once dead
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
