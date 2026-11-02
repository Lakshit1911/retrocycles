/* Every tunable number for the look of the game lives here.
   Grid: 1 world unit = 1 cell. The Phantom model is authored in metres, so
   vehicle.scale converts model metres to cells. */
export const VISUAL_CONFIG = {
  palette: {
    background:'#040508', panel:'#0b0d12', line:'#1d222c', text:'#e4e8ef', textDim:'#7f8796'
  },
  // Rider light colours, in slot order
  riders: [
    {key:'crimson',  hex:0xff2a3d, css:'#ff2a3d'},
    {key:'ion',      hex:0x21d4ff, css:'#21d4ff'},
    {key:'solar',    hex:0xffa21f, css:'#ffa21f'},
    {key:'venom',    hex:0x8cff2e, css:'#8cff2e'},
    {key:'violet',   hex:0xb44dff, css:'#b44dff'},
    {key:'platinum', hex:0xe8eef8, css:'#e8eef8'}
  ],
  vehicle: {
    scale:0.6,           // 4.4 m model -> ~2.6 cells long, ~0.5 cells wide
    originBehindHead:0.75 // cells the craft's origin trails the simulated head, so the nose sits at the head
  },
  // The crafts a rider can pick in the Garage. scale: model metres -> cells (Xenoth is 4.8 m, so it
  // gets a little less to sit on the same footprint as the 4.4 m Phantom GT)
  crafts: [
    {key:'gt',     name:'Phantom GT', scale:0.6,  blurb:'Sculpted hover racer. Three thrusters, venturi sponsons, a long tail.'},
    {key:'xenoth', name:'Xenoth',     scale:0.55, blurb:'Biomechanical jet-hover. Living veins, spinning intakes, an afterburner that roars with boost.'}
  ],
  turn: {
    yawTime:0.15,        // seconds to ease through a 90 degree turn
    bankPeak:0.45,       // radians, into the turn
    bankRise:0.09,       // seconds to reach the peak
    bankSettle:0.2       // seconds (time constant) to settle back
  },
  // Free steering feel: snap turns larger than snapAngle (rad) ease like grid turns; otherwise the
  // craft banks with its yaw rate (bankPerYaw radians of lean per rad/s, capped at bankMax)
  free: {snapAngle:0.6, bankPerYaw:0.13, bankMax:0.5, bankResp:8},
  // Body motion on springs (visual only): bank stiffness / damping (a little under critical, so a
  // small overshoot as it settles), and nose pitch per unit of acceleration (model m/s^2), capped
  motion: {leanStiff:140, leanDamp:19, pitchPerAccel:0.0016, pitchMax:0.07, pitchStiff:60, pitchDamp:13},
  wall: {
    height:0.8           // ~1.4 m at vehicle scale: reads clearly above the craft's nose from the chase camera
  },
  trail: {
    maxPoints:2048,      // fixed buffer size per rider (turn points per round; free mode thins older points)
    bodyBottom:0.22, bodyTop:0.55,       // translucent body, brighter toward the top (solid enough to read at a glance)
    band:0.16, bandIntensity:2.8,        // bright top band (fraction of height) and its strength
    baseLine:0.06, baseIntensity:1.2,    // a bright line where the wall meets the floor
    whiteCore:0.6,                       // white in the band's core
    tipBoost:1.4, tipLength:1.6,         // extra brightness right behind the craft (cells)
    fogKeep:0.6,                         // walls only take this share of the fog, so far walls still read
    glowIntensity:0.32, glowWidth:1.7,   // soft glow strip on the floor
    glowNear:[4, 14],                    // the floor glow fades in over this camera distance (cells): your own trail doesn't flood the screen
    collapse:0.6                         // seconds for a crashed wall to fold down and fade
  },
  render: {
    exposure:1.0,          // ACES Filmic tone mapping exposure
    envBlur:0.04,          // RoomEnvironment PMREM sigma
    envRoomShade:0.025,    // darken RoomEnvironment's walls so reflections are night-showroom: black with light strips
    envLightScale:0.7      // its light panels
  },
  arena: {
    // Obsidian floor; panel = cells per floor panel (seams and the brighter grid line)
    floor:{color:'#06070a', seam:'#11141b', panel:8, metalness:0.55, roughness:0.42, env:0.14},
    grid:{line:'#1d222c', major:'#2b3242', opacity:0.7},
    // Perimeter: matte dark metal, one thin emissive top line, light ripples when riders come near
    wall:{height:3.5, thickness:0.6, color:'#0b0d12', edge:'#c9d3e6', edgeIntensity:1.4,
      rippleReach:7, rippleWidth:30, rippleIntensity:0.55},
    // 'stadium' (closed bowl, cheap: a few meshes) or 'city' (the open skyline with beams)
    scenery:'stadium',
    // Stadium bowl (world units; the circuit reaches ~147 from the centre). Colours are sRGB.
    stadium:{inner:158, outer:262, front:4.2, standHeight:58, backHeight:72, crown:150,
      seat:'#0a0c12', row:'#141925', aisle:'#0d1018', concourse:'#1a2131', rows:22, aisles:48, repeat:6,
      crowd:2600, crowdCool:'#8fa6d6', crowdWarm:'#d9a46a', rim:'#9fb7ff',
      led:'#9fb7ff', ledWarm:'#ffb36b', ledHeight:1.6, ledRepeat:10, ledIntensity:1.4, ledSpeed:0.004,
      roof:'#07090f', roofRim:'#0d111b', rib:'#151b28', ribs:40, oculus:'#2a3552', oculusEdge:'#141a2a',
      flood:'#e8eef8', floods:24, floodGlow:0.05},
    sky:{horizon:'#141a33', silhouette:'#07080d', strip:'#7f98c9', stripWarm:'#c99a6a', stripOpacity:0.5,
      stripChance:0.3, stripThickness:0.14, towerHeight:[16, 80], archRadius:[38, 70],
      beacon:'#ff4a55', towers:70, arches:4, pylons:10, radius:[220, 480],
      beams:[[0.8, 260, 0], [3.6, 300, 2.1]], beam:'#9fb7ff', beamIntensity:0.09, beamSpeed:0.12},
    dust:{count:420, box:28, height:7, size:0.09, opacity:0.35, color:'#8ea3c9', drift:0.35},
    pulses:{count:4, length:7, width:0.12, speed:9, opacity:0.55, color:'#5b7fb8', gap:9}
  },
  // Circuit mode (js/visuals/track.js): road, barriers, gates, start gantry, pickups
  track: {
    road:{color:'#0a0c12', metalness:0.55, roughness:0.36, env:0.16, y:0.006},
    lane:{color:'#3a4356', opacity:0.5, width:0.1, dash:2.4, period:6},     // faint dashed centre line
    edge:{color:'#9fb7ff', intensity:0.85, width:0.12, inset:0.5},           // glow lines just inside the barriers
    // stripe: an emissive band along the inner face (from, to as fractions of the height) so barriers read against the dark road
    barrier:{height:0.9, thickness:0.35, color:'#1a2030', edge:'#c9d3e6', edgeIntensity:2.0, edgeWidth:0.12,
      stripe:[0.38, 0.5], stripeColor:'#9fb7ff', stripeIntensity:0.7},
    gate:{color:'#9fb7ff', intensity:0.45, height:4.6, tube:0.04, flash:1.6, flashTime:0.6},
    gantry:{height:6.4, color:'#0b0d12', strip:'#e8eef8', stripIntensity:1.6, checker:0.32},
    pickups:{hover:0.95, bob:0.12, spin:1.6, size:0.5, halo:2.4, glow:0.55,
      colors:{boost:'#ffb547', shield:'#7fd6ff', recharge:'#f2f5ff', phase:'#c38bff'}},
    shell:{scale:[0.7, 0.42, 1.35], opacity:0.4},   // shield / phase shell around the craft
    ghostBlink:14                                    // Hz: a respawned rider blinks while ghosting
  },
  // Exponential fog in world units (1 unit = 1 cell = ~1.8 m at vehicle scale), so the far
  // half of the 128-cell arena melts into darkness while the near field stays crisp
  fog: {density:0.011},
  bloom: {strength:0.85, radius:0.55, threshold:0.78, boostExtra:0.45},
  lights: {
    hemi:{sky:'#3b4a6b', ground:'#050609', intensity:0.32},
    key:{color:'#d6e2ff', intensity:0.8, offset:[-14, 26, 12], extent:12, near:1, far:80, bias:-0.0006},
    rim:{intensity:2.2, offset:[4.5, 3.5, -5.5], distance:14, angle:0.38, penumbra:0.9, decay:1.5},
    glow:{intensity:2.4, distance:5.5, decay:2, height:0.35}   // pooled point light under each rider
  },
  quality: {
    // pixelRatio cap, shadow map size (0 = off), bloom resolution scale (0 = no bloom pass),
    // MSAA samples on the bloom render target (WebGL2 only), particle count scale
    high:  {pixelRatio:1.5, shadows:2048, bloomScale:1,   msaa:4, particles:1},
    medium:{pixelRatio:1.5, shadows:1024, bloomScale:0.6, msaa:2, particles:0.6},
    low:   {pixelRatio:1,   shadows:0,    bloomScale:0,   msaa:0, particles:0.35}
  },
  // under minFps for `seconds` drops a quality level (52: a 60 Hz screen that keeps missing frames is visibly stuttering)
  // target: fraction of the screen's refresh rate below which the render resolution steps down by `step`
  // (to minScale), climbing back after upSeconds of headroom
  autoQuality: {minFps:52, seconds:2.5, graceSeconds:4, target:0.94, step:0.1, minScale:0.6, upSeconds:6},
  // Grid arena pickups (host-authoritative; cfg.pickups). Cells; seconds. Colours sRGB.
  gridPickups:{max:3, respawn:6, edge:6, minDist:10, surgeTime:1.6, surgeMul:1.65, phaseTime:2.2, breakR:4,
    hover:0.9, size:0.42, spin:2.2, bob:0.12, halo:1.3,
    types:{surge:{color:'#ffb547', label:'SPEED SURGE'}, phase:{color:'#c38bff', label:'PHASE'}, breaker:{color:'#ff5a3c', label:'WALL BREAKER'}}},
  // Quick emotes (keys 1-4 or the HUD buttons) and the kill feed
  emotes:['GG', '😈', '😱', '🔥'],
  feed:{life:4.5, max:4, comboWindow:4},
  // Edge-of-screen arrows for riders beside or behind you (off-screen) within this many cells
  hud: {threatRange:16, threatMax:5},
  camera: {
    // chase: cells behind / above the craft, how far ahead it looks, follow stiffness, roll with bank
    // yawFollow: how fast the camera's heading catches the craft's (lower = more of the turn's outside in view)
    // turnLead: radians the view swings into a turn per rad/s of yaw rate, capped at leadMax
    chase:{back:4.9, height:1.95, ahead:9, lookHeight:0.45, follow:7, bankTilt:0.22, yawFollow:12, turnLead:0.1, leadMax:0.3},
    cockpit:{height:1.0, ahead:25},
    overview:{height:46, back:22},
    orbit:{radius:66, height:30, speed:0.06},   // attract-mode flyover behind the menus
    intro:{back:30, height:34},                 // where the camera swoops in from at round start
    fov:{cruise:62, boost:76, menu:55, overview:55},
    shake:{boost:0.05, crash:0.9, decay:2.2}
  },
  // The turntable Phantom on the title and garage screens (camera space)
  showroom:{scale:1.3, distance:5.6, drop:0.08, garageDrop:-0.1, minAspect:0.75, landscapeShift:0.42, landscapeDrop:0.16, spin:0.35, light:[1.8, 2.2, -1], lightIntensity:3.2},
  effects: {
    heat:{max:900, size:0.12, life:0.6, rate:8, ratePerSpeed:1.0, back:2.5, rise:0.6, spread:0.6, brightness:0.9},
    shards:{count:80, speed:9, up:7, spin:14, life:1.2, size:0.32, gravity:16},
    flash:{life:0.35, size:6, light:14},
    streaks:{count:48, radius:[2.2, 4.2], depth:24, speed:60, length:2.6, opacity:0.32},
    scan:{duration:1.1},                         // spawn scan line rising through each craft
    powerOn:{duration:0.4, speed:40},            // thruster flare at GO
    slowMotion:{duration:0.3, scale:0.25}        // visual-only, your own crash
  }
};
