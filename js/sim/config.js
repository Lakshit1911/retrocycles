/* Free-steering physics tunables (arena and circuit). World units = grid cells (the arena is 128 x 128, centred
   on the origin). Pure data: shared by js/sim/free.js in the browser and on a future server. */
export const SIM_CONFIG = {
  size:128,              // arena edge length; the perimeter wall sits at +-size/2
  base:15,               // cruise speed, cells per second (same as grid mode)
  radius:.25,            // rider collision circle
  ownIgnore:1.5,         // your own newest trail (measured back from the head) never hits you
  ptAngle:2 * Math.PI / 180, ptDist:.75,   // new wall point when heading turns 2 degrees or after .75 units
  bucket:4,              // spatial hash bucket size (units)
  // Steering: yaw rate (rad/s) eases from yawLo at speed vLo down to yawHi at speed vHi
  yawLo:3.6, yawHi:2.2, vLo:12, vHi:26,
  steerResp:9,           // how fast the steering input ramps in (1/s): progressive arcs rather than on/off
  steerRelease:16,       // and how fast it lets go or reverses: lines straighten crisply
  grip:20, gripFall:1.5, // sideways slide bleeds off at grip/s, divided by mul^gripFall: boost drifts a little
  snapGap:.9,            // snap turns: at most one per .9 units travelled (grid: one per cell)
  // Boost and slipstream, equivalent to grid mode
  boost:1.7, slipBonus:.3, drain:.42, recharge:.3, ease:4, energy:.35,
  slip:2, grindHold:.22, // a wall within 2 units to either side keeps the slipstream on for .22 s
  // Lane assist: aimed through a narrow gap, the heading is nudged toward its centre (0 = off)
  assist:.5, assistAhead:1.6, assistWidth:1.2, assistRate:6,
  deathWindow:1.4,       // seconds a crashed rider's wall stays before it clears
  // AI preset (game.js passes its DIFF entry); this one is "rider"
  ai:{react:[3, 6], bfs:180, noise:.15, turn:.02, hunt:.35, boost:.5},
  /* Circuit mode (a world created with a track, js/sim/tracks/*.js): laps, checkpoint respawns,
     Light Burst walls, pickups, barrier scrapes. Seconds unless noted. */
  circuit:{
    laps:3,                // default race length
    base:18,               // cruise speed on a circuit (cells per second; arena: base above)
    respawn:1.0,           // a crashed rider reappears at its last checkpoint after this long
    ghost:1.5,             // then ghosts: can't hit walls or lay them
    // Light Burst: hold to lay a wall; it drains the meter (0..1), recharges when not laying
    burstLife:4, burstFade:.6,   // each wall segment stays solid this long; the last burstFade of it fades (visual)
    burstDrain:.5, burstRecharge:.06, burstMin:.15, burstMinT:.25, burstStart:.5,
    // Pickups: contact radius (cells) and respawn delay
    pickR:1.5, pickRespawn:8,
    cell:.5,               // Boost Cell: boost energy added
    phase:1.5,             // Phase: pass through light walls for this long
    shieldSave:.8,         // Shield: absorbs one crash, then this long of ghosting to clear the wall
    brake:.55, brakeResp:3,      // brake: speed multiplier it eases toward, and how fast
    draft:7,               // slipstream: tucked in up to this many cells behind a rider (light walls count too, barriers don't)
    regen:.03,             // boost charge trickling back per second when not boosting
    // Barriers are solid but not deadly: contact slides you along them, costing speed with the impact angle
    scrapeLoss:.4, scrapeMin:.45, bounce:.1,
    grace:20,              // seconds the race runs on after the first rider finishes
    // AI racers: look-ahead (cells + seconds of speed), braking reach (cells/s of speed per cell),
    // lateral wobble (cells, scaled by the preset's noise), reset if no progress for `stuck` seconds
    ai:{look:5, lookT:.3, decel:1, wobble:3, stuck:5}
  }
};
