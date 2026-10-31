/* The main stadium: an original night circuit. Data only (format: js/sim/track.js).
   Race direction runs east along the main straight, through the fast sweeper on the east end, back
   west down the back straight and its S-section, round the tight hairpin, east through the infield,
   south through the narrow chicane and round the west loop onto the main straight again. */
export default {
  id:'stadium',
  name:'Main Stadium',
  width:13,
  ds:1,
  ctrl:[
    [-60, 70],             // 0  start / finish, main straight heading east
    [16, 70],
    [84, 70],              // 2  end of the main straight
    [120, 57],             // 3  fast sweeper (east end)
    [138, 24],
    [134, -20],
    [114, -52],            // 6  sweeper exit
    [80, -69],             // 7  back straight heading west
    [44, -72],
    [18, -64, 12],         // 9  S-section
    [-6, -78, 12],
    [-30, -64, 12],
    [-54, -73],            // 12
    [-82, -76, 11],        // 13 tight hairpin
    [-98, -68, 11],
    [-98, -53, 11],
    [-82, -46, 11],        // 16 hairpin exit, infield heading east
    [-54, -42],
    [-30, -34],
    [-17, -16, 10],        // 19 turning south
    [-17, -3, 8],          // 20 narrow chicane: kink left, then right
    [-7, 6, 7],
    [-8, 16, 7],
    [-20, 25, 8],
    [-42, 35],             // 24 heading west
    [-76, 36],
    [-108, 39.5],          // 26 west loop
    [-119.5, 44],
    [-124, 55.5],
    [-119.5, 67],
    [-106, 71],
    [-86, 70.5]
  ],
  gates:[3, 6, 9, 13, 16, 20, 24, 27],
  pickups:[
    {u:.07, o:-.45, kind:'boost'},  {u:.07, o:.45, kind:'recharge'},
    {u:.23, o:.1, kind:'shield'},
    {u:.36, o:-.5, kind:'boost'},   {u:.36, o:.5, kind:'phase'},
    {u:.52, o:0, kind:'recharge'},
    {u:.66, o:-.4, kind:'boost'},   {u:.66, o:.4, kind:'shield'},
    {u:.84, o:0, kind:'phase'},
    {u:.94, o:-.3, kind:'recharge'}
  ],
  grid:{gap:5, back:6, row:.24}
};
