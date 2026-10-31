# Phantom Run

An anti-gravity night race in the browser: every rider leaves a wall of light behind it. Race AI rivals solo, or host an online grid and share a 5-character code with friends (up to 6 riders, empty seats filled with AI if you like). Works with keyboard or touch (buttons or swipe).

Static site: no build step. Three.js r128 and the Firebase JS SDK load from CDNs.

```
index.html               markup for HUD, title, auth, lobby, leaderboard
css/style.css            theme + responsive layout
js/game.js               engine: scene, riders, sim, HUD, camera, netcode roles
js/audio.js              original synthesised score + sound effects (Web Audio)
js/vehicles/phantom-gt.js  the Phantom GT craft (createPhantomGT), used by every rider
js/vanta.js              the original Vanta Phantom model (kept for reference)
tools/vehicle-preview.html  side-by-side craft preview (GT / Vanta, colours, speed, lean)
js/visuals/config.js     VISUAL_CONFIG: every tunable number for the look
js/visuals/riders.js     per-rider Phantom, eased turns, banking, disposal
js/visuals/renderer.js   renderer, colour pipeline, reflections, lights, fog, bloom, quality levels
js/visuals/arena.js      obsidian floor, cell grid, perimeter ripples, skyline, sky beams, dust, seam pulses
js/visuals/trails.js     shader light-wall ribbons and floor glow strips
js/visuals/effects.js    thruster heat, crash shards + flash, boost streaks, spawn scan line
js/visuals/camera.js     chase / cockpit / overview camera, FOV with speed, bank tilt, shake
js/vendor/three-r128/    pinned three.js r128 add-ons (EffectComposer, bloom, RoomEnvironment)
js/ui.js                 screens, sign-in, host/join flow, leaderboard
js/sim/free.js           free-steering simulation: pure, fixed 1/60 s step, seeded, spatial-hash walls
js/sim/config.js         free-mode feel (turn rate, grip, boost, lane assist)
js/sim/link.js           per-tick input coding and the host's input queue
js/progression/          Glicko-2 rating, seasons, signature colour, clash resolution (pure modules)
js/platform.js           desktop bridge: game events -> Steam achievements / rich presence (no-op on the web)
desktop/                 Electron app for Steam (see desktop/README.md)
tests/                   node tests/<name>.test.mjs (sim, rating, colour, signature), profile, signature reveal
js/progression/          skill rating (Glicko-2), seasons, signature colour, colour clashes (pure, Node-tested)
js/net.js                Realtime Database rooms (host / join / inputs / snapshots)
js/firebase.js           Firebase auth, rider profiles, stats
js/config.js             Firebase web config
database.rules.json      Realtime Database security rules
docs/progression.md      rating, seasons, signature colours, metrics contract for the game
tests/                   node tests/rating.test.mjs · colour.test.mjs · signature.test.mjs
```

## Rating and signature light

Signed-in riders get a Glicko-2 skill rating per season (calendar quarter). Online rivals count in full,
AI rivals at half weight, so solo races count too. After 5 rated matches in a season the rider is placed on
the Rating leaderboard and their **signature light** is revealed: a colour derived from how they ride (hue)
and how well (brightness), with a generated name. It drifts a little each season. Details and the data model:
`docs/progression.md`. Run the tests with `node tests/rating.test.mjs` (and `colour`, `signature`).

## Look and feel

The "Midnight Grand Prix" art direction: a dark, rain-polished arena where the riders are the light.
Every tunable number (palette, bloom, fog, lights, camera, wall look, particle counts, quality levels)
lives in `js/visuals/config.js` (`VISUAL_CONFIG`). Graphics quality (Low / Medium / High) is per device
and drops a level automatically if the frame rate stays under 45 fps for 3 seconds.

## Firebase console setup (one time)

1. **Authentication → Sign-in method**: enable **Email/Password** and **Google**.
2. **Authentication → Settings → Authorized domains**: add your Vercel domain(s), e.g. `<project>.vercel.app` (and any custom domain).
3. **Realtime Database → Rules**: paste the contents of `database.rules.json` and publish. Republish whenever the file changes (the Garage colour and the rating / season / signature / accent fields need the latest version).
4. **Google sign-in on your domain** (Google Cloud Console → project `retrocycles-e9965` → APIs & Services → Credentials → OAuth 2.0 Client IDs → *Web client (auto created by Google Service)*):
   - Authorized JavaScript origins: `https://<your-domain>`
   - Authorized redirect URIs: `https://<your-domain>/__/auth/handler`

   The deployed site serves Firebase's sign-in pages from its own domain (`vercel.json` proxies `/__/auth/*` to `firebaseapp.com`, and `js/config.js` sets `authDomain` to the current host). Browsers that partition third-party storage otherwise drop the Google sign-in result. Local development (`localhost`) keeps the default `firebaseapp.com` auth domain.

## Steering modes

- **Free** (default): hold left / right to steer; grip and drift depend on speed; Shift + left / right
  (or a swipe on touch) snaps a 90 degree turn. Walls are continuous polylines with circle-swept
  collision, so narrow lanes (down to ~0.8 cells) can be threaded, with a gentle lane assist.
- **Grid**: the original 90 degree cell-to-cell mode, unchanged. The host's choice goes into the room
  settings (`steer`); rooms without it race on Grid.

## How online play works

- The **host's browser runs the race** and streams a compact snapshot ~15×/second to `rooms/{CODE}/st`, plus every turn point to `rooms/{CODE}/tl`.
- **Guests** send only their inputs (turns + boost). Their own turns are predicted locally so steering feels instant; each turn carries the step it was pressed on, and the host rewinds that rider up to 6 cells so the turn lands where the guest saw it. A guest who hits a wall gets a 0.2 s grace window for a late turn to arrive.
- Free mode: guests send per-tick inputs with sequence numbers (`in/{uid}/f`), predict their own rider and
  replay unacknowledged inputs on each snapshot; other riders render ~100 ms behind, interpolated. New wall
  points stream to `rooms/{CODE}/fp`.
- Rooms delete themselves when the host disconnects (`onDisconnect`). The host should keep the tab in front while racing (browsers pause background tabs).
- Each signed-in rider records their own stats after a match. Rules only let a rider write their own profile and only let counters rise by one match at a time.

## Local run

Any static server works:

```bash
python3 -m http.server 8080
```

Sign-in needs the page served from an authorized domain (`localhost` is authorized by default).
