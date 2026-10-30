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
  camera: {
    // chase: cells behind / above the craft, and how far ahead it looks
    chase:{back:5.6, height:2.3, ahead:8, lookHeight:0.5, follow:7},
    cockpit:{height:1.0, ahead:25},
    overhead:{height:72, back:30}
  }
};
