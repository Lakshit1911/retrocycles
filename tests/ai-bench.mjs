// AI survival benchmark for the free-steering sim (not a pass/fail test).
// Run: node tests/ai-bench.mjs [json preset overrides], e.g. '{"boost":0}'
import * as F from '../js/sim/free.js';
const P = {rookie:{react:[1, 3], bfs:40, noise:.4, turn:.012, hunt:0, boost:.15}, rider:{react:[3, 6], bfs:180, noise:.15, turn:.02, hunt:.35, boost:.5}, legend:{react:[5, 9], bfs:480, noise:.04, turn:.025, hunt:.8, boost:.9}};
const over = JSON.parse(process.argv[2] || '{}');
for (const [name, base] of Object.entries(P)) {
  const preset = {...base, ...over}, life = [], why = {};
  for (let seed = 1; seed <= 20; seed++) {
    const w = F.createWorld({seed, cfg:{ai:preset}});
    F.spawnRing(w, 4).forEach(s => F.addRider(w, {...s, ai:true}));
    const deaths = [];
    while (w.tick < 60 * 120 && w.riders.filter(r => r.alive).length > 1) {
      F.step(w);
      for (const e of w.events) if (e.type === 'crash') {
        deaths.push(w.tick / 60);
        const r = w.riders[e.id], k = (r.boosting ? 'boost' : 'cruise') + (Math.abs(r.x) > 63 || Math.abs(r.z) > 63 ? '-edge' : '');
        why[k] = (why[k] || 0) + 1;
      }
      w.events.length = 0;
    }
    life.push(...deaths);
  }
  life.sort((a, b) => a - b);
  console.log(name.padEnd(7), 'deaths', life.length, 'median', life[life.length >> 1].toFixed(1) + 's', 'first', life[0].toFixed(1) + 's', 'under 5s', life.filter(x => x < 5).length, JSON.stringify(why));
}
