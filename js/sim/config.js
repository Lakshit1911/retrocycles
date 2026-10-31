/* Free-steering physics tunables. World units = grid cells (the arena is 128 x 128, centred
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
  steerResp:12,          // how fast the steering input ramps (1/s)
  grip:20, gripFall:1.5, // sideways slide bleeds off at grip/s, divided by mul^gripFall: boost drifts a little
  snapGap:.9,            // snap turns: at most one per .9 units travelled (grid: one per cell)
  // Boost and slipstream, equivalent to grid mode
  boost:1.7, slipBonus:.3, drain:.42, recharge:.3, ease:4, energy:.35,
  slip:2, grindHold:.22, // a wall within 2 units to either side keeps the slipstream on for .22 s
  // Lane assist: aimed through a narrow gap, the heading is nudged toward its centre (0 = off)
  assist:.5, assistAhead:1.6, assistWidth:1.2, assistRate:6,
  deathWindow:1.4,       // seconds a crashed rider's wall stays before it clears
  // AI preset (game.js passes its DIFF entry); this one is "rider"
  ai:{react:[3, 6], bfs:180, noise:.15, turn:.02, hunt:.35, boost:.5}
};
