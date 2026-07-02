/**
 * ArenaRoom — the authoritative game server for one match.
 *
 * THE CORE PRINCIPLE:
 *   Clients send INPUTS (a desired move direction), never positions.
 *   The server integrates movement, decides every eat, and owns all state.
 *
 * The simulation is 2D (x,z plane). hole.io is top-down gameplay wearing a 3D
 * coat — the server math is flat; the client renders these coordinates as 3D
 * models (cars, buildings, trees, people) with a stencil "hole" cut into the
 * ground. The server tells the client WHAT each object is via Food.kind.
 */
import { Room, Client } from "colyseus";
import { ArenaState, Hole, Food } from "./schema";
import { CONFIG, KIND, SMALL_KINDS } from "./config";

const COLORS = [0x14f195, 0x9945ff, 0xff7ad9, 0x4dabf7, 0xffd166, 0xff6b35, 0x00e5ff, 0xb197fc];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: T[]): T => a[(a.length * Math.random()) | 0];

// Deterministic per-block hash → [0,1). Same formula on the client, so the client
// can paint ground tiles that match the server's block layout with no extra sync.
function blockHash(bx: number, bz: number): number {
  const x = Math.round(bx) | 0, z = Math.round(bz) | 0;
  let h = (x * 374761393 + z * 668265263) | 0;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}
// Each block is a typed lot. The TYPE is deterministic (drives ground + placement);
// what fills it can still vary per match.
function blockType(bx: number, bz: number, W: number): string {
  const dist = Math.hypot(bx, bz);
  if (dist < 16) return "open";
  const zone = dist < W * 0.22 ? "downtown" : dist < W * 0.42 ? "midtown" : "outer";
  const h = blockHash(bx, bz);
  // buildings-dominant layout (a hole.io city is mostly building rows); parks/towers/industrial are the minority accents.
  if (zone === "outer") return h < 0.18 ? "park" : h < 0.26 ? "industrial" : h < 0.33 ? "plaza" : "buildings";
  if (zone === "midtown") return h < 0.09 ? "park" : h < 0.15 ? "plaza" : h < 0.30 ? "tower" : "buildings";
  return h < 0.05 ? "park" : h < 0.15 ? "landmark" : h < 0.22 ? "plaza" : h < 0.52 ? "tower" : "buildings";
}

type Vec = { dx: number; dz: number };

export class ArenaRoom extends Room<ArenaState> {
  maxClients = 16;

  private inputs = new Map<string, Vec>();
  private foodSeq = 0;
  private mode = "classic";
  private boost = new Map<string, number>(); // seconds of speed-boost left per hole
  // Per-bot skill state (server-only, never synced). Keyed by hole id.
  private botBrain = new Map<string, { nextDecideAt: number; aimX: number; aimZ: number; wanderUntil: number; wx: number; wz: number; huntId?: string | null }>();
  // Rubber-band effort per bot (0 relaxed .. 1 tryhard), recomputed in steerBots, read by moveHoles.
  private botIntensity = new Map<string, number>();
  // Living city: cars/people that advance each tick (food id → unit direction + speed).
  private movers = new Map<string, { dx: number; dz: number; spd: number }>();
  // Brief spawn protection (hole id → match-time seconds until eatable) so a fresh
  // joiner/respawn isn't instantly swallowed by a giant.
  private spawnSafe = new Map<string, number>();
  // Chain-eat combo per hole: quick successive eats build a score multiplier (x1..x8).
  private combo = new Map<string, { count: number; lastEatAt: number }>();
  // Per-hole velocity for momentum/drift steering (server-only; client prediction mirrors ACCEL).
  private hvel = new Map<string, { vx: number; vz: number }>();
  private static readonly ACCEL = 8; // steering ease — heavier = lower. MUST mirror client MOVE_ACCEL.
  private static roomCount = 0;                 // global live-room cap (create-flood DoS guard)
  private msgCount = new Map<string, number>(); // per-client messages this second (flood guard)

  // Drop message floods; kick a socket that's clearly hostile. Legit client sends ~21/s.
  private flooded(client: Client): boolean {
    const id = client.sessionId;
    const n = (this.msgCount.get(id) || 0) + 1;
    this.msgCount.set(id, n);
    if (n > 200) { try { client.leave(4000); } catch (e) {} return true; }
    return n > 60;
  }

  onCreate(options: any) {
    if (ArenaRoom.roomCount >= CONFIG.maxRooms) throw new Error("server at capacity");
    ArenaRoom.roomCount++;
    this.mode = (options && options.mode === "battle") ? "battle" : "classic";
    this.setState(new ArenaState());
    this.state.mode = this.mode;
    this.state.timeLeft = this.mode === "battle" ? CONFIG.roundSeconds : CONFIG.classicSeconds;
    this.state.zoneR = this.mode === "battle" ? CONFIG.worldSize / 2 : 9999;

    this.buildCity();
    for (let i = 0; i < CONFIG.botCount; i++) this.spawnBot(i);

    this.onMessage("input", (client, msg: any) => {
      if (this.flooded(client)) return;
      let dx = Number(msg?.dx) || 0;
      let dz = Number(msg?.dz) || 0;
      const len = Math.hypot(dx, dz);
      if (!isFinite(len) || len < 1e-4) this.inputs.set(client.sessionId, { dx: 0, dz: 0 });
      else this.inputs.set(client.sessionId, { dx: dx / len, dz: dz / len });
    });
    this.onMessage("ping", (client) => { if (this.flooded(client)) return; client.send("pong"); });

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), 1000 / CONFIG.simHz);
    this.setPatchRate(CONFIG.patchMs);
    this.clock.setInterval(() => this.msgCount.clear(), 1000); // reset the per-second flood counter

    this.clock.setInterval(() => {
      if (this.state.phase !== "playing") return;
      this.state.timeLeft = Math.max(0, this.state.timeLeft - 1);
      if (this.mode === "battle") this.updateZone();
      this.assignKing();
      if (this.state.timeLeft <= 0) this.endMatch();
    }, 1000);

    console.log(`[ArenaRoom ${this.roomId}] created — ${this.state.food.size} objects`);
  }

  onJoin(client: Client, options: any) {
    const spawn = this.openSpawn();
    const h = new Hole();
    // sanitize: cap raw length first, strip HTML + ALL control/zero-width/bidi chars (blocks display
    // spoofing e.g. "Nyx​" impersonating a bot), trim, cap (client also escapes on render)
    h.name = ((options?.name ?? "Player").toString().slice(0, 64)
      .replace(/[<>&"'`\\]|[\x00-\x1f\x7f]|[​-‏‪-‮⁦-⁩﻿]/g, "")
      .trim().slice(0, 16)) || "Player";
    h.x = spawn.x; h.z = spawn.z;
    this.freshStats(h);
    // distinct player palette (bots use COLORS[1..4]); don't clash with them
    const humans = [...this.state.holes.values()].filter((o) => !o.isBot).length;
    // an equipped skin can set the hole color, but only from the known skin palette
    // (MUST mirror the client SKINS[].rim list) so clients can't pick arbitrary colors
    const SKIN_COLORS = [0x9945ff, 0x4a5578, 0xff7a45, 0x3ba9ff, 0x14f195, 0xc4a3ff, 0xe79a44, 0x2a3350];
    const wanted = Number(options?.color) >>> 0;
    h.color = SKIN_COLORS.includes(wanted) ? wanted : [0x14f195, 0xff6b35, 0x00e5ff, 0xb197fc, 0xffd166][humans % 5];
    h.isBot = false;
    this.state.holes.set(client.sessionId, h);
    this.inputs.set(client.sessionId, { dx: 0, dz: 0 });
    this.spawnSafe.set(client.sessionId, this.clock.currentTime / 1000 + (this.finaleActive() ? 6 : 3)); // grace so mid-match joiners aren't instantly eaten (longer in the frenzy)
    console.log(`[ArenaRoom ${this.roomId}] ${h.name} joined`);
  }

  onLeave(client: Client) {
    this.state.holes.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.boost.delete(client.sessionId);
    this.botBrain.delete(client.sessionId);
    this.spawnSafe.delete(client.sessionId);
    this.combo.delete(client.sessionId);
    this.hvel.delete(client.sessionId);
    this.msgCount.delete(client.sessionId);
  }

  onDispose() { ArenaRoom.roomCount = Math.max(0, ArenaRoom.roomCount - 1); this.clock.clear(); } // free the room slot; cancel pending timeouts

  // ---------------------------------------------------------------- simulation
  private tick(dt: number) {
    if (this.state.phase !== "playing") return;
    if (dt <= 0 || dt > 0.1) dt = 1 / CONFIG.simHz;
    try {
      this.steerBots();
      this.moveHoles(dt);
      this.moveTraffic(dt);
      this.resolveEating();
      // combo lapses 0.9s after the last eat
      const nowS = this.clock.currentTime / 1000;
      this.combo.forEach((c, id) => {
        if (c.count > 0 && nowS - c.lastEatAt >= 0.9) {
          c.count = 0;
          const h = this.state.holes.get(id); if (h) h.combo = 1;
        }
      });
      this.resolveHoleVsHole();
      if (this.mode === "battle") this.zoneDamage(dt);
    } catch (e) {
      // one bad frame must never crash the room (and every player in it) — skip it
      console.error(`[ArenaRoom ${this.roomId}] tick error (skipped):`, e);
    }
  }

  private aliveCount(): number { let n = 0; this.state.holes.forEach((h) => { if (!h.dead) n++; }); return n; }

  // FINAL FRENZY — the last stretch of classic (client derives it from timeLeft, zero schema cost).
  private finaleActive(): boolean { return this.mode === "classic" && this.state.timeLeft <= CONFIG.finale.sec; }

  // Crown the score leader (Lv5+). A challenger must beat the king by 10% to steal it (no flicker).
  private assignKing() {
    let king: Hole | null = null; this.state.holes.forEach((h) => { if (h.isKing) king = h; });
    let top: Hole | null = null;
    this.state.holes.forEach((h) => { if (!h.dead && h.level >= 5 && (!top || h.score > (top as Hole).score)) top = h; });
    if (!top) { if (king) (king as Hole).isKing = false; return; }
    const t = top as Hole, k = king as Hole | null;
    if (k && k !== t && !k.dead && t.score < k.score * 1.1) return; // hysteresis
    if (k && k !== t) k.isKing = false;
    if (!t.isKing) t.isKing = true;
  }

  // Battle: the safe zone closes in over the match.
  private updateZone() {
    const half = CONFIG.worldSize / 2, b = CONFIG.battle;
    const elapsed = CONFIG.roundSeconds - this.state.timeLeft;
    const span = Math.max(1, CONFIG.roundSeconds - b.shrinkStartSec - 5);
    const p = Math.max(0, Math.min(1, (elapsed - b.shrinkStartSec) / span));
    this.state.zoneR = half * (1 - (1 - b.endFrac) * p);
  }

  // Battle: holes outside the zone shrink; below minRadius they're eliminated (no respawn).
  private zoneDamage(dt: number) {
    const zr = this.state.zoneR, min = CONFIG.battle.minRadius;
    let alive = 0, last: string | null = null;
    this.state.holes.forEach((h, id) => {
      if (h.dead) return;
      if (Math.hypot(h.x, h.z) > zr) {
        h.radius -= CONFIG.battle.outDamage * dt;
        if (h.radius <= min) { h.dead = true; return; }
      }
      alive++; last = id;
    });
    if (alive <= 1 && this.state.holes.size > 1) this.endMatch(last);
  }

  private speedFor(_radius: number): number {
    // FLAT speed for all sizes (playtest-settled): any bigger=faster bonus lets a snowballed
    // hole run small prey down deterministically (they can never escape — kills BR survivability),
    // and slower-when-big made the late game feel like mud. Flat keeps big holes sweeping
    // (their mouth covers more per meter) while small holes can always outrun trouble.
    // MUST mirror the client speedFor().
    return CONFIG.baseSpeed;
  }

  private moveHoles(dt: number) {
    const bound = CONFIG.worldSize / 2;
    this.state.holes.forEach((h, id) => {
      if (h.dead) return;
      let bt = this.boost.get(id) || 0;
      if (bt > 0) { bt -= dt; if (bt <= 0) { bt = 0; h.boosting = false; } this.boost.set(id, bt); }
      const inp = this.inputs.get(id) || { dx: 0, dz: 0 };
      const rbS = CONFIG.bot.rubber.speedMult, rbT = this.botIntensity.get(id) || 0;
      const botMult = h.isBot ? rbS[0] + (rbS[1] - rbS[0]) * rbT : 1; // rubber-banded bot speed
      const speed = this.speedFor(h.radius) * (bt > 0 ? CONFIG.boostMult : 1) * botMult;
      // momentum: ease velocity toward the input (heavy drifting hole + short coast on release — hole.io feel)
      let v = this.hvel.get(id); if (!v) { v = { vx: 0, vz: 0 }; this.hvel.set(id, v); }
      const k = Math.min(1, ArenaRoom.ACCEL * dt);
      v.vx += (inp.dx * speed - v.vx) * k;
      v.vz += (inp.dz * speed - v.vz) * k;
      h.x += v.vx * dt;
      h.z += v.vz * dt;
      const margin = bound - h.radius * 0.3;
      h.x = Math.max(-margin, Math.min(margin, h.x));
      h.z = Math.max(-margin, Math.min(margin, h.z));
    });
  }

  // Cars drive along their lanes, people walk along sidewalks; both wrap at the map edge.
  private moveTraffic(dt: number) {
    const b = CONFIG.worldSize / 2 - 2;
    this.movers.forEach((m, id) => {
      const f = this.state.food.get(id);
      if (!f) { this.movers.delete(id); return; } // eaten → drop it
      f.x += m.dx * m.spd * dt;
      f.z += m.dz * m.spd * dt;
      if (f.x > b) f.x = -b; else if (f.x < -b) f.x = b;
      if (f.z > b) f.z = -b; else if (f.z < -b) f.z = b;
    });
  }

  private resolveEating() {
    // hoist the hole list ONCE per tick (no MapSchema iterator alloc per food item) and
    // axis-band-reject before the sqrt — skips >95% of hypots on a 300u map.
    const alive: [string, Hole][] = [];
    this.state.holes.forEach((h, id) => { if (!h.dead) alive.push([id, h]); });
    this.state.food.forEach((f, fid) => {
      for (let ai = 0; ai < alive.length; ai++) {
        const hid = alive[ai][0], h = alive[ai][1];
        if (h.dead) continue; // may have died mid-tick (eaten as a rival)
        if (f.size >= h.radius * CONFIG.eatSizeGate) continue; // too big yet
        const reach = h.radius * CONFIG.eatTriggerFrac + f.size * 0.5;
        const dx = f.x - h.x; if (dx > reach || dx < -reach) continue;
        const dz = f.z - h.z; if (dz > reach || dz < -reach) continue;
        if (Math.hypot(dx, dz) - f.size * 0.5 < h.radius * CONFIG.eatTriggerFrac) { // EDGE contact — big objects tip in the moment the rim bites their edge (no straddling)
          if (f.kind === "boost") { this.boost.set(hid, CONFIG.boostDur); h.boosting = true; }
          // chain-eat combo: eats within 0.9s of each other build a multiplier up to x8.
          // Slow ramp (every 4 chained eats) so x8 takes a real streak — casuals see x2-x3.
          const now = this.clock.currentTime / 1000;
          const c = this.combo.get(hid) || { count: 0, lastEatAt: 0 };
          c.count = now - c.lastEatAt < 0.9 ? c.count + 1 : 1;
          c.lastEatAt = now;
          this.combo.set(hid, c);
          h.combo = Math.min(8, 1 + Math.floor(c.count / 4));
          const finale = this.finaleActive();
          this.grow(h, f.points, h.combo * (finale ? CONFIG.finale.scoreMult : 1)); // combo (+finale) multiply SCORE only
          // per-run stats (drive achievements + results)
          h.foodEaten++;
          if (f.size > h.bigEat) h.bigEat = f.size;
          if (h.combo > h.bestCombo) h.bestCombo = h.combo;
          const small = SMALL_KINDS.includes(f.kind);
          if (!small && f.kind !== "boost") { // city devour meter (structures only)
            this.state.cityEaten++;
            h.structures++;
            const pctBefore = ((this.state.cityEaten - 1) / Math.max(1, this.state.cityTotal)) * 100;
            const pct = (this.state.cityEaten / Math.max(1, this.state.cityTotal)) * 100;
            for (const m of [25, 50, 75, 90]) if (pctBefore < m && pct >= m) this.broadcast("city_milestone", { pct: m });
            const trophy = CONFIG.trophies[f.kind];
            if (trophy) { this.grow(h, trophy); this.broadcast("trophy", { kind: f.kind, by: h.name, bonus: trophy }); }
            if (this.state.cityEaten >= this.state.cityTotal * 0.9) { // CITY DEVOURED — rare alternate ending
              let dev: Hole | null = null; let devId: string | null = null;
              this.state.holes.forEach((o, oid) => { if (!dev || o.structures > (dev as Hole).structures) { dev = o; devId = oid; } });
              if (dev) this.grow(dev, 1500);
              this.endMatch(devId, "devoured");
            }
          }
          this.state.food.delete(fid);
          if (f.kind === "boost") this.spawnBoost();
          else if (CONFIG.respawnSmall && small && !finale) this.spawnSmallSomewhere(); // finale: the world runs dry
          break; // a food object can be eaten by only ONE hole per tick
        }
      }
    });
  }

  private resolveHoleVsHole() {
    const holes = Array.from(this.state.holes.entries());
    for (let i = 0; i < holes.length; i++) {
      const aid = holes[i][0], a = holes[i][1];
      if (a.dead) continue; // hoisted: a dead eater skips its whole inner loop
      for (let j = 0; j < holes.length; j++) {
        if (i === j) continue;
        const bid = holes[j][0], b = holes[j][1];
        if (b.dead) continue;
        if (a.radius <= b.radius * CONFIG.holeEatSizeRatio) continue;
        const bSafe = this.spawnSafe.get(bid); if (bSafe && this.clock.currentTime / 1000 < bSafe) continue; // don't eat a just-spawned hole
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < a.radius * CONFIG.holeEatReach) {
          // swallowing a rival is a BIG payout (late-game food that fights back) + combo surge
          const bonus = Math.max(60, Math.round(b.score * 0.5)) + b.level * 25;
          this.grow(a, bonus);
          a.kills++;
          a.combo = Math.min(8, a.combo + 2);
          // broadcast the killer's sessionId (names aren't unique — a player named "Nyx" must not
          // steal the bot's kill credit / farm unlocks); client compares ids, shows names.
          if (b.isKing) { // regicide — bounty on the crowned leader
            const kingBonus = Math.max(300, Math.min(1000, Math.round(b.score * 0.25)));
            this.grow(a, kingBonus);
            this.broadcast("king_slain", { killer: a.name, killerId: aid, victim: b.name, bonus: kingBonus });
            b.isKing = false;
          } else this.broadcast("swallowed", { hunter: a.name, hunterId: aid, prey: b.name, bonus });
          b.dead = true;
          if (this.mode === "battle") { if (this.aliveCount() <= 1) this.endMatch(); } // eliminated for good
          else if (!this.finaleActive()) this.clock.setTimeout(() => { const h = this.state.holes.get(bid); if (h) this.respawnHole(bid, h); }, 1400); // brief death — but FINALE deaths are final
        }
      }
    }
  }

  // CONTINUOUS growth (hole.io): every eat nudges the radius bigger by interpolating
  // within the current level band, instead of stair-stepping only at level-ups.
  // scoreMult (the chain combo) inflates SCORE for rank — never growth, or x8 chains snowball the size curve.
  private grow(h: Hole, points: number, scoreMult = 1) {
    if (h.isBot) points = Math.max(1, Math.round(points * CONFIG.bot.xpMult)); // bots grow slower
    h.score += Math.round(points * scoreMult);
    h.xp += points;
    while (h.level <= CONFIG.levelXP.length && h.xp >= h.xpForNext) {
      h.xp -= h.xpForNext;
      h.level++;
      h.baseR = Math.min(CONFIG.maxRadius, (h.baseR || CONFIG.startRadius) * CONFIG.levelGrowth); // new band floor
      h.xpForNext = CONFIG.levelXP[h.level - 1] ?? 0;
    }
    if (h.level > CONFIG.levelXP.length) { h.xp = 0; h.xpForNext = 0; } // maxed → XP ring reads full
    const baseR = h.baseR || CONFIG.startRadius;
    const frac = h.xpForNext > 0 ? h.xp / h.xpForNext : 1;
    h.radius = Math.min(CONFIG.maxRadius, baseR * Math.pow(CONFIG.levelGrowth, frac)); // creep within the band
  }

  // Reset a hole to a fresh level-1 state (used on join, bot spawn, respawn, reset).
  // keepScore: classic respawn keeps your SCORE (rank progress) — losing all size is
  // already the penalty; halving score too made one early death an unrecoverable spiral.
  private freshStats(h: Hole, keepScore = false) {
    h.radius = CONFIG.startRadius;
    h.baseR = CONFIG.startRadius; // reset the continuous-growth band floor
    h.score = keepScore ? h.score : 0;
    h.isKing = false;
    if (!keepScore) { // fresh MATCH — clear run stats (a classic respawn keeps achievement progress)
      h.kills = 0; h.bestCombo = 1; h.bigEat = 0; h.structures = 0; h.foodEaten = 0;
    }
    h.level = 1;
    h.xp = 0;
    h.xpForNext = CONFIG.levelXP[0];
    h.dead = false;
    h.boosting = false;
    h.combo = 1;
  }

  // ---------------------------------------------------------------- bots
  private steerBots() {
    const now = this.clock.currentTime / 1000; // seconds
    const B = CONFIG.bot, R = B.rubber;
    // rubber-band reference: the best HUMAN score (bots pace themselves against the player)
    let leaderScore = 0;
    this.state.holes.forEach((o) => { if (!o.isBot && o.score > leaderScore) leaderScore = o.score; });
    const lerp = (range: [number, number], t: number) => range[0] + (range[1] - range[0]) * t;
    this.state.holes.forEach((h, id) => {
      if (!h.isBot || h.dead) return;
      let brain = this.botBrain.get(id);
      if (!brain) { brain = { nextDecideAt: 0, aimX: h.x, aimZ: h.z, wanderUntil: 0, wx: 0, wz: 0 }; this.botBrain.set(id, brain); }

      const steerTo = (tx: number, tz: number) => {
        const dx = tx - h.x, dz = tz - h.z, l = Math.hypot(dx, dz) || 1;
        this.inputs.set(id, { dx: dx / l, dz: dz / l });
      };
      const wander = () => {
        if (now >= brain!.wanderUntil) {
          const a = Math.random() * Math.PI * 2;
          brain!.wx = Math.cos(a); brain!.wz = Math.sin(a);
          brain!.wanderUntil = now + B.wanderSec;
        }
        const cl = Math.hypot(h.x, h.z) || 1; // gentle centre bias so wanderers don't hug the wall
        this.inputs.set(id, { dx: brain!.wx - (h.x / cl) * 0.2, dz: brain!.wz - (h.z / cl) * 0.2 });
      };

      // Battle: get back inside the zone (survival, not skill → still reliable).
      if (this.mode === "battle" && Math.hypot(h.x, h.z) > this.state.zoneR * 0.9) { steerTo(0, 0); return; }

      // Reaction gate: between decisions keep steering to the committed aim (no twitch re-path).
      // Cheap early-return BEFORE the rubber-band math — skip it on the ~52/60 ticks that don't decide.
      if (now < brain.nextDecideAt) {
        if (brain.aimX === 1e9) wander(); else steerTo(brain.aimX, brain.aimZ);
        return;
      }
      // (decide tick) rubber-band effort: scale skill to how far this bot trails the player (0 relaxed .. 1 tryhard)
      let rb = 0;
      if (leaderScore >= R.minScore) {
        const gap = (leaderScore - h.score) / leaderScore;
        rb = Math.max(0, Math.min(1, (gap - R.ease) / (R.full - R.ease)));
      }
      this.botIntensity.set(id, rb);
      const effGreed = lerp(R.greed, rb), effReact = lerp(R.reactionSec, rb), effView = lerp(R.viewRange, rb);
      const effJitter = lerp(R.targetJitter, rb), effMistake = lerp(R.mistakeChance, rb);
      brain.nextDecideAt = now + effReact;

      // Flee (imperfect): tighter range, sometimes fails to react.
      let threat: Hole | null = null, threatD = 1e9;
      this.state.holes.forEach((o) => {
        if (o === h || o.dead) return;
        if (o.radius > h.radius * CONFIG.holeEatSizeRatio) {
          const d = Math.hypot(o.x - h.x, o.z - h.z);
          if (d < threatD) { threatD = d; threat = o; }
        }
      });
      if (threat && threatD < h.radius * B.fleeRange && Math.random() < B.fleeChance) {
        const t = threat as Hole;
        brain.aimX = h.x + (h.x - t.x); brain.aimZ = h.z + (h.z - t.z);
        steerTo(brain.aimX, brain.aimZ); return;
      }

      // Hunt rivals: always in battle; in classic only during the FINAL FRENZY (the climax flip).
      const finale = this.finaleActive();
      const huntGreed = finale ? Math.max(CONFIG.finale.greed, effGreed) : effGreed;
      const huntRange = finale ? CONFIG.finale.huntRange : B.huntRange;
      brain.huntId = null;
      if ((this.mode === "battle" || finale) && Math.random() < huntGreed) {
        // fairness: cap how many bots converge on one target
        const hunterCount = new Map<string, number>();
        this.botBrain.forEach((b2) => { if (b2.huntId) hunterCount.set(b2.huntId, (hunterCount.get(b2.huntId) || 0) + 1); });
        let prey: Hole | null = null, preyId: string | null = null, best = -1;
        this.state.holes.forEach((o, oid) => {
          if (o === h || o.dead || h.radius <= o.radius * CONFIG.holeEatSizeRatio) return;
          if ((hunterCount.get(oid) || 0) >= CONFIG.finale.maxHunters) return;
          const d = Math.hypot(o.x - h.x, o.z - h.z);
          if (d > h.radius * huntRange) return;
          const w = (o.score + 50) / Math.max(4, d) * (o.isKing ? 2 : 1); // juicy + close + crowned = priority
          if (w > best) { best = w; prey = o; preyId = oid; }
        });
        if (prey) {
          const p = prey as Hole; brain.huntId = preyId; brain.aimX = p.x; brain.aimZ = p.z; steerTo(p.x, p.z); return;
        }
      }

      // Food: short-sighted + lazy + jittery aim (all rubber-banded). Sometimes just wander.
      if (Math.random() > effGreed) { brain.aimX = 1e9; wander(); return; }

      const seen: Food[] = [];
      let best: Food | null = null, bestD = 1e9;
      this.state.food.forEach((f) => {
        if (f.size >= h.radius * CONFIG.eatSizeGate) return;
        const d = Math.hypot(f.x - h.x, f.z - h.z);
        if (d > effView) return;
        seen.push(f);
        if (d < bestD) { bestD = d; best = f; }
      });

      let target: Food | null = best;
      if (seen.length && Math.random() < effMistake) target = seen[(Math.random() * seen.length) | 0];

      if (target) {
        const t = target as Food, jit = effJitter * effView;
        brain.aimX = t.x + (Math.random() * 2 - 1) * jit;
        brain.aimZ = t.z + (Math.random() * 2 - 1) * jit;
        steerTo(brain.aimX, brain.aimZ);
      } else {
        brain.aimX = 1e9; wander(); // nothing in view → roam, don't beeline to (0,0)
      }
    });
  }

  // ---------------------------------------------------------------- world gen
  private addFood(kind: string, x: number, z: number, yaw = 0, move = false) {
    const k = KIND[kind] || KIND.car;
    const f = new Food();
    f.kind = kind; f.x = x; f.z = z; f.yaw = yaw;
    f.size = k.size; f.points = k.points;
    const id = "f" + this.foodSeq++;
    this.state.food.set(id, f);
    // only vehicles placed ON a lane and people placed ON a sidewalk move (move=true);
    // parked vans / park crowds / center props stay put so nothing drives off-road.
    const spd = move ? CONFIG.traffic[kind] : 0;
    if (spd) this.movers.set(id, { dx: Math.cos(yaw), dz: -Math.sin(yaw), spd }); // nose = +localZ = (cos yaw, -sin yaw)
  }

  // Pick a street-wall building tier by zone (big towers/megas placed separately).
  private pickBuilding(zone: string): string {
    const r = Math.random();
    if (zone === "downtown") return r < 0.5 ? "building_mid" : r < 0.75 ? "house" : "building_small";
    if (zone === "midtown") return r < 0.4 ? "building_mid" : r < 0.62 ? "factory" : r < 0.82 ? "house" : "building_small";
    return r < 0.35 ? "house" : r < 0.55 ? "factory" : "building_small";
  }

  // Street wall: buildings line each block edge, facing the road.
  private streetWall(bx: number, bz: number, zone: string) {
    const cell = CONFIG.city.cell, roadW = CONFIG.city.roadW;
    const hb = blockHash(bx, bz), hj = blockHash(bx, bz + 7); // per-block character
    const setback = roadW / 2 + 2.2 + hb * 1.6;   // 2.2..3.8 varied setback
    const jitter = (hj - 0.5) * 0.18;             // small shared yaw skew (radians)
    const frontHalf = cell / 2 - (roadW / 2 + 2.0);
    const edges = [
      { nx: 1, nz: 0, facing: -Math.PI / 2 },
      { nx: -1, nz: 0, facing: Math.PI / 2 },
      { nx: 0, nz: 1, facing: 0 },
      { nx: 0, nz: -1, facing: Math.PI },
    ];
    for (const e of edges) {
      let cursor = -frontHalf, guard = 0;
      while (cursor < frontHalf && guard++ < 5) {  // was 3 → fuller walls
        const kind = this.pickBuilding(zone);
        const width = KIND[kind].size * 2;
        const along = cursor + width / 2;
        if (along > frontHalf) break;
        const px = e.nx !== 0 ? bx + e.nx * setback : bx + along;
        const pz = e.nx !== 0 ? bz + along : bz + e.nz * setback;
        cursor += width + rand(0.2, 0.7);           // tighter gaps
        if (Math.hypot(px, pz) < 16 || Math.random() < 0.06) continue; // fewer gaps (was 0.12)
        this.addFood(kind, px, pz, e.facing + jitter);
        if (Math.random() < 0.5) {                   // sidewalk prop at the street corner
          const off = width / 2 + 1.2;
          const sx = e.nx !== 0 ? bx + e.nx * (setback - 2.2) : bx + along + off;
          const sz = e.nx !== 0 ? bz + along + off : bz + e.nz * (setback - 2.2);
          if (Math.hypot(sx, sz) > 16) this.addFood(pick(["cone", "trash", "hydrant", "kiosk"]), sx, sz, 0);
        }
      }
    }
  }

  private laneLines: number[] = []; // road centre-lines (built once; reused by spawnSmallSomewhere)

  private buildCity() {
    const W = CONFIG.worldSize, cell = CONFIG.city.cell, roadW = CONFIG.city.roadW;
    const lines: number[] = [];
    for (let p = -W / 2 + cell; p < W / 2; p += cell) lines.push(p);
    this.laneLines = lines;
    const inner = cell / 2 - roadW / 2 - 1.5; // usable half-extent inside a block

    // Per-block placement, by deterministic block type.
    for (let bx = -W / 2 + cell / 2; bx < W / 2; bx += cell) {
      for (let bz = -W / 2 + cell / 2; bz < W / 2; bz += cell) {
        const t = blockType(bx, bz, W);
        if (t === "open") continue;
        const dist = Math.hypot(bx, bz);
        const zone = dist < W * 0.22 ? "downtown" : dist < W * 0.42 ? "midtown" : "outer";

        if (t === "park") { this.fillPark(bx, bz, inner); continue; }

        if (t === "industrial") {
          const hy = blockHash(bx, bz) * Math.PI / 2;
          this.addFood("crane", bx, bz - inner * 0.35, hy);
          this.addFood("factory", bx - inner * 0.5, bz + inner * 0.45, hy);
          this.addFood("factory", bx + inner * 0.5, bz + inner * 0.45, hy);
          for (let i = 0; i < 5; i++) this.addFood("crate", bx + (i - 2) * (inner * 0.32), bz - inner * 0.85, 0);
          for (let i = 0; i < 3; i++) this.addFood("crate", bx + (i - 1) * 2.0, bz - inner * 0.55, 0);
          for (let i = 0; i < 3; i++) this.addFood("trash", bx - inner * 0.8 + i * 1.4, bz + inner * 0.85, 0);
          this.addFood("van", bx + inner * 0.6, bz - inner * 0.9, Math.PI / 2);
          continue;
        }

        if (t === "landmark") {
          const ly = Math.floor(blockHash(bx, bz) * 4) * Math.PI / 2; // square to the grid
          this.addFood(pick(["megatower", "stadium", "monument", "tower_tall"]), bx, bz, ly);
          continue;
        }

        if (t === "plaza") {
          const cy = blockHash(bx, bz);
          this.addFood(cy < 0.5 ? "fountain" : "statue", bx, bz, 0);
          this.addFood("busstop", bx, bz - inner * 0.7, 0);
          for (let i = 0; i < 4; i++) {
            const a = i * Math.PI / 2 + cy * 6.283;
            this.addFood("bench", bx + Math.cos(a) * inner * 0.55, bz + Math.sin(a) * inner * 0.55, a);
          }
          this.addFood("tree", bx - inner * 0.85, bz - inner * 0.85, 0);
          this.addFood("tree", bx + inner * 0.85, bz + inner * 0.85, 0);
          this.addFood("lamp", bx + inner * 0.85, bz - inner * 0.85, 0);
          this.addFood("lamp", bx - inner * 0.85, bz + inner * 0.85, 0);
          for (let i = 0; i < 6; i++) this.addFood("person", bx + rand(-inner * 0.7, inner * 0.7), bz + rand(-inner * 0.7, inner * 0.7), rand(0, 6.28));
          for (let i = 0; i < 4; i++) this.addFood(pick(["cone", "flowers", "kiosk"]), bx + rand(-inner * 0.8, inner * 0.8), bz + rand(-inner * 0.8, inner * 0.8), 0);
          continue;
        }

        if (t === "tower") {
          // one big tower centred, squared to the grid; decorative corners that don't clip it
          const cy = Math.floor(blockHash(bx, bz) * 4) * Math.PI / 2;
          this.addFood(pick(["skyscraper", "office_tower", "hotel_tower", "mall"]), bx, bz, cy);
          const c = inner * 0.96;
          this.addFood("tree", bx - c, bz - c, 0); this.addFood("tree", bx + c, bz + c, 0);
          this.addFood("lamp", bx + c, bz - c, 0); this.addFood("lamp", bx - c, bz + c, 0);
          for (let i = 0; i < 4; i++) {
            const a = i * Math.PI / 2 + cy;
            this.addFood(i % 2 ? "bench" : "planter", bx + Math.cos(a) * inner * 0.62, bz + Math.sin(a) * inner * 0.62, a);
          }
          for (let i = 0; i < 3; i++) this.addFood("person", bx + rand(-inner * 0.6, inner * 0.6), bz + rand(-inner * 0.6, inner * 0.6), rand(0, 6.28));
          this.addFood(pick(["kiosk", "cone", "trash"]), bx + inner * 0.5, bz - inner * 0.5, 0);
          continue;
        }

        // buildings → street wall facing the roads, mostly-open courtyard (a couple of trees)
        this.streetWall(bx, bz, zone);
        if (Math.random() < 0.35) this.addFood("tree", bx + rand(-inner * 0.45, inner * 0.45), bz + rand(-inner * 0.45, inner * 0.45), rand(0, 6.28));
        if (Math.random() < 0.2) this.addFood(pick(["bush", "planter", "lamp"]), bx + rand(-inner * 0.4, inner * 0.4), bz + rand(-inner * 0.4, inner * 0.4), 0);
      }
    }

    // Street lamps along the sidewalks
    lines.forEach((p) => {
      for (let q = -W / 2 + 20; q < W / 2; q += 46) {
        if (Math.hypot(p + roadW / 2 + 1.4, q) > 15) this.addFood("lamp", p + roadW / 2 + 1.4, q, 0);
        if (Math.hypot(q, p - (roadW / 2 + 1.4)) > 15) this.addFood("lamp", q, p - (roadW / 2 + 1.4), 0);
      }
    });

    // Vehicles on the lanes
    for (let i = 0; i < CONFIG.city.cars; i++) {
      const onX = Math.random() < 0.5, lane = pick(lines), dir = Math.random() < 0.5 ? 1 : -1;
      const laneOff = dir * 2.2, along = rand(-W / 2, W / 2);
      const x = onX ? along : lane + laneOff, z = onX ? lane + laneOff : along;
      const yaw = onX ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      const vr = Math.random();
      this.addFood(vr < 0.78 ? "car" : vr < 0.92 ? "van" : "bus", x, z, yaw, true); // on a lane → drives
    }
    // Seed the open center with early-game snacks (L1–L3), ringed off the spawn point.
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * 6.283, rr = rand(9, 26);
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      this.addFood(pick(["cone", "trash", "flowers", "person", "person", "bush", "kiosk", "car", "crate", "hydrant"]), x, z, rand(0, 6.28));
    }
    for (let i = 0; i < CONFIG.boostCount; i++) this.spawnBoost(); // speed-boost pickups

    // Sidewalk furniture + pedestrians, placed ON the sidewalks (not scattered).
    const sideOff = roadW / 2 + 1.6;
    const sidewalkSpot = () => {
      const lane = pick(lines), along = rand(-W / 2 + 5, W / 2 - 5), side = Math.random() < 0.5 ? 1 : -1, onX = Math.random() < 0.5;
      return { x: onX ? along : lane + sideOff * side, z: onX ? lane + sideOff * side : along, onX };
    };
    for (let i = 0; i < 110; i++) {
      const s = sidewalkSpot(); if (Math.hypot(s.x, s.z) < 15) continue;
      const r = Math.random();
      const kind = r < 0.24 ? "cone" : r < 0.44 ? "trash" : r < 0.58 ? "hydrant"
        : r < 0.72 ? "bench" : r < 0.86 ? "planter" : r < 0.95 ? "flowers" : "busstop";
      this.addFood(kind, s.x, s.z, s.onX ? 0 : Math.PI / 2);
    }
    for (let i = 0; i < CONFIG.city.people; i++) {
      const s = sidewalkSpot(); if (Math.hypot(s.x, s.z) < 14) { i--; continue; }
      // face ALONG the sidewalk so they walk down it (not across into traffic)
      const pyaw = s.onX ? (Math.random() < 0.5 ? 0 : Math.PI) : (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
      this.addFood("person", s.x, s.z, pyaw, true); // on a sidewalk → walks
    }

    // City devour meter: total STRUCTURES (respawning smalls + boosts don't count),
    // and guarantee the apex trophy exists — a map can roll zero monuments.
    let hasMonument = false, total = 0;
    this.state.food.forEach((f) => {
      if (f.kind === "monument") hasMonument = true;
      if (!SMALL_KINDS.includes(f.kind) && f.kind !== "boost") total++;
    });
    if (!hasMonument) { this.addFood("monument", cell * 1.5, cell * 1.5, 0); total++; }
    this.state.cityTotal = total;
    this.state.cityEaten = 0;
  }

  // A park lot: a centrepiece, then greenery laid out on a loose grid (no pile-ups).
  private fillPark(bx: number, bz: number, inner: number) {
    if (blockHash(bx + 1, bz) < 0.5) this.addFood("fountain", bx, bz, 0);
    else this.addFood("statue", bx, bz, 0);
    const n = 5, span = inner * 0.84, step = (2 * span) / (n - 1);
    const fills = ["tree", "bush", "flowers", "bush", "tree", "planter", "bush", "flowers"];
    let k = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const px = bx - span + i * step + rand(-1.6, 1.6), pz = bz - span + j * step + rand(-1.6, 1.6);
      if (Math.hypot(px - bx, pz - bz) < inner * 0.36) continue; // keep the centre clear
      this.addFood(fills[(k++) % fills.length], px, pz, rand(0, 6.28));
    }
    this.addFood("bench", bx - span, bz, Math.PI / 2); this.addFood("bench", bx + span, bz, Math.PI / 2);
    this.addFood("lamp", bx - inner, bz - inner, 0); this.addFood("lamp", bx + inner, bz + inner, 0);
    this.addFood("lamp", bx, bz - span, 0); this.addFood("lamp", bx, bz + span, 0);
    this.addFood("bench", bx, bz - span * 0.5, 0); this.addFood("bench", bx, bz + span * 0.5, 0);
    for (let i = 0; i < 3; i++) this.addFood("person", bx + rand(-span, span), bz + rand(-span, span), rand(0, 6.28));
  }

  private spawnSmallSomewhere() {
    const W = CONFIG.worldSize, cell = CONFIG.city.cell, roadW = CONFIG.city.roadW, kind = pick(SMALL_KINDS);
    const lines = this.laneLines; // cached — identical every call, was rebuilt per respawn
    const clearOfHoles = (x: number, z: number) => { let ok = true; this.state.holes.forEach((h) => { if (!h.dead && Math.hypot(x - h.x, z - h.z) < h.radius * 1.6) ok = false; }); return ok; };

    if (kind === "car" || kind === "van" || kind === "bus") { // respawn a vehicle ON a lane so it drives on the road
      for (let t = 0; t < 10; t++) {
        const onX = Math.random() < 0.5, lane = pick(lines), dir = Math.random() < 0.5 ? 1 : -1, laneOff = dir * 2.2, along = rand(-W / 2 + 6, W / 2 - 6);
        const x = onX ? along : lane + laneOff, z = onX ? lane + laneOff : along;
        const yaw = onX ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
        if (Math.hypot(x, z) > 15 && clearOfHoles(x, z)) { this.addFood(kind, x, z, yaw, true); return; }
      }
      return;
    }
    if (kind === "person") { // respawn a pedestrian ON a sidewalk so they walk along it
      const sideOff = roadW / 2 + 1.6;
      for (let t = 0; t < 10; t++) {
        const onX = Math.random() < 0.5, lane = pick(lines), side = Math.random() < 0.5 ? 1 : -1, along = rand(-W / 2 + 6, W / 2 - 6);
        const x = onX ? along : lane + sideOff * side, z = onX ? lane + sideOff * side : along;
        const pyaw = onX ? (Math.random() < 0.5 ? 0 : Math.PI) : (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
        if (Math.hypot(x, z) > 14 && clearOfHoles(x, z)) { this.addFood("person", x, z, pyaw, true); return; }
      }
      return;
    }
    // static props (cones, trash, bushes…) → anywhere clear of holes
    let x = 0, z = 0;
    for (let t = 0; t < 8; t++) { x = rand(-W / 2 + 4, W / 2 - 4); z = rand(-W / 2 + 4, W / 2 - 4); if (clearOfHoles(x, z)) break; }
    this.addFood(kind, x, z, rand(0, 6.28));
  }

  private spawnBoost() {
    const W = CONFIG.worldSize;
    let x = 0, z = 0;
    for (let t = 0; t < 8; t++) {
      x = rand(-W / 2 + 6, W / 2 - 6); z = rand(-W / 2 + 6, W / 2 - 6);
      let clear = true;
      this.state.holes.forEach((h) => { if (!h.dead && Math.hypot(x - h.x, z - h.z) < h.radius * 2) clear = false; });
      if (clear) break;
    }
    this.addFood("boost", x, z, 0);
  }

  private spawnBot(i: number) {
    const h = new Hole();
    const s = this.openSpawn();
    h.name = CONFIG.botNames[i % CONFIG.botNames.length];
    h.x = s.x; h.z = s.z;
    this.freshStats(h);
    h.color = COLORS[(i + 1) % COLORS.length];
    h.isBot = true;
    const id = "bot_" + i;
    this.state.holes.set(id, h);
    this.inputs.set(id, { dx: 0, dz: 0 });
  }

  private respawnHole(id: string, h: Hole) {
    const s = this.openSpawn();
    h.x = s.x; h.z = s.z;
    this.freshStats(h, true);
    this.spawnSafe.set(id, this.clock.currentTime / 1000 + 3); // grace after respawn too
  }

  // a spawn point clear of big rival holes (so mid-match joiners don't land under a giant)
  private openSpawn() {
    for (let t = 0; t < 12; t++) {
      const r = t < 6 ? 12 : 120, x = rand(-r, r), z = rand(-r, r);
      let ok = true;
      this.state.holes.forEach((h) => { if (!h.dead && h.radius > 3 && Math.hypot(x - h.x, z - h.z) < h.radius * 6) ok = false; });
      if (ok) return { x, z };
    }
    return { x: rand(-12, 12), z: rand(-12, 12) };
  }

  private endMatch(winnerId?: string | null, reason: "time" | "lastalive" | "devoured" = "time") {
    if (this.state.phase !== "playing") return; // guard against double-end (timer + zone + devoured)
    this.state.phase = "ended";
    let winner: Hole | null = winnerId ? (this.state.holes.get(winnerId) || null) : null;
    let winId: string | null = winner ? winnerId! : null;
    if (!winner) this.state.holes.forEach((h, id) => { if (!h.dead && (!winner || h.score > (winner as Hole).score)) { winner = h; winId = id; } });
    if (!winner) this.state.holes.forEach((h, id) => { if (!winner || h.score > (winner as Hole).score) { winner = h; winId = id; } });
    if (this.mode === "battle" && winnerId) reason = "lastalive";
    console.log(`[ArenaRoom ${this.roomId}] match over (${this.mode}, ${reason}) — winner: ${winner ? (winner as Hole).name : "?"}`);
    // Staking settlement hook (future): the authoritative server would settle the pot here.
    // winnerId lets the client verify "did I win?" by sessionId, not by (non-unique) name.
    this.broadcast("match_over", { winner: winner ? (winner as Hole).name : null, winnerId: winId, reason });
    this.clock.setTimeout(() => this.resetMatch(), 6000);
  }

  private resetMatch() {
    this.state.food.clear();
    this.boost.clear();
    this.botBrain.clear();
    this.movers.clear();
    this.spawnSafe.clear();
    this.combo.clear();
    this.hvel.clear();
    this.botIntensity.clear();
    // keep foodSeq monotonic — reusing ids (f0,f1,…) makes the client keep the
    // previous match's meshes keyed by the same id (stale/ghost world). Fresh ids
    // force every old object to vanish and every new one to be created.
    this.buildCity();
    this.state.holes.forEach((h, id) => {
      const s = this.openSpawn();
      h.x = s.x; h.z = s.z; this.freshStats(h);
      this.inputs.set(id, { dx: 0, dz: 0 });
    });
    this.state.timeLeft = this.mode === "battle" ? CONFIG.roundSeconds : CONFIG.classicSeconds;
    this.state.zoneR = this.mode === "battle" ? CONFIG.worldSize / 2 : 9999;
    this.state.phase = "playing";
    this.broadcast("match_reset", {});
    console.log(`[ArenaRoom ${this.roomId}] new match — ${this.state.food.size} objects`);
  }
}
