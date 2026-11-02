/* Grid arena pickups: a spinning, bobbing gem over the cell with a soft halo ring on the floor, one
   per pickup slot (VC.gridPickups). Purely visual: game.js owns where they are and who takes them. */
import { VISUAL_CONFIG as VC } from './config.js';
import { lin } from './renderer.js';
const THREE = window.THREE;

export function createGridPickups(scene, wx){
  const P = VC.gridPickups, types = Object.keys(P.types);
  const gemGeo = new THREE.OctahedronGeometry(P.size, 0), haloGeo = new THREE.RingGeometry(P.halo * .55, P.halo, 40);
  haloGeo.rotateX(-Math.PI / 2);
  const mats = {};
  types.forEach(t => {
    const c = lin(P.types[t].color);
    mats[t] = {
      gem:new THREE.MeshBasicMaterial({color:c.clone().multiplyScalar(2.2), toneMapped:false}),
      halo:new THREE.MeshBasicMaterial({color:c.clone(), transparent:true, opacity:.55, blending:THREE.AdditiveBlending, depthWrite:false, toneMapped:false})
    };
  });
  const slots = Array.from({length:P.max}, () => {
    const g = new THREE.Group(), gem = new THREE.Mesh(gemGeo, mats[types[0]].gem), halo = new THREE.Mesh(haloGeo, mats[types[0]].halo);
    gem.scale.y = 1.5; halo.position.y = .015; g.add(gem, halo); g.visible = false; scene.add(g);
    return {g, gem, halo, type:null};
  });
  let t = 0;
  // list: [{x, z, type, on}] in slot order (cells)
  function update(dt, list){
    t += dt;
    slots.forEach((s, i) => {
      const p = list && list[i];
      if (!p || !p.on) { s.g.visible = false; return; }
      if (s.type !== p.type) { s.type = p.type; s.gem.material = mats[p.type].gem; s.halo.material = mats[p.type].halo; }
      s.g.visible = true;
      s.g.position.set(wx(p.x), 0, wx(p.z));
      s.gem.position.y = P.hover + Math.sin(t * 2.4 + i) * P.bob;
      s.gem.rotation.y = t * P.spin + i;
      const pulse = .85 + .15 * Math.sin(t * 5 + i * 2);
      s.halo.scale.setScalar(pulse); s.halo.material.opacity = .35 + .25 * pulse;
    });
  }
  function hide(){ slots.forEach(s => { s.g.visible = false; }); }
  return {update, hide};
}
