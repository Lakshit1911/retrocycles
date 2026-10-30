/* Motion and impact effects, all pooled (no per-frame allocation):
   thruster heat particles, crash shards + flash, boost speed streaks, and the spawn scan line
   that materialises each craft during the countdown. Visual only. */
import { VISUAL_CONFIG as VC } from './config.js';
import { lin } from './renderer.js';
const THREE = window.THREE;
const E = () => VC.effects;

function dotTexture(){
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d'), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.4, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export function createEffects(scene, camera, reduceMotion){
  const cfg = E(), dot = dotTexture();
  const v3 = new THREE.Vector3(), v3b = new THREE.Vector3(), col = new THREE.Color();

  /* ---------- Thruster heat: additive points whose colour fades to black (additive = fade out) ---------- */
  const HM = cfg.heat.max;
  const hPos = new Float32Array(HM * 3), hCol = new Float32Array(HM * 3), hVel = new Float32Array(HM * 3), hLife = new Float32Array(HM), hBase = new Float32Array(HM * 3);
  const heatGeo = new THREE.BufferGeometry();
  heatGeo.setAttribute('position', new THREE.BufferAttribute(hPos, 3).setUsage(THREE.DynamicDrawUsage));
  heatGeo.setAttribute('color', new THREE.BufferAttribute(hCol, 3).setUsage(THREE.DynamicDrawUsage));
  const heat = new THREE.Points(heatGeo, new THREE.PointsMaterial({size:cfg.heat.size, map:dot, vertexColors:true, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, toneMapped:false}));
  heat.frustumCulled = false; scene.add(heat);
  let hNext = 0;
  function emitHeat(x, y, z, bx, bz, colorLin){
    const i = hNext; hNext = (hNext + 1) % HM;
    const j = i * 3, spread = cfg.heat.spread;
    hPos[j] = x; hPos[j + 1] = y; hPos[j + 2] = z;
    // drift back (opposite heading) and up
    hVel[j] = bx * cfg.heat.back + (Math.random() - .5) * spread;
    hVel[j + 1] = cfg.heat.rise * (.5 + Math.random());
    hVel[j + 2] = bz * cfg.heat.back + (Math.random() - .5) * spread;
    hLife[i] = cfg.heat.life;
    hBase[j] = colorLin.r; hBase[j + 1] = colorLin.g; hBase[j + 2] = colorLin.b;
  }

  /* ---------- Crash shards: instanced glowing slivers ---------- */
  const SM = cfg.shards.count * 6;
  const shardGeo = new THREE.TetrahedronGeometry(1, 0); shardGeo.scale(.5, .12, 1);
  const shards = new THREE.InstancedMesh(shardGeo, new THREE.MeshBasicMaterial({toneMapped:false, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false}), SM);
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shards.frustumCulled = false; scene.add(shards);
  const sPos = new Float32Array(SM * 3), sVel = new Float32Array(SM * 3), sRot = new Float32Array(SM * 3), sSpin = new Float32Array(SM * 3), sLife = new Float32Array(SM), sSize = new Float32Array(SM), sCol = new Float32Array(SM * 3);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), eul = new THREE.Euler(), scl = new THREE.Vector3(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < SM; i++) { shards.setMatrixAt(i, zero); shards.setColorAt(i, col.setRGB(0, 0, 0)); }
  let sNext = 0;

  // Flash: one bright additive sprite plus a point light, reused
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({map:dot, color:0xffffff, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, toneMapped:false}));
  flash.visible = false; scene.add(flash);
  const flashLight = new THREE.PointLight(0xffffff, 0, 14, 2); scene.add(flashLight);
  let flashT = 0;

  function crash(x, z, hex, intensity){
    const c = lin(hex), n = Math.round(cfg.shards.count * (intensity || 1));
    for (let k = 0; k < n; k++) {
      const i = sNext; sNext = (sNext + 1) % SM; const j = i * 3;
      sPos[j] = x + (Math.random() - .5) * .8; sPos[j + 1] = .35 + Math.random() * .6; sPos[j + 2] = z + (Math.random() - .5) * .8;
      const a = Math.random() * Math.PI * 2, sp = cfg.shards.speed * (.35 + Math.random());
      sVel[j] = Math.cos(a) * sp; sVel[j + 1] = cfg.shards.up * (.4 + Math.random()); sVel[j + 2] = Math.sin(a) * sp;
      for (let d = 0; d < 3; d++) { sRot[j + d] = Math.random() * 6.28; sSpin[j + d] = (Math.random() - .5) * cfg.shards.spin; }
      sLife[i] = cfg.shards.life; sSize[i] = cfg.shards.size * (.4 + Math.random());
      const w = Math.random() < .25 ? .6 : 0;   // a few near-white sparks
      sCol[j] = c.r + (1 - c.r) * w; sCol[j + 1] = c.g + (1 - c.g) * w; sCol[j + 2] = c.b + (1 - c.b) * w;
    }
    flash.position.set(x, .6, z); flash.material.color.copy(c).lerp(col.setRGB(1, 1, 1), .5);
    flashLight.position.set(x, 1, z); flashLight.color.copy(c);
    flashT = cfg.flash.life; flash.visible = true;
  }

  /* ---------- Speed streaks: thin additive lines in camera space, only while boosting ---------- */
  const ST = cfg.streaks.count, stPos = new Float32Array(ST * 6), stZ = new Float32Array(ST);
  const stGeo = new THREE.BufferGeometry(); stGeo.setAttribute('position', new THREE.BufferAttribute(stPos, 3).setUsage(THREE.DynamicDrawUsage));
  const streaks = new THREE.LineSegments(stGeo, new THREE.LineBasicMaterial({color:0xffffff, transparent:true, opacity:0, depthWrite:false, blending:THREE.AdditiveBlending, fog:false, toneMapped:false}));
  streaks.frustumCulled = false; camera.add(streaks); scene.add(camera);
  function placeStreak(i, z){
    // keep to the edges of the view: angle around the view axis, radius well off-centre
    const a = Math.random() * Math.PI * 2, r = cfg.streaks.radius[0] + Math.random() * (cfg.streaks.radius[1] - cfg.streaks.radius[0]);
    const j = i * 6, x = Math.cos(a) * r, y = Math.sin(a) * r * .6;
    stPos[j] = stPos[j + 3] = x; stPos[j + 1] = stPos[j + 4] = y; stZ[i] = z;
  }
  for (let i = 0; i < ST; i++) placeStreak(i, -Math.random() * cfg.streaks.depth);

  /* ---------- Spawn scan: clip each craft above a rising plane, with a glowing line at the plane ---------- */
  const scanGeo = new THREE.PlaneGeometry(1, 1); scanGeo.rotateX(-Math.PI / 2);
  function attachScan(b){
    const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e4);   // y > constant is clipped; huge = nothing clipped
    b.mesh.group.traverse(o => {
      if (!o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.clippingPlanes = [plane]; m.clipShadows = true; });
    });
    const line = new THREE.Mesh(scanGeo, new THREE.MeshBasicMaterial({color:lin(b.r.color).multiplyScalar(2.2), map:dot, transparent:true, opacity:0, depthWrite:false, blending:THREE.AdditiveBlending, toneMapped:false}));
    line.scale.set(1.6, 1, 3.2); scene.add(line);
    b.scan = {plane, line, t:9};
  }
  function detachScan(b){ if (b.scan) { scene.remove(b.scan.line); b.scan.line.material.dispose(); b.scan = null; } }
  function startScan(b){ if (b.scan) b.scan.t = 0; }

  /* ---------- Per frame ---------- */
  function update(dt, bikes, boost){
    // heat: emit from each living craft's nozzles, more with speed
    for (const b of bikes) {
      if (!b.alive || !b.mesh.group.visible) continue;
      const nozzles = b.mesh.ud.nozzles, speed = b.visualSpeed || 0;
      b.heatAcc = (b.heatAcc || 0) + dt * (cfg.heat.rate + cfg.heat.ratePerSpeed * speed) * (b.particleScale || 1);
      const fx = -Math.sin(b.vyaw), fz = -Math.cos(b.vyaw);
      const c = b.heatColor || (b.heatColor = lin(b.r.color));
      while (b.heatAcc >= 1) {
        b.heatAcc -= 1;
        const nz = nozzles[(Math.random() * nozzles.length) | 0];
        nz.getWorldPosition(v3);
        emitHeat(v3.x, v3.y, v3.z, -fx, -fz, c);
      }
    }
    for (let i = 0; i < HM; i++) {
      const j = i * 3;
      if (hLife[i] <= 0) { hCol[j] = hCol[j + 1] = hCol[j + 2] = 0; continue; }
      hLife[i] -= dt;
      const k = Math.max(0, hLife[i] / cfg.heat.life);
      hPos[j] += hVel[j] * dt; hPos[j + 1] += hVel[j + 1] * dt; hPos[j + 2] += hVel[j + 2] * dt;
      const f = k * k * cfg.heat.brightness;
      hCol[j] = hBase[j] * f; hCol[j + 1] = hBase[j + 1] * f; hCol[j + 2] = hBase[j + 2] * f;
    }
    heatGeo.attributes.position.needsUpdate = heatGeo.attributes.color.needsUpdate = true;

    // shards: velocity, gravity, spin, fade by shrinking and dimming
    let any = false;
    for (let i = 0; i < SM; i++) {
      if (sLife[i] <= 0) continue;
      any = true;
      sLife[i] -= dt;
      const j = i * 3;
      if (sLife[i] <= 0) { shards.setMatrixAt(i, zero); continue; }
      sVel[j + 1] -= cfg.shards.gravity * dt;
      sPos[j] += sVel[j] * dt; sPos[j + 1] += sVel[j + 1] * dt; sPos[j + 2] += sVel[j + 2] * dt;
      if (sPos[j + 1] < .03) { sPos[j + 1] = .03; sVel[j + 1] *= -.35; sVel[j] *= .7; sVel[j + 2] *= .7; }
      for (let d = 0; d < 3; d++) sRot[j + d] += sSpin[j + d] * dt;
      const k = sLife[i] / cfg.shards.life;
      q.setFromEuler(eul.set(sRot[j], sRot[j + 1], sRot[j + 2]));
      scl.setScalar(sSize[i] * (.4 + .6 * k));
      m4.compose(v3.set(sPos[j], sPos[j + 1], sPos[j + 2]), q, scl);
      shards.setMatrixAt(i, m4);
      shards.setColorAt(i, col.setRGB(sCol[j] * k * 1.6, sCol[j + 1] * k * 1.6, sCol[j + 2] * k * 1.6));
    }
    if (any) { shards.instanceMatrix.needsUpdate = true; if (shards.instanceColor) shards.instanceColor.needsUpdate = true; }

    if (flashT > 0) {
      flashT -= dt;
      const k = Math.max(0, flashT / cfg.flash.life);
      flash.scale.setScalar(cfg.flash.size * (1.4 - k * .4)); flash.material.opacity = k;
      flashLight.intensity = cfg.flash.light * k;
      if (flashT <= 0) { flash.visible = false; flashLight.intensity = 0; }
    }

    // streaks rush past near the screen edges while boosting
    const target = reduceMotion ? 0 : Math.max(0, Math.min(1, boost));
    streaks.material.opacity += (target * cfg.streaks.opacity - streaks.material.opacity) * Math.min(1, dt * 6);
    streaks.visible = streaks.material.opacity > .01;
    if (streaks.visible) {
      for (let i = 0; i < ST; i++) {
        stZ[i] += cfg.streaks.speed * (.6 + target) * dt;
        if (stZ[i] > -.5) placeStreak(i, -cfg.streaks.depth);
        const j = i * 6; stPos[j + 2] = stZ[i]; stPos[j + 5] = stZ[i] - cfg.streaks.length * (.4 + target);
      }
      stGeo.attributes.position.needsUpdate = true;
    }

    // spawn scan lines
    for (const b of bikes) {
      const s = b.scan; if (!s) continue;
      const top = 1.0 * VC.vehicle.scale * 1.7;   // craft height in cells, with margin
      if (s.t < cfg.scan.duration) {
        s.t += dt;
        const k = Math.min(1, s.t / cfg.scan.duration), y = top * k;
        s.plane.constant = y;
        s.line.visible = b.mesh.group.visible;
        s.line.position.set(b.vpos.x, y, b.vpos.z); s.line.rotation.y = b.vyaw;
        s.line.material.opacity = Math.sin(k * Math.PI) * .9 + .1;
        if (k >= 1) { s.plane.constant = 1e4; s.line.visible = false; }
      }
    }
  }

  return {update, crash, attachScan, detachScan, startScan};
}
