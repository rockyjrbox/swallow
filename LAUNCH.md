# VOIDRUN — Launch Guide

Free-to-play launch. The staking surfaces ($SWALLOW on Robinhood Chain) are intentionally **"coming soon"** (simulated) — no on-chain code runs. One Node process serves the 3D client **and** the Colyseus WebSocket server on the same origin, so the client's `ws://`/`wss://` derivation "just works" behind a single TLS proxy (no CORS, no split origin).

## What's already hardened (done)

- **Security:** player names sanitized server-side + HTML-escaped on render (no XSS). Server is authoritative — clients only send an input direction.
- **Resilience:** `uncaughtException`/`unhandledRejection` guards, the 60Hz tick is wrapped in try/catch (one bad frame can't crash a room), graceful `SIGTERM`/`SIGINT` shutdown, `onDispose` clears timers.
- **Self-contained:** GLB assets copied **into the repo** (`client3d/assets`), and `three.js` + `GLTFLoader` **vendored locally** (`client3d/three.min.js`, `GLTFLoader.js`) — no CDN dependency, no 404s in prod. Only Google Fonts is still external (soft, non-blocking).
- **Prod hygiene:** `GET /health` → 200; the 2D debug client (`/2d`) is **off** unless `ENABLE_DEBUG_CLIENT=1`; the on-screen diagnostics overlay is **off** unless `?debug=1`; disconnect/error handling returns the player to the menu with a message instead of freezing on stale state.
- **Client bugs fixed:** no duplicate net timers across replays, no prediction drift on the frozen results screen, no double-counted games/wins, mid-match joiners get a 3s spawn grace and don't spawn under a giant.
- **Bandwidth:** traffic movers trimmed (cars 150→100, people 100→65); `Encoder.BUFFER_SIZE` = 512 KB.
- **Share-ready:** title, description, favicon, Open Graph + Twitter meta, `theme-color`.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT` | `2567` | HTTP + WS port |
| `NODE_ENV` | `development` | set `production` in prod |
| `ROUND_SECONDS` | `600` | match length (10 min); lower for testing |
| `ENABLE_DEBUG_CLIENT` | unset | set `1` only to expose `/2d` |

## Deploy

> **Vercel cannot run the game server** — it's serverless (no persistent WebSocket / 60Hz process). Vercel can host the *client* only. So either run everything on one persistent host, **or** split: client on Vercel + server on Railway/Fly. The client's server address is configurable via `<meta name="game-server">` in `client3d/index.html` (empty = same origin).

### Option A — Split: client on Vercel + server on Railway (matches "Vercel")

**1. Deploy the server on Railway (or Fly/Render) first — you need its URL for step 2.**
- New Railway project → Deploy from this repo → set **Root Directory** to `voidrun-online` (it builds the `Dockerfile`).
- Railway injects `PORT` automatically (the server reads `process.env.PORT`). Set `NODE_ENV=production`.
- Health check path: `/health`. Note the public URL, e.g. `https://voidrun-server.up.railway.app`.

**2. Point the client at that server.** In `client3d/index.html`, set the meta tag to the server's **wss** URL:
```html
<meta name="game-server" content="wss://voidrun-server.up.railway.app" />
```

**3. Deploy the client on Vercel (static, no build).**
- New Vercel project → import this repo → set **Root Directory** to `voidrun-online/client3d`, Framework Preset **Other**, no build command. `client3d/vercel.json` handles asset caching.
- Vercel serves `index.html` + the vendored `three.min.js`/`GLTFLoader.js`/`colyseus.js` + `/assets`. The game connects over `wss://` to Railway (WebSocket is not blocked by CORS).

That's it — the Vercel URL is your game. (The Railway server also serves the game at its own URL as a fallback.)

### Option B — All-in-one on one persistent host (simplest)

Run client **and** server together on **Railway / Fly.io / Render** (repo deploy, WSS + TLS + restart built in). Leave the `<meta name="game-server">` empty (same origin). A `Dockerfile` + `.dockerignore` are included; the image runs `npm --prefix server start` and exposes `/health`.

**Railway / Render (Docker):** point it at this folder, it builds the `Dockerfile`, set `PORT` (Railway injects one — the server already reads `process.env.PORT`), health check path `/health`. Done.

**Fly.io:** `fly launch` in this folder (detects the Dockerfile), ensure `internal_port = 2567`, add a `[[services.http_checks]]` on `/health`, `fly deploy`. Fly terminates TLS and upgrades WS automatically.

**Colyseus Cloud:** zero-infra option if you'd rather not manage a host (some cost/lock-in) — deploy the `server/` app; serve `client3d/` statically from the same app or a CDN.

**Bare VPS:** `npm --prefix server ci --omit=dev` → run under **PM2** (`pm2 start "npm --prefix server start" --name voidrun`, `pm2 save`, `pm2 startup`) behind **Caddy** (auto-HTTPS, proxies WS out of the box):
```
your.domain { reverse_proxy localhost:2567 }
```

## Pre-launch smoke test (on the deployed host)

1. `curl -I https://HOST/health` → `200`.
2. `curl -I https://HOST/assets/cars/ambulance.glb` → `200`.
3. Open the site → join a match → confirm the 3D city, HUD, traffic, and eating all work.
4. Kill/restart the server → the client shows "Disconnected", returns to the menu (does **not** freeze), and reconnects on Play.
5. **Load test one 16-client room**, watching per-client outbound KB/s and server CPU — this is the real scaling signal.

## Post-launch performance backlog (defer until you have traffic)

Ordered by value: stagger mesh creation on join + `match_reset` (kills the join freeze and the recurring ~per-round freeze), a `movingMeshes` list instead of per-frame map lookups, lower `devicePixelRatio`/`antialias` + smaller shadow map on mobile, then the heavy wins — a spatial-hash grid for `resolveEating`/`steerBots`, `InstancedMesh`/merged static geometry (collapses ~1,600 draw calls to dozens), and area-of-interest culling (the real fix for many players per room).
