// Verify power-ups: boosts spawn, and eating one activates the speed boost.
import { Client } from "colyseus.js";
const room = await new Client("ws://localhost:2567").joinOrCreate("arena", { name: "BoostTest" });
await new Promise((r) => setTimeout(r, 1500));
const me = () => room.state.holes.get(room.sessionId);

let boosts = 0; room.state.food.forEach((f) => { if (f.kind === "boost") boosts++; });
console.log("boosts on map:", boosts);

let gotBoost = false, boostSecs = 0;
const iv = setInterval(() => {
  const m = me(); if (!m) return;
  if (m.boosting) { if (!gotBoost) console.log("BOOSTING activated!"); gotBoost = true; boostSecs += 0.05; }
  // re-target the nearest boost each tick (bots may eat them too)
  let t = null, td = 1e9;
  room.state.food.forEach((f) => { if (f.kind === "boost") { const d = Math.hypot(f.x - m.x, f.z - m.z); if (d < td) { td = d; t = f; } } });
  if (t) { const dx = t.x - m.x, dz = t.z - m.z, l = Math.hypot(dx, dz) || 1; room.send("input", { dx: dx / l, dz: dz / l }); }
}, 50);

await new Promise((r) => setTimeout(r, 15000));
clearInterval(iv);
console.log(`RESULT: boosts spawned=${boosts > 0} · activated boost=${gotBoost} · boosted ~${boostSecs.toFixed(1)}s`);
process.exit(0);
