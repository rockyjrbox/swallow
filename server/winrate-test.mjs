// Headless win-rate harness — a "competent player" vs the nerfed bots.
// Verifies the owner's "you can almost always win" target (aim: >=80%).
// Run (from server/):  ROUND_SECONDS=30 npx tsx winrate-test.mjs 20
import { createServer } from "http";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { Encoder } from "@colyseus/schema";
import { ArenaRoom } from "./src/ArenaRoom";

Encoder.BUFFER_SIZE = 512 * 1024; // match the production buffer so the client sees full state
// classic reads CLASSIC_SECONDS now (ROUND_SECONDS is battle-only); map the old env through
process.env.CLASSIC_SECONDS = process.env.CLASSIC_SECONDS || process.env.ROUND_SECONDS || "120";

const N = Number(process.argv[2] || 20);
const PORT = 2599;
const EAT_GATE = 1.0, HOLE_RATIO = 1.25; // MUST mirror server eatSizeGate/holeEatSizeRatio

const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
gameServer.define("arena", ArenaRoom);
await gameServer.listen(PORT);

const norm = (x, z) => { const l = Math.hypot(x, z) || 1; return { dx: x / l, dz: z / l }; };

// A reasonable human: SEES threats across the screen (not just point-blank), COMMITS to a
// dodge briefly (momentum-aware, no dithering), else beelines the nearest eatable.
const fleeState = { until: 0, dx: 0, dz: 0 };
function competentInput(state, myId) {
  const me = state.holes.get(myId); if (!me || me.dead) return { dx: 0, dz: 0 };
  const now = Date.now();
  if (now < fleeState.until) return { dx: fleeState.dx, dz: fleeState.dz }; // committed dodge
  let fx = 0, fz = 0, flee = false;
  const aware = Math.max(22, me.radius * 8); // human-like screen awareness
  state.holes.forEach((o, oid) => {
    if (oid === myId || o.dead) return;
    if (o.radius > me.radius * HOLE_RATIO) {
      const d = Math.hypot(o.x - me.x, o.z - me.z);
      if (d < aware) { const w = 1 / Math.max(1, d); fx += (me.x - o.x) * w; fz += (me.z - o.z) * w; flee = true; }
    }
  });
  if (flee) {
    const v = norm(fx, fz);
    fleeState.until = now + 450; fleeState.dx = v.dx; fleeState.dz = v.dz; // commit through momentum lag
    return v;
  }
  let best = null, bestD = 1e9;
  state.food.forEach((f) => {
    if (f.size >= me.radius * EAT_GATE) return;
    let d = Math.hypot(f.x - me.x, f.z - me.z);
    if (f.kind === "boost") d *= 0.6;
    if (d < bestD) { bestD = d; best = f; }
  });
  return best ? norm(best.x - me.x, best.z - me.z) : norm(-me.x, -me.z);
}

let wins = 0, played = 0;
for (let i = 0; i < N; i++) {
  const client = new Client(`ws://localhost:${PORT}`);
  const room = await client.create("arena", { name: "HUMAN" }); // fresh room each match
  const myId = room.sessionId;
  fleeState.until = 0; // reset dodge state per match
  const tick = setInterval(() => { try { room.send("input", competentInput(room.state, myId)); } catch {} }, 50);
  await new Promise((res) => {
    let done = false;
    room.onStateChange((s) => {
      if (done || s.phase !== "ended") return;
      done = true; clearInterval(tick);
      const scores = [];
      s.holes.forEach((h, id) => scores.push({ id, score: h.score, bot: h.isBot }));
      scores.sort((a, b) => b.score - a.score);
      const rank = scores.findIndex((x) => x.id === myId) + 1;
      const me = scores.find((x) => x.id === myId);
      const won = scores[0].id === myId;
      if (won) wins++;
      played++;
      console.log(`match ${played}: rank ${rank}/${scores.length}  you=${Math.round(me ? me.score : 0)}  top=${Math.round(scores[0].score)}${won ? "  ← WIN" : ""}`);
      room.leave(); res();
    });
  });
}
console.log(`\n=== player win-rate: ${wins}/${played} = ${(100 * wins / played).toFixed(0)}%  (target >=80%) ===`);
process.exit(0);
