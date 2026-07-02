/**
 * Shared, authoritative game tuning. The SERVER owns all of this — the client
 * only renders. `size` is the object's footprint RADIUS in world units, so the
 * eat gate matches the visible model.
 *
 * Progression is a STAIRCASE: object sizes are spread across 12 levels so each
 * level unlocks roughly one new tier and there is always something "too big to
 * eat yet" ahead. Milestones: cars ~L3, buildings ~L6, skyscrapers ~L9,
 * mega-landmarks ~L11, the monument only near the cap.
 */
export const CONFIG = {
  worldSize: 300,
  maxRooms: Number(process.env.MAX_ROOMS) || 20, // global live-room cap (create-flood DoS guard; tune to host)

  // Holes (players + bots)
  startRadius: 1.4,
  maxRadius: 24, // must exceed the biggest object (monument 19.5) so end-game holes can swallow it
  baseSpeed: 15, // flat drifting speed for all sizes (hole.io feel) — MUST mirror client BASE_SPEED

  // Eating
  eatTriggerFrac: 1.0,  // object falls in once its center reaches the rim → can enter from the SIDE, not just dead-center
  eatSizeGate: 1.0,     // eatable only if its footprint radius < your hole radius → matches what LOOKS swallowable
  holeEatSizeRatio: 1.25,
  holeEatReach: 0.66,

  // Discrete level progression — 15 thresholds → 16 levels. Playtest-tuned (balance-test.mjs):
  // deliberate opening (first level-up in seconds as the hook, but Lv5 ≈ 1 min — owner found
  // the old 20s-to-Lv5 too fast), then the validated climb: monument tier (Lv12, r>19.5)
  // ≈ 5 min for a PERFECT chainer, near match end for a good human.
  levelXP: [25, 55, 100, 170, 280, 450, 700, 1100, 1800, 2900, 4600, 6800, 9500, 13000, 17000],
  levelGrowth: 1.28,

  // City layout
  city: {
    cell: 42,
    roadW: 10,
    cars: 100,   // driving cars (movers) — trimmed from 150 for bandwidth; still a busy city
    people: 65,  // walking sidewalk people (movers); parked vans + park crowds are static
  },
  // Living city: cars/vans/buses drive along their lanes, people walk along sidewalks (world units / sec).
  traffic: { car: 9, van: 8, bus: 7, person: 1.4 } as Record<string, number>,
  respawnSmall: true,

  // Bots — a tunable skill model. Bots are CLEARLY beatable: slower, short-sighted,
  // imperfect aim, laggy reactions, occasionally lazy, and they grow slower.
  botCount: 5,
  botNames: ["Nyx", "Maw", "Abyss", "Rift", "Hex", "Void", "Null", "Gloom"],
  bot: {
    // NOTE: greed/reactionSec/viewRange/targetJitter/mistakeChance/speedMult now live in `rubber`
    // (the fixed scalars were superseded by the rubber-band ranges and are no longer read).
    xpMult: 0.85,        // 85% growth rate → bots stay visible in the late-game race, still beatable
    fleeRange: 4.6,      // notice threats a bit sooner
    fleeChance: 0.85,    // react to threats more reliably
    huntRange: 9,        // battle prey-hunt range in radius units
    wanderSec: 1.4,      // shorter aimless wanders
    // RUBBER-BAND: bots scale their effort to the score gap vs the best human.
    // Far behind → tryhard (right end of each range); close → relaxed (left end).
    rubber: {
      minScore: 300,             // rubber-band only kicks in once the player has real score
      ease: 0.15,                // within 15% of the player → fully relaxed
      full: 0.75,                // 75%+ behind → full tryhard
      greed: [0.7, 0.97],        // chase-the-best-food chance
      reactionSec: [0.3, 0.12],  // re-targeting delay
      viewRange: [38, 75],       // food sight radius
      targetJitter: [0.24, 0.05],// aim error
      mistakeChance: [0.12, 0.02],
      speedMult: [0.86, 0.96],   // caps below 1.0 → a fleeing player always escapes
    } as Record<string, any>,
  },

  // Match — classic is a tight 5-min run; battle keeps 7 (its zone math derives from roundSeconds).
  roundSeconds: Number(process.env.ROUND_SECONDS) || 420,        // battle length
  classicSeconds: Number(process.env.CLASSIC_SECONDS) || 300,    // classic length

  // FINAL FRENZY — the last stretch of classic flips: bots hunt, score doubles, deaths are
  // final, small food stops refilling. Turns the dead late-game into the climax.
  finale: {
    sec: 75,          // finale starts when timeLeft <= this (classic only)
    scoreMult: 2,     // extra score multiplier during the finale (stacks with combo, score-only)
    greed: 0.95,      // bots chase relentlessly during the finale
    huntRange: 14,    // bots hunt prey within radius*this
    maxHunters: 2,    // fairness: at most this many bots converge on one target
  },
  // Trophy landmarks — one-time score bonuses for swallowing the apex objects.
  trophies: { stadium: 250, megatower: 350, monument: 500 } as Record<string, number>,

  // Battle mode — a shrinking safe zone; outside it you shrink; last hole standing wins.
  battle: {
    shrinkStartSec: 60,  // 1-min calm open before the zone starts closing (10-min match)
    endFrac: 0.1,        // final zone radius = worldSize/2 * endFrac (tight → forces fights)
    outDamage: 2.6,      // radius lost per second while outside the zone
    minRadius: 1.0,      // shrink below this → eliminated (no respawn)
  },

  // Power-ups
  boostCount: 8,   // speed-boost pickups on the map
  boostDur: 5,     // seconds
  boostMult: 1.7,  // speed multiplier while boosted

  // Simulation / network
  simHz: 60,
  patchMs: 50,
} as const;

/**
 * Object ladder. size = footprint radius (drives the eat gate). Spread so each
 * tier unlocks at a distinct level. The client maps the kind to a GLB or
 * procedural mesh; visual width ≈ size*2.
 *
 * eat thresholds (radius*1.15) per level ≈
 *   L1 1.61  L2 2.06  L3 2.64  L4 3.38  L5 4.32  L6 5.53
 *   L7 7.08  L8 9.07  L9 11.6  L10 14.86  L11 19.0  L12 20.7
 */
export const KIND: Record<string, { size: number; points: number }> = {
  boost: { size: 0.7, points: 3 }, // speed-boost pickup (always eatable)
  // L1 — tiny props & people
  cone: { size: 0.3, points: 1 },
  hydrant: { size: 0.45, points: 2 },
  trash: { size: 0.55, points: 2 },
  flowers: { size: 0.6, points: 2 },
  kiosk: { size: 0.5, points: 2 },   // sidewalk newsstand
  crate: { size: 0.8, points: 2 },   // industrial loading prop
  lamp: { size: 0.7, points: 2 },
  person: { size: 0.85, points: 1 },
  planter: { size: 1.05, points: 3 },
  bush: { size: 1.2, points: 3 },
  // L2 — street furniture
  bench: { size: 1.7, points: 4 },
  statue: { size: 1.9, points: 9 },
  // L3 — CARS
  car: { size: 2.3, points: 6 },
  tree: { size: 2.6, points: 9 },
  // L4 — big street objects / vans
  busstop: { size: 2.9, points: 9 },
  van: { size: 3.2, points: 11 },
  // L5 — large vehicles / plaza
  bus: { size: 3.7, points: 16 },
  fountain: { size: 4.2, points: 20 },
  // L6 — BUILDINGS
  building_small: { size: 4.9, points: 16 },
  // L7 — houses / industrial
  house: { size: 5.6, points: 24 },
  factory: { size: 6.3, points: 30 },
  // L8 — mid-rise / heavy
  building_mid: { size: 7.2, points: 34 },
  crane: { size: 8.0, points: 46 },
  // L9 — SKYSCRAPERS
  mall: { size: 9.2, points: 55 },
  skyscraper: { size: 10.4, points: 70 },
  // L10 — tall towers
  office_tower: { size: 11.8, points: 95 },
  hotel_tower: { size: 13.0, points: 120 },
  tower_tall: { size: 14.8, points: 160 },
  // L11 — MEGA-LANDMARKS
  stadium: { size: 16.0, points: 210 },
  megatower: { size: 17.5, points: 280 },
  // L12 — apex
  monument: { size: 19.5, points: 380 },
};

// Small kinds used for respawns (keep cheap eatables flowing).
export const SMALL_KINDS = ["car", "car", "person", "person", "cone", "trash", "flowers", "bush", "van", "busstop", "kiosk", "crate", "hydrant"];
