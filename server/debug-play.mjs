// Instrumented playthrough: greedily plays a FULL match (incl. end → reset) and
// logs anomalies — NaN, stuck hole, score/level regressions, phase changes, an
// emptied world, and food-id reuse on reset (which can collide with client meshes).
import { Client } from "colyseus.js";

const room = await new Client("ws://localhost:2567").joinOrCreate("arena", { name: "Debugger" });
const GATE = 1.0; // mirror server eatSizeGate
const me = () => room.state.holes.get(room.sessionId);
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(1);
const anomalies = [];
const flag = (m) => { anomalies.push(`[${T()}s] ${m}`); console.log("  ⚠ " + m); };

room.onMessage("match_over", (m) => console.log(`[${T()}s] MATCH OVER — winner ${m.winner}`));
room.onMessage("match_reset", () => {
  console.log(`[${T()}s] MATCH RESET`);
  setTimeout(() => {
    const ids = []; room.state.food.forEach((_, id) => ids.push(id));
    const nums = ids.map((s) => +s.slice(1)).filter((n) => !isNaN(n));
    console.log(`  after reset: food=${room.state.food.size}, id range f${Math.min(...nums)}..f${Math.max(...nums)}`);
    if (Math.min(...nums) === 0) flag("RESET reuses food ids from f0 — client meshes keyed by id can collide (stale sinking mesh blocks new food)");
  }, 600);
});

setInterval(() => {
  const m = me(); if (!m) return;
  let best = null, bd = 1e9;
  room.state.food.forEach((f) => { if (f.size < m.radius * GATE) { const d = Math.hypot(f.x - m.x, f.z - m.z); if (d < bd) { bd = d; best = f; } } });
  if (best) { const dx = best.x - m.x, dz = best.z - m.z, l = Math.hypot(dx, dz) || 1; room.send("input", { dx: dx / l, dz: dz / l }); }
}, 50);

let prevLvl = 1, prevScore = 0, prevPhase = "playing", stuckFor = 0, lastPos = null;
setInterval(() => {
  const m = me(); if (!m) return;
  if (!isFinite(m.x) || !isFinite(m.z) || !isFinite(m.radius) || !isFinite(m.score)) flag(`NaN/Inf in hole: x=${m.x} z=${m.z} r=${m.radius} score=${m.score}`);
  if (m.level > prevLvl) { console.log(`[${T()}s] Lv${m.level} r=${m.radius.toFixed(2)} score=${Math.round(m.score)} food=${room.state.food.size}`); prevLvl = m.level; }
  if (m.level < prevLvl) { /* reset/respawn expected */ prevLvl = m.level; }
  if (m.score < prevScore - 1 && room.state.phase === "playing") { /* respawn halves score → expected only after elimination */ }
  prevScore = m.score;
  if (room.state.phase !== prevPhase) { console.log(`[${T()}s] phase ${prevPhase} → ${room.state.phase}`); prevPhase = room.state.phase; }
  if (room.state.phase === "playing" && room.state.food.size < 60) flag(`world nearly eaten: only ${room.state.food.size} objects left`);
  // stuck detection: input is non-zero but position barely moves
  if (lastPos) { const moved = Math.hypot(m.x - lastPos.x, m.z - lastPos.z); if (moved < 0.05 && best4()) { stuckFor += 0.25; if (stuckFor > 3) { flag(`hole stuck ~${stuckFor.toFixed(1)}s at (${m.x.toFixed(1)},${m.z.toFixed(1)}) r=${m.radius.toFixed(2)}`); stuckFor = 0; } } else stuckFor = 0; }
  lastPos = { x: m.x, z: m.z };
}, 250);
function best4() { const m = me(); if (!m) return false; let any = false; room.state.food.forEach((f) => { if (f.size < m.radius * GATE) any = true; }); return any; }

await new Promise((r) => setTimeout(r, 135000));
console.log(`\n=== DONE (${T()}s) ===  anomalies: ${anomalies.length}`);
anomalies.forEach((a) => console.log("  " + a));
const m = me();
console.log(`final: Lv${m ? m.level : "?"} r=${m ? m.radius.toFixed(2) : "?"} phase=${room.state.phase} food=${room.state.food.size} holes=${room.state.holes.size}`);
process.exit(0);
