# Progression: skill rating, seasons and the colour ritual

Everything here is client-side, on top of the existing Firebase Realtime Database. The maths lives in
pure modules under `js/progression/` (no DOM, no Firebase) and is tested in Node:

```bash
node tests/rating.test.mjs      # Glicko-2, multi-rider matches, seasons
node tests/colour.test.mjs      # OKLab, readability, resolveClashes, riderColours
node tests/signature.test.mjs   # signature colour + name, applying a match to a rider record
```

| Module | What it does |
| --- | --- |
| `js/progression/rating.js` | Glicko-2, match → pairwise games, season carry-over, idle RD growth, board keys |
| `js/progression/season.js` | `seasonId()` → `"2026-Q4"` (UTC calendar quarter), `seasonLabel()`, `seasonEnds()` |
| `js/progression/colour.js` | OKLab/OKLCH, `readable()`, `deltaE()`, `resolveClashes()`, `ACCENTS`, `riderColours()`, `cssOf()`, `numOf()` |
| `js/progression/signature.js` | playstyle vector, rating band, `computeSignature()`, `signatureName()` |
| `js/progression/record.js` | `applyMatch(user, summary, ctx)`: the whole per-match update, used by `recordMatch` |

## Skill rating (Glicko-2)

- Textbook Glicko-2 (Glickman 2013), τ = 0.5, new riders start at 1500 / RD 350 / σ 0.06. Each match is one
  rating period. The test reproduces Glickman's worked example (1500/200/.06 vs 1400/30 W, 1550/100 L,
  1700/300 L → 1464.06 / RD 151.52 / σ 0.05999).
- **Multi-rider matches** become pairwise games by finishing order: compare rounds won with every other rider
  (more = win, fewer = loss, equal = draw). Pairwise results inside one match are strongly correlated, so in an
  N-rider match each pairwise game has weight `1/√(N−1)` (a 6-rider grid counts as ~2.2 duels, not 5). The
  weight scales each game's term in Glicko-2's `v` and `Δ` sums; weight 1 is exactly textbook.
- **AI rivals** are fixed opponents: rookie 1200, rider 1500, legend 1800, all RD 50.
- **Solo matches: reduced weight, same rating** (the choice asked for). Every game against an AI, solo or an AI
  seat in an online grid, counts at weight 0.5. Why not a separate solo rating: most riders start solo, and the
  signature needs a skill reading after 5 matches; a separate solo rating would leave solo-first riders without
  one, or give them two numbers that mean different things. AI opponents are honest anchors (known, fixed
  ratings), and Glicko's expected score means beating rookies again and again gains almost nothing, so the
  half weight is enough to stop farming from dominating. Human opponents always count at full weight.
- Human opponents' ratings are read when the match starts (`ratingsOf`), so everyone rates against
  pre-match numbers. An unreadable opponent counts as a new rider (1500 / RD 350), which barely moves you.
- **Idle time**: one Glicko-2 "no games" period per idle day inflates RD (capped at 350).
- Stored numbers are clamped to the rule bounds: r 100–3999, RD 30–350, σ ≤ 0.15.

## Seasons

A season is a UTC calendar quarter: `2026-Q4`. On the first rated match of a new season the rating keeps
`r` and `σ`, RD rises to at least 150 and the placement counter `n` resets to 0. Season stats accumulate
under `users/{uid}/seasons/{seasonId}`. After 5 rated matches in the season (`n ≥ 5`) the rider is
**placed**: they appear on the Rating leaderboard and their signature is revealed (or evolves).

## Data model

```
users/{uid}
  name, wins, matches, rounds, soloWins, soloMatches, color   (unchanged)
  rating:    {r, rd, vol, n, season, updated, board?}
             n = rated matches this season; board = "<season>:<round(r), 4 digits>", only when n >= 5
  seasons/{seasonId}:
             {matches, wins, soloMatches, soloWins,         online / solo, this season
              roundsWon, roundsPlayed,                       all matches
              diffN, diffSum,                                matches with AI rivals; sum of rookie 0 / rider 1 / legend 2
              r, rd, n, peak,                                rating snapshot after the last match; best placed rating
              style?: {n, rounds, trapped, survivalSec, boostSec, closePasses, ownWall}}   summed game metrics
  signature: {hex: "#rrggbb", name, season, revealedAt}
  accent:    {hex: "#rrggbb"}
```

The leaderboard's Rating tab queries `orderByChild('rating/board')` between `"<season>:"` and `"<season>:~"`,
`limitToLast(20)`. Because the key embeds the season and a zero-padded rating, string order equals rating order
within a season, and riders from other seasons or not yet placed never match the range. `.indexOn` includes
`rating/board`.

`recordMatch(uid, name, summary, {opponents})` runs `applyMatch` inside one transaction on `users/{uid}` and
resolves to `{report, user}`. `report = {season, before, after, delta, placement, placed, signature, sigEvent,
previousSignature}`, where `sigEvent` is `'reveal'`, `'evolve'` or `null`.

## The colour ritual (signature light)

After placement a rider's signature colour is computed deterministically from how they ride and how well:

- **Hue = playstyle.** A 2D style vector, x = aggression (+) vs caution (−), y = composure (+) vs volatility
  (−), is turned into an angle on the OKLCH wheel, starting at hue 25 (warm red) for pure aggression:
  aggressive → red, aggressive + composed → orange/amber, composed → yellow-green, cautious + composed →
  green/teal, cautious → cyan/blue, cautious + volatile → indigo, volatile → violet, aggressive + volatile →
  magenta/rose. A short per-rider bias vector and ±8° of jitter (both from a hash of the uid) separate riders
  with identical stats, so balanced riders spread round the whole wheel.
- **Lightness and chroma = rating band.** `t = (r − 1000) / 1100` clamped: L 0.68 → 0.85, chroma 0.12 → 0.22,
  easing off at the very top so the best riders burn white-hot. Tiers: Ember, Spark, Flare, Nova, White-hot.
  The result is gamut-mapped (chroma reduced, hue and lightness kept) and passed through `readable()`.
- Continuous hue × lightness × chroma gives thousands of distinct colours (the test generates >3000 distinct
  signatures from 4000 riders).
- **Name** from the colour: first word by brightness band (deep / lit / bright, 12 words each, e.g. Midnight,
  Meridian, Glacier), second by hue family (8 words for each of 9 families, e.g. Ember, Tide, Verdict),
  chosen by an FNV hash of the hex. Examples: "Midnight Ember", "Glacier Verdict", "Signal Tide".
- **Evolution**: once per season, after that season's 5 placement matches, the signature is recomputed. The
  change is limited to ±20° of hue, ±0.05 lightness and ±0.04 chroma around the previous signature, so it
  drifts slowly. Within a season it never changes.

The style vector uses game metrics when they exist and falls back to plain stats until they do. The metrics take
over gradually (fully after 5 matches with metrics this season):

| Axis | With metrics | Fallback (stats already recorded) |
| --- | --- | --- |
| aggression x | rivals trapped per round, close passes per minute alive, share of time boosting | difficulty of AI rivals chosen, share of matches played online, share of rounds won |
| composure y | seconds survived per round, minus rounds lost to your own wall | win rate, rounds per match (long, contested matches) |

The profile shows a one-word reading of the vector: Hunter (x+, y+), Daredevil (x+, y−), Sentinel (x−, y+),
Drifter (x−, y−) or Balanced.

The **accent** is a second colour the rider picks freely: one of 24 curated colours (`ACCENTS`) or any hue from a
slider (`accentFromHue`), all readable on the arena. The six-colour Garage pick stays: it is the rider's colour
until a signature exists, and the fallback wherever a signature cannot be shown.

## Colour clashes

`resolveClashes(colours, {threshold = 0.12})` takes the lobby's colours in priority order (host first, then join
order, then AI) and returns `'#rrggbb'` strings. Distances are Euclidean in OKLab (ΔE_OK; the closest classic
pair, ion / platinum, is 0.19). Each colour is first made readable (OKLab L ≥ 0.60, and C ≥ 0.08 when L < 0.78,
so a wall never reads as fog on the near-black arena). A rider within the threshold of an earlier rider has their
hue rotated by the smallest angle (1° steps, either direction) that clears everyone earlier, keeping lightness;
near-greys get enough chroma for a hue turn to separate them; in a very crowded lobby lightness is stepped too.
`null` entries get the first free classic colour.

## Metrics contract (for the integrator)

`hooks.end(summary)` may carry an optional `summary.metrics`, for the **local rider**, summed over every round of
the match. `recordMatch` passes it through `cleanMetrics()` (values clamped to the bounds below, which match the
database rules). All fields are optional; a missing field counts as 0. Without `metrics` everything still works
(the fallback style is used).

```js
summary.metrics = {
  trapped: 0,             // integer, ≤ 40. Rivals whose fatal crash was into a wall segment you laid
                          //   (credit the wall owner; a rider hitting their own wall credits nobody;
                          //   arena-edge crashes credit nobody).
  survivalSec: 0,         // seconds, ≤ 3600. Sum over rounds of simulated time from GO until you crashed
                          //   or the round ended. Use simulation time (dt sum), not wall-clock.
  boostSec: 0,            // seconds, ≤ 3600. Simulated time with boost actually firing (held and charge > 0).
  closePasses: 0,         // integer, ≤ 500. Count of the game's existing close-pass events (closePasses(now)
                          //   in game.js) for the local rider; count each event once, not per frame.
  crashesIntoOwnWall: 0   // integer, ≤ 64. Rounds in which you died on your own wall.
};
```

Suggested implementation in `js/game.js`: keep a `stats = {trapped, survivalSec, boostSec, closePasses,
crashesIntoOwnWall}` object, reset it in `startSolo` / `startOnline`; in the fixed sim step add `dt` to
`survivalSec` while the player is alive and `state === 'run'`, and to `boostSec` while their boost fires; where a
crash is resolved, look up the owner of the wall that was hit and increment `trapped` (owner is the player and the
victim is not) or `crashesIntoOwnWall` (victim is the player and owner is the player); increment `closePasses`
where the close-pass effect fires for the player. Add `metrics:{...stats}` to the summary in `matchOver()`. On
online guests, compute from the guest's own view (snapshots carry deaths; ownership of the hit wall is the
nearest segment at the crash point).

## Rendering hand-off (for the integrator)

```js
import { riderColours, cssOf, numOf, resolveClashes } from './progression/colour.js';
riderColours(profile)   // → {primaryHex:'#rrggbb', accentHex:'#rrggbb'}
                        //   primary = signature.hex, else the Garage classic (profile.color), else crimson
                        //   accent  = accent.hex, else a paler tint of the primary
cssOf(0xff2a3d)         // → '#ff2a3d' (accepts numbers, '#RGB', '#RRGGBB', 'rrggbb'; null if invalid)
numOf('#ff2a3d')        // → 0xff2a3d (for three.js colours)
resolveClashes(list)    // → '#rrggbb'[] with every pair at least ΔE_OK 0.12 apart and readable
```

Steps to make the game ride signature colours:

1. **Seats carry hexes.** In `js/net.js` add `hex` / `accent` to `rooms/{code}/players/{uid}` (from
   `riderColours(profile)`), and in `js/ui.js` pass them through `sortedPlayers()` into the `roster` entries
   (`{name, uid, bot, color, hex, accent}`); for solo pass `hex` / `accent` in `Game.startSolo` options. Add a
   rule: `"hex": {".validate": "newData.isString() && newData.val().matches(/^#[0-9a-f]{6}$/)"}` (same for
   `accent`) under `rooms/$code/players/$uid`.
2. **Resolve clashes once, on the host.** In `hostStart()` build the roster, then
   `const hexes = resolveClashes(roster.map(p => p.hex || CLASSIC[p.color]))` and write each back to
   `roster[i].hex` before `room.begin(start)`, so every client paints the same colours. Bots can keep the
   classic keys left by `assignColours()` and be resolved in the same pass.
3. **`paint()` in `js/game.js`.** If `p.hex` is valid use `{color:numOf(p.hex), css:cssOf(p.hex)}`, else keep the
   classic-key path. Use `p.accent` for the craft's secondary/trim light where the vehicle model has one.
4. `ui.js` already sets the menu `--accent` and the turntable Phantom from `riderColours(profile).primaryHex`.

## Database rules

`database.rules.json` validates: rating numbers within bounds (r 100–3999 and at most ±700 per write, RD 30–350,
0 < σ ≤ 0.2), `n` a whole number rising by at most 1 per write (a reset to 0 at a new season is allowed),
`season` format, `updated ≤ now + 1 day` (clock-skew tolerance), `board` format, prefixed by the rating's
season and only with `n ≥ 5`; season stats counters each rising by bounded steps per write; signature hex
`#rrggbb`, name 3–32 letters/spaces, season format, and only writable with `rating.n ≥ 5` (an unchanged
signature passes); accent hex. Unknown keys are rejected as before. **Republish the rules after deploying.**

## Limitations

- **Ratings are client-reported.** Each client computes and writes its own rating; the rules bound each step
  but a determined cheater can still walk their rating up a little per write, pick their signature colour, or
  misreport opponents. Making it cheat-proof needs an authoritative server (e.g. a Cloud Function that rates
  the match from the host's result record and writes ratings with admin rights, with client writes to `rating`,
  `seasons` and `signature` denied).
- Opponent ratings are read at match start; if two riders' matches overlap, each uses the other's
  pre-match rating, which is the usual Glicko simplification.
- Online human opponents are matched back to roster seats by name; two riders with the same name in one grid
  may be swapped (both get rated, possibly against the other's number).
- `season` and timestamps come from the client clock.
