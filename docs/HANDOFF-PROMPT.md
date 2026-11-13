You are continuing development of **LIGHTLOCK** (by **Lumul Studios**), tagline **"Chess at 240 km/h. Meet you on the Grid."**
It is a browser + desktop (Electron, Steam-bound) + iPhone (Capacitor) light-wall racing game. Previous working name was "Phantom Run";
the GitHub repo is still named `retrocycles`.

Repository: https://github.com/Lakshit1911/retrocycles  (branches `main` and `integration` are identical, both at commit c40aca5)
Live web build: https://phantomrun.vercel.app  (Vercel auto-deploys `main`; the domain will be renamed later)

## 0. First steps
1. `git clone https://github.com/Lakshit1911/retrocycles.git && cd retrocycles` (work on `main`, or create a branch; push to `main` = deploy to the website).
2. Read `README.md`, `desktop/README.md`, `docs/progression.md`, and skim `js/game.js` (engine), `js/ui.js` (menus), `js/net.js` (multiplayer).
3. Install and verify (Node 22):
   - Root unit tests (no install needed): `node tests/sim.test.mjs`, `circuit`, `rating`, `colour`, `signature`, `apple` (each prints "N passed, 0 failed").
   - Desktop: `cd desktop && npm ci && npm test` (42 tests) then `npm start` (or `npm run start:nosteam`).
   - Mobile: `cd mobile && npm ci && node --test tests/*.test.mjs` (6 tests).
4. On Windows, build the installer locally with `cd desktop && npm run dist:win` (NSIS installer + portable exe + win-unpacked). On Linux the
   installer/portable targets need Wine; only `electron-builder --win dir` works there.

## 1. Where we left off (the immediate task)
- Goal: **a solid Windows base version** so the owner can play, bug-fix and iterate before the Steam launch.
- Done: full rename to Lightlock (title wordmark `LIGHT<span>LOCK</span>`, tagline, "A Lumul Studios game", page title, manifest, share text,
  desktop productName/executable `Lightlock.exe`, installer shortcut, app ids `com.lumulstudios.lightlock` for desktop and iPhone,
  service-worker cache prefix `lightlock-` with old `phantom-run-` caches cleaned). Internal identifiers that hold player data were
  deliberately NOT renamed (localStorage keys like `rc3d-settings`, `pr-quality`, `pr-volume`; `window.phantomDesktop` bridge; `PHANTOM_*`
  env vars; Firebase project `retrocycles-e9965`). Craft names Phantom GT and Xenoth stay.
- Speedometer retuned: `KMH = 240 / (BASE * 1.7)` in `js/game.js`, so full boost in the arena reads 240 km/h (cruise ~141).
- `tools/web-bundle.mjs` (shared bundler for desktop/iPhone) now strips the website's remote speed hints (preconnects, remote
  modulepreloads, no-JS fonts fallback) via `stripRemoteHints()` so the bundled apps stay fully local.
- GitHub Actions `.github/workflows/windows.yml` runs on `windows-latest` on every push to main/integration (and manually): npm ci, unit
  tests (failures are printed as `::error::` annotations), electron-builder `--win --x64` (installer + portable + unpacked), a packaged
  smoke test (`Lightlock.exe --smoke-test --no-steam --use-angle=swiftshader --enable-unsafe-swiftshader`, must print
  `SMOKE_RESULT {... "ok":true}`), zips the unpacked app, uploads artifact **Lightlock-windows** (setup exe, portable exe, zip).
- Last CI run before the final commit: build + Windows smoke test PASSED; only `desktop/tests/server.test.mjs` "cannot escape the root"
  failed because it hard-coded POSIX paths. Commit c40aca5 fixed that test (uses `path.resolve`/`path.join`, adds a backslash case).
  **First thing: check that the latest "Windows build" run on `main` is green** (Actions tab, or
  `curl -s "https://api.github.com/repos/Lakshit1911/retrocycles/actions/runs?branch=main&per_page=1"`), then download the
  Lightlock-windows artifact and play it.
- A local zip of the unpacked Windows app (v0.1.0) was also handed to the owner for testing.

## 2. Next Windows tasks (do these in order, test each on the real Windows machine)
1. Play-test the packaged build: launch, fullscreen (F11 / Alt+Enter), window restore, high-DPI scaling, alt-tab, controllers (Xbox /
   PlayStation via Gamepad API), keyboard remapping (Controls screen), audio, solo Grid/Free/Circuit, online host/join with a friend.
   Fix anything Windows-specific (`desktop/main.js`, `desktop/src/*.js`).
2. App icon: `desktop/build/icon.png` (1024 px) is used for Windows; consider generating a proper `.ico`; verify the exe/installer icon.
3. Steam integration on the test app id 480 (Spacewar, `desktop/steam_appid.txt`): overlay (Shift+Tab), achievements
   (`desktop/achievements.json` <-> `js/platform.js`), rich presence (`desktop/rich_presence.vdf`), then Steam lobbies/invites ("Join game"
   from the friends list) and Steam Datagram Relay networking via steamworks.js. Swap in the real App ID once Steamworks is set up.
4. Code signing is not set up (SmartScreen will warn on the unsigned exe) - fine for testing.
5. Keep `npm test` green on Windows (CI enforces it).

## 3. Game state (what already exists)
- Modes: **Grid** (classic 90-degree turns; the signature mode; host/solo turns happen instantly if pressed in the first half of a cell),
  **Free Steer** (deterministic 60 Hz sim in `js/sim/free.js`), **Circuit** (laps on a stadium track, Light Burst walls, pickups, brake).
- Grid arena pickups (setting "Pickups", on by default): speed surge (+65% / 1.6 s), phase (2.2 s through light walls), wall breaker
  (clears walls within 4 cells; later walls through the hole are solid). Host-authoritative; synced in snapshots (`pk`, `cu`, `pe`).
- Kill feed + TAKEDOWN/DOUBLE/TRIPLE/RAMPAGE callouts, match MVP; emotes (keys 1-4 / HUD buttons: GG, devil, scream, fire);
  pause menu **CHANGE RULES** (host or solo) restarts a fresh match with new settings for everyone.
- Crafts: Phantom GT and Xenoth (`js/vehicles/*.js`), picked in the Garage; AI bots alternate crafts. Bots: rookie/rider/legend (`DIFF`).
- Visuals: Midnight Grand Prix look, closed stadium dome (`VC.arena.scenery = 'stadium'`), light walls with floor glow, dynamic
  resolution + auto quality (`js/visuals/renderer.js`), smoothed frame pacing.
- Multiplayer (`js/net.js`): Firebase Realtime Database rooms (5-char codes) for lobby/handshake and fallback, plus a **direct WebRTC
  peer-to-peer link** host<->guest ('ev' reliable + 'st' unordered channels, dedupe by ids/sequence numbers, pings shown in HUD
  "Direct link · NN ms"). Grid guests: 20 Hz snapshots, eased corrections, remote riders drawn 40-100 ms behind; free guests interpolate.
- Progression: Glicko-2 rating, seasons, signature colours, accent; per-match log in `logs/{uid}` (fps, slow frames, quality, device,
  deaths by cause, snapshot gaps, rtt). Firebase rules are in `database.rules.json` (owner publishes them manually in the console).
- Auto-update: idle menus reload into a newer deployed build.

## 4. Product decisions already locked (do not change without asking)
- Name **LIGHTLOCK**, studio **Lumul Studios**, tagline "Chess at 240 km/h. Meet you on the Grid." (never use "Tron" or plain "GRID" as a name).
- Steam: publish as a **Canadian individual** (owner is a Canadian tax resident), price **US $7.99**, 15-20% launch discount, free demo,
  Valve's regional pricing; pitch to streamers as "chess at 240 km/h". Ranked = Grid with pickups off; Party = pickups/mutators on.
- Design pillars: readable in one glance (stream test), every round is a story (20-60 s), skill over luck.
- Planned features: round-winner replay + end-of-match highlight reel (grid replays are reconstructable from turn points), Streamer Mode
  (hidden code, viewer queue, chat-voted mutators, auto clips), tutorial, Team Grid, Daily Grid, more crafts (names reserved:
  Kestrel R, Bastion Mk II, Solenne, Ostrix, Nocturne, Halcyon Zero), dedicated game server later (Oracle Cloud Always Free, Mumbai)
  and Steam Datagram Relay for Steam players, TURN relay for strict NATs.

## 5. Working rules from the owner
- The owner is a chemical engineer (data analytics / project management): give the best rational solution, add a little warmth and a pun,
  and ask clarifying questions when a choice is genuinely theirs.
- Test before pushing to `main` (it deploys the live site). Run the root tests, desktop and mobile tests; for gameplay changes run the game.
- Commit messages end with the session's attribution lines if your environment provides them. Never commit secrets.
