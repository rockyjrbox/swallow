/**
 * local-sim.js — self-contained single-player port of the ArenaRoom server.
 *
 * Faithful browser translation of server/src/{config,schema,ArenaRoom}.ts so the
 * game is playable single-player vs bots with NO server. Exposes `window.LocalRoom`
 * as a drop-in replacement for a Colyseus `room`.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- CONFIG
  var CONFIG = {
    worldSize: 300,
    maxRooms: 20,

    startRadius: 1.4,
    maxRadius: 24,
    baseSpeed: 15,

    eatTriggerFrac: 1.0,
    eatSizeGate: 1.0,
    holeEatSizeRatio: 1.25,
    holeEatReach: 0.66,

    levelXP: [25, 55, 100, 170, 280, 450, 700, 1100, 1800, 2900, 4600, 6800, 9500, 13000, 17000],
    levelGrowth: 1.28,

    city: {
      cell: 42,
      roadW: 10,
      cars: 100,
      people: 65,
    },
    traffic: { car: 9, van: 8, bus: 7, person: 1.4 },
    respawnSmall: true,

    botCount: 5,
    botNames: ["Nyx", "Maw", "Abyss", "Rift", "Hex", "Void", "Null", "Gloom"],
    bot: {
      xpMult: 0.85,
      fleeRange: 4.6,
      fleeChance: 0.85,
      huntRange: 9,
      wanderSec: 1.4,
      rubber: {
        minScore: 300,
        ease: 0.15,
        full: 0.75,
        greed: [0.7, 0.97],
        reactionSec: [0.3, 0.12],
        viewRange: [38, 75],
        targetJitter: [0.24, 0.05],
        mistakeChance: [0.12, 0.02],
        speedMult: [0.86, 0.96],
      },
    },

    roundSeconds: 420,
    classicSeconds: 300,

    finale: {
      sec: 75,
      scoreMult: 2,
      greed: 0.95,
      huntRange: 14,
      maxHunters: 2,
    },
    trophies: { stadium: 250, megatower: 350, monument: 500 },

    battle: {
      shrinkStartSec: 60,
      endFrac: 0.1,
      outDamage: 2.6,
      minRadius: 1.0,
    },

    boostCount: 8,
    boostDur: 5,
    boostMult: 1.7,

    simHz: 60,
    patchMs: 50,
  };

  var KIND = {
    boost: { size: 0.7, points: 3 },
    // L1
    cone: { size: 0.3, points: 1 },
    hydrant: { size: 0.45, points: 2 },
    trash: { size: 0.55, points: 2 },
    flowers: { size: 0.6, points: 2 },
    kiosk: { size: 0.5, points: 2 },
    crate: { size: 0.8, points: 2 },
    lamp: { size: 0.7, points: 2 },
    person: { size: 0.85, points: 1 },
    planter: { size: 1.05, points: 3 },
    bush: { size: 1.2, points: 3 },
    // L2
    bench: { size: 1.7, points: 4 },
    statue: { size: 1.9, points: 9 },
    // L3
    car: { size: 2.3, points: 6 },
    tree: { size: 2.6, points: 9 },
    // L4
    busstop: { size: 2.9, points: 9 },
    van: { size: 3.2, points: 11 },
    // L5
    bus: { size: 3.7, points: 16 },
    fountain: { size: 4.2, points: 20 },
    // L6
    building_small: { size: 4.9, points: 16 },
    // L7
    house: { size: 5.6, points: 24 },
    factory: { size: 6.3, points: 30 },
    // L8
    building_mid: { size: 7.2, points: 34 },
    crane: { size: 8.0, points: 46 },
    // L9
    mall: { size: 9.2, points: 55 },
    skyscraper: { size: 10.4, points: 70 },
    // L10
    office_tower: { size: 11.8, points: 95 },
    hotel_tower: { size: 13.0, points: 120 },
    tower_tall: { size: 14.8, points: 160 },
    // L11
    stadium: { size: 16.0, points: 210 },
    megatower: { size: 17.5, points: 280 },
    // L12
    monument: { size: 19.5, points: 380 },
  };

  var SMALL_KINDS = ["car", "car", "person", "person", "cone", "trash", "flowers", "bush", "van", "busstop", "kiosk", "crate", "hydrant"];

  var COLORS = [0x14f195, 0x9945ff, 0xff7ad9, 0x4dabf7, 0xffd166, 0xff6b35, 0x00e5ff, 0xb197fc];

  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var pick = function (a) { return a[(a.length * Math.random()) | 0]; };

  // Deterministic per-block hash → [0,1). Byte-identical to server/client.
  function blockHash(bx, bz) {
    var x = Math.round(bx) | 0, z = Math.round(bz) | 0;
    var h = (x * 374761393 + z * 668265263) | 0;
    h = Math.imul((h ^ (h >> 13)), 1274126177) | 0;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  function blockType(bx, bz, W) {
    var dist = Math.hypot(bx, bz);
    if (dist < 16) return "open";
    var zone = dist < W * 0.22 ? "downtown" : dist < W * 0.42 ? "midtown" : "outer";
    var h = blockHash(bx, bz);
    if (zone === "outer") return h < 0.18 ? "park" : h < 0.26 ? "industrial" : h < 0.33 ? "plaza" : "buildings";
    if (zone === "midtown") return h < 0.09 ? "park" : h < 0.15 ? "plaza" : h < 0.30 ? "tower" : "buildings";
    return h < 0.05 ? "park" : h < 0.15 ? "landmark" : h < 0.22 ? "plaza" : h < 0.52 ? "tower" : "buildings";
  }

  // ---------------------------------------------------------------- SMap (MapSchema replacement)
  function SMap() {
    this._keys = [];
    this._map = Object.create(null);
  }
  SMap.prototype.get = function (k) {
    var v = this._map[k];
    return v === undefined ? undefined : v;
  };
  SMap.prototype.set = function (k, v) {
    if (!(k in this._map)) this._keys.push(k);
    this._map[k] = v;
    return this;
  };
  SMap.prototype.delete = function (k) {
    if (k in this._map) {
      delete this._map[k];
      var i = this._keys.indexOf(k);
      if (i >= 0) this._keys.splice(i, 1);
      return true;
    }
    return false;
  };
  SMap.prototype.has = function (k) { return k in this._map; };
  SMap.prototype.clear = function () { this._keys = []; this._map = Object.create(null); };
  SMap.prototype.forEach = function (cb) {
    // iterate over a snapshot of keys so deletes during iteration are safe (matches
    // Colyseus MapSchema which tolerates mid-iteration mutation)
    var keys = this._keys.slice();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = this._map[k];
      if (v !== undefined) cb(v, k);
    }
  };
  SMap.prototype.values = function () {
    var out = [];
    for (var i = 0; i < this._keys.length; i++) out.push(this._map[this._keys[i]]);
    return out;
  };
  SMap.prototype.entries = function () {
    var out = [];
    for (var i = 0; i < this._keys.length; i++) out.push([this._keys[i], this._map[this._keys[i]]]);
    return out;
  };
  Object.defineProperty(SMap.prototype, "size", {
    get: function () { return this._keys.length; },
  });

  // ---------------------------------------------------------------- Hole / Food factories
  function makeHole() {
    return {
      name: "",
      x: 0,
      z: 0,
      radius: 1.6,
      score: 0,
      level: 1,
      xp: 0,
      xpForNext: 15,
      isBot: false,
      dead: false,
      boosting: false,
      combo: 1,
      isKing: false,
      kills: 0,
      bestCombo: 1,
      bigEat: 0,
      structures: 0,
      foodEaten: 0,
      color: 0x14f195,
      baseR: 1.4,
    };
  }
  function makeFood() {
    return { x: 0, z: 0, size: 0.5, points: 1, kind: "car", yaw: 0 };
  }

  // ---------------------------------------------------------------- OnStateChange helper
  function OnStateChange() { this._onceCbs = []; }
  OnStateChange.prototype.once = function (cb) { if (typeof cb === "function") this._onceCbs.push(cb); return this; };
  OnStateChange.prototype._fireOnce = function () {
    var cbs = this._onceCbs;
    this._onceCbs = [];
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](); } catch (e) { /* swallow */ }
    }
  };

  var ACCEL = 8; // steering ease — MUST mirror client MOVE_ACCEL

  // ---------------------------------------------------------------- LocalRoom
  function LocalRoom(mode, options) {
    options = options || {};
    this.sessionId = "local";

    // Colyseus-style hooks
    this.onStateChange = new OnStateChange();
    this._messageHandlers = Object.create(null); // type → [cb]
    this._errorCbs = [];
    this._leaveCbs = [];

    // clock
    this._clockMs = 0;         // internal ms counter (this.clock.currentTime)
    this._timers = [];         // active setTimeout/setInterval ids to clear on leave
    this._firstTickDone = false;

    // sim-internal maps (server private fields)
    this.inputs = new Map();       // id → {dx,dz}
    this.foodSeq = 0;
    this.boost = new Map();        // id → seconds left
    this.botBrain = new Map();
    this.botIntensity = new Map();
    this.movers = new Map();       // food id → {dx,dz,spd}
    this.spawnSafe = new Map();    // id → matchtime seconds until eatable
    this.combo = new Map();        // id → {count,lastEatAt}
    this.hvel = new Map();         // id → {vx,vz}

    this.mode = (mode === "battle") ? "battle" : "classic";

    // state
    this.state = {
      holes: new SMap(),
      food: new SMap(),
      timeLeft: this.mode === "battle" ? CONFIG.roundSeconds : CONFIG.classicSeconds,
      phase: "playing",
      mode: this.mode,
      zoneR: this.mode === "battle" ? CONFIG.worldSize / 2 : 9999,
      cityTotal: 0,
      cityEaten: 0,
    };

    this._joinOptions = options;

    // build world + spawn everyone
    this.buildCity();
    for (var i = 0; i < CONFIG.botCount; i++) this.spawnBot(i);
    this._joinLocal(options);

    // start sim loop (~60Hz) + 1Hz clock
    var self = this;
    var stepMs = 1000 / CONFIG.simHz;
    this._simId = window.setInterval(function () {
      self._clockMs += stepMs;
      self.tick(stepMs / 1000);
      if (!self._firstTickDone) {
        self._firstTickDone = true;
        self.onStateChange._fireOnce();
      }
    }, stepMs);
    this._timers.push(this._simId);

    this._clockId = window.setInterval(function () {
      if (self.state.phase !== "playing") return;
      self.state.timeLeft = Math.max(0, self.state.timeLeft - 1);
      if (self.mode === "battle") self.updateZone();
      self.assignKing();
      if (self.state.timeLeft <= 0) self.endMatch();
    }, 1000);
    this._timers.push(this._clockId);
  }

  // ---- Colyseus-style API ------------------------------------------------
  LocalRoom.prototype.onMessage = function (type, cb) {
    if (!this._messageHandlers[type]) this._messageHandlers[type] = [];
    if (typeof cb === "function") this._messageHandlers[type].push(cb);
    return this;
  };
  LocalRoom.prototype.onError = function (cb) { if (typeof cb === "function") this._errorCbs.push(cb); return this; };
  LocalRoom.prototype.onLeave = function (cb) { if (typeof cb === "function") this._leaveCbs.push(cb); return this; };

  LocalRoom.prototype.broadcast = function (type, data) {
    var hs = this._messageHandlers[type];
    if (!hs) return;
    for (var i = 0; i < hs.length; i++) {
      try { hs[i](data); } catch (e) { /* swallow */ }
    }
  };

  LocalRoom.prototype.send = function (type, data) {
    if (type === "input") {
      var dx = Number(data && data.dx) || 0;
      var dz = Number(data && data.dz) || 0;
      var len = Math.hypot(dx, dz);
      if (!isFinite(len) || len < 1e-4) this.inputs.set(this.sessionId, { dx: 0, dz: 0 });
      else this.inputs.set(this.sessionId, { dx: dx / len, dz: dz / len });
    } else if (type === "ping") {
      this.broadcast("pong");
    }
  };

  LocalRoom.prototype.leave = function () {
    for (var i = 0; i < this._timers.length; i++) {
      try { window.clearInterval(this._timers[i]); window.clearTimeout(this._timers[i]); } catch (e) {}
    }
    this._timers = [];
  };

  // ---- clock helpers -----------------------------------------------------
  LocalRoom.prototype._setTimeout = function (fn, ms) {
    var self = this;
    var id = window.setTimeout(function () {
      var idx = self._timers.indexOf(id);
      if (idx >= 0) self._timers.splice(idx, 1);
      try { fn(); } catch (e) {}
    }, ms);
    this._timers.push(id);
    return id;
  };

  // ---------------------------------------------------------------- join local player
  LocalRoom.prototype._joinLocal = function (options) {
    var spawn = this.openSpawn();
    var h = makeHole();
    h.name = ((options && options.name != null ? options.name : "Player").toString().slice(0, 64)
      .replace(/[<>&"'`\\]|[\x00-\x1f\x7f]|[​-‏‪-‮⁦-⁩﻿]/g, "")
      .trim().slice(0, 16)) || "Player";
    h.x = spawn.x; h.z = spawn.z;
    this.freshStats(h);
    var humans = 0;
    this.state.holes.forEach(function (o) { if (!o.isBot) humans++; });
    var SKIN_COLORS = [0x9945ff, 0x4a5578, 0xff7a45, 0x3ba9ff, 0x14f195, 0xc4a3ff, 0xe79a44, 0x2a3350];
    var wanted = (Number(options && options.color) >>> 0);
    h.color = SKIN_COLORS.indexOf(wanted) >= 0 ? wanted : [0x14f195, 0xff6b35, 0x00e5ff, 0xb197fc, 0xffd166][humans % 5];
    h.isBot = false;
    this.state.holes.set(this.sessionId, h);
    this.inputs.set(this.sessionId, { dx: 0, dz: 0 });
    this.spawnSafe.set(this.sessionId, this._clockMs / 1000 + (this.finaleActive() ? 6 : 3));
  };

  // ---------------------------------------------------------------- simulation
  LocalRoom.prototype.tick = function (dt) {
    if (this.state.phase !== "playing") return;
    if (dt <= 0 || dt > 0.1) dt = 1 / CONFIG.simHz;
    try {
      this.steerBots();
      this.moveHoles(dt);
      this.moveTraffic(dt);
      this.resolveEating();
      var nowS = this._clockMs / 1000;
      var self = this;
      this.combo.forEach(function (c, id) {
        if (c.count > 0 && nowS - c.lastEatAt >= 0.9) {
          c.count = 0;
          var h = self.state.holes.get(id); if (h) h.combo = 1;
        }
      });
      this.resolveHoleVsHole();
      if (this.mode === "battle") this.zoneDamage(dt);
    } catch (e) {
      // one bad frame must never crash the sim — skip it
    }
  };

  LocalRoom.prototype.aliveCount = function () {
    var n = 0; this.state.holes.forEach(function (h) { if (!h.dead) n++; }); return n;
  };

  LocalRoom.prototype.finaleActive = function () {
    return this.mode === "classic" && this.state.timeLeft <= CONFIG.finale.sec;
  };

  LocalRoom.prototype.assignKing = function () {
    var king = null; this.state.holes.forEach(function (h) { if (h.isKing) king = h; });
    var top = null;
    this.state.holes.forEach(function (h) { if (!h.dead && h.level >= 5 && (!top || h.score > top.score)) top = h; });
    if (!top) { if (king) king.isKing = false; return; }
    var t = top, k = king;
    if (k && k !== t && !k.dead && t.score < k.score * 1.1) return; // hysteresis
    if (k && k !== t) k.isKing = false;
    if (!t.isKing) t.isKing = true;
  };

  LocalRoom.prototype.updateZone = function () {
    var half = CONFIG.worldSize / 2, b = CONFIG.battle;
    var elapsed = CONFIG.roundSeconds - this.state.timeLeft;
    var span = Math.max(1, CONFIG.roundSeconds - b.shrinkStartSec - 5);
    var p = Math.max(0, Math.min(1, (elapsed - b.shrinkStartSec) / span));
    this.state.zoneR = half * (1 - (1 - b.endFrac) * p);
  };

  LocalRoom.prototype.zoneDamage = function (dt) {
    var zr = this.state.zoneR, min = CONFIG.battle.minRadius;
    var alive = 0, last = null;
    this.state.holes.forEach(function (h, id) {
      if (h.dead) return;
      if (Math.hypot(h.x, h.z) > zr) {
        h.radius -= CONFIG.battle.outDamage * dt;
        if (h.radius <= min) { h.dead = true; return; }
      }
      alive++; last = id;
    });
    if (alive <= 1 && this.state.holes.size > 1) this.endMatch(last);
  };

  LocalRoom.prototype.speedFor = function (_radius) {
    return CONFIG.baseSpeed;
  };

  LocalRoom.prototype.moveHoles = function (dt) {
    var bound = CONFIG.worldSize / 2;
    var self = this;
    this.state.holes.forEach(function (h, id) {
      if (h.dead) return;
      var bt = self.boost.get(id) || 0;
      if (bt > 0) { bt -= dt; if (bt <= 0) { bt = 0; h.boosting = false; } self.boost.set(id, bt); }
      var inp = self.inputs.get(id) || { dx: 0, dz: 0 };
      var rbS = CONFIG.bot.rubber.speedMult, rbT = self.botIntensity.get(id) || 0;
      var botMult = h.isBot ? rbS[0] + (rbS[1] - rbS[0]) * rbT : 1;
      var speed = self.speedFor(h.radius) * (bt > 0 ? CONFIG.boostMult : 1) * botMult;
      var v = self.hvel.get(id); if (!v) { v = { vx: 0, vz: 0 }; self.hvel.set(id, v); }
      var k = Math.min(1, ACCEL * dt);
      v.vx += (inp.dx * speed - v.vx) * k;
      v.vz += (inp.dz * speed - v.vz) * k;
      h.x += v.vx * dt;
      h.z += v.vz * dt;
      var margin = bound - h.radius * 0.3;
      h.x = Math.max(-margin, Math.min(margin, h.x));
      h.z = Math.max(-margin, Math.min(margin, h.z));
    });
  };

  LocalRoom.prototype.moveTraffic = function (dt) {
    var b = CONFIG.worldSize / 2 - 2;
    var self = this;
    this.movers.forEach(function (m, id) {
      var f = self.state.food.get(id);
      if (!f) { self.movers.delete(id); return; }
      f.x += m.dx * m.spd * dt;
      f.z += m.dz * m.spd * dt;
      if (f.x > b) f.x = -b; else if (f.x < -b) f.x = b;
      if (f.z > b) f.z = -b; else if (f.z < -b) f.z = b;
    });
  };

  LocalRoom.prototype.resolveEating = function () {
    var alive = [];
    this.state.holes.forEach(function (h, id) { if (!h.dead) alive.push([id, h]); });
    var self = this;
    this.state.food.forEach(function (f, fid) {
      for (var ai = 0; ai < alive.length; ai++) {
        var hid = alive[ai][0], h = alive[ai][1];
        if (h.dead) continue;
        if (f.size >= h.radius * CONFIG.eatSizeGate) continue;
        var reach = h.radius * CONFIG.eatTriggerFrac + f.size * 0.5;
        var dx = f.x - h.x; if (dx > reach || dx < -reach) continue;
        var dz = f.z - h.z; if (dz > reach || dz < -reach) continue;
        if (Math.hypot(dx, dz) - f.size * 0.5 < h.radius * CONFIG.eatTriggerFrac) {
          if (f.kind === "boost") { self.boost.set(hid, CONFIG.boostDur); h.boosting = true; }
          var now = self._clockMs / 1000;
          var c = self.combo.get(hid) || { count: 0, lastEatAt: 0 };
          c.count = now - c.lastEatAt < 0.9 ? c.count + 1 : 1;
          c.lastEatAt = now;
          self.combo.set(hid, c);
          h.combo = Math.min(8, 1 + Math.floor(c.count / 4));
          var finale = self.finaleActive();
          self.grow(h, f.points, h.combo * (finale ? CONFIG.finale.scoreMult : 1));
          h.foodEaten++;
          if (f.size > h.bigEat) h.bigEat = f.size;
          if (h.combo > h.bestCombo) h.bestCombo = h.combo;
          var small = SMALL_KINDS.indexOf(f.kind) >= 0;
          if (!small && f.kind !== "boost") {
            self.state.cityEaten++;
            h.structures++;
            var pctBefore = ((self.state.cityEaten - 1) / Math.max(1, self.state.cityTotal)) * 100;
            var pct = (self.state.cityEaten / Math.max(1, self.state.cityTotal)) * 100;
            var mstones = [25, 50, 75, 90];
            for (var mi = 0; mi < mstones.length; mi++) {
              var m = mstones[mi];
              if (pctBefore < m && pct >= m) self.broadcast("city_milestone", { pct: m });
            }
            var trophy = CONFIG.trophies[f.kind];
            if (trophy) { self.grow(h, trophy); self.broadcast("trophy", { kind: f.kind, by: h.name, bonus: trophy }); }
            if (self.state.cityEaten >= self.state.cityTotal * 0.9) {
              var dev = null; var devId = null;
              self.state.holes.forEach(function (o, oid) { if (!dev || o.structures > dev.structures) { dev = o; devId = oid; } });
              if (dev) self.grow(dev, 1500);
              self.endMatch(devId, "devoured");
            }
          }
          self.state.food.delete(fid);
          if (f.kind === "boost") self.spawnBoost();
          else if (CONFIG.respawnSmall && small && !finale) self.spawnSmallSomewhere();
          break;
        }
      }
    });
  };

  LocalRoom.prototype.resolveHoleVsHole = function () {
    var holes = this.state.holes.entries();
    var self = this;
    for (var i = 0; i < holes.length; i++) {
      var aid = holes[i][0], a = holes[i][1];
      if (a.dead) continue;
      for (var j = 0; j < holes.length; j++) {
        if (i === j) continue;
        var bid = holes[j][0], b = holes[j][1];
        if (b.dead) continue;
        if (a.radius <= b.radius * CONFIG.holeEatSizeRatio) continue;
        var bSafe = this.spawnSafe.get(bid); if (bSafe && this._clockMs / 1000 < bSafe) continue;
        var d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < a.radius * CONFIG.holeEatReach) {
          var bonus = Math.max(60, Math.round(b.score * 0.5)) + b.level * 25;
          this.grow(a, bonus);
          a.kills++;
          a.combo = Math.min(8, a.combo + 2);
          if (b.isKing) {
            var kingBonus = Math.max(300, Math.min(1000, Math.round(b.score * 0.25)));
            this.grow(a, kingBonus);
            this.broadcast("king_slain", { killer: a.name, killerId: aid, victim: b.name, bonus: kingBonus });
            b.isKing = false;
          } else {
            this.broadcast("swallowed", { hunter: a.name, hunterId: aid, prey: b.name, bonus: bonus });
          }
          b.dead = true;
          if (this.mode === "battle") { if (this.aliveCount() <= 1) this.endMatch(); }
          else if (!this.finaleActive()) {
            (function (capturedBid) {
              self._setTimeout(function () { var h = self.state.holes.get(capturedBid); if (h) self.respawnHole(capturedBid, h); }, 1400);
            })(bid);
          }
        }
      }
    }
  };

  LocalRoom.prototype.grow = function (h, points, scoreMult) {
    if (scoreMult === undefined) scoreMult = 1;
    if (h.isBot) points = Math.max(1, Math.round(points * CONFIG.bot.xpMult));
    h.score += Math.round(points * scoreMult);
    h.xp += points;
    while (h.level <= CONFIG.levelXP.length && h.xp >= h.xpForNext) {
      h.xp -= h.xpForNext;
      h.level++;
      h.baseR = Math.min(CONFIG.maxRadius, (h.baseR || CONFIG.startRadius) * CONFIG.levelGrowth);
      h.xpForNext = CONFIG.levelXP[h.level - 1] != null ? CONFIG.levelXP[h.level - 1] : 0;
    }
    if (h.level > CONFIG.levelXP.length) { h.xp = 0; h.xpForNext = 0; }
    var baseR = h.baseR || CONFIG.startRadius;
    var frac = h.xpForNext > 0 ? h.xp / h.xpForNext : 1;
    h.radius = Math.min(CONFIG.maxRadius, baseR * Math.pow(CONFIG.levelGrowth, frac));
  };

  LocalRoom.prototype.freshStats = function (h, keepScore) {
    if (keepScore === undefined) keepScore = false;
    h.radius = CONFIG.startRadius;
    h.baseR = CONFIG.startRadius;
    h.score = keepScore ? h.score : 0;
    h.isKing = false;
    if (!keepScore) {
      h.kills = 0; h.bestCombo = 1; h.bigEat = 0; h.structures = 0; h.foodEaten = 0;
    }
    h.level = 1;
    h.xp = 0;
    h.xpForNext = CONFIG.levelXP[0];
    h.dead = false;
    h.boosting = false;
    h.combo = 1;
  };

  // ---------------------------------------------------------------- bots
  LocalRoom.prototype.steerBots = function () {
    var now = this._clockMs / 1000;
    var B = CONFIG.bot, R = B.rubber;
    var self = this;
    var leaderScore = 0;
    this.state.holes.forEach(function (o) { if (!o.isBot && o.score > leaderScore) leaderScore = o.score; });
    var lerp = function (range, t) { return range[0] + (range[1] - range[0]) * t; };
    this.state.holes.forEach(function (h, id) {
      if (!h.isBot || h.dead) return;
      var brain = self.botBrain.get(id);
      if (!brain) { brain = { nextDecideAt: 0, aimX: h.x, aimZ: h.z, wanderUntil: 0, wx: 0, wz: 0, huntId: null }; self.botBrain.set(id, brain); }

      var steerTo = function (tx, tz) {
        var dx = tx - h.x, dz = tz - h.z, l = Math.hypot(dx, dz) || 1;
        self.inputs.set(id, { dx: dx / l, dz: dz / l });
      };
      var wander = function () {
        if (now >= brain.wanderUntil) {
          var a = Math.random() * Math.PI * 2;
          brain.wx = Math.cos(a); brain.wz = Math.sin(a);
          brain.wanderUntil = now + B.wanderSec;
        }
        var cl = Math.hypot(h.x, h.z) || 1;
        self.inputs.set(id, { dx: brain.wx - (h.x / cl) * 0.2, dz: brain.wz - (h.z / cl) * 0.2 });
      };

      if (self.mode === "battle" && Math.hypot(h.x, h.z) > self.state.zoneR * 0.9) { steerTo(0, 0); return; }

      if (now < brain.nextDecideAt) {
        if (brain.aimX === 1e9) wander(); else steerTo(brain.aimX, brain.aimZ);
        return;
      }
      var rb = 0;
      if (leaderScore >= R.minScore) {
        var gap = (leaderScore - h.score) / leaderScore;
        rb = Math.max(0, Math.min(1, (gap - R.ease) / (R.full - R.ease)));
      }
      self.botIntensity.set(id, rb);
      var effGreed = lerp(R.greed, rb), effReact = lerp(R.reactionSec, rb), effView = lerp(R.viewRange, rb);
      var effJitter = lerp(R.targetJitter, rb), effMistake = lerp(R.mistakeChance, rb);
      brain.nextDecideAt = now + effReact;

      // Flee
      var threat = null, threatD = 1e9;
      self.state.holes.forEach(function (o) {
        if (o === h || o.dead) return;
        if (o.radius > h.radius * CONFIG.holeEatSizeRatio) {
          var d = Math.hypot(o.x - h.x, o.z - h.z);
          if (d < threatD) { threatD = d; threat = o; }
        }
      });
      if (threat && threatD < h.radius * B.fleeRange && Math.random() < B.fleeChance) {
        var t = threat;
        brain.aimX = h.x + (h.x - t.x); brain.aimZ = h.z + (h.z - t.z);
        steerTo(brain.aimX, brain.aimZ); return;
      }

      // Hunt
      var finale = self.finaleActive();
      var huntGreed = finale ? Math.max(CONFIG.finale.greed, effGreed) : effGreed;
      var huntRange = finale ? CONFIG.finale.huntRange : B.huntRange;
      brain.huntId = null;
      if ((self.mode === "battle" || finale) && Math.random() < huntGreed) {
        var hunterCount = new Map();
        self.botBrain.forEach(function (b2) { if (b2.huntId) hunterCount.set(b2.huntId, (hunterCount.get(b2.huntId) || 0) + 1); });
        var prey = null, preyId = null, bestH = -1;
        self.state.holes.forEach(function (o, oid) {
          if (o === h || o.dead || h.radius <= o.radius * CONFIG.holeEatSizeRatio) return;
          if ((hunterCount.get(oid) || 0) >= CONFIG.finale.maxHunters) return;
          var d = Math.hypot(o.x - h.x, o.z - h.z);
          if (d > h.radius * huntRange) return;
          var w = (o.score + 50) / Math.max(4, d) * (o.isKing ? 2 : 1);
          if (w > bestH) { bestH = w; prey = o; preyId = oid; }
        });
        if (prey) {
          var p = prey; brain.huntId = preyId; brain.aimX = p.x; brain.aimZ = p.z; steerTo(p.x, p.z); return;
        }
      }

      // Food
      if (Math.random() > effGreed) { brain.aimX = 1e9; wander(); return; }

      var seen = [];
      var best = null, bestD = 1e9;
      self.state.food.forEach(function (f) {
        if (f.size >= h.radius * CONFIG.eatSizeGate) return;
        var d = Math.hypot(f.x - h.x, f.z - h.z);
        if (d > effView) return;
        seen.push(f);
        if (d < bestD) { bestD = d; best = f; }
      });

      var target = best;
      if (seen.length && Math.random() < effMistake) target = seen[(Math.random() * seen.length) | 0];

      if (target) {
        var tf = target, jit = effJitter * effView;
        brain.aimX = tf.x + (Math.random() * 2 - 1) * jit;
        brain.aimZ = tf.z + (Math.random() * 2 - 1) * jit;
        steerTo(brain.aimX, brain.aimZ);
      } else {
        brain.aimX = 1e9; wander();
      }
    });
  };

  // ---------------------------------------------------------------- world gen
  LocalRoom.prototype.addFood = function (kind, x, z, yaw, move) {
    if (yaw === undefined) yaw = 0;
    if (move === undefined) move = false;
    var k = KIND[kind] || KIND.car;
    var f = makeFood();
    f.kind = kind; f.x = x; f.z = z; f.yaw = yaw;
    f.size = k.size; f.points = k.points;
    var id = "f" + this.foodSeq++;
    this.state.food.set(id, f);
    var spd = move ? CONFIG.traffic[kind] : 0;
    if (spd) this.movers.set(id, { dx: Math.cos(yaw), dz: -Math.sin(yaw), spd: spd });
  };

  LocalRoom.prototype.pickBuilding = function (zone) {
    var r = Math.random();
    if (zone === "downtown") return r < 0.5 ? "building_mid" : r < 0.75 ? "house" : "building_small";
    if (zone === "midtown") return r < 0.4 ? "building_mid" : r < 0.62 ? "factory" : r < 0.82 ? "house" : "building_small";
    return r < 0.35 ? "house" : r < 0.55 ? "factory" : "building_small";
  };

  LocalRoom.prototype.streetWall = function (bx, bz, zone) {
    var cell = CONFIG.city.cell, roadW = CONFIG.city.roadW;
    var hb = blockHash(bx, bz), hj = blockHash(bx, bz + 7);
    var setback = roadW / 2 + 2.2 + hb * 1.6;
    var jitter = (hj - 0.5) * 0.18;
    var frontHalf = cell / 2 - (roadW / 2 + 2.0);
    var edges = [
      { nx: 1, nz: 0, facing: -Math.PI / 2 },
      { nx: -1, nz: 0, facing: Math.PI / 2 },
      { nx: 0, nz: 1, facing: 0 },
      { nx: 0, nz: -1, facing: Math.PI },
    ];
    for (var ei = 0; ei < edges.length; ei++) {
      var e = edges[ei];
      var cursor = -frontHalf, guard = 0;
      while (cursor < frontHalf && guard++ < 5) {
        var kind = this.pickBuilding(zone);
        var width = KIND[kind].size * 2;
        var along = cursor + width / 2;
        if (along > frontHalf) break;
        var px = e.nx !== 0 ? bx + e.nx * setback : bx + along;
        var pz = e.nx !== 0 ? bz + along : bz + e.nz * setback;
        cursor += width + rand(0.2, 0.7);
        if (Math.hypot(px, pz) < 16 || Math.random() < 0.06) continue;
        this.addFood(kind, px, pz, e.facing + jitter);
        if (Math.random() < 0.5) {
          var off = width / 2 + 1.2;
          var sx = e.nx !== 0 ? bx + e.nx * (setback - 2.2) : bx + along + off;
          var sz = e.nx !== 0 ? bz + along + off : bz + e.nz * (setback - 2.2);
          if (Math.hypot(sx, sz) > 16) this.addFood(pick(["cone", "trash", "hydrant", "kiosk"]), sx, sz, 0);
        }
      }
    }
  };

  LocalRoom.prototype.buildCity = function () {
    var W = CONFIG.worldSize, cell = CONFIG.city.cell, roadW = CONFIG.city.roadW;
    var lines = [];
    for (var p = -W / 2 + cell; p < W / 2; p += cell) lines.push(p);
    this.laneLines = lines;
    var inner = cell / 2 - roadW / 2 - 1.5;

    for (var bx = -W / 2 + cell / 2; bx < W / 2; bx += cell) {
      for (var bz = -W / 2 + cell / 2; bz < W / 2; bz += cell) {
        var t = blockType(bx, bz, W);
        if (t === "open") continue;
        var dist = Math.hypot(bx, bz);
        var zone = dist < W * 0.22 ? "downtown" : dist < W * 0.42 ? "midtown" : "outer";

        if (t === "park") { this.fillPark(bx, bz, inner); continue; }

        if (t === "industrial") {
          var hy = blockHash(bx, bz) * Math.PI / 2;
          this.addFood("crane", bx, bz - inner * 0.35, hy);
          this.addFood("factory", bx - inner * 0.5, bz + inner * 0.45, hy);
          this.addFood("factory", bx + inner * 0.5, bz + inner * 0.45, hy);
          for (var ii = 0; ii < 5; ii++) this.addFood("crate", bx + (ii - 2) * (inner * 0.32), bz - inner * 0.85, 0);
          for (var ii2 = 0; ii2 < 3; ii2++) this.addFood("crate", bx + (ii2 - 1) * 2.0, bz - inner * 0.55, 0);
          for (var ii3 = 0; ii3 < 3; ii3++) this.addFood("trash", bx - inner * 0.8 + ii3 * 1.4, bz + inner * 0.85, 0);
          this.addFood("van", bx + inner * 0.6, bz - inner * 0.9, Math.PI / 2);
          continue;
        }

        if (t === "landmark") {
          var ly = Math.floor(blockHash(bx, bz) * 4) * Math.PI / 2;
          this.addFood(pick(["megatower", "stadium", "monument", "tower_tall"]), bx, bz, ly);
          continue;
        }

        if (t === "plaza") {
          var cy = blockHash(bx, bz);
          this.addFood(cy < 0.5 ? "fountain" : "statue", bx, bz, 0);
          this.addFood("busstop", bx, bz - inner * 0.7, 0);
          for (var pi = 0; pi < 4; pi++) {
            var a = pi * Math.PI / 2 + cy * 6.283;
            this.addFood("bench", bx + Math.cos(a) * inner * 0.55, bz + Math.sin(a) * inner * 0.55, a);
          }
          this.addFood("tree", bx - inner * 0.85, bz - inner * 0.85, 0);
          this.addFood("tree", bx + inner * 0.85, bz + inner * 0.85, 0);
          this.addFood("lamp", bx + inner * 0.85, bz - inner * 0.85, 0);
          this.addFood("lamp", bx - inner * 0.85, bz + inner * 0.85, 0);
          for (var pj = 0; pj < 6; pj++) this.addFood("person", bx + rand(-inner * 0.7, inner * 0.7), bz + rand(-inner * 0.7, inner * 0.7), rand(0, 6.28));
          for (var pk = 0; pk < 4; pk++) this.addFood(pick(["cone", "flowers", "kiosk"]), bx + rand(-inner * 0.8, inner * 0.8), bz + rand(-inner * 0.8, inner * 0.8), 0);
          continue;
        }

        if (t === "tower") {
          var cyt = Math.floor(blockHash(bx, bz) * 4) * Math.PI / 2;
          this.addFood(pick(["skyscraper", "office_tower", "hotel_tower", "mall"]), bx, bz, cyt);
          var c = inner * 0.96;
          this.addFood("tree", bx - c, bz - c, 0); this.addFood("tree", bx + c, bz + c, 0);
          this.addFood("lamp", bx + c, bz - c, 0); this.addFood("lamp", bx - c, bz + c, 0);
          for (var ti = 0; ti < 4; ti++) {
            var at = ti * Math.PI / 2 + cyt;
            this.addFood(ti % 2 ? "bench" : "planter", bx + Math.cos(at) * inner * 0.62, bz + Math.sin(at) * inner * 0.62, at);
          }
          for (var tj = 0; tj < 3; tj++) this.addFood("person", bx + rand(-inner * 0.6, inner * 0.6), bz + rand(-inner * 0.6, inner * 0.6), rand(0, 6.28));
          this.addFood(pick(["kiosk", "cone", "trash"]), bx + inner * 0.5, bz - inner * 0.5, 0);
          continue;
        }

        // buildings
        this.streetWall(bx, bz, zone);
        if (Math.random() < 0.35) this.addFood("tree", bx + rand(-inner * 0.45, inner * 0.45), bz + rand(-inner * 0.45, inner * 0.45), rand(0, 6.28));
        if (Math.random() < 0.2) this.addFood(pick(["bush", "planter", "lamp"]), bx + rand(-inner * 0.4, inner * 0.4), bz + rand(-inner * 0.4, inner * 0.4), 0);
      }
    }

    // Street lamps along the sidewalks
    for (var li = 0; li < lines.length; li++) {
      var pl = lines[li];
      for (var q = -W / 2 + 20; q < W / 2; q += 46) {
        if (Math.hypot(pl + roadW / 2 + 1.4, q) > 15) this.addFood("lamp", pl + roadW / 2 + 1.4, q, 0);
        if (Math.hypot(q, pl - (roadW / 2 + 1.4)) > 15) this.addFood("lamp", q, pl - (roadW / 2 + 1.4), 0);
      }
    }

    // Vehicles on the lanes
    for (var vi = 0; vi < CONFIG.city.cars; vi++) {
      var onX = Math.random() < 0.5, lane = pick(lines), dir = Math.random() < 0.5 ? 1 : -1;
      var laneOff = dir * 2.2, along = rand(-W / 2, W / 2);
      var vx = onX ? along : lane + laneOff, vz = onX ? lane + laneOff : along;
      var vyaw = onX ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      var vr = Math.random();
      this.addFood(vr < 0.78 ? "car" : vr < 0.92 ? "van" : "bus", vx, vz, vyaw, true);
    }
    // Seed the open center
    for (var si = 0; si < 26; si++) {
      var sa = Math.random() * 6.283, rr = rand(9, 26);
      var scx = Math.cos(sa) * rr, scz = Math.sin(sa) * rr;
      this.addFood(pick(["cone", "trash", "flowers", "person", "person", "bush", "kiosk", "car", "crate", "hydrant"]), scx, scz, rand(0, 6.28));
    }
    for (var bi = 0; bi < CONFIG.boostCount; bi++) this.spawnBoost();

    // Sidewalk furniture + pedestrians
    var sideOff = roadW / 2 + 1.6;
    var self = this;
    var sidewalkSpot = function () {
      var lane2 = pick(lines), along2 = rand(-W / 2 + 5, W / 2 - 5), side = Math.random() < 0.5 ? 1 : -1, onX2 = Math.random() < 0.5;
      return { x: onX2 ? along2 : lane2 + sideOff * side, z: onX2 ? lane2 + sideOff * side : along2, onX: onX2 };
    };
    for (var fi = 0; fi < 110; fi++) {
      var s = sidewalkSpot(); if (Math.hypot(s.x, s.z) < 15) continue;
      var r = Math.random();
      var kind2 = r < 0.24 ? "cone" : r < 0.44 ? "trash" : r < 0.58 ? "hydrant"
        : r < 0.72 ? "bench" : r < 0.86 ? "planter" : r < 0.95 ? "flowers" : "busstop";
      this.addFood(kind2, s.x, s.z, s.onX ? 0 : Math.PI / 2);
    }
    for (var pp = 0; pp < CONFIG.city.people; pp++) {
      var s2 = sidewalkSpot(); if (Math.hypot(s2.x, s2.z) < 14) { pp--; continue; }
      var pyaw = s2.onX ? (Math.random() < 0.5 ? 0 : Math.PI) : (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
      this.addFood("person", s2.x, s2.z, pyaw, true);
    }

    // City devour meter
    var hasMonument = false, total = 0;
    this.state.food.forEach(function (f) {
      if (f.kind === "monument") hasMonument = true;
      if (SMALL_KINDS.indexOf(f.kind) < 0 && f.kind !== "boost") total++;
    });
    if (!hasMonument) { this.addFood("monument", cell * 1.5, cell * 1.5, 0); total++; }
    this.state.cityTotal = total;
    this.state.cityEaten = 0;
  };

  LocalRoom.prototype.fillPark = function (bx, bz, inner) {
    if (blockHash(bx + 1, bz) < 0.5) this.addFood("fountain", bx, bz, 0);
    else this.addFood("statue", bx, bz, 0);
    var n = 5, span = inner * 0.84, step = (2 * span) / (n - 1);
    var fills = ["tree", "bush", "flowers", "bush", "tree", "planter", "bush", "flowers"];
    var k = 0;
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
      var px = bx - span + i * step + rand(-1.6, 1.6), pz = bz - span + j * step + rand(-1.6, 1.6);
      if (Math.hypot(px - bx, pz - bz) < inner * 0.36) continue;
      this.addFood(fills[(k++) % fills.length], px, pz, rand(0, 6.28));
    }
    this.addFood("bench", bx - span, bz, Math.PI / 2); this.addFood("bench", bx + span, bz, Math.PI / 2);
    this.addFood("lamp", bx - inner, bz - inner, 0); this.addFood("lamp", bx + inner, bz + inner, 0);
    this.addFood("lamp", bx, bz - span, 0); this.addFood("lamp", bx, bz + span, 0);
    this.addFood("bench", bx, bz - span * 0.5, 0); this.addFood("bench", bx, bz + span * 0.5, 0);
    for (var pcount = 0; pcount < 3; pcount++) this.addFood("person", bx + rand(-span, span), bz + rand(-span, span), rand(0, 6.28));
  };

  LocalRoom.prototype.spawnSmallSomewhere = function () {
    var W = CONFIG.worldSize, cell = CONFIG.city.cell, roadW = CONFIG.city.roadW, kind = pick(SMALL_KINDS);
    var lines = this.laneLines;
    var self = this;
    var clearOfHoles = function (x, z) { var ok = true; self.state.holes.forEach(function (h) { if (!h.dead && Math.hypot(x - h.x, z - h.z) < h.radius * 1.6) ok = false; }); return ok; };

    if (kind === "car" || kind === "van" || kind === "bus") {
      for (var t = 0; t < 10; t++) {
        var onX = Math.random() < 0.5, lane = pick(lines), dir = Math.random() < 0.5 ? 1 : -1, laneOff = dir * 2.2, along = rand(-W / 2 + 6, W / 2 - 6);
        var x = onX ? along : lane + laneOff, z = onX ? lane + laneOff : along;
        var yaw = onX ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
        if (Math.hypot(x, z) > 15 && clearOfHoles(x, z)) { this.addFood(kind, x, z, yaw, true); return; }
      }
      return;
    }
    if (kind === "person") {
      var sideOff = roadW / 2 + 1.6;
      for (var t2 = 0; t2 < 10; t2++) {
        var onX2 = Math.random() < 0.5, lane2 = pick(lines), side = Math.random() < 0.5 ? 1 : -1, along2 = rand(-W / 2 + 6, W / 2 - 6);
        var x2 = onX2 ? along2 : lane2 + sideOff * side, z2 = onX2 ? lane2 + sideOff * side : along2;
        var pyaw = onX2 ? (Math.random() < 0.5 ? 0 : Math.PI) : (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
        if (Math.hypot(x2, z2) > 14 && clearOfHoles(x2, z2)) { this.addFood("person", x2, z2, pyaw, true); return; }
      }
      return;
    }
    var fx = 0, fz = 0;
    for (var t3 = 0; t3 < 8; t3++) { fx = rand(-W / 2 + 4, W / 2 - 4); fz = rand(-W / 2 + 4, W / 2 - 4); if (clearOfHoles(fx, fz)) break; }
    this.addFood(kind, fx, fz, rand(0, 6.28));
  };

  LocalRoom.prototype.spawnBoost = function () {
    var W = CONFIG.worldSize;
    var x = 0, z = 0;
    var self = this;
    for (var t = 0; t < 8; t++) {
      x = rand(-W / 2 + 6, W / 2 - 6); z = rand(-W / 2 + 6, W / 2 - 6);
      var clear = true;
      this.state.holes.forEach(function (h) { if (!h.dead && Math.hypot(x - h.x, z - h.z) < h.radius * 2) clear = false; });
      if (clear) break;
    }
    this.addFood("boost", x, z, 0);
  };

  LocalRoom.prototype.spawnBot = function (i) {
    var h = makeHole();
    var s = this.openSpawn();
    h.name = CONFIG.botNames[i % CONFIG.botNames.length];
    h.x = s.x; h.z = s.z;
    this.freshStats(h);
    h.color = COLORS[(i + 1) % COLORS.length];
    h.isBot = true;
    var id = "bot_" + i;
    this.state.holes.set(id, h);
    this.inputs.set(id, { dx: 0, dz: 0 });
  };

  LocalRoom.prototype.respawnHole = function (id, h) {
    var s = this.openSpawn();
    h.x = s.x; h.z = s.z;
    this.freshStats(h, true);
    this.spawnSafe.set(id, this._clockMs / 1000 + 3);
  };

  LocalRoom.prototype.openSpawn = function () {
    for (var t = 0; t < 12; t++) {
      var r = t < 6 ? 12 : 120, x = rand(-r, r), z = rand(-r, r);
      var ok = true;
      this.state.holes.forEach(function (h) { if (!h.dead && h.radius > 3 && Math.hypot(x - h.x, z - h.z) < h.radius * 6) ok = false; });
      if (ok) return { x: x, z: z };
    }
    return { x: rand(-12, 12), z: rand(-12, 12) };
  };

  LocalRoom.prototype.endMatch = function (winnerId, reason) {
    if (reason === undefined) reason = "time";
    if (this.state.phase !== "playing") return;
    this.state.phase = "ended";
    var winner = winnerId ? (this.state.holes.get(winnerId) || null) : null;
    var winId = winner ? winnerId : null;
    if (!winner) this.state.holes.forEach(function (h, id) { if (!h.dead && (!winner || h.score > winner.score)) { winner = h; winId = id; } });
    if (!winner) this.state.holes.forEach(function (h, id) { if (!winner || h.score > winner.score) { winner = h; winId = id; } });
    if (this.mode === "battle" && winnerId) reason = "lastalive";
    this.broadcast("match_over", { winner: winner ? winner.name : null, winnerId: winId, reason: reason });
    var self = this;
    this._setTimeout(function () { self.resetMatch(); }, 6000);
  };

  LocalRoom.prototype.resetMatch = function () {
    this.state.food.clear();
    this.boost.clear();
    this.botBrain.clear();
    this.movers.clear();
    this.spawnSafe.clear();
    this.combo.clear();
    this.hvel.clear();
    this.botIntensity.clear();
    this.buildCity();
    var self = this;
    this.state.holes.forEach(function (h, id) {
      var s = self.openSpawn();
      h.x = s.x; h.z = s.z; self.freshStats(h);
      self.inputs.set(id, { dx: 0, dz: 0 });
    });
    this.state.timeLeft = this.mode === "battle" ? CONFIG.roundSeconds : CONFIG.classicSeconds;
    this.state.zoneR = this.mode === "battle" ? CONFIG.worldSize / 2 : 9999;
    this.state.phase = "playing";
    this.broadcast("match_reset", {});
  };

  window.LocalRoom = LocalRoom;
})();
