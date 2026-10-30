# Retrocycles 3D

A neon light-cycle arena in the browser. Race AI rivals solo, or host an online grid and share a 5-character code with friends (up to 6 riders, empty seats filled with AI if you like). Works with keyboard or touch (buttons or swipe).

Static site: no build step. Three.js r128 and the Firebase JS SDK load from CDNs.

```
index.html               markup for HUD, title, auth, lobby, leaderboard
css/style.css            theme + responsive layout
js/game.js               engine: scene, riders, sim, audio, HUD, camera, netcode roles
js/ui.js                 screens, sign-in, host/join flow, leaderboard
js/net.js                Realtime Database rooms (host / join / inputs / snapshots)
js/firebase.js           Firebase auth, rider profiles, stats
js/config.js             Firebase web config
database.rules.json      Realtime Database security rules
```

## Firebase console setup (one time)

1. **Authentication → Sign-in method**: enable **Email/Password** and **Google**.
2. **Authentication → Settings → Authorized domains**: add your Vercel domain(s), e.g. `retrocycles.vercel.app` (and any custom domain).
3. **Realtime Database → Rules**: paste the contents of `database.rules.json` and publish.

## How online play works

- The **host's browser runs the race** and streams a compact snapshot ~15×/second to `rooms/{CODE}/st`, plus every turn point to `rooms/{CODE}/tl`.
- **Guests** send only their inputs (turns + boost). Their own turns are predicted locally so steering feels instant; each turn carries the step it was pressed on, and the host rewinds that rider up to 6 cells so the turn lands where the guest saw it. A guest who hits a wall gets a 0.2 s grace window for a late turn to arrive.
- Rooms delete themselves when the host disconnects (`onDisconnect`). The host should keep the tab in front while racing (browsers pause background tabs).
- Each signed-in rider records their own stats after a match. Rules only let a rider write their own profile and only let counters rise by one match at a time.

## Local run

Any static server works:

```bash
python3 -m http.server 8080
```

Sign-in needs the page served from an authorized domain (`localhost` is authorized by default).
