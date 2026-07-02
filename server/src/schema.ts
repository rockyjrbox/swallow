/**
 * Networked state. Colyseus serializes these schema classes as binary deltas and
 * broadcasts only what changed at the patch rate. This is the ONLY thing clients
 * see — they never compute authoritative state themselves.
 */
import { Schema, MapSchema, type } from "@colyseus/schema";

export class Hole extends Schema {
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") radius = 1.6;
  @type("number") score = 0;
  @type("uint16") level = 1;
  @type("number") xp = 0;          // progress toward the next level
  @type("number") xpForNext = 15;  // xp needed for the next level
  @type("boolean") isBot = false;
  @type("boolean") dead = false;
  @type("boolean") boosting = false; // speed-boost pickup active
  @type("uint8") combo = 1;          // chain-eat score multiplier (1..8), decays when the chain lapses
  @type("boolean") isKing = false;   // current score leader (Lv5+) — carries a bounty
  @type("uint16") kills = 0;         // rivals swallowed this match
  @type("uint8") bestCombo = 1;      // peak combo this match (drives skin unlocks)
  @type("number") bigEat = 0;        // largest object footprint swallowed this match
  @type("uint16") structures = 0;    // city structures eaten this match (devour-race tiebreak)
  @type("uint16") foodEaten = 0;     // total objects eaten this match
  @type("uint32") color = 0x14f195;
  baseR = 1.4;                        // UNDECORATED (server-only, not synced): continuous-growth band floor
}

export class Food extends Schema {
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") size = 0.5; // footprint radius
  @type("uint16") points = 1;
  @type("string") kind = "car"; // person | car | tree | building_small | building_mid | skyscraper
  @type("number") yaw = 0; // facing, radians
}

export class ArenaState extends Schema {
  // keyed by sessionId (players) or "bot_N" (bots)
  @type({ map: Hole }) holes = new MapSchema<Hole>();
  // keyed by incrementing food id
  @type({ map: Food }) food = new MapSchema<Food>();
  @type("number") timeLeft = 120;
  @type("string") phase = "playing"; // "playing" | "ended"
  @type("string") mode = "classic";  // "classic" | "battle"
  @type("number") zoneR = 9999;       // battle: shrinking safe-zone radius (from centre)
  @type("uint16") cityTotal = 0;      // structures in the city at match start (devour meter)
  @type("uint16") cityEaten = 0;      // structures swallowed so far (by anyone)
}
