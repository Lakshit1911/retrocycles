# Phantom Run

An anti-gravity night race in the browser: every rider leaves a wall of light behind it. Race AI rivals solo, or host an online grid and share a 5-character code with friends (up to 6 riders, empty seats filled with AI if you like). Works with keyboard (remappable), touch (buttons or swipe) or a game controller, in the browser, as an installable web app (iPhone home screen, offline solo), as a Mac / Windows / Linux app (Electron, Steam-ready) and as an iPhone app (Capacitor).

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
desktop/                 Electron app for Steam and the Mac (see desktop/README.md)
mobile/                  iPhone app: Capacitor iOS shell around the same bundle (see mobile/README.md)
tools/web-bundle.mjs     shared bundler for the apps (vendors three.js + fonts, used by desktop/ and mobile/)
tools/icons.mjs          icons from desktop/build/icon.png: icons/ (web app), desktop/build/icon.icns, iOS icon
js/input/bindings.js     remappable keyboard bindings (localStorage pr-keys)
js/input/gamepad.js      game controllers (Gamepad API): race controls, menu navigation, rumble
js/input/controls.js     the Controls screen (remap keys, controller layout) and key hints
js/mobile.js             iPhone app bridge (haptics, keep-awake, sign-in note) + iOS touch polish
js/pwa.js · sw.js        installable web app: service worker registration + offline cache
manifest.webmanifest     web app manifest (icons in icons/)
tests/browser/apple.mjs  Playwright: PWA offline, controllers, key remapping, layouts
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

## Controls

| | Keyboard (default, remappable) | Controller | Touch |
|---|---|---|---|
| Steer (Free: hold, Grid: 90° turn) | ← → / A D | left stick / d-pad | hold ◀ ▶ |
| Snap 90° (Free) | Shift + ← → | LB / RB | swipe |
| Boost | Space / W / ↑ | A or right trigger | BOOST |
| Burst (Circuit) | E | X / Square | |
| Camera | C | View / Select | CAM |
| Menu / pause | P / Esc | Start / Options | II |
| Sound | M | | ♪ |

Keys are remapped in the race settings (**Controls**, in Solo and the Lobby): up to three keys per action,
saved on the device (`localStorage` `pr-keys`). Game code reads them through `js/input/bindings.js`
(`actionOf(event)`), never through hard-coded key codes. Controllers (Xbox, PlayStation, MFi, Switch Pro;
anything with the standard Gamepad mapping) also drive the menus: d-pad / stick moves the focus, A selects,
B goes back. A crash rumbles the pad. `js/input/gamepad.js` is polled once per frame from `game.js`
(`pollGamepad(keys, padGame)`) and writes the same `keys` fields as the keyboard (`l`, `r`, `boost`,
`burst`, `snapQ` through `queueTurn`).

## Apps

- **Installable web app (iPhone today, no App Store):** open the site in Safari > Share > Add to Home
  Screen. `manifest.webmanifest` + `icons/` give it a full-screen app icon; `sw.js` caches the game so solo
  races work offline (network first for the game's own files, so deploys show up at once; Firebase and the
  `/__/auth` pages are never cached). The worker registers only on a real domain, or on localhost with
  `?sw=1`. `vercel.json` serves `sw.js` with `Cache-Control: no-cache` and `Service-Worker-Allowed: /`.
- **Mac app:** `cd desktop && npm ci && npm run build-app && npm run dist:mac` on a Mac gives a universal
  dmg + zip. Step by step, Gatekeeper and signing: [desktop/README.md](desktop/README.md#build-the-mac-app-step-by-step).
- **iPhone app:** `cd mobile && npm ci && npm run ios:add && npm run ios:open`, then Run in Xcode.
  Details and the Google sign-in limitation: [mobile/README.md](mobile/README.md).

Regenerate every icon after changing `desktop/build/icon.png`: `node tools/icons.mjs`.

## Local run

Any static server works:

```bash
python3 -m http.server 8080
```

Sign-in needs the page served from an authorized domain (`localhost` is authorized by default).

Tests: `node tests/<name>.test.mjs` (sim, rating, colour, signature, apple), `cd desktop && npm test`,
`cd mobile && npm test`, and the browser checks `node tests/browser/apple.mjs [pwa|gamepad|keys|shots] [--out dir]`
(Playwright, software WebGL: a few minutes).
