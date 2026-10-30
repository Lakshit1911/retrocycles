/* Rider visuals: the Vanta Phantom per rider, plus the purely visual pose on top of the
   simulation: eased yaw through each 90 degree turn, a quick bank into it, hover animation.
   Nothing here feeds back into positions, cells or collisions. */
import { createVanta } from '../vanta.js';
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
  const acc = new THREE.Color(accentHex), caliper = acc.clone().multiplyScalar(0.6), seen = new Set();
  root.traverse(o => {
    const m = o.material;
    if (!m || seen.has(m) || m.isShaderMaterial) return;
    seen.add(m);
    if (m.color && !m.color.equals(acc) && !m.color.equals(caliper)) m.color.convertSRGBToLinear();
    if (m.emissive) m.emissive.convertSRGBToLinear();
  });
}

export function createRiderVisual(color){
  const accent = linHex(color);
  const root = createVanta(THREE, {hover:true, color:accent, scale:VC.vehicle.scale});
  linearizeFixedColours(root, accent);
  const ud = root.userData;
  // Distance from the craft origin back to where its light wall begins, in cells
  const tail = ud.trailOrigin.position.z * VC.vehicle.scale;
  return {group:root, ud, tail};
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
  b.mesh.ud.setLean(0);
}

/* Per frame. anchor: where the craft origin sits (a point on the rider's path, so it carves
   round corners instead of jumping). heading: simulated yaw. speed: model metres per second. */
export function updatePose(b, dt, anchor, heading, speed){
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
  b.lean = b.bankSign * T.bankPeak * bank;
  const g = b.mesh.group;
  g.position.copy(anchor);
  g.rotation.y = b.vyaw;
  b.mesh.ud.setLean(b.lean);
  b.mesh.ud.update(dt, speed);
}
