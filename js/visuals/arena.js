/* The arena: polished obsidian floor with a faint cell grid and panel seams, tall matte perimeter
   walls that ripple with light when a rider is near, drifting dust and light pulses running along
   the floor seams, all inside a closed stadium: raked stands, a scrolling LED ribbon and a ribbed
   roof dome with an oculus and floodlights (VC.arena.stadium; a handful of meshes, cheap to draw).
   The older open-sky skyline is still here as VC.arena.scenery = 'city'. Purely visual. */
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
const rand = (a, b) => a + Math.random() * (b - a);
function canvasTex(w, h, draw){
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
  return t;
}

export function createArena(scene, N){
  const A = VC.arena, H = N / 2, disposables = [];
  const keep = o => { disposables.push(o); return o; };
  const arenaOnly = [];   // floor panels, grid, perimeter, seam pulses: hidden on a circuit (setCircuit)

  /* ---------- Floor ---------- */
  // Outer floor fades into the fog; the arena floor carries panel seams and gloss variation.
  const outer = new THREE.Mesh(keep(new THREE.PlaneGeometry(1400, 1400)), keep(new THREE.MeshStandardMaterial({
    color:lin(A.floor.color), metalness:A.floor.metalness, roughness:A.floor.roughness + .15, envMapIntensity:A.floor.env * .6})));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.002; outer.receiveShadow = true; scene.add(outer);

  const panel = A.floor.panel;   // cells per panel
  const seamTex = keep(canvasTexture(512, (g, s) => {
    g.fillStyle = A.floor.color; g.fillRect(0, 0, s, s);
    g.strokeStyle = A.floor.seam; g.lineWidth = 3; g.strokeRect(1.5, 1.5, s - 3, s - 3);
  }, true));
  const roughTex = keep(canvasTexture(256, (g, s) => {
    // Rain-polished: mostly glossy with soft duller patches (green channel = roughness)
    g.fillStyle = 'rgb(0,70,0)'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * s, y = Math.random() * s, r = rand(14, 60), gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(0,150,0,.55)'); gr.addColorStop(1, 'rgba(0,150,0,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }));
  [seamTex, roughTex].forEach(t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; });
  seamTex.repeat.set(N / panel, N / panel);
  const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(N, N)), keep(new THREE.MeshStandardMaterial({
    map:seamTex, roughnessMap:roughTex, color:0xffffff, metalness:A.floor.metalness, roughness:1, envMapIntensity:A.floor.env})));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor); arenaOnly.push(floor);
  // r128 shares one UV transform across maps, so sample the gloss map at a quarter of the seam
  // tiling and remap it to the configured roughness range
  floor.material.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <roughnessmap_fragment>',
      `float roughnessFactor = mix(${A.floor.roughness.toFixed(3)}, ${(A.floor.roughness + .3).toFixed(3)}, texture2D(roughnessMap, vUv * 0.25).g);`);
  };

  // Faint cell grid so lanes stay readable (a subtle line at ~70% opacity), slightly stronger every panel
  const gridPos = [], majorPos = [];
  for (let i = 0; i <= N; i++) {
    const v = i - H, arr = i % panel === 0 ? majorPos : gridPos;
    arr.push(-H, 0, v, H, 0, v, v, 0, -H, v, 0, H);
  }
  const lines = (pos, color, opacity, y) => {
    const g = keep(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const l = new THREE.LineSegments(g, keep(new THREE.LineBasicMaterial({color:lin(color), transparent:true, opacity, depthWrite:false})));
    l.position.y = y; scene.add(l); return l;
  };
  arenaOnly.push(lines(gridPos, A.grid.line, A.grid.opacity, 0.004), lines(majorPos, A.grid.major, A.grid.opacity, 0.006));

  /* ---------- Perimeter walls ---------- */
  const W = A.wall, wallMat = keep(new THREE.MeshStandardMaterial({color:lin(W.color), metalness:.6, roughness:.75, envMapIntensity:.4}));
  const edgeMat = keep(new THREE.MeshBasicMaterial({color:lin(W.edge).multiplyScalar(W.edgeIntensity), toneMapped:false}));
  const rippleMat = keep(new THREE.ShaderMaterial({
    transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, side:THREE.DoubleSide,
    uniforms:{uTime:{value:0}, uLen:{value:N}, uP:{value:Array.from({length:6}, () => new THREE.Vector4())}, uC:{value:Array.from({length:6}, () => new THREE.Color())}},
    vertexShader:'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader:`
      uniform float uTime; uniform float uLen; uniform vec4 uP[6]; uniform vec3 uC[6]; varying vec2 vUv;
      void main(){
        vec3 c = vec3(0.0);
        for (int i = 0; i < 6; i++) {
          // uP: x = position along this wall, y = proximity 0..1 (z, w unused)
          float p = uP[i].y;
          if (p <= 0.0) continue;
          float d = abs(vUv.x * uLen - uP[i].x);
          float env = exp(-d * d / ${W.rippleWidth.toFixed(1)});
          float ripple = 0.5 + 0.5 * cos(d * 2.4 - uTime * 6.5);
          c += uC[i] * env * ripple * exp(-vUv.y * 2.6) * p * p;
        }
        gl_FragColor = vec4(c * ${W.rippleIntensity.toFixed(2)}, 1.0);
      }`
  }));
  // Each wall: centre, rotation, and how to turn a world position into (along, distance from the wall)
  const walls = [
    {x:0, z:-H, ry:0,            along:p => p.x + H, dist:p => p.z + H},
    {x:0, z:H,  ry:Math.PI,      along:p => H - p.x, dist:p => H - p.z},
    {x:-H, z:0, ry:Math.PI / 2,  along:p => H - p.z, dist:p => p.x + H},
    {x:H,  z:0, ry:-Math.PI / 2, along:p => p.z + H, dist:p => H - p.x}
  ];
  const wallGeo = keep(new THREE.BoxGeometry(N + W.thickness * 2, W.height, W.thickness));
  const edgeGeo = keep(new THREE.BoxGeometry(N + W.thickness * 2, .05, .05));
  const rippleGeo = keep(new THREE.PlaneGeometry(N, W.height));
  walls.forEach(w => {
    const grp = new THREE.Group(); grp.position.set(w.x, 0, w.z); grp.rotation.y = w.ry; scene.add(grp); arenaOnly.push(grp);
    const body = new THREE.Mesh(wallGeo, wallMat); body.position.set(0, W.height / 2, -W.thickness / 2); body.receiveShadow = true; grp.add(body);
    const edge = new THREE.Mesh(edgeGeo, edgeMat); edge.position.set(0, W.height + .02, -.02); grp.add(edge);
    w.mat = rippleMat.clone(); keep(w.mat);
    w.mat.uniforms.uP.value = Array.from({length:6}, () => new THREE.Vector4());
    w.mat.uniforms.uC.value = Array.from({length:6}, () => new THREE.Color());
    const rip = new THREE.Mesh(rippleGeo, w.mat); rip.position.set(0, W.height / 2, .01); grp.add(rip);
  });

  /* ---------- Surroundings ---------- */
  const S = A.sky;
  let beams = [], beaconMat = null, roofLights = null, ledTex = null;
  if (A.scenery === 'city') {
    /* ---------- Sky and skyline ---------- */
    const dome = new THREE.Mesh(keep(new THREE.SphereGeometry(900, 32, 16)), keep(new THREE.ShaderMaterial({
      side:THREE.BackSide, depthWrite:false, fog:false,
      uniforms:{uTop:{value:lin(VC.palette.background)}, uHorizon:{value:lin(S.horizon)}},
      vertexShader:'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader:'uniform vec3 uTop; uniform vec3 uHorizon; varying vec3 vP; void main(){ float h = normalize(vP).y; float k = exp(-max(h, 0.0) * 9.0); gl_FragColor = vec4(mix(uTop, uHorizon, k), 1.0); }'
    })));
    scene.add(dome);

    // Silhouettes are unfogged but darker than the horizon glow, so they read as far-off shapes in haze
    const silhouette = keep(new THREE.MeshBasicMaterial({color:lin(S.silhouette), fog:false}));
    const stripMat = keep(new THREE.MeshBasicMaterial({color:0xffffff, fog:false, toneMapped:false, transparent:true, opacity:S.stripOpacity}));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const box = keep(new THREE.BoxGeometry(1, 1, 1));
    const towers = new THREE.InstancedMesh(box, silhouette, S.towers), strips = new THREE.InstancedMesh(box, stripMat, S.towers * 3);
    let si = 0;
    const stripCol = new THREE.Color();
    for (let i = 0; i < S.towers; i++) {
      const a = Math.random() * Math.PI * 2, r = rand(S.radius[0], S.radius[1]), w = rand(8, 24), h = rand(S.towerHeight[0], S.towerHeight[1]) * (r / S.radius[1] + .5);
      q.setFromAxisAngle(up, Math.random() * Math.PI);
      p.set(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r); sc.set(w, h, w * rand(.6, 1.2)); m4.compose(p, q, sc); towers.setMatrixAt(i, m4);
      // Sparse emissive strips: a few towers get one to three thin horizontal bands
      if (Math.random() < S.stripChance) for (let k = 0, n = 1 + (Math.random() * 2 | 0); k < n && si < S.towers * 3; k++, si++) {
        p.set(Math.cos(a) * r, rand(.3, .97) * h, Math.sin(a) * r); sc.set(w * 1.01, S.stripThickness, w * 1.01 * rand(.6, 1.2));
        m4.compose(p, q, sc); strips.setMatrixAt(si, m4);
        const fade = 1 - (r - S.radius[0]) / (S.radius[1] - S.radius[0]) * .6;
        strips.setColorAt(si, stripCol.copy(lin(Math.random() < .92 ? S.strip : S.stripWarm)).multiplyScalar(fade));
      }
    }
    strips.count = si;
    if (strips.instanceColor) strips.instanceColor.needsUpdate = true;
    scene.add(towers, strips);

    // Arches: half rings standing on the horizon, with a thin light along the crown
    const archGeo = keep(new THREE.TorusGeometry(1, .06, 6, 28, Math.PI)), archLineGeo = keep(new THREE.TorusGeometry(1, .008, 4, 48, Math.PI));
    const arches = new THREE.InstancedMesh(archGeo, silhouette, S.arches), archLines = new THREE.InstancedMesh(archLineGeo, stripMat, S.arches);
    for (let i = 0; i < S.arches; i++) {
      const a = (i / S.arches) * Math.PI * 2 + rand(-.2, .2), r = rand(S.radius[0] + 60, S.radius[1] - 40), R = rand(S.archRadius[0], S.archRadius[1]);
      q.setFromAxisAngle(up, -a + Math.PI / 2);
      p.set(Math.cos(a) * r, 0, Math.sin(a) * r); sc.setScalar(R); m4.compose(p, q, sc);
      arches.setMatrixAt(i, m4);
      sc.setScalar(R * 1.06); m4.compose(p, q, sc); archLines.setMatrixAt(i, m4);
      archLines.setColorAt(i, stripCol.copy(lin(S.strip)).multiplyScalar(.7));
    }
    if (archLines.instanceColor) archLines.instanceColor.needsUpdate = true;
    scene.add(arches, archLines);

    // Pylons with slow-blinking beacons
    const pylonGeo = keep(new THREE.CylinderGeometry(.6, 1.6, 1, 6)), beaconGeo = keep(new THREE.SphereGeometry(1.4, 8, 6));
    beaconMat = keep(new THREE.MeshBasicMaterial({color:lin(S.beacon), fog:false, toneMapped:false, transparent:true, opacity:1}));
    const pylons = new THREE.InstancedMesh(pylonGeo, silhouette, S.pylons), beacons = new THREE.InstancedMesh(beaconGeo, beaconMat, S.pylons);
    for (let i = 0; i < S.pylons; i++) {
      const a = rand(0, Math.PI * 2), r = rand(S.radius[0] - 20, S.radius[0] + 60), h = rand(60, 120);
      p.set(Math.cos(a) * r, h / 2, Math.sin(a) * r); sc.set(1, h, 1); q.identity(); m4.compose(p, q, sc); pylons.setMatrixAt(i, m4);
      p.y = h + 1; sc.setScalar(1); m4.compose(p, q, sc); beacons.setMatrixAt(i, m4);
    }
    scene.add(pylons, beacons);

    // Sweeping sky beams: soft additive cones
    const beamMat = keep(new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, fog:false,
      uniforms:{uColor:{value:lin(S.beam).multiplyScalar(S.beamIntensity)}},
      vertexShader:`varying float vY; varying float vEdge;
        void main(){ vY = uv.y; vec3 n = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vEdge = abs(dot(n, normalize(-mv.xyz))); gl_Position = projectionMatrix * mv; }`,
      fragmentShader:'uniform vec3 uColor; varying float vY; varying float vEdge; void main(){ float a = pow(1.0 - vY, 1.6) * pow(vEdge, 2.0); gl_FragColor = vec4(uColor * a, 1.0); }'
    }));
    const beamGeo = keep(new THREE.CylinderGeometry(18, .8, 360, 24, 1, true));
    beamGeo.translate(0, 180, 0);
    // CylinderGeometry uv.y runs 0 at the bottom; flip so the beam is brightest at its source
    const uvs = beamGeo.attributes.uv; for (let i = 0; i < uvs.count; i++) uvs.setY(i, 1 - uvs.getY(i));
    beams = S.beams.map(([ang, r, phase]) => {
      const b = new THREE.Mesh(beamGeo, beamMat); b.position.set(Math.cos(ang) * r, -2, Math.sin(ang) * r);
      b.userData.phase = phase; scene.add(b); return b;
    });
  } else {
    /* Stadium: one lathe for the stands (front wall, rake, back wall), a scrolling LED ribbon along
       the front, and a spherical-cap roof whose rim meets the top of the stands */
    const D = A.stadium, R0 = D.inner, R1 = D.outer, Ht = D.standHeight, Hb = D.backHeight;
    // Stands: v runs from the front wall (0) up the rake to the back wall (1); u goes round the bowl
    const standTex = canvasTex(2048, 512, (g, w, h) => {
      g.fillStyle = D.seat; g.fillRect(0, 0, w, h);
      g.fillStyle = D.row;
      for (let k = 0; k < D.rows; k++) { const y = h * (.1 + .82 * k / D.rows); g.fillRect(0, y, w, 2); }
      // aisles every so often, and a concourse band across the middle
      g.fillStyle = D.aisle; for (let x = 0; x < w; x += w / D.aisles) g.fillRect(x, h * .1, 3, h * .82);
      g.fillStyle = D.concourse; g.fillRect(0, h * .5, w, 10);
      // a crowd of tiny lights (phones, strips), sparse and mostly cool
      for (let i = 0; i < D.crowd; i++) {
        g.fillStyle = Math.random() < .85 ? D.crowdCool : D.crowdWarm; g.globalAlpha = rand(.25, .9);
        g.fillRect(Math.random() * w, h * rand(.12, .9), 2, 2);
      }
      g.globalAlpha = 1;
      g.fillStyle = D.rim; g.fillRect(0, h - 6, w, 3);   // light line along the top of the back wall
      g.fillStyle = D.rim; g.fillRect(0, h * .085, w, 2);   // and along the front parapet
    });
    standTex.wrapS = THREE.RepeatWrapping; standTex.repeat.set(D.repeat, 1);
    const prof = [[R0, -1], [R0, D.front], [R0 + 4, D.front], [R1, Ht], [R1, Hb], [R1 + 6, Hb]].map(([r, y]) => new THREE.Vector2(r, y));
    const standGeo = keep(new THREE.LatheGeometry(prof, 128));
    // v by distance along the profile (the lathe spaces it by point index), 0 at the front, 1 at the back
    const cum = [0]; for (let j = 1; j < prof.length; j++) cum.push(cum[j - 1] + prof[j].distanceTo(prof[j - 1]));
    const sUV = standGeo.attributes.uv;
    for (let k = 0; k < sUV.count; k++) sUV.setY(k, cum[k % prof.length] / cum[prof.length - 1]);
    standTex.flipY = false;
    const stands = new THREE.Mesh(standGeo, keep(new THREE.MeshBasicMaterial({map:standTex, side:THREE.DoubleSide, fog:false})));
    scene.add(stands);
    // LED ribbon on the front wall: blocks of light that drift round the bowl (texture offset only)
    ledTex = canvasTex(1024, 32, (g, w, h) => {
      g.fillStyle = '#05070c'; g.fillRect(0, 0, w, h);
      for (let x = 0; x < w;) {
        const len = rand(40, 160), on = Math.random() < .6;
        if (on) { g.fillStyle = Math.random() < .8 ? D.led : D.ledWarm; g.globalAlpha = rand(.35, 1); g.fillRect(x, 6, len, h - 12); }
        x += len + rand(10, 40);
      }
      g.globalAlpha = 1;
    });
    ledTex.wrapS = THREE.RepeatWrapping; ledTex.repeat.set(D.ledRepeat, 1);
    const led = new THREE.Mesh(keep(new THREE.CylinderGeometry(R0 - .3, R0 - .3, D.ledHeight, 128, 1, true)),
      keep(new THREE.MeshBasicMaterial({map:ledTex, side:THREE.BackSide, fog:false, toneMapped:false, color:new THREE.Color(D.ledIntensity, D.ledIntensity, D.ledIntensity)})));
    led.position.y = D.front - D.ledHeight / 2 - .4; scene.add(led);
    // Roof: a spherical cap from the back wall (radius R1 + 6, height Hb) up to the crown
    const rimR = R1 + 6, rise = D.crown - Hb, Rs = (rimR * rimR + rise * rise) / (2 * rise), cy = D.crown - Rs, th = Math.asin(rimR / Rs);
    const roofTex = canvasTex(2048, 512, (g, w, h) => {
      // v = 0 at the crown, 1 at the rim; u round the bowl
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, D.oculus); gr.addColorStop(.07, D.oculusEdge); gr.addColorStop(.1, D.roof); gr.addColorStop(1, D.roofRim);
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = D.rib;
      for (let k = 0; k < D.ribs; k++) g.fillRect(k * w / D.ribs, h * .1, 3, h * .9);
      for (const v of [.1, .3, .52, .74]) g.fillRect(0, h * v, w, 3);
      // floodlight banks round the rim
      g.fillStyle = D.flood;
      for (let k = 0; k < D.floods; k++) { const x = (k + .5) * w / D.floods; g.fillRect(x - 14, h * .9, 28, 8); }
    });
    const roof = new THREE.Mesh(keep(new THREE.SphereGeometry(Rs, 128, 24, 0, Math.PI * 2, 0, th)),
      keep(new THREE.MeshBasicMaterial({map:roofTex, side:THREE.BackSide, fog:false})));
    roof.position.y = cy; scene.add(roof);
    // The floodlights also glow a little through the haze: a faint additive band just under the rim
    roofLights = new THREE.Mesh(keep(new THREE.CylinderGeometry(rimR - 2, rimR - 2, 3, 128, 1, true)),
      keep(new THREE.MeshBasicMaterial({color:lin(D.flood).multiplyScalar(D.floodGlow), side:THREE.BackSide, fog:false, transparent:true,
        blending:THREE.AdditiveBlending, depthWrite:false, toneMapped:false})));
    roofLights.position.y = Hb - 2; scene.add(roofLights);
  }

  /* ---------- Ambient: dust motes and seam pulses ---------- */
  const D = A.dust, dustPos = new Float32Array(D.count * 3), dustSeed = new Float32Array(D.count);
  for (let i = 0; i < D.count; i++) { dustPos[i * 3] = rand(-D.box, D.box); dustPos[i * 3 + 1] = rand(.3, D.height); dustPos[i * 3 + 2] = rand(-D.box, D.box); dustSeed[i] = Math.random() * 100; }
  const dustGeo = keep(new THREE.BufferGeometry()); dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dotTex = keep(canvasTexture(32, (g, s) => { const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, s, s); }));
  const dust = new THREE.Points(dustGeo, keep(new THREE.PointsMaterial({map:dotTex, color:lin(D.color), size:D.size, transparent:true, opacity:D.opacity, depthWrite:false, blending:THREE.AdditiveBlending})));
  dust.frustumCulled = false; scene.add(dust);

  const P = A.pulses, pulseTex = keep(canvasTexture(128, (g, s) => { const gr = g.createLinearGradient(0, 0, s, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(.85, 'rgba(255,255,255,.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, s, s); }));
  const pulseGeo = keep(new THREE.PlaneGeometry(P.length, P.width)); pulseGeo.rotateX(-Math.PI / 2);
  const pulses = Array.from({length:P.count}, () => {
    const m = new THREE.Mesh(pulseGeo, keep(new THREE.MeshBasicMaterial({map:pulseTex, color:lin(P.color), transparent:true, opacity:0, depthWrite:false, blending:THREE.AdditiveBlending, toneMapped:false})));
    m.position.y = .008; m.userData = {t:0, life:0, wait:rand(0, P.gap)}; scene.add(m); arenaOnly.push(m); return m;
  });
  function spawnPulse(m){
    const seam = (Math.floor(rand(1, N / panel)) * panel) - H, alongX = Math.random() < .5, dir = Math.random() < .5 ? 1 : -1;
    m.userData = {t:0, life:(N + P.length) / P.speed, wait:0, alongX, dir, seam};
    m.rotation.y = alongX ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
  }

  /* ---------- Per frame ---------- */
  let time = 0;
  // riders: [{pos:Vector3, colorHex, on}] in slot order; camPos: camera position
  function update(dt, riders, camPos, particleScale){
    time += dt;
    // Perimeter ripples: each rider within reach lights the wall nearest to it
    if (!circuit) walls.forEach(w => {
      const P4 = w.mat.uniforms.uP.value, C = w.mat.uniforms.uC.value;
      w.mat.uniforms.uTime.value = time;
      for (let i = 0; i < 6; i++) {
        const r = riders[i];
        if (!r || !r.on) { P4[i].y = 0; continue; }
        const d = w.dist(r.pos);
        P4[i].x = w.along(r.pos); P4[i].y = Math.max(0, 1 - d / W.rippleReach);
        if (C[i].userData !== r.colorHex) { C[i].copy(lin(r.colorHex)); C[i].userData = r.colorHex; }
      }
    });
    beams.forEach(b => { const ph = b.userData.phase; b.rotation.z = Math.sin(time * S.beamSpeed + ph) * .55; b.rotation.x = Math.cos(time * S.beamSpeed * .7 + ph) * .3; });
    if (beaconMat) beaconMat.opacity = .35 + .65 * Math.pow(.5 + .5 * Math.sin(time * 1.3), 6);
    if (ledTex) ledTex.offset.x = (ledTex.offset.x + dt * A.stadium.ledSpeed) % 1;

    // Dust drifts slowly and wraps around the camera so it is always nearby
    const count = Math.max(1, Math.round(D.count * (particleScale || 1)));
    dustGeo.setDrawRange(0, count);
    for (let i = 0; i < count; i++) {
      const j = i * 3, s = dustSeed[i];
      dustPos[j] += Math.sin(time * .21 + s) * D.drift * dt;
      dustPos[j + 1] += Math.sin(time * .17 + s * 1.7) * D.drift * .5 * dt;
      dustPos[j + 2] += Math.cos(time * .19 + s) * D.drift * dt;
      let rel = dustPos[j] - camPos.x;
      if (rel > D.box) dustPos[j] -= D.box * 2; else if (rel < -D.box) dustPos[j] += D.box * 2;
      rel = dustPos[j + 2] - camPos.z;
      if (rel > D.box) dustPos[j + 2] -= D.box * 2; else if (rel < -D.box) dustPos[j + 2] += D.box * 2;
      if (dustPos[j + 1] < .2) dustPos[j + 1] = D.height; else if (dustPos[j + 1] > D.height) dustPos[j + 1] = .2;
    }
    dustGeo.attributes.position.needsUpdate = true;

    // Occasional slow light pulses along the panel seams
    if (!circuit) pulses.forEach(m => {
      const u = m.userData;
      if (u.life <= 0) { u.wait -= dt; m.material.opacity = 0; if (u.wait <= 0) spawnPulse(m); return; }
      u.t += dt;
      const along = -H - P.length / 2 + u.t * P.speed;
      const pos = u.dir > 0 ? along : -along;
      if (u.alongX) m.position.set(pos, .008, u.seam); else m.position.set(u.seam, .008, pos);
      m.material.opacity = P.opacity * Math.sin(Math.min(1, u.t / u.life) * Math.PI);
      if (u.t >= u.life) { u.life = 0; u.wait = rand(P.gap * .4, P.gap); }
    });
  }

  let circuit = false;
  // Circuit mode: the track brings its own road and barriers; keep the sky, skyline, beams and dust
  function setCircuit(on){ circuit = !!on; arenaOnly.forEach(o => { o.visible = !circuit; }); }

  return {update, floor, setCircuit, dispose:() => disposables.forEach(d => d.dispose && d.dispose())};
}
