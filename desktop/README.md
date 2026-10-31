# Phantom Run desktop build (Electron + Steam)

The same game as the website, wrapped in Electron for Steam. Solo races work offline. Sign-in, online
grids and leaderboards use the network exactly like the web version (Firebase is still loaded from
Google's CDN). Steam achievements, rich presence and the overlay run when Steam is there. Without Steam
the game runs the same.

```
desktop/
  main.js              Electron main process: local server, window, popups, Steam, IPC
  preload.js           window.phantomDesktop bridge (contextIsolation, sandbox, no nodeIntegration)
  src/server.js        static server for app/ on http://localhost:<port>
  src/steam.js         steamworks.js wrapper (every call guarded)
  src/window-state.js  remembers size / position / fullscreen / port
  src/menu.js          macOS application menu template (About, Hide, Quit, View > Toggle Full Screen, Window)
  scripts/build-app.mjs  builds app/ (the offline bundle) with the shared bundler ../tools/web-bundle.mjs
  achievements.json    achievements to create on the Steamworks partner site
  rich_presence.vdf    rich presence tokens to upload on the partner site
  steam_appid.txt      Steam app id (480 = Valve's Spacewar test app, for development)
  steampipe/           SteamPipe upload templates
  build/               icon.png (1024 px source), icon.icns (macOS, from `npm run icons`) and macOS entitlements
  tests/               node:test unit tests + Playwright browser smoke test
  app/  dist/          generated (git-ignored)
```

## Build and run

Node 20+ (22 tested).

```bash
cd desktop
npm install            # Electron, electron-builder, steamworks.js, three@0.128.0, @fontsource fonts
npm run build-app      # copy the site into app/, vendor three.js + fonts, point index.html at them
npm start              # build-app + launch (npm run start:nosteam skips Steam)
```

`npm run build-app` must run again after any change to `index.html`, `css/` or `js/` (`npm start` does it
for you). The bundling itself lives in `../tools/web-bundle.mjs`, shared with the iPhone app (`../mobile/`). It fails loudly if `index.html` no longer has the three.js CDN tag or the Google Fonts link it
rewrites, or if anything in `index.html` still loads from the network. If the site moves to a new
three.js release, bump `three` in `package.json` to match (the script checks the revision). If it adds a
font family or weight, `npm install @fontsource/<family>`; weights are read from the Google Fonts URL.

Keys in the desktop build: **F11** or **Alt+Enter** toggles fullscreen (macOS: **Ctrl+Cmd+F** or the green
traffic light, **Cmd+Q** quits, **Cmd+H** hides). Game controllers (Xbox, PlayStation, MFi, Switch Pro) work
out of the box through the Gamepad API, and keys can be remapped in the race settings (**Controls**). In development (or with
`PHANTOM_DEBUG=1`) **F12** opens DevTools and **Ctrl+R** reloads.

## Build the Mac app (step by step)

On your Mac (Apple Silicon or Intel, macOS 12 or newer):

1. Install **Node.js 22 LTS** (nodejs.org installer, or `brew install node@22`) and Git (`xcode-select --install`
   installs Git and the command line tools; full Xcode is not needed for the desktop app).
2. Get the code and build:

   ```bash
   git clone https://github.com/Lakshit1911/retrocycles.git
   cd retrocycles/desktop
   npm ci                 # exact versions from package-lock.json (Electron, electron-builder, steamworks.js, three, fonts)
   npm run build-app      # copies the game into desktop/app/ with three.js + fonts vendored
   npm start              # try it from source first (npm run start:nosteam skips Steam)
   npm run dist:mac       # universal (Apple Silicon + Intel) app, dmg and zip
   ```

3. Results in `desktop/dist/`:
   - `Phantom Run-0.1.0-mac.dmg`: open it and drag Phantom Run into Applications
   - `Phantom Run-0.1.0-mac.zip`: the same app zipped (for itch.io / direct downloads)
   - `mac-universal/Phantom Run.app`: the unpacked app (this is what goes into a Steam macOS depot)

   `npm run dist:mac:dir` builds only the `.app` (faster, for local testing).

**The macOS app.** Native menu bar (Phantom Run > About / Hide / Quit ⌘Q, Edit, View > Toggle Full Screen ⌃⌘F,
Window), a hidden-inset title bar: the traffic lights float over the game, a 30 px strip along the top drags
the window (double-click zooms), and the HUD and menus start below that strip so it never swallows a click;
in fullscreen the strip is gone. Quality defaults to **High** on a Mac (pointer is not coarse), with the
pixel-ratio cap from `js/visuals/config.js` (1.5 on Retina screens). No frame cap: Electron follows the
display, so ProMotion MacBook Pros run at 120 Hz, and the frame-rate watchdog only reacts to a minimum
(under 45 fps for 3 s drops one quality level), never to a high frame rate. The icon is
`build/icon.icns` (all sizes 16 to 1024 px on Apple's 824 px icon grid), generated from `build/icon.png`
with `npm run icons` (no extra tools needed).

**Gatekeeper (unsigned builds).** Without an Apple Developer ID the app is unsigned. An app you built
yourself on the same Mac usually opens directly. A copy that was downloaded (AirDrop, browser, Steam) is
quarantined and macOS says it "cannot be opened" or "is damaged":
- macOS 15 Sequoia and newer: try to open it once, then System Settings > Privacy & Security > scroll to
  "Phantom Run was blocked" > **Open Anyway** (right-click > Open no longer bypasses the check).
- or remove the quarantine flag: `xattr -dr com.apple.quarantine "/Applications/Phantom Run.app"`.
- If it still will not start on Apple Silicon, build with an ad-hoc signature:
  `npm run build-app && npx electron-builder --mac --universal -c.mac.identity=-`.

**Signing and notarizing (for anyone else to open it, and for Steam).** Join the Apple Developer Program
(99 USD/year), then in Xcode > Settings > Accounts > Manage Certificates add a **Developer ID Application**
certificate (it lands in your login keychain). electron-builder finds it and signs automatically
(`CSC_NAME="Developer ID Application: Your Name (TEAMID)"` picks one). To notarize:

```bash
# app-specific password from appleid.apple.com > Sign-In and Security > App-Specific Passwords
export APPLE_ID="you@example.com" APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop" APPLE_TEAM_ID="ABCDE12345"
npm run dist:mac -- -c.mac.notarize=true      # or set "notarize": true under build.mac in package.json
spctl -a -vvv -t install "dist/mac-universal/Phantom Run.app"   # should say: accepted, source=Notarized Developer ID
xcrun stapler validate "dist/Phantom Run-0.1.0-mac.dmg"
```

The hardened runtime entitlements in `build/entitlements.mac.plist` (JIT for V8 / WebGL, Steam overlay
injection) are already set up for this.

### Packaging

```bash
npm run dist:win      # dist/win-unpacked/ + NSIS installer + portable .exe   (build on Windows, or Linux with wine)
npm run dist:mac      # dist/mac-universal/Phantom Run.app + .dmg + .zip     (build on a Mac, universal arm64 + x64)
npm run dist:linux    # dist/linux-unpacked/ + .AppImage
npm run pack          # unpacked folder for the current OS only
```

Steam does not use installers: SteamPipe uploads the **unpacked folders** (`win-unpacked`,
`mac-universal/Phantom Run.app`, `linux-unpacked`). The installers, portable exe, dmg and AppImage are for
itch.io / direct downloads.

steamworks.js ships prebuilt native binaries. They are unpacked from the asar
(`resources/app.asar.unpacked/node_modules/steamworks.js/dist/<os>/`) next to the Steam API library they
load, and each OS build only keeps its own binaries.

**macOS signing and notarization.** An unsigned app downloaded through Steam is blocked by Gatekeeper.
You need an Apple Developer account (99 USD/year) and a *Developer ID Application* certificate in your
keychain. electron-builder signs automatically when it finds one (`CSC_NAME` picks a specific one). For
notarization set `"notarize": true` under `build.mac` and export `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
and `APPLE_TEAM_ID` (or the App Store Connect API key variables) before `npm run dist:mac`. The hardened
runtime entitlements in `build/entitlements.mac.plist` allow V8's JIT and the Steam overlay's injected
dylib. Upload the signed, notarized `.app` to the macOS depot.

**Windows signing** is optional but avoids SmartScreen warnings for the installer: set `CSC_LINK` /
`CSC_KEY_PASSWORD` (or use Azure Trusted Signing). Steam-launched games are not affected by SmartScreen.

## How the desktop shell works

- **Local server, not file://.** The window loads `http://localhost:<port>/`. Firebase only allows sign-in
  from authorized domains, and `localhost` is authorized by default in every Firebase project
  (`js/config.js` already uses the `firebaseapp.com` auth domain on localhost). The port matters: the
  origin, and with it `localStorage`, IndexedDB and the Firebase sign-in session, includes it. The shell
  tries the port it used last time, then 47823-47838 (`phantomRun.preferredPort` in package.json), and
  only then a random one. It binds loopback only (127.0.0.1 and ::1) and rejects requests whose `Host`
  is not localhost.
- **Google sign-in.** `signInWithPopup` opens `https://retrocycles-e9965.firebaseapp.com/__/auth/handler`.
  The shell lets popups to `accounts.google.com` and `*.firebaseapp.com` open as child windows (no
  bridge, no Node), and sends every other `window.open` / link to the system browser. The Electron
  token is removed from the user agent because Google refuses sign-in from browsers that look embedded.
  If Google still refuses on some machine, email + password sign-in always works.
- **Offline.** three.js r128 and both fonts are bundled. If the Firebase CDN cannot load, the game shows
  "Online grid unreachable. Solo races still work." and goes straight to solo, as on the web.
- **Window.** 16:9, 1600x900 by default (shrunk to fit smaller screens), resizable (min 960x540), size,
  position, maximized and fullscreen remembered in `<userData>/window-state.json`, `#040508` background
  before first paint, no menu bar on Windows / Linux (macOS: the native app menu from `src/menu.js` and a
  hidden-inset title bar; `preload.js` adds the drag strip and toggles it on fullscreen changes), single instance
  (a second launch focuses the running window). `backgroundThrottling` is off so an online host keeps
  simulating when the window is in the background.
- **Steam.** `src/steam.js` loads steamworks.js and calls `init(appId)` inside try/catch. Unsupported
  OS / CPU, Steam not running, or the account not owning the app all just leave
  `phantomDesktop.steam.available` false. When Steam is up the overlay is enabled
  (`electronEnableSteamOverlay()`: `in-process-gpu` + `disable-direct-composition` switches and a repaint
  ticker). App id: `$PHANTOM_STEAM_APPID`, else `steam_appid.txt` (dev: `desktop/`, packaged:
  `resources/`), else `$SteamAppId` (set by Steam), else 480.
- **Bridge** (`preload.js`), only on the game's own origin:

  ```js
  window.phantomDesktop = {
    isDesktop: true, version, platform, webUrl,
    steam: { available, appId, unlockAchievement(id), setRichPresence(key, value),
             getPersonaName(), activateOverlay('friends' | 'achievements' | ... | 'https://...') },
    setFullscreen(on), toggleFullscreen(), isFullscreen(), openExternal(httpsUrl), quit()
  }
  ```
  Every function returns a Promise. `steam.*` resolves `false` / `null` when Steam is unavailable.

## Achievements and rich presence (js/platform.js)

`js/platform.js` listens for `phantom:event` and, in the desktop build only, updates progress counters
(localStorage), unlocks achievements and sets rich presence. In a browser it does nothing. The desktop
bundle already loads it (`build-app` adds `<script type="module" src="js/platform.js">`). The website does
not need it, but importing it there is harmless.

| API name | Name | Unlocks when |
|---|---|---|
| ACH_FIRST_ROUND | First Light | first round won |
| ACH_FIRST_WIN | Own the Grid | first match won (solo or online) |
| ACH_FIRST_ONLINE_WIN | Phantom Among Friends | first online match won |
| ACH_FLAWLESS | Untouchable | match won with `roundsWon == rounds` |
| ACH_LEGEND_WIN | Machine Breaker | solo match won on Legend |
| ACH_WINS_10 | Grid Regular | 10 matches won |
| ACH_WINS_50 | Night Circuit Legend | 50 matches won |
| ACH_MATCHES_25 | Marathon Rider | 25 matches finished |
| ACH_FIRST_GRID | Plugged In | hosted or joined an online grid |
| ACH_FIRST_CRASH | Every Wall Is a Lesson (hidden) | first crash |
| ACH_BOOST_100 | Afterburner | 100 boosts |

Counters survive restarts. Anything earned while Steam was off is sent the next time the game starts with
Steam. To add one: add it to `ACHIEVEMENTS` in `js/platform.js` and to `achievements.json` (`npm test`
fails if they differ), then create it on the partner site.

Rich presence: `steam_display` is one of `#Status_Menu`, `#Status_Garage`, `#Status_Ranks`,
`#Status_Lobby`, `#Status_Solo`, `#Status_Online` (texts in `rich_presence.vdf`, which use the `difficulty`,
`riders` and `score` keys). `status` gets a plain-text line, and `steam_player_group` is set to the grid
code while in an online grid so Steam groups friends in the same grid.

## Integration: events the game must dispatch

Nothing in the game dispatches these events yet. Add the calls below to `js/game.js` and `js/ui.js`.
Either import the helper:

```js
import { emit } from './platform.js';
emit('round-win');
```

or dispatch directly (no import needed, same effect):

```js
dispatchEvent(new CustomEvent('phantom:event', {detail:{type:'round-win'}}));
```

| Event | Detail | Where |
|---|---|---|
| `menu` | `{screen}` | `js/ui.js` `show(name)`, right after `screen = name;`: `emit('menu', {screen:name})` |
| `match-start` | `{online, host, riders, diff}` | `js/game.js` `begin()`, at the end: `emit('match-start', {online:mode !== 'solo', host:mode === 'host', riders:bikes.length, diff:cfg.diff})`. Covers solo, host and guest. |
| `round-win` | `{}` | `js/game.js` `roundMsg(w)`, inside `if (w === player)`: `emit('round-win')`. `roundMsg` runs on the host (from `endRound`) and on guests (from `applySnapshot`), once per round. |
| `crash` | `{}` | `js/game.js` `crash(b)`, inside `if (b === player && state === 'run')`: `emit('crash')`. Also reached on guests through `applySnapshot`. |
| `boost` | `{}` | `js/game.js` `frame()`, where `const boosting = ...` is computed: fire on the rising edge only, e.g. `if (boosting && !wasBoosting) emit('boost'); wasBoosting = boosting;` with `let wasBoosting = 0` at module level. Not once per frame. |
| `join-room` | `{host, code}` | `js/ui.js` `hostGrid()` after `room = await NET.Room.host(...)`: `emit('join-room', {host:true, code:room.code})`. Join form submit after `room = await NET.Room.join(...)`: `emit('join-room', {host:false, code:room.code})`. |
| `leave-room` | `{}` | `js/ui.js` `leaveRoom()` after `room = null`, and in `watchRoom`'s `closed` handler after `room = null`: `emit('leave-room')` |
| `match-end` | `{won, online, rounds, roundsWon, diff}` | `js/ui.js` `Game.hooks.end = s => {...}`, first line: `emit('match-end', {won:s.won, online:s.online, rounds:s.rounds, roundsWon:s.roundsWon, diff:s.diff})`. The fields come from the `matchOver` summary. |

Optional desktop touches for the integrator (all guarded by `window.phantomDesktop`):

- **Quit button.** Steam players (especially on Steam Deck) expect one. Show a "Quit" link on the title or
  home screen when `window.phantomDesktop` exists, and call `phantomDesktop.quit()`.
- **Share link.** In the desktop build `location.origin` is `http://localhost:<port>`, so the lobby
  Share button would hand out a useless link. Set `phantomRun.webUrl` in `desktop/package.json` to the
  public site (for example `https://<project>.vercel.app/`) and build the link from
  `window.phantomDesktop?.webUrl || location.origin + location.pathname`. It falls back to copying just
  the code.
- **Steam name.** `phantomDesktop.steam.getPersonaName()` could prefill the rider name for guests.

## Steam setup checklist

1. **Steamworks partner account**: sign up at partner.steamgames.com, complete the company/tax/bank
   forms and identity check.
2. **Pay the Steam Direct fee**: 100 USD per app (recoupable after 1,000 USD of revenue). You then get
   an **App ID** and depot IDs (usually app id + 1, + 2, ...).
3. **Put the app id in `desktop/steam_appid.txt`** (replacing 480). It ships in `resources/` and is read
   by the shell. It is not placed next to the executable, so it does not interfere with Steam's own
   launch checks. To make the game always start through Steam, set
   `phantomRun.steamRestartIfNecessary` to `true` (calls `SteamAPI_RestartAppIfNecessary`; only in
   packaged builds and never for app id 480).
4. **Store page**: capsule images, screenshots, trailer, description, content survey, system
   requirements (say "requires a GPU with WebGL 2"), pricing. Steam requires the page to be "Coming
   Soon" for at least two weeks before release, and both the store page and the build go through review.
5. **Depots**: Edit Steamworks Settings > SteamPipe > Depots. Create one depot per OS (Windows 64-bit, macOS, Linux +
   SteamOS) and publish.
6. **Launch options** (Edit Steamworks Settings > Installation > General Installation):
   - Windows: `PhantomRun.exe`, OS Windows, 64-bit.
   - macOS: `Phantom Run.app`, OS macOS.
   - Linux: `phantom-run`, OS Linux + SteamOS. If the game does not start inside the Steam Linux Runtime
     (Chromium sandbox: "SUID sandbox helper binary ... not configured correctly"), add `--no-sandbox` as
     the launch argument. A Steam install does not give `chrome-sandbox` the setuid bit it would need.
7. **Achievements**: Edit Steamworks Settings > Stats & Achievements. Create every entry in `achievements.json` with
   the exact API name, display name, description and hidden flag. Upload 256x256 JPG icons (achieved +
   unachieved), then **Publish**.
8. **Rich presence**: Edit Steamworks Settings > Community > Rich Presence. Upload `rich_presence.vdf` (English) and
   publish.
9. **Upload a build** with SteamPipe (below), set it live on a beta branch, install it through Steam,
   and check that achievements unlock and the overlay opens (Shift+Tab).
10. **Steam Deck**: request Deck compatibility review. The game reads controllers itself (Gamepad API:
    stick / d-pad steer, A or RT boost, LB / RB snap, Start menu, d-pad + A / B in the menus), so pick the
    "Gamepad" Steam Input template (Steamworks > Steam Input) before asking for "Verified".

### SteamPipe upload

1. Install the Steamworks SDK and use its `tools/ContentBuilder/builder*/steamcmd`.
2. Build the unpacked folders: `npm run dist:win`, `npm run dist:mac` (on a Mac, signed + notarized),
   `npm run dist:linux`. Each one writes to `desktop/dist/`.
3. Copy `steampipe/app_build_APPID.vdf` to `app_build_<appid>.vdf`, and each
   `depot_build_DEPOTID_<OS>.vdf` to `depot_build_<depotid>.vdf`. Replace the `<APP_ID>`,
   `<DEPOT_ID_*>` and `<VERSION>` placeholders and the depot file names in the app build file.
4. Upload with a Steam account that has the "Edit App Metadata" and "Publish App Changes To Steam" permissions:

   ```bash
   steamcmd +login <builder_account> +run_app_build "$(pwd)/steampipe/app_build_<appid>.vdf" +quit
   ```
   Set `"Preview" "1"` first for a dry run.
5. In Edit Steamworks Settings > SteamPipe > Builds, set the new build live on a branch (`beta` first, then `default`).

## Tests

```bash
npm run check          # node --check on every desktop source + ../js
npm test               # node:test: bundle (+ shared bundler, iOS target), server, Steam wrapper, window state,
                       # platform.js mapping, macOS menu / dmg + zip targets / .icns / title bar
npm run test:browser   # Playwright Chromium against app/ on http://localhost:8092, online and offline
npm run test:electron  # real Electron: boots the bundle, Title -> Solo -> race, prints SMOKE_RESULT
```

On a headless Linux box run Electron under Xvfb with software WebGL:

```bash
xvfb-run -a npx electron . --smoke-test --offline --no-steam --no-sandbox \
  --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist
```

`--offline` blocks every request outside the local server, which shows solo works without network.
The same flags work on a packaged binary (`dist/linux-unpacked/phantom-run --smoke-test ...`).
`test:browser` uses Playwright from `node_modules` or the global install (`npm root -g`).
