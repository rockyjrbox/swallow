/**
 * Server bootstrap — serves the 3D client AND runs the Colyseus WebSocket game
 * server on one port. Same-origin, so the client's `ws://` derivation from
 * location.origin "just works" behind a single TLS/reverse proxy (no CORS,
 * no split-origin websocket).
 */
import { createServer } from "http";
import path from "path";
import express from "express";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Encoder } from "@colyseus/schema";
import { ArenaRoom } from "./ArenaRoom";

// The dense city (~1,600 objects) encodes larger than the 64 KB default state
// buffer — raise it with headroom so full state is never truncated to clients.
Encoder.BUFFER_SIZE = 512 * 1024;

// Never let a stray error take the whole process (and every connected player)
// down. The 60Hz tick is also wrapped in try/catch (ArenaRoom.tick).
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

const port = Number(process.env.PORT) || 2567;
const clientDir = path.join(__dirname, "..", "..", "client3d");

const app = express();
app.get("/health", (_req, res) => res.status(200).send("ok")); // host/load-balancer health check
app.use((_req, res, next) => {                                   // baseline hardening headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.static(clientDir));                              // 3D client + vendored three.js/GLTFLoader/colyseus.js
app.use("/assets", express.static(path.join(clientDir, "assets"))); // GLB models (cars/city/nature/factory), now in-repo
if (process.env.ENABLE_DEBUG_CLIENT === "1") {                   // 2D debug client — OFF in prod unless explicitly enabled
  app.use("/2d", express.static(path.join(__dirname, "..", "..", "client")));
}

// Optional origin lock-down: set ALLOWED_ORIGINS="https://swallow.games,https://www.swallow.games"
// in prod to reject drive-by sockets from other sites. Unset = open (dev + pre-domain launch).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
    verifyClient: (info: any, next: any) => {
      if (!allowedOrigins.length) return next(true);            // default: allow all
      const o = info.origin;                                    // browsers always send Origin
      next(!o || allowedOrigins.includes(o));                   // no-origin (native/test tools) allowed
    },
  }),
});

gameServer.define("arena", ArenaRoom);                       // classic timed FFA
gameServer.define("battle", ArenaRoom, { mode: "battle" });  // last hole standing, shrinking zone

httpServer.listen(port, () => {
  console.log(`\n  Swallow game server  (${process.env.NODE_ENV || "development"})`);
  console.log(`  → client:    http://localhost:${port}/`);
  console.log(`  → websocket: ws://localhost:${port}\n`);
});

// Graceful shutdown so a host can roll/restart without hard-dropping rooms.
let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${sig}] shutting down…`);
  try {
    const gs = gameServer as any;
    if (typeof gs.gracefulShutdown === "function") await gs.gracefulShutdown();
  } catch (e) { console.error(e); }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref(); // hard cap
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
