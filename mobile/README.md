# Phantom Run for iPhone (Capacitor)

The same game as the website and the Mac app, in a native iOS shell. [Capacitor](https://capacitorjs.com)
8 wraps the web bundle in a WKWebView; the bundle is built by the same script as the desktop app
(`../tools/web-bundle.mjs`), with three.js and the fonts inside the app, so solo races work offline.
Sign-in, online grids and leaderboards use Firebase over the network, like everywhere else.

```
mobile/
  package.json           Capacitor 8 (core, ios, cli), haptics + keep-awake plugins, three + fonts for the bundle
  capacitor.config.json  app id app.phantomrun.game, webDir www/, full-screen web view, no bounce
  scripts/build-web.mjs  www/ from the repo (shared bundler, target "ios")
  scripts/ios.mjs        `cap add ios` / `cap sync ios`, then patches Info.plist, the app icon and the launch screen
  tests/ios.test.mjs     config, bundle, generated Xcode project + patches, native bridge mapping (no Xcode needed)
  www/  ios/             generated (www/ is git-ignored; commit ios/ once you have set up signing, if you like)
```

## No App Store needed today: install the web app

On the iPhone, open the deployed site in **Safari** > Share > **Add to Home Screen**. It starts full screen
from its own icon, keeps working offline for solo races (service worker), and controllers work too.

## Build and run the iPhone app (on your Mac)

You need a Mac with **Xcode 16 or newer** (App Store, free), **Node.js 22**, and an Apple ID. A free Apple ID
can put the app on your own iPhone for 7 days at a time; the Apple Developer Program (99 USD/year) removes
that limit and is required for TestFlight and the App Store.

```bash
cd retrocycles/mobile
npm ci
npm run ios:add      # builds www/, creates ios/ (Swift Package Manager, no CocoaPods), patches it
npm run ios:open     # opens ios/App/App.xcodeproj in Xcode
```

In Xcode:
1. Select the **App** target > **Signing & Capabilities** > Team: your Apple ID / team
   (Xcode > Settings > Accounts to add it). Change the bundle identifier if `app.phantomrun.game` is taken.
2. Plug in the iPhone (or pick it over Wi-Fi), choose it as the run destination, press **Run** (⌘R).
   The first time: on the iPhone, Settings > General > VPN & Device Management > trust your developer
   certificate, and turn on Settings > Privacy & Security > **Developer Mode**.
3. The Simulator works too (pick any iPhone in the destination menu).

After changing the game (`index.html`, `css/`, `js/`): `npm run ios:sync`, then Run again in Xcode.
`npm run ios:run` does sync + build + launch from the terminal (`npx cap run ios --list` shows devices).

For TestFlight / the App Store: Product > Archive in Xcode, then Distribute App. App Store Connect needs
screenshots, a privacy policy URL and the age rating questionnaire.

## What the app adds

- **Info.plist** (`scripts/ios.mjs`, re-applied on every `ios:sync`): status bar hidden, full screen,
  portrait and both landscapes, `CADisableMinimumFrameDurationOnPhone` (lets ProMotion iPhones run above
  60 Hz), `GCSupportsControllerUserInteraction` (MFi / Xbox / PlayStation controllers drive the game),
  racing-games category, `ITSAppUsesNonExemptEncryption = false` (no export-compliance question on upload).
- **App icon** (opaque 1024 px, generated from `desktop/build/icon.png`) and a dark launch screen.
- **Haptics** (`js/mobile.js`, @capacitor/haptics): crash = heavy impact, boost start = light impact,
  round won = success. Mapped from the same `phantom:event` events as the Steam achievements; in a browser
  nothing happens.
- **Screen stays on** during a match (@capacitor-community/keep-awake).
- **Audio** starts on the first tap and comes back after calls / app switches. The ring / silent switch mutes
  the game, as iOS games usually do.
- **Notch and home indicator**: the web view fills the screen (`contentInset: never`) and the page keeps
  its controls inside `env(safe-area-inset-*)`.

## Google sign-in in the app (limitation)

Google refuses OAuth sign-in inside embedded web views ("disallowed_useragent"), and Firebase's popup /
redirect sign-in cannot return to a `capacitor://` page. So in the iPhone app:

- the **Continue with Google** button is hidden and a note explains why;
- **email and password** is the way in. A rider created with Google can type their Gmail address and tap
  **Forgot password?** to set a password, then sign in with it (same Firebase account, same rider);
- Firebase Auth runs with `initializeAuth(..., {persistence: indexedDBLocalPersistence})` in the app
  (`getAuth()` waits forever on its popup helper iframe in a Capacitor iOS web view).

A working native Google button is possible later with `@capacitor-firebase/authentication` (native Google
Sign-In SDK, then `signInWithCredential` in the web layer). It needs the Firebase iOS app registered in the
Firebase console, its `GoogleService-Info.plist` added to Xcode and the reversed client id as a URL scheme.
It was not added here because none of that can be built or tested without a Mac and the console.

## Not verified here

This was prepared on Linux: `cap add ios`, `cap sync ios`, the Info.plist / icon / launch-screen patches and
the web bundle are tested (`npm test`), but nothing was compiled or run in Xcode, on the Simulator or on an
iPhone. Things to check on the first run: sign-in with email, a solo race in portrait and landscape, a
controller, haptics on crash, and the frame rate on a ProMotion iPhone (WKWebView may still hold
`requestAnimationFrame` to 60 Hz depending on the iOS version).
