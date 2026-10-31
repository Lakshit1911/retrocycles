/*
 * Xenoth, an original alien jet-hover light cycle for Three.js (r125+).
 * Biomechanical carapace with a living vein pattern, a jet engine built into the body
 * (flank intakes with spinning fans, a visible turbine, iris nozzle, afterburner),
 * an exposed gyro reactor, mandibles, membrane fins and orbiting gravity shards.
 * Units: 1 unit = 1 metre. Forward is -Z, up is +Y. The root sits on the floor; the craft floats.
 * Looks best with scene.environment set (e.g. RoomEnvironment) and a bloom pass.
 */
function createXenoth(THREE, opts) {
  opts = opts || {};
  var accent = new THREE.Color(opts.color !== undefined ? opts.color : 0xff2a3d);
  var PIVOT = 0.8;
  var U = { time: { value: 0 }, color: { value: accent.clone() }, boost: { value: 1 }, thrust: { value: 0.3 } };

  var root = new THREE.Group();
  root.name = 'Xenoth';
  var craft = new THREE.Group();
  craft.position.y = PIVOT;
  root.add(craft);
  var group = new THREE.Group();
  group.position.y = -PIVOT;
  craft.add(group);

  // ---------- Materials ----------
  var skin = new THREE.MeshPhysicalMaterial({
    color: opts.bodyColor !== undefined ? opts.bodyColor : 0x0a0b10,
    metalness: 0.45, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.55
  });
  if ('iridescence' in skin) { skin.iridescence = 0.35; skin.iridescenceIOR = 1.35; skin.iridescenceThicknessRange = [120, 420]; }
  // Living vein network: a cellular pattern in the paint that pulses from nose to tail.
  skin.onBeforeCompile = function (shader) {
    shader.uniforms.uTime = U.time;
    shader.uniforms.uVein = U.color;
    shader.uniforms.uBoost = U.boost;
    shader.vertexShader = 'varying vec3 vObjPos;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>', '#include <begin_vertex>\n  vObjPos = position;');
    shader.fragmentShader = [
      'uniform float uTime; uniform vec3 uVein; uniform float uBoost; varying vec3 vObjPos;',
      'vec3 xhash(vec3 p){ p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6))); return fract(sin(p)*43758.5453); }',
      'float xvoro(vec3 x){ vec3 p = floor(x); vec3 f = fract(x); float d1 = 8.0, d2 = 8.0;',
      '  for (int k=-1;k<=1;k++) for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++) {',
      '    vec3 b = vec3(float(i),float(j),float(k)); vec3 r = b - f + xhash(p + b); float d = dot(r,r);',
      '    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; } }',
      '  return sqrt(d2) - sqrt(d1); }',
      shader.fragmentShader
    ].join('\n').replace('#include <emissivemap_fragment>', [
      '#include <emissivemap_fragment>',
      '{',
      '  float e = xvoro(vObjPos * vec3(5.2, 5.2, 2.7));',
      '  float line = 1.0 - smoothstep(0.0, 0.03, e);',
      '  float wave = pow(0.5 + 0.5 * sin(vObjPos.z * 5.0 + uTime * 3.2 * uBoost), 6.0);',
      '  totalEmissiveRadiance += uVein * line * (0.1 + 2.4 * wave * uBoost);',
      '}'
    ].join('\n'));
  };
  var shell = new THREE.MeshPhysicalMaterial({ color: 0x0c0d12, metalness: 0.55, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 0.6 });
  var satin = new THREE.MeshStandardMaterial({ color: 0x14161c, metalness: 0.8, roughness: 0.4 });
  var chrome = new THREE.MeshStandardMaterial({ color: 0xc9cfd9, metalness: 1, roughness: 0.14 });
  var duct = new THREE.MeshStandardMaterial({ color: 0x050608, metalness: 0.4, roughness: 0.7, side: THREE.DoubleSide });
  var glass = new THREE.MeshPhysicalMaterial({ color: 0x0a1018, metalness: 0.1, roughness: 0.03, clearcoat: 1, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false });
  var canopy = new THREE.MeshPhysicalMaterial({ color: 0x05070c, metalness: 0.4, roughness: 0.05, clearcoat: 1 });
  var membrane = new THREE.MeshPhysicalMaterial({ color: accent.clone().multiplyScalar(0.25), emissive: accent.clone(), emissiveIntensity: 0.12, metalness: 0.2, roughness: 0.25, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
  var glowMat = new THREE.MeshBasicMaterial({ color: accent.clone(), toneMapped: false });
  var hotMat = new THREE.MeshBasicMaterial({ color: accent.clone().lerp(new THREE.Color(0xffffff), 0.5), toneMapped: false });
  var eyeMat = new THREE.MeshBasicMaterial({ color: 0xf2f8ff, toneMapped: false });
  var coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });

  var pulseMat = new THREE.ShaderMaterial({
    uniforms: { uColor: U.color, uTime: U.time, uBoost: U.boost },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform vec3 uColor; uniform float uTime; uniform float uBoost; varying vec2 vUv;',
      'void main(){',
      '  float p = pow(fract(vUv.x * 2.0 - uTime * 0.6 * uBoost), 10.0);',
      '  float ends = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.9, vUv.x);',
      '  gl_FragColor = vec4((uColor * (0.7 + 2.6 * p) + vec3(p * 0.5)) * ends, 1.0);',
      '}'
    ].join('\n')
  });

  function add(mesh, parent) { mesh.castShadow = true; mesh.receiveShadow = true; (parent || group).add(mesh); return mesh; }
  var UP = new THREE.Vector3(0, 1, 0);
  function taper(a, b, r1, r2, mat, parent) {
    var A = new THREE.Vector3().fromArray(a), B = new THREE.Vector3().fromArray(b), d = B.clone().sub(A);
    var m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r1, d.length(), 16), mat);
    m.position.copy(A).add(B).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(UP, d.normalize());
    return add(m, parent);
  }
  // Tube whose radius follows rFn(t) along a curve.
  function taperTube(points, rFn, mat, segs) {
    var curve = new THREE.CatmullRomCurve3(points.map(function (p) { return new THREE.Vector3().fromArray(p); }));
    var T = segs || 40, R = 12, g = new THREE.TubeGeometry(curve, T, 1, R, false), pos = g.attributes.position;
    for (var i = 0; i <= T; i++) {
      var c = curve.getPointAt(i / T), r = rFn(i / T);
      for (var j = 0; j <= R; j++) {
        var k = i * (R + 1) + j;
        pos.setXYZ(k, c.x + (pos.getX(k) - c.x) * r, c.y + (pos.getY(k) - c.y) * r, c.z + (pos.getZ(k) - c.z) * r);
      }
    }
    g.computeVertexNormals();
    return add(new THREE.Mesh(g, mat));
  }
  // Lathe profile [[radius, z], ...] turned around the Z axis, centred at (0, y, 0).
  function latheZ(profile, y, mat, segs) {
    var g = new THREE.LatheGeometry(profile.map(function (p) { return new THREE.Vector2(p[0], p[1]); }), segs || 56);
    g.rotateX(Math.PI / 2);
    var m = add(new THREE.Mesh(g, mat));
    m.position.y = y;
    return m;
  }

  // ---------- Carapace (lofted) ----------
  // [z, centreY, halfWidth, halfHeight, roundness]
  var ST = [
    [-2.05, 0.93, 0.004, 0.004, 2.2],
    [-1.80, 0.95, 0.12, 0.065, 2.3],
    [-1.45, 0.99, 0.24, 0.115, 2.5],
    [-1.05, 1.02, 0.34, 0.175, 2.6],
    [-0.62, 1.03, 0.42, 0.24, 2.8],
    [-0.20, 1.01, 0.44, 0.28, 2.9],
    [0.22, 0.99, 0.40, 0.30, 2.8],
    [0.62, 0.98, 0.34, 0.30, 2.6],
    [0.95, 0.98, 0.29, 0.27, 2.4],
    [1.30, 0.98, 0.004, 0.004, 2.2]
  ];
  var NS = ST.length;
  function cr(a, b, c, d, t) { return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t); }
  function param(u, k) {
    var i = Math.min(Math.floor(u), NS - 2), t = u - i;
    return cr(ST[Math.max(i - 1, 0)][k], ST[i][k], ST[i + 1][k], ST[Math.min(i + 2, NS - 1)][k], t);
  }
  function spow(v, e) { return (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), e); }
  function surface(u, theta, off) {
    var z = param(u, 0), yc = param(u, 1), w = Math.max(0.004, param(u, 2)), h = Math.max(0.004, param(u, 3)), e = 2 / param(u, 4);
    var s = Math.sin(theta), c = Math.cos(theta);
    var crest = h * 0.3 * Math.pow(Math.max(0, c), 16);                       // knife spine
    var keel = c < 0 ? 0.82 : 1;                                               // flatter belly
    var rib = 1 + 0.035 * Math.pow(Math.abs(Math.cos(theta * 5)), 8) * Math.min(1, w * 4);   // carapace ridges
    var seg = z > -0.7 ? 1 - 0.045 * Math.pow(Math.max(0, Math.cos(z * 11)), 14) : 1;    // segmented abdomen
    var k = (1 + (off || 0)) * rib * seg;
    return [w * spow(s, e) * k, yc + (h * keel * spow(c, e) + crest) * k, z];
  }
  function uAt(z) {
    var lo = 0, hi = NS - 1;
    for (var i = 0; i < 30; i++) { var mid = (lo + hi) / 2; if (param(mid, 0) < z) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  (function () {
    var L = 120, M = 64, v = [], idx = [];
    for (var i = 0; i <= L; i++) for (var j = 0; j <= M; j++) { var p = surface((i / L) * (NS - 1), (j / M) * Math.PI * 2, 0); v.push(p[0], p[1], p[2]); }
    for (i = 0; i < L; i++) for (j = 0; j < M; j++) { var a = i * (M + 1) + j, b = a + M + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    add(new THREE.Mesh(g, skin));
  })();
  function onBody(z, theta, off) { var p = surface(uAt(z), theta, off || 0); return p; }

  // shoulder light lines
  [-1, 1].forEach(function (sd) {
    var pts = [];
    for (var i = 0; i <= 50; i++) { var z = -1.75 + (i / 50) * 2.55; pts.push(onBody(z, sd * 1.05, 0.02)); }
    var c = new THREE.CatmullRomCurve3(pts.map(function (p) { return new THREE.Vector3().fromArray(p); }));
    group.add(new THREE.Mesh(new THREE.TubeGeometry(c, 160, 0.009, 8, false), pulseMat));
  });

  // ---------- Jet engine nacelle (built into the tail) ----------
  var EY = 0.98;
  latheZ([[0.2, 0.5], [0.3, 0.75], [0.35, 1.05], [0.365, 1.4], [0.345, 1.72], [0.31, 1.96], [0.285, 1.97], [0.27, 1.72], [0.26, 1.2], [0.15, 0.9]], EY, skin, 64);
  latheZ([[0.27, 1.25], [0.272, 1.95]], EY, duct, 48); // dark inner wall
  [1.5, 1.62, 1.74].forEach(function (z, i) {          // heat bands
    var t = new THREE.Mesh(new THREE.TorusGeometry(0.352 - i * 0.008, 0.006, 6, 64), glowMat);
    t.position.set(0, EY, z);
    group.add(t);
  });
  // turbine, seen through the nozzle
  var turbine = new THREE.Group();
  turbine.position.set(0, EY, 1.66);
  group.add(turbine);
  var backplate = new THREE.Mesh(new THREE.CircleGeometry(0.27, 40), hotMat);
  backplate.position.z = -0.03;
  turbine.add(backplate);
  var spinner = new THREE.ConeGeometry(0.075, 0.2, 24);
  spinner.rotateX(Math.PI / 2);
  var sp = add(new THREE.Mesh(spinner, chrome), turbine);
  sp.position.z = 0.08;
  for (var b = 0; b < 18; b++) {
    var holder = new THREE.Group();
    holder.rotation.z = (b / 18) * Math.PI * 2;
    turbine.add(holder);
    var blade = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.19, 0.01), b % 2 ? satin : chrome);
    blade.position.y = 0.165;
    blade.rotation.y = 0.65;
    holder.add(blade);
  }
  // iris nozzle petals
  var petals = [];
  for (var p = 0; p < 16; p++) {
    var a = (p / 16) * Math.PI * 2, hinge = new THREE.Group();
    hinge.rotation.order = 'ZYX';
    hinge.position.set(Math.cos(a) * 0.295, EY + Math.sin(a) * 0.295, 1.95);
    hinge.rotation.z = a;
    hinge.rotation.y = -0.2;
    group.add(hinge);
    var pm = add(new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.12, 0.26), p % 2 ? chrome : satin), hinge);
    pm.position.z = 0.13;
    petals.push(hinge);
  }
  // afterburner: an outer plume and a hot inner core, each with shock diamonds
  function plume(rExit, rEnd, inner) {
    var g = new THREE.CylinderGeometry(rExit, rEnd, 1, 32, 24, true);
    g.translate(0, -0.5, 0);
    g.rotateX(-Math.PI / 2);
    var m = new THREE.ShaderMaterial({
      uniforms: { uColor: U.color, uTime: U.time, uThrust: U.thrust, uInner: { value: inner ? 1 : 0 } },
      vertexShader: [
        'varying vec2 vUv; varying float vFace;',
        'void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  vec3 n = normalize(normalMatrix * normal); vFace = abs(dot(n, normalize(-mv.xyz)));',
        '  gl_Position = projectionMatrix * mv; }'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor; uniform float uTime; uniform float uThrust; uniform float uInner; varying vec2 vUv; varying float vFace;',
        'void main(){',
        '  float t = 1.0 - vUv.y;',
        '  float fade = pow(1.0 - t, 1.7);',
        '  float diamonds = 0.55 + 0.45 * pow(0.5 + 0.5 * cos(t * 30.0), 3.0);',
        '  float flick = 0.85 + 0.15 * sin(uTime * 63.0 + t * 24.0) * sin(uTime * 41.0 + vUv.x * 30.0);',
        '  vec3 hot = mix(vec3(1.0), uColor, smoothstep(0.0, 0.55, t) * (1.0 - uInner * 0.6));',
        '  float body = pow(vFace, 1.6) * fade * diamonds * flick * (0.25 + uThrust * 0.7) * (1.0 + uInner * 0.5);',
        '  gl_FragColor = vec4(hot * body, 1.0);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
    var mesh = new THREE.Mesh(g, m);
    mesh.position.set(0, EY, 1.98);
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  }
  var flameOuter = plume(0.25, 0.03, false), flameInner = plume(0.14, 0.01, true);
  var exhaust = new THREE.Object3D();
  exhaust.position.set(0, EY, 2.0);
  group.add(exhaust);

  // ---------- Flank intakes with compressor fans ----------
  var fans = [];
  [-1, 1].forEach(function (sd) {
    var ix = sd * 0.45, iy = 0.93, iz = -0.62;
    var m = latheZ([[0.15, -0.0], [0.135, 0.12], [0.1, 0.42], [0.04, 0.6], [0.03, 0.6], [0.09, 0.4], [0.12, 0.1], [0.13, 0.0]], 0, shell, 40);
    m.position.set(ix, iy, iz);
    m.rotation.y = -sd * 0.08;
    var lip = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.012, 8, 48), glowMat);
    lip.position.set(ix, iy, iz);
    group.add(lip);
    var fan = new THREE.Group();
    fan.position.set(ix, iy, iz + 0.12);
    group.add(fan);
    var hubg = new THREE.ConeGeometry(0.045, 0.12, 20);
    hubg.rotateX(-Math.PI / 2);
    add(new THREE.Mesh(hubg, chrome), fan).position.z = -0.03;
    for (var i = 0; i < 11; i++) {
      var hd = new THREE.Group();
      hd.rotation.z = (i / 11) * Math.PI * 2;
      fan.add(hd);
      var bl = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.085, 0.006), i % 2 ? chrome : satin);
      bl.position.y = 0.075;
      bl.rotation.y = 0.7;
      hd.add(bl);
    }
    var ring = new THREE.Mesh(new THREE.CircleGeometry(0.11, 32), hotMat);
    ring.position.set(ix, iy, iz + 0.2);
    ring.rotation.y = Math.PI;
    group.add(ring);
    fans.push(fan);
  });

  // ---------- Exposed gyro reactor on the spine ----------
  var reactor = new THREE.Group();
  reactor.position.set(0, 1.36, 0.62);
  group.add(reactor);
  var dome = new THREE.Mesh(new THREE.SphereGeometry(0.19, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  dome.scale.set(1, 1, 1.5);
  dome.position.y = -0.06;
  reactor.add(dome);
  var collar = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.016, 8, 48), chrome);
  collar.rotation.x = Math.PI / 2;
  collar.scale.set(1, 1.5, 1);
  collar.position.y = -0.06;
  add(collar, reactor);
  var gyros = [0.12, 0.092, 0.066].map(function (r, i) {
    var g = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0075, 6, 48), i === 1 ? hotMat : glowMat);
    g.position.y = 0.03;
    reactor.add(g);
    return g;
  });
  var core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.035, 1), coreMat);
  core.position.y = 0.03;
  reactor.add(core);

  // ---------- Head: canopy, eyes, mandibles ----------
  var cnp = add(new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), canopy));
  cnp.scale.set(0.17, 0.085, 0.5);
  cnp.position.set(0, 1.15, -1.0);
  cnp.rotation.x = -0.06;
  [-1, 1].forEach(function (sd) {
    [[-1.62, 1.05, 0.11, 0.36], [-1.48, 1.3, 0.09, 0.3], [-1.33, 1.5, 0.07, 0.25]].forEach(function (e, i) {
      var p = onBody(e[0], sd * e[1], 0.012);
      var eye = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.016, e[2]), i === 0 ? eyeMat : glowMat);
      eye.position.fromArray(p);
      eye.rotation.set(0, sd * e[3], sd * 0.35);
      group.add(eye);
    });
    taperTube([[sd * 0.2, 1.0, -1.3], [sd * 0.3, 0.99, -1.85], [sd * 0.2, 0.95, -2.3], [sd * 0.07, 0.9, -2.6]],
      function (t) { return 0.055 * (1 - t) + 0.006; }, shell);
    taperTube([[sd * 0.15, 0.85, -1.25], [sd * 0.24, 0.79, -1.7], [sd * 0.16, 0.77, -2.08], [sd * 0.05, 0.78, -2.3]],
      function (t) { return 0.04 * (1 - t) + 0.005; }, shell);
    [[sd * 0.07, 0.9, -2.6], [sd * 0.05, 0.78, -2.3]].forEach(function (tp) {
      var tip = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), hotMat);
      tip.position.fromArray(tp);
      group.add(tip);
    });
  });

  // ---------- Dorsal spines ----------
  [[-0.5, 0.2], [-0.3, 0.17], [-0.1, 0.14], [0.1, 0.11], [0.3, 0.08]].forEach(function (s) {
    var base = onBody(s[0], 0, -0.02);
    var sh = new THREE.Shape();
    sh.moveTo(-0.12, 0); sh.lineTo(0.16, s[1]); sh.lineTo(0.2, s[1] * 0.85); sh.lineTo(0.12, 0); sh.closePath();
    var g = new THREE.ExtrudeGeometry(sh, { depth: 0.014, bevelEnabled: false });
    g.translate(0, 0, -0.007);
    g.rotateY(Math.PI / 2);                // profile x -> -z, i.e. sweeps backward... flip to point aft
    g.scale(1, 1, -1);
    var m = add(new THREE.Mesh(g, shell));
    m.position.set(0, base[1], s[0]);
    var tip = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.01, 0.06), glowMat);
    tip.position.set(0, base[1] + s[1] * 0.93, s[0] + 0.18);
    group.add(tip);
  });

  // ---------- Membrane fins ----------
  [-1, 1].forEach(function (sd) {
    var fin = new THREE.Group();
    fin.position.set(sd * 0.36, 0.88, -0.15);
    fin.rotation.z = sd * -0.16;
    fin.scale.x = sd;
    group.add(fin);
    var shp = new THREE.Shape();
    shp.moveTo(0, -0.3); shp.quadraticCurveTo(0.42, -0.05, 0.62, 0.62); shp.quadraticCurveTo(0.38, 0.4, 0, 0.3); shp.closePath();
    var g = new THREE.ShapeGeometry(shp, 24);
    g.rotateX(Math.PI / 2);
    fin.add(new THREE.Mesh(g, membrane));
    var edge = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, -0.3), new THREE.Vector3(0.42, 0, -0.05), new THREE.Vector3(0.62, 0, 0.62));
    fin.add(new THREE.Mesh(new THREE.TubeGeometry(edge, 40, 0.012, 8, false), shell));
    var edgeGlow = new THREE.Mesh(new THREE.TubeGeometry(edge, 40, 0.005, 6, false), glowMat);
    edgeGlow.position.y = 0.012;
    fin.add(edgeGlow);
    [[0.06, 0.25], [0.3, 0.42], [0.5, 0.58]].forEach(function (v) {
      var c = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0.02, 0.002, -0.05 + v[0] * 0.3), new THREE.Vector3(v[0] * 0.8, 0.002, v[1] * 0.5), new THREE.Vector3(v[0] + 0.1, 0.002, v[1] + 0.05));
      fin.add(new THREE.Mesh(new THREE.TubeGeometry(c, 24, 0.0035, 5, false), pulseMat));
    });
  });

  // ---------- Gravity drive: emitter arcs and orbiting shards ----------
  var arcs = [];
  [[-0.95, 0.7, 0.26], [1.05, 0.52, 0.32]].forEach(function (e) {
    var holder = new THREE.Group();
    holder.position.set(0, e[1], e[0]);
    group.add(holder);
    for (var i = 0; i < 3; i++) {
      var arc = new THREE.Mesh(new THREE.TorusGeometry(e[2], 0.016, 8, 40, 1.5), glowMat);
      arc.rotation.x = Math.PI / 2;
      arc.rotation.z = (i / 3) * Math.PI * 2;
      holder.add(arc);
    }
    var disc = new THREE.Mesh(new THREE.CircleGeometry(e[2] * 0.75, 32), hotMat);
    disc.rotation.x = Math.PI / 2;
    disc.position.y = 0.01;
    holder.add(disc);
    arcs.push(holder);
  });
  var shards = [];
  for (var s = 0; s < 6; s++) {
    var sm = new THREE.Mesh(new THREE.OctahedronGeometry(0.03 + (s % 3) * 0.01, 0), s % 3 === 0 ? hotMat : glowMat);
    sm.scale.y = 1.8;
    group.add(sm);
    shards.push({ m: sm, ph: (s / 6) * Math.PI * 2, sp: 0.5 + (s % 4) * 0.12, h: 0.46 + (s % 3) * 0.05 });
  }

  // ground ripple, kept flat on the floor
  var rippleMat = new THREE.ShaderMaterial({
    uniforms: { uColor: U.color, uTime: U.time, uThrust: U.thrust },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform vec3 uColor; uniform float uTime; uniform float uThrust; varying vec2 vUv;',
      'void main(){',
      '  vec2 q = (vUv - 0.5) * vec2(1.0, 2.2);',
      '  float d = length(q);',
      '  float rings = pow(0.5 + 0.5 * sin(d * 46.0 - uTime * 7.0), 8.0);',
      '  float fall = smoothstep(0.5, 0.05, d);',
      '  float glow = exp(-d * 9.0);',
      '  gl_FragColor = vec4(uColor * (rings * 0.45 + glow * 0.9) * fall * (0.6 + uThrust * 0.4), 1.0);',
      '}'
    ].join('\n'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  var ripple = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 5.6), rippleMat);
  ripple.rotation.x = -Math.PI / 2;
  ripple.position.set(0, 0.012, 0);
  root.add(ripple);

  var trailOrigin = new THREE.Object3D();
  trailOrigin.name = 'trailOrigin';
  trailOrigin.position.set(0, 0, 2.15);
  root.add(trailOrigin);

  if (opts.scale) root.scale.setScalar(opts.scale);

  // ---------- Animation ----------
  var time = 0, boostS = 0, white = new THREE.Color(0xffffff);
  root.userData = {
    hover: true,
    craft: craft,
    wheels: [],
    trailOrigin: trailOrigin,
    nozzles: [exhaust],
    length: 4.8, height: 1.55, wheelRadius: 0,
    setColor: function (hex) {
      accent.setHex(hex);
      U.color.value.setHex(hex);
      glowMat.color.setHex(hex);
      hotMat.color.setHex(hex).lerp(white, 0.5);
      membrane.color.setHex(hex).multiplyScalar(0.25);
      membrane.emissive.setHex(hex);
    },
    setLean: function (a) { craft.rotation.z = a; },
    // dt seconds, speed metres per second, boost 0..1 (optional)
    update: function (dt, speed, boost) {
      time += dt;
      var v = Math.abs(speed || 0);
      boostS += ((boost || 0) - boostS) * Math.min(1, dt * 4);
      var thrust = Math.min(1.6, 0.18 + v / 45 + boostS * 0.75);
      U.time.value = time;
      U.boost.value = 1 + v / 35 + boostS * 0.8;
      U.thrust.value = thrust;

      craft.position.y = PIVOT + Math.sin(time * 1.8) * 0.035 + Math.sin(time * 4.7) * 0.008;
      craft.rotation.x = Math.sin(time * 1.1) * 0.01 - boostS * 0.03;

      var spin = dt * (10 + v * 1.4 + boostS * 35);
      turbine.rotation.z += spin;
      fans.forEach(function (f, i) { f.rotation.z += (i ? -1 : 1) * spin * 1.3; });
      petals.forEach(function (h) { h.rotation.y = -0.26 + thrust * 0.17; });
      var flick = 1 + Math.sin(time * 47) * 0.04;
      flameOuter.scale.set(flick, flick, 0.25 + thrust * 1.15);
      flameInner.scale.set(1, 1, 0.15 + thrust * 0.6);

      gyros[0].rotation.set(time * 1.3, time * 0.7, 0);
      gyros[1].rotation.set(0, time * -1.9, time * 1.1);
      gyros[2].rotation.set(time * 2.6, 0, time * -1.7);
      var beat = 0.75 + 0.25 * Math.pow(0.5 + 0.5 * Math.sin(time * (4 + v * 0.2)), 4);
      core.scale.setScalar(beat * (1 + boostS * 0.4));
      coreMat.color.copy(white).lerp(accent, 0.35).multiplyScalar(1 + boostS);

      arcs[0].rotation.y += dt * 2.4;
      arcs[1].rotation.y -= dt * 1.8;
      shards.forEach(function (s, i) {
        var a = time * s.sp + s.ph;
        s.m.position.set(Math.cos(a) * 0.5, s.h + Math.sin(time * 1.6 + i) * 0.04, Math.sin(a) * 1.25 + 0.05);
        s.m.rotation.set(time * 1.3 + i, time * 0.9, 0);
      });
    }
  };
  return root;
}

export { createXenoth };
export default createXenoth;
