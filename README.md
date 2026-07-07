# VOIDRUN Online — Phase 1 (authoritative multiplayer core)

A server-authoritative rewrite of the VOIDRUN hole.io prototype, built toward a
real-time multiplayer battle royale. This phase proves the **hard part**: an
authoritative game server where clients send only *inputs* and the server owns
all truth (positions, eats, growth, elimination). That's the foundation that
later makes real-money staking safe — the browser can never be trusted.

> Status: **Phase 1 vertical slice — working & verified.** No crypto yet (that's
> Phase 3+, and only after legal sign-off). See "Roadmap" below.

## What works right now

- **Authoritative Colyseus server** (`server/`) running a 2D hole.io simulation at
  60 Hz, broadcasting binary state deltas at 20 Hz.
- Clients send a **direction vector only**; the server integrates movement, so
  speed-hacking / teleporting / fake-eats are impossible by construction.
- **4 AI bots** fill the arena (seek food, flee bigger holes) so a solo player
  always has rivals.
- **Eating** (food + hole-vs-hole battle-royale elimination), growth, leveling,
  a 120 s match clock, winner detection, and auto-restart.
- **Thin 2D canvas debug client** (`client/`) with client-side **prediction +
  reconciliation** on your own hole and render-smoothing for everyone else.
  This is a throwaway view — the existing Three.js renderer slots in here later.

## Run it

Requires Node 18+ (tested on Node 23).

```bash
cd voidrun-online/server
npm install          # first time only
npm run dev          # hot-reloading server on http://localhost:2567
```

Then open **http://localhost:2567/** in a browser, enter a name, and click
*Connect & play*. Move with the **mouse** (steer toward the cursor; center =
stop) or **WASD**. Open a second tab to see real multiplayer.

- **`/`** — the **3D client** (`client3d/`): real GLB cars/buildings/trees and a
  stencil hole, the hole.io look, driven entirely by the server.
- **`/2d`** — the 2D canvas debug client (`client/`): same data, dots instead of
  models. Handy for debugging netcode.
- GLB models are the original VOIDRUN assets, served from `/assets`.

`npm start` runs without hot-reload. Set `PORT` to change the port.

## Smoke test

`server/smoketest.mjs` is a headless client that joins, drives input, and asserts
the server moved the hole and replicated state:

```bash
cd voidrun-online/server
node smoketest.mjs        # prints PASS/FAIL
```

## Architecture

```
client (browser)                    server (authoritative)
─────────────────                   ──────────────────────
read pointer/keys                   ArenaRoom (one per match)
  → send {dx,dz} @20Hz  ───────►    validate + normalize input
predict own hole locally            60Hz fixed sim:
render room.state every frame         move holes (server integrates)
  ◄───────  binary delta @20Hz        resolve eating (server decides)
reconcile to server pos               hole-vs-hole elimination
                                      120s clock → winner → reset
```

- `server/src/config.ts` — all gameplay tuning (authoritative).
- `server/src/schema.ts` — networked state (`Hole`, `Food`, `ArenaState`).
- `server/src/ArenaRoom.ts` — the simulation. **This is the source of truth.**
- `server/src/index.ts` — HTTP (serves the client) + WebSocket bootstrap.
- `client/index.html` — the debug renderer + netcode (prediction/reconciliation).

## Roadmap (where this is going)

1. **Phase 1 — authoritative core** ✅ *(this)*
2. **Phase 2 — netcode feel + anti-cheat**: snapshot interpolation, lag
   compensation, movement/eat validation tightening, collusion/Sybil detection.
3. **Swap renderer**: drive the existing 3D Three.js `voidrun` client off this
   server's state instead of its local simulation.
4. **Phase 3 — Robinhood Chain on devnet**: SIWS wallet auth + Anchor escrow (PDA vault,
   `has_one = authority` settlement, timeout refund). Devnet only.
5. **Phase 4 — mainnet** *(only after a Latvian/EU gaming lawyer signs off on the
   paid mode — pay-to-enter winner-take-all likely triggers gambling regulation).*

## Known prototype limitations

- O(holes × food) eat checks per tick — fine at this scale; add a spatial grid
  before scaling object counts.
- No snapshot-buffer interpolation yet (uses simple render-smoothing); remote
  holes can look slightly loose under latency. Phase 2.
- The 2D canvas client sizes its canvas once on load; resize the window if it
  doesn't fill the viewport. (The Three.js client replaces this anyway.)
- Wallet / staking: **not present by design** — Phase 3+.
