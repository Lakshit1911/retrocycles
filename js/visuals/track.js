/* Circuit visuals: the road ribbon along the centreline (dark polished, like the arena floor, with a
   faint dashed centre line and soft edge glow lines), low matte barriers with one thin emissive top
   line, checkpoint gates as thin light arches, the start / finish gantry with a chequered line, the
   hovering pickups, and a shield / phase shell around riders who carry one. Purely visual: built
   from the sim's track (js/sim/track.js) and reading the sim's pickup state. */
import { VISUAL_CONFIG as VC } from './config.js';
import { lin } from './renderer.js';
const THREE = window.THREE;

function canvasTexture(size, draw, srgb){
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.encoding = THREE.sRGBEncoding;
  return t;
}

// Ribbon along the loop between two lateral offsets (functions of the sample: + right of the race
// direction), at height y0 -> y1 (flat when equal, a vertical face when the offsets match)
function ribbon(T, offA, offB, y0, y1, vScale = 1){
  const n = T.M + 1, pos = new Float32Array(n * 6), uv = new Float32Array(n * 4), idx = [];
  let s = 0;
  for (let k = 0; k < n; k++) {
    const i = k % T.M, a = offA(i), b = offB(i);
    pos.set([T.X[i] + T.NX[i] * a, y0, T.Z[i] + T.NZ[i] * a, T.X[i] + T.NX[i] * b, y1, T.Z[i] + T.NZ[i] * b], k * 6);
    uv.set([0, s / vScale, 1, s / vScale], k * 4);
    s += T.ds;
    if (k < n - 1) { const q = k * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// A half-ellipse arch of constant tube thickness, spanning local x from -hw to hw, up to height h
function archGeometry(hw, h, tube){
  class Arch extends THREE.Curve {
    getPoint(t, out = new THREE.Vector3()){ const a = Math.PI * t; return out.set(Math.cos(a) * hw, Math.sin(a) * h, 0); }
  }
  return new THREE.TubeGeometry(new Arch(), 64, tube, 6, false);
}

export function createTrackView(scene){
  const TV = VC.track, root = new THREE.Group(); root.visible = false; scene.add(root);
  const dot = canvasTexture(64, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.35, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  });
  let built = null, time = 0;
  const shells = new Map();
  const shellGeo = new THREE.IcosahedronGeometry(1, 1);

  function build(T){
    const grp = new THREE.Group(), trash = [];
    const keep = o => { trash.push(o); return o; };
    const half = i => T.W[i] / 2, B = TV.barrier;
    // Road surface
    const roadMat = keep(new THREE.MeshStandardMaterial({color:lin(TV.road.color), metalness:TV.road.metalness, roughness:TV.road.roughness, envMapIntensity:TV.road.env, side:THREE.DoubleSide}));
    const road = new THREE.Mesh(keep(ribbon(T, i => -half(i), i => half(i), TV.road.y, TV.road.y)), roadMat);
    road.receiveShadow = true; grp.add(road);
    // Faint dashed centre line
    const dash = keep(canvasTexture(64, (g, s) => { g.clearRect(0, 0, s, s); g.fillStyle = '#fff'; g.fillRect(0, 0, s, s * TV.lane.dash / TV.lane.period); }));
    dash.wrapS = dash.wrapT = THREE.RepeatWrapping;
    const lane = new THREE.Mesh(keep(ribbon(T, () => -TV.lane.width / 2, () => TV.lane.width / 2, TV.road.y + .004, TV.road.y + .004, TV.lane.period)),
      keep(new THREE.MeshBasicMaterial({color:lin(TV.lane.color), map:dash, transparent:true, opacity:TV.lane.opacity, depthWrite:false, side:THREE.DoubleSide})));
    grp.add(lane);
    // Edge glow lines just inside the barriers
    const edgeMat = keep(new THREE.MeshBasicMaterial({color:lin(TV.edge.color).multiplyScalar(TV.edge.intensity), transparent:true, depthWrite:false,
      blending:THREE.AdditiveBlending, toneMapped:false, side:THREE.DoubleSide}));
    for (const sg of [-1, 1]) {
      const a = i => sg * (half(i) - TV.edge.inset), b = i => sg * (half(i) - TV.edge.inset - TV.edge.width);
      grp.add(new THREE.Mesh(keep(ribbon(T, a, b, TV.road.y + .005, TV.road.y + .005)), edgeMat));
    }
    // Barriers: matte inner face, top and outer face, with a thin emissive line on the inner top edge
    const wallMat = keep(new THREE.MeshStandardMaterial({color:lin(B.color), metalness:.6, roughness:.75, envMapIntensity:.4, side:THREE.DoubleSide}));
    const lineMat = keep(new THREE.MeshBasicMaterial({color:lin(B.edge).multiplyScalar(B.edgeIntensity), toneMapped:false, side:THREE.DoubleSide}));
    for (const sg of [-1, 1]) {
      const inner = i => sg * half(i), outer = i => sg * (half(i) + B.thickness);
      for (const g of [ribbon(T, inner, inner, 0, B.height), ribbon(T, inner, outer, B.height, B.height), ribbon(T, outer, outer, 0, B.height)]) {
        const m = new THREE.Mesh(keep(g), wallMat); m.receiveShadow = true; grp.add(m);
      }
      grp.add(new THREE.Mesh(keep(ribbon(T, inner, i => sg * (half(i) + B.edgeWidth), B.height + .004, B.height + .004)), lineMat));
    }
    // Checkpoint arches (gate 0 is the start / finish gantry)
    const gates = T.gates.map((g, k) => {
      const i = g.i, hw = half(i) + B.thickness + .2;
      const mat = keep(new THREE.MeshBasicMaterial({color:lin(TV.gate.color).multiplyScalar(TV.gate.intensity), transparent:true, depthWrite:false,
        blending:THREE.AdditiveBlending, toneMapped:false}));
      const rotY = Math.atan2(-T.NZ[i], T.NX[i]);
      if (k > 0) {
        const arch = new THREE.Mesh(keep(archGeometry(hw, TV.gate.height, TV.gate.tube)), mat);
        arch.position.set(T.X[i], 0, T.Z[i]); arch.rotation.y = rotY; grp.add(arch);
      }
      return {mat, t:0, base:mat.color.clone()};
    });
    // Start / finish gantry: two pillars, a beam with a light strip each side, a chequered line
    {
      const g0 = T.gates[0], i = g0.i, hw = half(i) + B.thickness + 1.1, G = TV.gantry;
      const gant = new THREE.Group(); gant.position.set(T.X[i], 0, T.Z[i]); gant.rotation.y = Math.atan2(-T.NZ[i], T.NX[i]); grp.add(gant);
      const dark = keep(new THREE.MeshStandardMaterial({color:lin(G.color), metalness:.6, roughness:.6, envMapIntensity:.5}));
      const pillar = keep(new THREE.BoxGeometry(.6, G.height, .6));
      for (const sg of [-1, 1]) { const p = new THREE.Mesh(pillar, dark); p.position.set(sg * hw, G.height / 2, 0); p.castShadow = true; gant.add(p); }
      const beam = new THREE.Mesh(keep(new THREE.BoxGeometry(hw * 2 + .6, .7, .7)), dark); beam.position.y = G.height - .35; gant.add(beam);
      const stripMat = keep(new THREE.MeshBasicMaterial({color:lin(G.strip).multiplyScalar(G.stripIntensity), toneMapped:false}));
      for (const sg of [-1, 1]) { const st = new THREE.Mesh(keep(new THREE.BoxGeometry(hw * 2, .07, .02)), stripMat); st.position.set(0, G.height - .35, sg * .36); gant.add(st); }
      gates[0].mat = stripMat; gates[0].base = stripMat.color.clone();
      const checker = keep(canvasTexture(128, (g, s) => {
        g.clearRect(0, 0, s, s); g.fillStyle = '#fff';
        for (let y = 0; y < 2; y++) for (let x = 0; x < 16; x++) if ((x + y) % 2) g.fillRect(x * s / 16, y * s / 2, s / 16, s / 2);
      }));
      const line = new THREE.Mesh(keep(new THREE.PlaneGeometry(half(i) * 2, 1.2)), keep(new THREE.MeshBasicMaterial({map:checker, color:0xffffff, transparent:true,
        opacity:G.checker, depthWrite:false, blending:THREE.AdditiveBlending})));
      line.rotation.x = -Math.PI / 2; line.position.y = TV.road.y + .006; gant.add(line);
    }
    // Pickups: a glowing shape, a halo and a soft pool of light on the road
    const P = TV.pickups, sz = P.size;
    const shapes = {
      boost:keep(new THREE.OctahedronGeometry(sz, 0)), shield:keep(new THREE.IcosahedronGeometry(sz * 1.05, 0)),
      recharge:keep(new THREE.TorusGeometry(sz * .8, sz * .18, 8, 28)), phase:keep(new THREE.TetrahedronGeometry(sz * 1.1, 0))
    };
    const poolGeo = keep(new THREE.PlaneGeometry(1, 1)); poolGeo.rotateX(-Math.PI / 2);
    const pickups = T.pickups.map(p => {
      const c = lin(P.colors[p.kind]);
      const g = new THREE.Group(); g.position.set(p.x, 0, p.z); grp.add(g);
      const body = new THREE.Mesh(shapes[p.kind], keep(new THREE.MeshBasicMaterial({color:c.clone().multiplyScalar(1.6), toneMapped:false, wireframe:p.kind === 'shield'})));
      const halo = new THREE.Sprite(keep(new THREE.SpriteMaterial({map:dot, color:c.clone(), transparent:true, opacity:.75, depthWrite:false, blending:THREE.AdditiveBlending, toneMapped:false})));
      halo.scale.setScalar(P.halo);
      const pool = new THREE.Mesh(poolGeo, keep(new THREE.MeshBasicMaterial({map:dot, color:c.clone().multiplyScalar(P.glow), transparent:true, depthWrite:false, blending:THREE.AdditiveBlending})));
      pool.scale.setScalar(P.halo * 1.3); pool.position.y = TV.road.y + .01;
      const lift = new THREE.Group(); lift.add(body, halo); g.add(lift, pool);
      return {g, lift, body, halo, pool, k:0, phase:p.x * .37 + p.z * .11};
    });
    root.add(grp);
    return {id:T.id, grp, trash, gates, pickups};
  }

  function dispose(){
    if (!built) return;
    root.remove(built.grp);
    built.trash.forEach(o => o.dispose && o.dispose());
    built = null;
  }

  // T: the sim track to show (null hides the circuit)
  function show(T){
    if (!T) { root.visible = false; shells.forEach(s => { s.visible = false; }); return; }
    if (!built || built.id !== T.id) { dispose(); built = build(T); }
    root.visible = true;
  }

  // A checkpoint (or the line) lights up as the local rider passes it
  function flashGate(k){ if (built && built.gates[k]) built.gates[k].t = TV.gate.flashTime; }

  /* Per frame. pk: the sim's pickup respawn ticks (available when <= tick). bikes: riders, for the
     shield / phase shells (b.fr carries the sim state). */
  function update(dt, pk, tick, bikes){
    if (!built || !root.visible) return;
    time += dt;
    const P = TV.pickups;
    built.pickups.forEach((p, k) => {
      const on = !pk || pk[k] <= tick;
      p.k += ((on ? 1 : 0) - p.k) * Math.min(1, dt * (on ? 3 : 10));
      p.g.visible = p.k > .01;
      p.lift.position.y = P.hover + Math.sin(time * 2.2 + p.phase) * P.bob;
      p.body.rotation.y = time * P.spin + p.phase; p.body.rotation.x = Math.sin(time * .7 + p.phase) * .5;
      p.lift.scale.setScalar(p.k); p.pool.material.opacity = p.k;
    });
    built.gates.forEach(g => {
      if (g.t <= 0) return;
      g.t = Math.max(0, g.t - dt);
      g.mat.color.copy(g.base).multiplyScalar(1 + TV.gate.flash * g.t / TV.gate.flashTime);
    });
    for (const b of bikes) {
      const r = b.fr, on = !!r && b.alive && (r.shield || r.phaseT > 0);
      let s = shells.get(b);
      if (!on) { if (s) s.visible = false; continue; }
      if (!s) {
        s = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({wireframe:true, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, toneMapped:false}));
        scene.add(s); shells.set(b, s);
      }
      const kind = r.phaseT > 0 ? 'phase' : 'shield';
      if (s.userData.kind !== kind) { s.userData.kind = kind; s.material.color.copy(lin(P.colors[kind])); }
      s.visible = true;
      s.position.set(b.vpos.x, .35, b.vpos.z); s.rotation.set(0, b.vyaw, 0);
      s.scale.set(...TV.shell.scale);
      s.material.opacity = TV.shell.opacity * (kind === 'phase' ? .55 + .45 * Math.sin(time * 30) : .8 + .2 * Math.sin(time * 4));
    }
  }

  // Riders were rebuilt: drop their shells
  function clearShells(){ shells.forEach(s => { scene.remove(s); s.material.dispose(); }); shells.clear(); }

  return {show, update, flashGate, clearShells, get visible(){ return root.visible; }};
}
