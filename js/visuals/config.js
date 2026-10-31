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
  turn: {
    yawTime:0.15,        // seconds to ease through a 90 degree turn
    bankPeak:0.45,       // radians, into the turn
    bankRise:0.09,       // seconds to reach the peak
    bankSettle:0.2       // seconds (time constant) to settle back
  },
  wall: {
    height:0.5           // 0.9 m at vehicle scale
  },
  trail: {
    maxPoints:1024,      // fixed buffer size per rider (turn points per round)
    bodyBottom:0.08, bodyTop:0.3,        // dim translucent body, brighter toward the top
    band:0.14, bandIntensity:2.4,        // bright top band (fraction of height) and its strength
    whiteCore:0.6,                       // white in the band's core
    tipBoost:1.4, tipLength:1.6,         // extra brightness right behind the craft (cells)
    glowIntensity:0.22, glowWidth:1.6,   // soft glow strip on the floor
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
    sky:{horizon:'#141a33', silhouette:'#07080d', strip:'#7f98c9', stripWarm:'#c99a6a', stripOpacity:0.5,
      stripChance:0.3, stripThickness:0.14, towerHeight:[16, 80], archRadius:[38, 70],
      beacon:'#ff4a55', towers:70, arches:4, pylons:10, radius:[220, 480],
      beams:[[0.8, 260, 0], [3.6, 300, 2.1]], beam:'#9fb7ff', beamIntensity:0.09, beamSpeed:0.12},
    dust:{count:420, box:28, height:7, size:0.09, opacity:0.35, color:'#8ea3c9', drift:0.35},
    pulses:{count:4, length:7, width:0.12, speed:9, opacity:0.55, color:'#5b7fb8', gap:9}
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
    high:  {pixelRatio:2,   shadows:2048, bloomScale:1,   msaa:4, particles:1},
    medium:{pixelRatio:1.5, shadows:1024, bloomScale:0.6, msaa:2, particles:0.6},
    low:   {pixelRatio:1,   shadows:0,    bloomScale:0,   msaa:0, particles:0.35}
  },
  autoQuality: {minFps:45, seconds:3, graceSeconds:4},
  camera: {
    // chase: cells behind / above the craft, how far ahead it looks, follow stiffness, roll with bank
    chase:{back:4.4, height:1.45, ahead:6.5, lookHeight:0.6, follow:6, bankTilt:0.28},
    cockpit:{height:1.0, ahead:25},
    overview:{height:46, back:22},
    orbit:{radius:66, height:30, speed:0.06},   // attract-mode flyover behind the menus
    intro:{back:30, height:34},                 // where the camera swoops in from at round start
    fov:{cruise:42, boost:58, menu:55, overview:55},
    shake:{boost:0.05, crash:0.9, decay:2.2}
  },
  // The turntable Phantom on the title and garage screens (camera space)
  showroom:{scale:1.3, distance:5.6, drop:0.08, garageDrop:-0.1, minAspect:1.0, spin:0.35, light:[1.8, 2.2, -1], lightIntensity:3.2},
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
