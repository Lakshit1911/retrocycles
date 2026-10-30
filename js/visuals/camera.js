/* Camera rig. Modes: chase (low, close, eased through turns, banks with the craft, FOV opens up
   with speed, micro-shake on boost), cockpit, and a high overview. Also the menu flyover and
   impact shake. Visual only. */
import { VISUAL_CONFIG as VC } from './config.js';
const THREE = window.THREE;
export const CAMS = ['Chase', 'Cockpit', 'Overview'];

export function createCameraRig(camera, reduceMotion){
  const pos = new THREE.Vector3(0, 60, 90), look = new THREE.Vector3(), tA = new THREE.Vector3(), tB = new THREE.Vector3();
  let orbitT = 0, shake = 0, roll = 0;

  // Put the camera behind the craft right away (round start)
  function intro(b){
    const fx = -Math.sin(b.vyaw), fz = -Math.cos(b.vyaw), C = VC.camera.intro;
    pos.set(b.vpos.x - fx * C.back, C.height, b.vpos.z - fz * C.back); look.copy(b.vpos);
    camera.fov = VC.camera.fov.cruise; camera.updateProjectionMatrix();
  }
  function impact(amount){ if (!reduceMotion) shake = Math.max(shake, amount); else shake = Math.max(shake, amount * .25); }

  // focus: the rider to follow (null = menu flyover). boost: 0..1. countdown: easing slower at the start.
  function update(dt, {mode, focus, boost, countdown, menu}){
    const C = VC.camera;
    if (menu || !focus) {
      orbitT += dt * C.orbit.speed;
      tA.set(Math.cos(orbitT) * C.orbit.radius, C.orbit.height, Math.sin(orbitT) * C.orbit.radius); tB.set(0, 0, 0);
      pos.lerp(tA, 1 - Math.exp(-dt * 2)); look.lerp(tB, 1 - Math.exp(-dt * 2));
      camera.position.copy(pos); camera.lookAt(look);
      if (Math.abs(camera.fov - C.fov.menu) > .05) { camera.fov += (C.fov.menu - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
      return;
    }
    const b = focus;
    const fx = -Math.sin(b.vyaw), fz = -Math.cos(b.vyaw), P = b.vpos;
    let m = mode, k;
    if (!b.alive) m = 2;
    if (m === 0) {
      tA.set(P.x - fx * C.chase.back, C.chase.height, P.z - fz * C.chase.back);
      tB.set(P.x + fx * C.chase.ahead, C.chase.lookHeight, P.z + fz * C.chase.ahead);
      k = countdown ? 2.2 : C.chase.follow;
    } else if (m === 1) {
      tA.set(P.x + fx * .35, C.cockpit.height, P.z + fz * .35);
      tB.set(P.x + fx * C.cockpit.ahead, .7, P.z + fz * C.cockpit.ahead); k = 30;
    } else { tA.set(P.x, C.overview.height, P.z + C.overview.back); tB.copy(P); k = 3; }
    pos.lerp(tA, 1 - Math.exp(-dt * k)); look.lerp(tB, 1 - Math.exp(-dt * (k * 1.4)));
    camera.position.copy(pos);
    // boost micro-shake and impact shake
    const micro = reduceMotion ? 0 : C.shake.boost * boost;
    const s = shake + micro;
    if (s > 0) {
      camera.position.x += (Math.random() - .5) * s; camera.position.y += (Math.random() - .5) * s;
      shake = Math.max(0, shake - dt * C.shake.decay);
    }
    camera.lookAt(look);
    // tilt a little with the craft's bank (chase only)
    const targetRoll = m === 0 && b.alive ? (b.lean || 0) * C.chase.bankTilt : 0;
    roll += (targetRoll - roll) * Math.min(1, dt * 8);
    camera.rotateZ(roll);
    // FOV opens up with speed
    const fov = m === 2 ? C.fov.overview : C.fov.cruise + (C.fov.boost - C.fov.cruise) * boost;
    if (Math.abs(camera.fov - fov) > .05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 5); camera.updateProjectionMatrix(); }
  }

  return {update, intro, impact, get look(){ return look; }};
}
