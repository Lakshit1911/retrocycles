/* Rendering pipeline (three.js r128): sRGB output with ACES Filmic tone mapping, RoomEnvironment
   reflections, the light rig, fog, bloom, and Low / Medium / High quality with auto-downgrade.

   Colour management: r128 does not convert colours for us. Every palette hex is sRGB, so it is
   converted to linear with lin() before it reaches a material; the final gamma pass (or
   renderer.outputEncoding when rendering straight to screen) converts back to sRGB.
   r128 tone-maps inside materials and writes render targets in linear, so the chain is
   RenderPass -> UnrealBloomPass -> GammaCorrection (OutputPass only exists from r153).
   Every quality level uses the composer, so custom shaders get the same sRGB conversion;
   Low simply drops the bloom pass. */
import { VISUAL_CONFIG as VC } from './config.js';
const THREE = window.THREE;

export const lin = hex => new THREE.Color(hex).convertSRGBToLinear();
export const linHex = hex => lin(hex).getHex();
export const QUALITY_LEVELS = ['low', 'medium', 'high'];
export const defaultQuality = () => matchMedia('(pointer: coarse)').matches ? 'medium' : 'high';

export function createPipeline({mount, scene, camera, quality, onAutoDrop}){
  const L = VC.lights;
  // desynchronized: a low-latency canvas where the browser supports it (frames skip a compositor step)
  const renderer = new THREE.WebGLRenderer({antialias:false, stencil:false, powerPreference:'high-performance', desynchronized:true});
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = VC.render.exposure;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mount.appendChild(renderer.domElement);
  const gl2 = renderer.capabilities.isWebGL2;
  const halfFloat = gl2 && !!renderer.extensions.get('EXT_color_buffer_float');

  // Reflections for the paint and the floor
  // RoomEnvironment is a bright white studio; dim its walls and boxes so black paint and the
  // floor reflect a dark room with bright panels instead of a white box
  const pmrem = new THREE.PMREMGenerator(renderer), room = new THREE.RoomEnvironment();
  room.traverse(o => {
    if (!o.material) return;
    if (o.material.isMeshStandardMaterial) o.material.color.setScalar(VC.render.envRoomShade);
    else if (o.material.isMeshBasicMaterial) o.material.color.multiplyScalar(VC.render.envLightScale);
  });
  scene.environment = pmrem.fromScene(room, VC.render.envBlur).texture;
  pmrem.dispose();
  room.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  scene.background = lin(VC.palette.background);
  scene.fog = new THREE.FogExp2(lin(VC.palette.background).getHex(), VC.fog.density);

  // Light rig: dim cool fill, a shadow-casting key and a rim in the local rider's colour (both
  // follow the local rider), and one pooled point light under each rider for its floor glow
  const hemi = new THREE.HemisphereLight(lin(L.hemi.sky), lin(L.hemi.ground), L.hemi.intensity);
  const key = new THREE.DirectionalLight(lin(L.key.color), L.key.intensity);
  key.castShadow = true;
  Object.assign(key.shadow.camera, {left:-L.key.extent, right:L.key.extent, top:L.key.extent, bottom:-L.key.extent, near:L.key.near, far:L.key.far});
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = L.key.bias;
  // Rim: a tight spot on the local rider, so its colour catches the craft without washing the glossy floor
  const rim = new THREE.SpotLight(0xffffff, L.rim.intensity, L.rim.distance, L.rim.angle, L.rim.penumbra, L.rim.decay);
  scene.add(hemi, key, key.target, rim, rim.target);
  // A fixed pool keeps the light count constant, so riders joining or leaving never recompile shaders
  const glows = Array.from({length:VC.riders.length}, () => {
    const p = new THREE.PointLight(0xffffff, 0, L.glow.distance, L.glow.decay);
    scene.add(p); return p;
  });

  let level = null, composer = null, bloom = null, settings = null, scale = 1;
  const size = new THREE.Vector2();

  function buildComposer(){
    if (composer) {
      composer.renderTarget1.dispose(); composer.renderTarget2.dispose();
      composer.passes.forEach(p => p.dispose && p.dispose());
      composer = bloom = null;
    }
    renderer.getDrawingBufferSize(size);
    const opts = {minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter, format:THREE.RGBAFormat,
      type:halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType};
    let rt;
    if (gl2 && settings.msaa) { rt = new THREE.WebGLMultisampleRenderTarget(size.x, size.y, opts); rt.samples = settings.msaa; }
    else rt = new THREE.WebGLRenderTarget(size.x, size.y, opts);
    composer = new THREE.EffectComposer(renderer, rt);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(innerWidth, innerHeight);
    composer.addPass(new THREE.RenderPass(scene, camera));
    if (settings.bloomScale > 0) {
      bloom = new THREE.UnrealBloomPass(new THREE.Vector2(size.x, size.y), VC.bloom.strength, VC.bloom.radius, VC.bloom.threshold);
      // Bloom resolution follows the quality level
      const bloomSetSize = bloom.setSize.bind(bloom), k = settings.bloomScale;
      bloom.setSize = (w, h) => bloomSetSize(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
      bloom.setSize(size.x, size.y);
      composer.addPass(bloom);
    }
    composer.addPass(new THREE.ShaderPass(THREE.GammaCorrectionShader));
  }

  function setQuality(q){
    if (!VC.quality[q]) q = defaultQuality();
    if (q === level) return level;
    level = q; settings = VC.quality[q];
    renderer.setPixelRatio(basePR() * scale);
    renderer.setSize(innerWidth, innerHeight);
    const shadows = settings.shadows > 0;
    if (renderer.shadowMap.enabled !== shadows) {
      renderer.shadowMap.enabled = shadows;
      scene.traverse(o => { const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => x.needsUpdate = true); });
    }
    if (shadows) {
      key.shadow.mapSize.set(settings.shadows, settings.shadows);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
    buildComposer();
    grace = VC.autoQuality.graceSeconds; slow = 0; acc = 0; frames = 0;
    return level;
  }

  function resize(){
    renderer.setSize(innerWidth, innerHeight);
    if (composer) composer.setSize(innerWidth, innerHeight);
  }

  // Lights that follow the local rider. Snapping the shadow target to whole texels stops shadow edges shimmering.
  function follow(pos, colorHex){
    const texel = (L.key.extent * 2) / (settings.shadows || 1024);
    const tx = Math.round(pos.x / texel) * texel, tz = Math.round(pos.z / texel) * texel;
    key.target.position.set(tx, 0, tz);
    key.position.set(tx + L.key.offset[0], L.key.offset[1], tz + L.key.offset[2]);
    rim.target.position.set(pos.x, 0, pos.z);
    rim.position.set(pos.x + L.rim.offset[0], L.rim.offset[1], pos.z + L.rim.offset[2]);
    if (colorHex !== undefined && colorHex !== rim.userData.hex) { rim.userData.hex = colorHex; rim.color.copy(lin(colorHex)); }
  }

  // riders: [{pos:Vector3, colorHex, on:boolean}] in slot order
  function setGlows(riders){
    for (let i = 0; i < glows.length; i++) {
      const g = glows[i], r = riders[i];
      if (!r || !r.on) { g.intensity = 0; continue; }
      if (g.userData.hex !== r.colorHex) { g.userData.hex = r.colorHex; g.color.copy(lin(r.colorHex)); }
      g.intensity = L.glow.intensity;
      g.position.set(r.pos.x, L.glow.height, r.pos.z);
    }
  }

  /* Frame-rate watchdog, two stages (session only):
     1. Dynamic resolution: when the frame rate falls under ~94% of what this screen can show, the
        render resolution steps down (10% at a time, to VC.autoQuality.minScale); with steady headroom
        it climbs back. Sharpness gives way first, so motion stays smooth at the screen's own rate.
     2. Still under minFps for `seconds` at the lowest resolution: drop one quality level. */
  function basePR(){ return Math.min(window.devicePixelRatio || 1, settings.pixelRatio); }
  function applyScale(next){
    scale = next;
    renderer.setPixelRatio(basePR() * scale);
    renderer.setSize(innerWidth, innerHeight);
    if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(innerWidth, innerHeight); }
  }
  let acc = 0, frames = 0, slow = 0, grace = VC.autoQuality.graceSeconds, upT = 0, coolT = 0;
  const recent = [];   // the last 20 s of half-second frame rates
  function watch(rawDt){
    if (document.hidden || rawDt > 0.25) { acc = frames = 0; return; }
    if (grace > 0) { grace -= rawDt; return; }
    acc += rawDt; frames++;
    if (acc < 0.5) return;
    const fps = frames / acc, AQ = VC.autoQuality; acc = frames = 0;
    recent.push(Math.min(fps, 240)); if (recent.length > 40) recent.shift();
    const refresh = Math.max(60, ...recent);   // what this screen has recently shown it can do (a 60 Hz cap on battery lowers it)
    const minScale = Math.max(AQ.minScale, 1 / Math.max(1, basePR()));   // never below ~1 device pixel per CSS pixel on Retina
    coolT -= 0.5;
    if (fps < refresh * AQ.target) {
      upT = 0;
      if (scale > minScale + 1e-3) { if (coolT <= 0) { applyScale(Math.max(minScale, scale - AQ.step)); coolT = 1; } slow = 0; return; }
    } else if (scale < 1 && (upT += 0.5) >= AQ.upSeconds) { upT = 0; coolT = 2; applyScale(Math.min(1, scale + AQ.step)); }
    slow = fps < AQ.minFps ? slow + 0.5 : 0;
    if (slow >= VC.autoQuality.seconds && level !== 'low') {
      const next = QUALITY_LEVELS[QUALITY_LEVELS.indexOf(level) - 1];
      setQuality(next);
      if (onAutoDrop) onAutoDrop(next);
    }
  }

  function render(rawDt, boost){
    watch(rawDt);
    if (bloom) bloom.strength = VC.bloom.strength + VC.bloom.boostExtra * Math.max(0, Math.min(1, boost || 0));
    composer.render(rawDt);
  }

  setQuality(quality);
  return {
    renderer, setQuality, resize, follow, setGlows, render,
    get quality(){ return level; },
    get particleScale(){ return settings.particles; }
  };
}
