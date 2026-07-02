// Full-match balance playtest — a competent greedy player vs the bots for one
// entire round. Logs the progression curve, combo usage, map dryness, and the
// final standings. Run (from server/):  npx tsx balance-test.mjs   (own server, port 2601)
// Optional: ROUND_SECONDS=420 to match prod length (default here).
import { createServer } from "http";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { Encoder } from "@colyseus/schema";
import { ArenaRoom } from "./src/ArenaRoom";

Encoder.BUFFER_SIZE = 512 * 1024;
// classic reads CLASSIC_SECONDS (ROUND_SECONDS is battle-only now); keep both envs working
process.env.CLASSIC_SECONDS = process.env.CLASSIC_SECONDS || process.env.ROUND_SECONDS || "300";
process.env.ROUND_SECONDS = process.env.ROUND_SECONDS || process.env.CLASSIC_SECONDS;

const PORT = 2601;
const GATE = 1.0; // mirror CONFIG.eatSizeGate
const gameServer = new Server({ transport: new WebSocketTransport({ server: createServer() }) });
gameServer.define("arena", ArenaRoom);
await gameServer.listen(PORT);

const room = await new Client(`ws://localhost:${PORT}`).create("arena", { name: "TESTER" });
const myId = room.sessionId;
const me = () => room.state.holes.get(myId);
const t0 = Date.now();
const secs = () => (Date.now() - t0) / 1000;

let lastLevel = 0, peakCombo = 1, comboSamples = 0, comboSum = 0;

// competent-greedy policy: flee holes that can eat you, else chase nearest eatable (edge-contact aware)
setInterval(() => {
  const m = me(); if (!m || m.dead) return;
  let fx = 0, fz = 0, flee = false;
  room.state.holes.forEach((o, oid) => {
    if (oid === myId || o.dead) return;
    if (o.radius > m.radius * 1.25) {
      const d = Math.hypot(o.x - m.x, o.z - m.z);
      if (d < m.radius * 7) { fx += m.x - o.x; fz += m.z - o.z; flee = true; }
    }
  });
  if (flee) { const l = Math.hypot(fx, fz) || 1; room.send("input", { dx: fx / l, dz: fz / l }); return; }
  let best = null, bd = 1e9;
  room.state.food.forEach((f) => {
    if (f.size >= m.radius * GATE) return;
    const d = Math.hypot(f.x - m.x, f.z - m.z) - f.size * 0.5; // edge-contact mirror
    if (d < bd) { bd = d; best = f; }
  });
  if (best) { const dx = best.x - m.x, dz = best.z - m.z, l = Math.hypot(dx, dz) || 1; room.send("input", { dx: dx / l, dz: dz / l }); }
}, 50);

// samplers
const lvIv = setInterval(() => {
  const m = me(); if (!m) return;
  if (m.combo > peakCombo) peakCombo = m.combo;
  comboSum += m.combo; comboSamples++;
  if (m.level !== lastLevel) {
    lastLevel = m.level;
    let eat = 0, tot = 0; room.state.food.forEach((f) => { tot++; if (f.size < m.radius * GATE) eat++; });
    console.log(`Lv${String(m.level).padStart(2)}  t=${secs().toFixed(0).padStart(3)}s  r=${m.radius.toFixed(2).padStart(5)}  score=${String(Math.round(m.score)).padStart(6)}  eatable=${Math.round(100 * eat / tot)}%`);
  }
}, 100);

const statIv = setInterval(() => {
  const m = me(); if (!m) return;
  const rivals = []; room.state.holes.forEach((h, id) => { if (id !== myId) rivals.push(Math.round(h.score)); });
  rivals.sort((a, b) => b - a);
  console.log(`  [${secs().toFixed(0)}s] food=${room.state.food.size} me=${Math.round(m.score)} (r=${m.radius.toFixed(1)}, Lv${m.level}) topBot=${rivals[0]} avgCombo=${(comboSum / Math.max(1, comboSamples)).toFixed(2)}`);
}, 30000);

await new Promise((res) => {
  room.onStateChange((s) => { if (s.phase === "ended") res(); });
  setTimeout(res, (Number(process.env.ROUND_SECONDS) + 30) * 1000); // hard cap
});
clearInterval(lvIv); clearInterval(statIv);

const m = me();
const standings = []; room.state.holes.forEach((h, id) => standings.push({ name: h.name, score: Math.round(h.score), lvl: h.level, r: +h.radius.toFixed(1), me: id === myId }));
standings.sort((a, b) => b.score - a.score);
console.log(`\n=== MATCH OVER at t=${secs().toFixed(0)}s ===`);
standings.forEach((s, i) => console.log(`  ${i + 1}. ${s.me ? "→ " : "  "}${s.name.padEnd(8)} score=${String(s.score).padStart(6)}  Lv${s.lvl}  r=${s.r}`));
console.log(`\nplayer: Lv${m.level} r=${m.radius.toFixed(2)} peakCombo=x${peakCombo} avgCombo=${(comboSum / Math.max(1, comboSamples)).toFixed(2)}`);
console.log(`monument eatable (needs r>19.5): ${m.radius > 19.5 ? "YES" : "no"} · food left=${room.state.food.size}`);
process.exit(0);
