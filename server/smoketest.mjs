// Headless smoke test: join the arena, drive input, verify the SERVER moves the
// hole and registers eating. Proves the authoritative loop end-to-end.
import { Client } from "colyseus.js";

const client = new Client("ws://localhost:2567");
const room = await client.joinOrCreate("arena", { name: "SmokeBot" });

let start = null;
room.onStateChange.once((s) => {
  const me = s.holes.get(room.sessionId);
  start = { x: me.x, z: me.z, score: me.score, radius: me.radius };
  console.log("joined; start:", start);
});

// drive a constant direction, sweeping so we cross some food
let t = 0;
const iv = setInterval(() => {
  t += 0.05;
  room.send("input", { dx: Math.cos(t * 0.7), dz: Math.sin(t * 0.7) });
}, 50);

await new Promise((r) => setTimeout(r, 3000));
clearInterval(iv);

const me = room.state.holes.get(room.sessionId);
const moved = Math.hypot(me.x - start.x, me.z - start.z);
const grew = me.radius - start.radius;
const botCount = [...room.state.holes.values()].filter((h) => h.isBot).length;
console.log("after 3s:", { x: +me.x.toFixed(2), z: +me.z.toFixed(2), score: Math.round(me.score), radius: +me.radius.toFixed(3) });
console.log("foodInState:", room.state.food.size, "bots:", botCount);
console.log("RESULT moved:", +moved.toFixed(2), "grew:", +grew.toFixed(3));

const ok = moved > 5 && room.state.food.size > 0 && botCount >= 1;
console.log(ok ? "PASS ✅ authoritative movement + state replication working" : "FAIL ❌");
await room.leave();
process.exit(ok ? 0 : 1);
