/* Rider visuals: each rider's craft (Phantom GT or Xenoth, VC.crafts), plus the purely visual pose on
   top of the simulation: eased yaw through each 90 degree turn, a sprung bank into it, pitch with
   speed changes, hover animation.
   Nothing here feeds back into positions, cells or collisions. */
import { createPhantomGT } from '../vehicles/phantom-gt.js';
import { createXenoth } from '../vehicles/xenoth.js';
import { VISUAL_CONFIG as VC } from './config.js';
import { linHex } from './renderer.js';
const THREE = window.THREE;

// Model forward is -Z, so a heading (dx, dz) maps to rotation.y = atan2(-dx, -dz)
export const headingYaw = (dx, dz) => Math.atan2(-dx, -dz);
const wrap = a => ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const easeInOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/* The model is authored with sRGB hex colours. Convert its fixed paints (body, chrome, glass...)
   to linear once; accent-driven parts already get the linear rider colour we pass in. */
function linearizeFixedColours(root, accentHex){
  // Colours the models derive from the accent (already linear): the accent itself, the GT's calipers,
  // Xenoth's membranes and its hot white-blend
  const acc = new THREE.Color(accentHex), white = new THREE.Color(0xffffff), seen = new Set();
  const derived = [acc, acc.clone().multiplyScalar(0.6), acc.clone().multiplyScalar(0.25), acc.clone().lerp(white, 0.5)];
  const isDerived = c => derived.some(d => Math.abs(d.r - c.r) + Math.abs(d.g - c.g) + Math.abs(d.b - c.b) < 1e-4);
  root.traverse(o => {
    const m = o.material;
    if (!m || seen.has(m) || m.isShaderMaterial) return;
    seen.add(m);
    if (m.color && !isDerived(m.color)) m.color.convertSRGBToLinear();
    if (m.emissive && !isDerived(m.emissive)) m.emissive.convertSRGBToLinear();
  });
}

const MAKERS = {gt:createPhantomGT, xenoth:createXenoth};
export const craftOf = key => VC.crafts.find(c => c.key === key) || VC.crafts[0];

export function createRiderVisual(color, craft){
  const accent = linHex(color), C = craftOf(craft);
  const root = MAKERS[C.key](THREE, {hover:true, color:accent, scale:C.scale});
  linearizeFixedColours(root, accent);
  const ud = root.userData;
  root.rotation.order = 'YXZ';   // yaw, then pitch about the craft's own side axis
  // Distance from the craft origin back to where its light wall begins, in cells
  const tail = ud.trailOrigin.position.z * C.scale;
  return {group:root, ud, tail, craft:C.key};
}

export function disposeRiderVisual(v){
  if (!v) return;
  const seen = new Set();
  v.group.traverse(o => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    mats.forEach(m => {
      if (seen.has(m)) return; seen.add(m);
      if (m.map && !seen.has(m.map)) { seen.add(m.map); m.map.dispose(); }
      m.dispose();
    });
  });
}

// Snap the pose to the current heading (round start, respawn)
export function resetPose(b, yaw){
  b.vyaw = b.yawFrom = b.yawTo = yaw; b.turnT = 1; b.bankT = 9; b.bankSign = 0;
  b.vhead = yaw; b.yawOff = 0; b.yawRate = 0;   // free steering (updatePoseFree)
  b.lean = b.leanV = 0; b.pitch = b.pitchV = 0; b.lastSpeed = -1;
  b.mesh.ud.setLean(0); b.mesh.group.rotation.x = 0;
}

/* Sprung body motion, shared by both modes: the bank chases its target on a slightly
   under-damped spring (a touch of overshoot as the craft settles out of a turn), and the nose
   lifts under acceleration and dips when slowing. */
function bodyMotion(b, dt, targetLean, speed, boost){
  const M = VC.motion;
  if (dt > 0) {
    const h = Math.min(dt, 1 / 30);
    b.leanV = (b.leanV || 0) + ((targetLean - (b.lean || 0)) * M.leanStiff - (b.leanV || 0) * M.leanDamp) * h;
    b.lean = (b.lean || 0) + b.leanV * h;
    const acc = b.lastSpeed >= 0 ? (speed - b.lastSpeed) / dt : 0;
    b.lastSpeed = speed;
    const target = Math.max(-M.pitchMax, Math.min(M.pitchMax, acc * M.pitchPerAccel));
    b.pitchV = (b.pitchV || 0) + ((target - (b.pitch || 0)) * M.pitchStiff - (b.pitchV || 0) * M.pitchDamp) * h;
    b.pitch = (b.pitch || 0) + b.pitchV * h;
  }
  const g = b.mesh.group;
  g.rotation.x = b.pitch || 0;
  b.mesh.ud.setLean(b.lean);
  b.mesh.ud.update(dt, speed, boost);
}

/* Per frame. anchor: where the craft origin sits (a point on the rider's path, so it carves
   round corners instead of jumping). heading: simulated yaw. speed: model metres per second. */
export function updatePose(b, dt, anchor, heading, speed){
  // b.mul above 1 (boost) drives Xenoth's afterburner
  const T = VC.turn;
  if (Math.abs(wrap(heading - b.yawTo)) > 1e-3) {
    const delta = wrap(heading - b.vyaw);
    b.yawFrom = b.vyaw; b.yawTo = b.vyaw + delta; b.turnT = 0;
    b.bankT = 0; b.bankSign = Math.sign(delta);   // turning right gives a negative delta: lean right
  }
  b.turnT = Math.min(1, b.turnT + dt / T.yawTime);
  b.vyaw = b.yawFrom + (b.yawTo - b.yawFrom) * easeInOut(b.turnT);
  b.bankT += dt;
  const bank = b.bankT < T.bankRise ? Math.sin(b.bankT / T.bankRise * Math.PI / 2) : Math.exp(-(b.bankT - T.bankRise) / T.bankSettle);
  const g = b.mesh.group;
  g.position.copy(anchor);
  g.rotation.y = b.vyaw;
  bodyMotion(b, dt, b.bankSign * T.bankPeak * bank, speed, Math.max(0, Math.min(1, ((b.mul || 1) - 1) / .7)));
}

/* Free steering: the heading is already continuous, so the craft follows it directly and banks
   with its yaw rate. A snap turn (a jump of more than VC.free.snapAngle) is eased and banked like a
   grid turn. heading: simulated yaw (headingYaw convention). */
export function updatePoseFree(b, dt, anchor, heading, speed){
  const T = VC.turn, F = VC.free;
  let d = wrap(heading - b.vhead);
  if (Math.abs(d) > F.snapAngle) {
    b.yawOff = wrap(b.vyaw - heading); b.turnT = 0;
    b.bankT = 0; b.bankSign = Math.sign(d); d = 0;
  }
  b.vhead = heading;
  if (dt > 0) b.yawRate += (d / dt - b.yawRate) * Math.min(1, dt * F.bankResp);
  b.turnT = Math.min(1, b.turnT + dt / T.yawTime);
  b.vyaw = heading + b.yawOff * (1 - easeInOut(b.turnT));
  b.bankT += dt;
  const bank = b.bankT < T.bankRise ? Math.sin(b.bankT / T.bankRise * Math.PI / 2) : Math.exp(-(b.bankT - T.bankRise) / T.bankSettle);
  const carve = Math.max(-F.bankMax, Math.min(F.bankMax, b.yawRate * F.bankPerYaw));
  const lean = Math.max(-F.bankMax, Math.min(F.bankMax, carve + b.bankSign * T.bankPeak * bank));
  const g = b.mesh.group;
  g.position.copy(anchor);
  g.rotation.y = b.vyaw;
  bodyMotion(b, dt, lean, speed, Math.max(0, Math.min(1, ((b.mul || 1) - 1) / .7)));
}
