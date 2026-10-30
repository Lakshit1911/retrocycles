/*
 * Vanta, an original hyper-sport light cycle for Three.js (r125+).
 * Sculpted lofted bodywork, swept-blade alloy wheels, animated light veins.
 * Units: about 4.4 long, 1.6 tall (1 unit = 1 metre). Forward is -Z, up is +Y, tyres touch y = 0.
 * Looks best with scene.environment set (e.g. RoomEnvironment) and a bloom pass.
 */
function createVanta(THREE, opts) {
  opts = opts || {};
  var accent = new THREE.Color(opts.color !== undefined ? opts.color : 0xff2a3d);
  var hover = !!opts.hover;
  var PIVOT = 0.75;
  // root sits on the ground; craft is the body that leans and (for hover) floats; group holds the geometry.
  var root = new THREE.Group();
  root.name = hover ? 'VantaPhantom' : 'VantaCycle';
  var craft = new THREE.Group();
  craft.position.y = PIVOT;
  root.add(craft);
  var group = new THREE.Group();
  group.position.y = -PIVOT;
  craft.add(group);

  // ---------- Materials ----------
  var paint = new THREE.MeshPhysicalMaterial({
    color: opts.bodyColor !== undefined ? opts.bodyColor : 0x0b0d12,
    metalness: 0.55, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.06
  });
  var satin = new THREE.MeshStandardMaterial({ color: 0x15181e, metalness: 0.75, roughness: 0.42 });
  var chrome = new THREE.MeshStandardMaterial({ color: 0xc8ced8, metalness: 1, roughness: 0.16 });
  var alloy = new THREE.MeshStandardMaterial({ color: 0x2a2e36, metalness: 0.95, roughness: 0.24 });
  var rubber = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, metalness: 0, roughness: 0.92 });
  var leather = new THREE.MeshStandardMaterial({ color: 0x121316, metalness: 0.1, roughness: 0.78 });
  var glass = new THREE.MeshPhysicalMaterial({
    color: 0x0c1622, metalness: 0.2, roughness: 0.04, clearcoat: 1,
    transparent: true, opacity: 0.55, side: THREE.DoubleSide
  });
  var caliperMat = new THREE.MeshStandardMaterial({ color: accent.clone().multiplyScalar(0.6), metalness: 0.5, roughness: 0.3 });
  var brakeMat = new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 0.9, roughness: 0.35, emissive: 0xff4a12, emissiveIntensity: 0 });
  var headMat = new THREE.MeshBasicMaterial({ color: 0xeef6ff, toneMapped: false });
  var glowMat = new THREE.MeshBasicMaterial({ color: accent.clone(), toneMapped: false });
  var nozzleMat = new THREE.MeshBasicMaterial({ color: accent.clone(), toneMapped: false });
  var coreMats = [0, 1, 2].map(function () { return new THREE.MeshBasicMaterial({ color: accent.clone(), toneMapped: false }); });

  // Light veins: a bright pulse travels nose to tail, faster with speed.
  var veinMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: accent.clone() }, uTime: { value: 0 }, uBoost: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform vec3 uColor; uniform float uTime; uniform float uBoost; varying vec2 vUv;',
      'void main(){',
      '  float p = fract(vUv.x * 2.2 - uTime);',
      '  float pulse = pow(p, 9.0);',
      '  float ends = smoothstep(0.0, 0.05, vUv.x) * smoothstep(1.0, 0.92, vUv.x);',
      '  vec3 c = uColor * (0.75 + 2.4 * pulse * uBoost) + vec3(1.0) * pulse * 0.45 * uBoost;',
      '  gl_FragColor = vec4(c * ends, 1.0);',
      '}'
    ].join('\n')
  });

  function add(mesh, parent) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    (parent || group).add(mesh);
    return mesh;
  }

  var UP = new THREE.Vector3(0, 1, 0);
  // Tapered cylinder from a to b.
  function taper(a, b, r1, r2, mat, parent) {
    var A = new THREE.Vector3().fromArray(a), B = new THREE.Vector3().fromArray(b);
    var dir = B.clone().sub(A);
    var m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r1, dir.length(), 20), mat);
    m.position.copy(A).add(B).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(UP, dir.normalize());
    return add(m, parent);
  }

  // ---------- Lofted bodywork ----------
  // Stations: [z, centreY, halfWidth, halfHeight, roundness]. Higher roundness = fuller section.
  var ST = [
    [-2.32, 1.04, 0.004, 0.004, 2.4],
    [-2.08, 1.07, 0.09, 0.055, 2.4],
    [-1.78, 1.12, 0.19, 0.085, 2.6],
    [-1.45, 1.17, 0.26, 0.11, 2.6],
    [-1.08, 1.20, 0.31, 0.16, 2.8],
    [-0.68, 1.16, 0.34, 0.30, 3.0],
    [-0.25, 1.06, 0.33, 0.41, 3.0],
    [0.20, 1.00, 0.27, 0.33, 2.8],
    [0.60, 1.08, 0.20, 0.22, 2.6],
    [0.97, 1.20, 0.15, 0.13, 2.4],
    [1.36, 1.32, 0.11, 0.08, 2.4],
    [1.75, 1.42, 0.06, 0.045, 2.4],
    [2.05, 1.48, 0.004, 0.004, 2.4]
  ];
  var NS = ST.length;
  function cr(a, b, c, d, t) {
    return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  }
  function param(u, k) {
    var i = Math.min(Math.floor(u), NS - 2), t = u - i;
    return cr(ST[Math.max(i - 1, 0)][k], ST[i][k], ST[i + 1][k], ST[Math.min(i + 2, NS - 1)][k], t);
  }
  function spow(v, e) { return (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), e); }
  // Point on the body surface. theta = 0 on the spine, PI/2 on the right flank.
  function surface(u, theta, off) {
    var z = param(u, 0), yc = param(u, 1);
    var w = Math.max(0.004, param(u, 2)), h = Math.max(0.004, param(u, 3));
    var e = 2 / param(u, 4);
    var s = Math.sin(theta), c = Math.cos(theta);
    var crest = h * 0.22 * Math.pow(Math.max(0, c), 14); // knife-edge spine
    var k = 1 + (off || 0);
    return [w * spow(s, e) * k, yc + (h * spow(c, e) + crest) * k, z];
  }
  (function buildBody() {
    var L = 110, M = 56, verts = [], idx = [];
    for (var i = 0; i <= L; i++) {
      var u = (i / L) * (NS - 1);
      for (var j = 0; j <= M; j++) {
        var p = surface(u, (j / M) * Math.PI * 2, 0);
        verts.push(p[0], p[1], p[2]);
      }
    }
    for (i = 0; i < L; i++) {
      for (j = 0; j < M; j++) {
        var a = i * (M + 1) + j, b = a + M + 1, c = a + 1, d = b + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    add(new THREE.Mesh(g, paint));
  })();

  function vein(theta, u0, u1, radius) {
    var pts = [];
    for (var i = 0; i <= 70; i++) {
      var p = surface(u0 + (u1 - u0) * (i / 70), theta, 0.018);
      pts.push(new THREE.Vector3(p[0], p[1], p[2]));
    }
    var m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 200, radius, 8, false), veinMat);
    group.add(m);
  }
  [-1, 1].forEach(function (side) {
    vein(side * 1.12, 0.7, 10.7, 0.011);   // shoulder line, nose to tail
    vein(side * 2.0, 2.6, 8.2, 0.009);     // lower flank sweep
  });
  vein(0, 5.3, 11.3, 0.013);               // spine crest, tank to tail

  // ---------- Wheels ----------
  var blurTex = (function () {
    var cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    var x = cv.getContext('2d');
    var g = x.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, 'rgba(70,74,82,0.95)');
    g.addColorStop(0.25, 'rgba(40,42,48,0.9)');
    g.addColorStop(0.8, 'rgba(25,26,30,0.85)');
    g.addColorStop(1, 'rgba(25,26,30,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 256, 256);
    x.globalAlpha = 0.25;
    for (var r = 30; r < 124; r += 7) {
      x.strokeStyle = r % 2 ? '#8b919c' : '#20232a';
      x.lineWidth = 2;
      x.beginPath(); x.arc(128, 128, r, 0, Math.PI * 2); x.stroke();
    }
    var t = new THREE.CanvasTexture(cv);
    return t;
  })();

  function bladeGeometry(rHub, rTip, count) {
    var s = new THREE.Shape(), steps = 12, sweep = 0.75, edgeL = [], edgeR = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps, r = rHub + (rTip - rHub) * t;
      var phi = sweep * t * t;
      var half = (0.075 - 0.045 * t) / r;
      edgeL.push([Math.cos(phi + half) * r, Math.sin(phi + half) * r]);
      edgeR.push([Math.cos(phi - half) * r, Math.sin(phi - half) * r]);
    }
    s.moveTo(edgeR[0][0], edgeR[0][1]);
    edgeR.forEach(function (p) { s.lineTo(p[0], p[1]); });
    edgeL.reverse().forEach(function (p) { s.lineTo(p[0], p[1]); });
    s.closePath();
    var g = new THREE.ExtrudeGeometry(s, { depth: 0.045, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.008, bevelSegments: 2 });
    g.translate(0, 0, -0.0225);
    g.rotateY(Math.PI / 2);
    return g;
  }

  function wheel(z, r, width, brakeSide) {
    var w = new THREE.Group();
    w.position.set(0, r, z);
    group.add(w);
    var rot = new THREE.Group();
    w.add(rot);

    var tire = new THREE.TorusGeometry(r - 0.1, 0.1, 22, 80);
    tire.rotateY(Math.PI / 2);
    var tm = add(new THREE.Mesh(tire, rubber), rot);
    tm.scale.x = width / 0.2;
    var lip = new THREE.TorusGeometry(r - 0.2, 0.024, 10, 80);
    lip.rotateY(Math.PI / 2);
    add(new THREE.Mesh(lip, chrome), rot);

    var bg = bladeGeometry(0.08, r - 0.19, 7);
    for (var i = 0; i < 7; i++) {
      var b = add(new THREE.Mesh(bg, alloy), rot);
      b.rotation.x = (i / 7) * Math.PI * 2;
    }
    var hub = new THREE.CylinderGeometry(0.095, 0.095, width * 0.8, 28);
    hub.rotateZ(Math.PI / 2);
    add(new THREE.Mesh(hub, chrome), rot);
    var cap = new THREE.CylinderGeometry(0.038, 0.038, width * 0.84, 6);
    cap.rotateZ(Math.PI / 2);
    rot.add(new THREE.Mesh(cap, glowMat));

    var disc = new THREE.CylinderGeometry(r - 0.25, r - 0.25, 0.012, 56);
    disc.rotateZ(Math.PI / 2);
    var dm = add(new THREE.Mesh(disc, brakeMat), rot);
    dm.position.x = brakeSide * (width * 0.42);

    var cal = add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.1), caliperMat), w);
    cal.position.set(brakeSide * (width * 0.42 + 0.03), 0.14, 0.18);
    cal.rotation.x = -0.9;

    // motion blur discs, faded in with speed
    var blurMat = new THREE.MeshBasicMaterial({ map: blurTex, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    [-1, 1].forEach(function (sd) {
      var bd = new THREE.Mesh(new THREE.CircleGeometry(r - 0.17, 48), blurMat);
      bd.rotation.y = Math.PI / 2;
      bd.position.x = sd * 0.045;
      w.add(bd);
    });
    return { group: w, spin: rot, radius: r, blur: blurMat };
  }
  var front = null, rear = null, podMat = null, washMats = [];
  if (hover) {
    // ---------- Anti-gravity pods ----------
    podMat = new THREE.MeshBasicMaterial({ color: accent.clone(), toneMapped: false });
    var washTex = (function () {
      var cv = document.createElement('canvas'); cv.width = cv.height = 128;
      var x = cv.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.35, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(cv);
    })();
    function pod(x, z, sx, sy, sz) {
      var shell = add(new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), paint));
      shell.scale.set(sx, sy, sz);
      shell.position.set(x, 0.55, z);
      var plate = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 12), podMat);
      plate.scale.set(sx * 0.72, 0.018, sz * 0.8);
      plate.position.set(x, 0.55 - sy * 0.86, z);
      group.add(plate);
      [-1, 1].forEach(function (sd) {
        var trim = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.02, sz * 1.1), glowMat);
        trim.position.set(x + sd * sx * 0.93, 0.53, z);
        group.add(trim);
      });
      var noz = new THREE.Mesh(new THREE.CircleGeometry(Math.min(sx, sy) * 0.42, 20), nozzleMat);
      noz.position.set(x, 0.56, z + sz * 0.985);
      group.add(noz);
      var m = new THREE.Object3D();
      m.position.copy(noz.position);
      group.add(m);
      nozzles.push(m);
      // ground wash, kept on the root so it stays flat on the floor
      var wm = new THREE.MeshBasicMaterial({ map: washTex, color: accent.clone(), transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      var wash = new THREE.Mesh(new THREE.PlaneGeometry(sx * 4.2, sz * 3), wm);
      wash.rotation.x = -Math.PI / 2;
      wash.position.set(x, 0.012, z);
      root.add(wash);
      washMats.push(wm);
    }
    var nozzles = [];
    pod(0, -1.42, 0.3, 0.16, 0.72);
    pod(-0.27, 1.32, 0.17, 0.15, 0.68);
    pod(0.27, 1.32, 0.17, 0.15, 0.68);

    // swept neck to the front pod, struts and crossbar to the rear pods
    taper([0, 1.1, -1.18], [0, 0.66, -1.48], 0.085, 0.06, satin);
    taper([0, 1.0, -1.25], [0, 0.7, -1.52], 0.012, 0.012, glowMat);
    [-1, 1].forEach(function (sd) {
      taper([sd * 0.08, 0.92, 0.66], [sd * 0.27, 0.64, 1.1], 0.06, 0.045, satin);
      taper([sd * 0.27, 0.68, 1.0], [sd * 0.27, 0.95, 1.62], 0.016, 0.004, satin); // stabiliser fin edge
      var fin = add(new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.22, 0.42), paint));
      fin.position.set(sd * 0.27, 0.78, 1.38);
      fin.rotation.x = 0.55;
    });
    taper([-0.27, 0.58, 1.72], [0.27, 0.58, 1.72], 0.028, 0.028, satin);
  } else {
  front = wheel(-1.45, 0.52, 0.22, 1);
  rear = wheel(1.35, 0.55, 0.3, 1);

  // ---------- Chassis ----------
  [-0.18, 0.18].forEach(function (x) {
    taper([x, 1.24, -1.12], [x, 0.86, -1.3], 0.048, 0.046, satin);
    taper([x, 0.86, -1.3], [x, 0.52, -1.45], 0.034, 0.032, chrome);
  });
  var fAx = new THREE.CylinderGeometry(0.022, 0.022, 0.42, 12);
  fAx.rotateZ(Math.PI / 2);
  add(new THREE.Mesh(fAx, chrome), front.group);

  // single-sided swingarm on the left
  taper([-0.17, 0.56, 0.22], [-0.25, 0.55, 1.35], 0.075, 0.048, satin);
  taper([-0.17, 0.66, 0.3], [-0.25, 0.6, 1.2], 0.02, 0.02, glowMat);
  var rAx = new THREE.CylinderGeometry(0.03, 0.03, 0.3, 12);
  rAx.rotateZ(Math.PI / 2);
  var ra = add(new THREE.Mesh(rAx, chrome), rear.group);
  ra.position.x = -0.12;
  }

  // energy core: dark capsule wrapped in pulsing rings
  var capsule = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), satin);
  capsule.scale.set(0.2, 0.2, 0.42);
  capsule.position.set(0, 0.52, -0.15);
  add(capsule);
  var rings = [-0.38, -0.15, 0.08].map(function (z, i) {
    var t = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.016, 10, 48), coreMats[i]);
    var sz = Math.sqrt(Math.max(0.02, 1 - Math.pow((z + 0.15) / 0.42, 2)));
    t.scale.setScalar(sz * 1.04);
    t.position.set(0, 0.52, z);
    group.add(t);
    return t;
  });

  // clip-on bars, seat, screen
  [-1, 1].forEach(function (sd) {
    taper([sd * 0.16, 1.34, -0.84], [sd * 0.36, 1.27, -0.72], 0.018, 0.018, satin);
    taper([sd * 0.3, 1.29, -0.74], [sd * 0.4, 1.26, -0.71], 0.026, 0.026, rubber);
  });
  var seat = add(new THREE.Mesh(new THREE.SphereGeometry(1, 28, 14), leather));
  seat.scale.set(0.2, 0.05, 0.34);
  seat.position.set(0, 1.375, 0.28);
  var screen = add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 14, 0, Math.PI * 2, 0, Math.PI / 2), glass));
  screen.scale.set(0.19, 0.13, 0.42);
  screen.position.set(0, 1.3, -1.02);
  screen.rotation.x = -0.18;

  // twin under-tail exhausts with glowing nozzles
  nozzles = nozzles || [];
  [-0.075, 0.075].forEach(function (x) {
    var a = [x, 1.12, 0.75], b = [x, 1.27, 1.72];
    taper(a, b, 0.05, 0.058, satin);
    var dir = new THREE.Vector3().fromArray(b).sub(new THREE.Vector3().fromArray(a)).normalize();
    var n = new THREE.Mesh(new THREE.CircleGeometry(0.045, 20), nozzleMat);
    n.position.fromArray(b).addScaledVector(dir, 0.001);
    n.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    group.add(n);
    var marker = new THREE.Object3D();
    marker.position.copy(n.position);
    group.add(marker);
    nozzles.push(marker);
  });

  // headlight slits and tail blade
  [-1, 1].forEach(function (sd) {
    var hl = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.016, 0.05), headMat);
    hl.position.set(sd * 0.1, 1.085, -1.9);
    hl.rotation.set(0, -sd * 0.45, sd * 0.22);
    group.add(hl);
  });
  var tl = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.014, 0.32), glowMat);
  tl.position.set(0, 1.405, 1.82);
  tl.rotation.x = -0.25;
  group.add(tl);

  var trailOrigin = new THREE.Object3D();
  trailOrigin.name = 'trailOrigin';
  trailOrigin.position.set(0, 0, 1.95);
  root.add(trailOrigin);

  if (opts.scale) root.scale.setScalar(opts.scale);

  // ---------- Animation ----------
  var time = 0, lastSpeed = 0, heat = 0, lean = 0;
  root.userData = {
    hover: hover,
    craft: craft,
    wheels: hover ? [] : [front.group, rear.group],
    trailOrigin: trailOrigin,
    nozzles: nozzles,
    length: 4.4, height: 1.6, wheelRadius: 0.55,
    setColor: function (hex) {
      accent.setHex(hex);
      veinMat.uniforms.uColor.value.setHex(hex);
      glowMat.color.setHex(hex);
      caliperMat.color.setHex(hex).multiplyScalar(0.6);
      washMats.forEach(function (m) { m.color.setHex(hex); });
    },
    // roll angle in radians, positive leans left. Hover craft bank around their own centre.
    setLean: function (a) { lean = a; if (hover) { craft.rotation.z = a; } else { root.rotation.z = a; } },
    // speed in units per second, forward positive
    update: function (dt, speed) {
      time += dt;
      var v = Math.abs(speed);
      veinMat.uniforms.uTime.value += dt * (0.3 + v * 0.05);
      veinMat.uniforms.uBoost.value = 1 + v / 30;
      if (hover) {
        var bob = Math.sin(time * 2.1) * 0.035 + Math.sin(time * 5.3) * 0.008 * (1 + v / 20);
        craft.position.y = PIVOT + bob;
        craft.rotation.x = Math.sin(time * 1.3) * 0.012;
        var thrust = 0.6 + 0.4 * Math.sin(time * 9) * 0.25 + Math.min(0.5, v / 60);
        podMat.color.copy(accent).lerp(new THREE.Color(0xffffff), 0.2 + 0.15 * Math.sin(time * 14)).multiplyScalar(thrust);
        washMats.forEach(function (m, i) { m.opacity = (0.38 + 0.12 * Math.sin(time * 7 + i)) * (1 - bob * 4) + Math.min(0.25, v / 120); });
      }
      if (!hover) [front, rear].forEach(function (wh) {
        wh.spin.rotation.x -= (speed * dt) / wh.radius;
        wh.blur.opacity = Math.min(0.88, Math.max(0, (v - 5) / 18));
      });
      heat = Math.min(1.6, Math.max(0, heat + Math.max(0, lastSpeed - v) * 0.12 - dt * 0.35));
      lastSpeed = v;
      brakeMat.emissiveIntensity = heat;
      for (var i = 0; i < 3; i++) {
        var k = 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(time * (3 + v * 0.15) - i * 1.4), 3);
        coreMats[i].color.copy(accent).multiplyScalar(k);
      }
      var flick = (0.55 + Math.min(0.45, v / 50)) * (0.85 + Math.random() * 0.15);
      nozzleMat.color.copy(accent).lerp(new THREE.Color(0xffffff), 0.25).multiplyScalar(flick);
    }
  };
  return root;
}

export { createVanta };
export default createVanta;
