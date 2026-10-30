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
    scale:0.55,          // 4.4 m model -> ~2.4 cells long, ~0.45 cells wide
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
  render: {
    exposure:1.0,          // ACES Filmic tone mapping exposure
    envBlur:0.04,          // RoomEnvironment PMREM sigma
    envRoomShade:0.025,    // darken RoomEnvironment's walls so reflections are night-showroom: black with light strips
    envLightScale:0.7,     // its light panels
    floorColor:'#06070a', floorMetalness:0.55, floorRoughness:0.5, floorEnv:0.3
  },
  // Exponential fog in world units (1 unit = 1 cell = ~1.8 m at vehicle scale), so the far
  // half of the 128-cell arena melts into darkness while the near field stays crisp
  fog: {density:0.011},
  bloom: {strength:0.85, radius:0.55, threshold:0.78, boostExtra:0.45},
  lights: {
    hemi:{sky:'#3b4a6b', ground:'#050609', intensity:0.32},
    key:{color:'#d6e2ff', intensity:0.8, offset:[-14, 26, 12], extent:12, near:1, far:80, bias:-0.0006},
    rim:{intensity:0.75, offset:[11, 5, -15]},
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
    // chase: cells behind / above the craft, and how far ahead it looks
    chase:{back:5.6, height:2.3, ahead:8, lookHeight:0.5, follow:7},
    cockpit:{height:1.0, ahead:25},
    overhead:{height:72, back:30},
    orbit:{radius:66, height:30}   // attract-mode flyover behind the menus
  }
};
