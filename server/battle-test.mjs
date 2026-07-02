// Verify battle mode: join the "battle" room as a passive observer near centre,
// watch the safe zone shrink and rivals get eliminated until the match ends.
import { Client } from "colyseus.js";

const room = await new Client("ws://localhost:2567").joinOrCreate("battle", { name: "Watcher" });
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(0);
const alive = () => { let n = 0; room.state.holes.forEach((h) => { if (!h.dead) n++; }); return n; };

let started = false;
room.onStateChange.once(() => { started = true; console.log(`joined: mode=${room.state.mode} zoneR0=${room.state.zoneR.toFixed(0)} holes=${room.state.holes.size}`); });
room.onMessage("match_over", (m) => console.log(`[${T()}s] MATCH OVER — winner ${m.winner} (alive ${alive()})`));

// keep the observer safe at centre so it doesn't skew eliminations
setInterval(() => { if (room) room.send("input", { dx: 0, dz: 0 }); }, 100);

const iv = setInterval(() => {
  if (!started) return;
  console.log(`[${T()}s] phase=${room.state.phase} timeLeft=${Math.round(room.state.timeLeft)} zoneR=${room.state.zoneR.toFixed(0)} alive=${alive()} food=${room.state.food.size}`);
}, 4000);

await new Promise((r) => setTimeout(r, 100000));
clearInterval(iv);
console.log(`\nFINAL: phase=${room.state.phase} zoneR=${room.state.zoneR.toFixed(0)} alive=${alive()}`);
process.exit(0);
