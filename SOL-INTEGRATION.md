# VOIDRUN — Solana Staked Lobbies (Engineering Spec)

Wire real Solana staking onto **Battle mode**: a creator sets a buy-in, others stake the same amount into an on-chain escrow, one Battle match runs, and the **winner takes the pot** minus a house rake. Server-authority over eat/elimination (the existing anti-cheat foundation) is untouched; staking adds only a *money + lifecycle* layer around a match.

**Status:** Phase 0 shipped — game is live **free-to-play** (Classic + Battle), with the SOL surfaces (a "Staked" mode button, a "Connect Wallet" button, a teaser panel) present in the UI but marked **COMING SOON**. This document specifies **Phase 1 (devnet)** in buildable detail and gates Phase 2 (audit + mainnet). Devnet first; **no mainnet funds until an audit and legal review clear.**

---

## 1. Goals & non-goals

**Goals**
- Free play stays **100% free and default**. Classic and Battle never require a wallet.
- Staking is strictly **opt-in**, and only on **Battle** mode (last-hole-standing).
- **Winner takes the pot** (`stake × players`) minus a fixed rake to the house.
- Enforce **~one live lobby per creator wallet** on-chain (the owner's hard anti-abuse ask).
- Funds are **never trapped**: every failure path resolves to payout or full refund.
- Reuse the existing `ArenaRoom` simulation byte-for-byte — money changes gating/lifecycle/settlement, never physics.

**Non-goals (Phase 1)**
- No "provably fair" claim. Deterministic re-simulation is a **Phase 2** design target, not a Phase 1 promise. Over-claiming is its own reputational risk.
- No bots in staked rooms — real money is **PvP-only**.
- No mainnet launch, no real-value custody, until the audit + legal gates in §12–13 clear.
- No on-chain adjudication of gameplay — the chain never sees `{dx,dz}`; a signed off-chain authority names the winner.

---

## 2. Trust model at a glance

The escrow is trustless (Anchor PDAs custody SOL, enforce one-lobby-per-wallet, guard double-settle/refund). **The one thing players must trust is that our off-chain server names the correct winner**, because only the server sees gameplay.

| Layer | Devnet posture | Mainnet posture |
|---|---|---|
| SOL custody | Program-owned PDA vault; deposits & payouts by CPI | Same, **audited** |
| Winner authority | Separate signer service (**off the game box**) + match-result attestation | **Squads v4 M-of-N** multisig + attestation |
| One-lobby-per-wallet | On-chain PDA `init` collision (source of truth) | Same |
| Liveness backstop | Permissionless `timeout_refund` / `cancel_lobby` | Same |
| Fairness evidence | Signed match transcript + stored input logs | + deterministic re-sim + dispute window |

**Non-negotiable on-chain invariant (all environments):** `settle_match` asserts `winner ∈ lobby.players[]`. Even a fully compromised settlement key can then only pay *an actual staker* — theft-of-arbitrary-address becomes at-worst grief, and the timeout path caps an *unavailable* authority to "everyone refunded."

---

## 3. On-chain program (`voidrun_escrow`, Anchor)

The program is the source of truth for these constants; mirror them in `server/src/config.ts` (a new `staking` block) but never let the client supply them.

| Constant | Devnet default | Notes |
|---|---|---|
| `MAX_PLAYERS` | 8 | bounds the `players[]` array & settle loop |
| `MIN_PLAYERS` | 2 | below this at lock → refund only (owner may raise to 4, see §15) |
| `RAKE_BPS` | **500 (5%)** | see §9/§11 economics; guard `0..=1000` |
| `JOIN_WINDOW_SECS` | 900 | Open lobby auto-reapable after this |
| `SETTLE_TIMEOUT_SECS` | 1800 | Locked-but-unsettled → refund path opens (must exceed worst-case settle latency, §5) |
| `MIN_STAKE_LAMPORTS` | 10_000_000 (0.01 SOL) | above dust/rent noise |

### 3.1 Accounts / PDAs

All PDAs are program-derived; a client cannot smuggle a look-alike account because Anchor re-derives and checks every seed/bump.

**Config** — singleton, `seeds = [b"config"]`.
`admin, settlement_authority, house_wallet, rake_bps, paused, bump`. Set once via `init_config`, mutable only by `admin`. Makes the settlement authority **swappable** (devnet hot signer → mainnet multisig) without redeploy.

**Lobby** — `seeds = [b"lobby", creator.key()]`. **This is the one-lobby-per-wallet enforcement.** The seed is *only* the creator pubkey (no nonce/counter), so a wallet derives exactly one Lobby address; `create_lobby` uses `init` (not `init_if_needed`), so a second concurrent create fails with `already in use`. The seat frees only when the Lobby is `close`d at settle/cancel.

```rust
pub struct Lobby {
  creator: Pubkey,
  stake_lamports: u64,
  rake_bps: u16,
  status: LobbyStatus,        // Open | Locked | Settled | Cancelled
  player_count: u8,
  max_players: u8,
  players: [Pubkey; 8],       // fixed size → constant rent, bounded settle loop
  refunded_mask: u16,         // bit i set once player i refunded (double-refund guard)
  match_id: [u8; 32],         // room id / committed seed, echoed by the attestation
  created_at: i64,
  locked_at: i64,
  vault_bump: u8,
  bump: u8,
}
```

**Vault** — `seeds = [b"vault", lobby.key()]`. A **system-owned** PDA (no data, just lamports). Deposits arrive via `system_program::transfer` (joiner-signed CPI); payouts leave via `invoke_signed` with the vault seeds (program signs as the vault). First deposit tops it to rent-exempt-min; that floor is returned to the creator when the vault closes.

**Entry** — `seeds = [b"entry", lobby.key(), player.key()]`. Per-player receipt `{ lobby, player, amount, slot_index: u8, bump }`, created on join with `init`. Gives (a) **idempotency** — a re-join reverts because Entry already exists (no double-stake); (b) a trustless "this player is owed `amount`" proof on the refund path; (c) `close = player` returns Entry rent to the player. **Keep Entry** — the cleaner idempotency and per-player rent reclamation are worth the account.

### 3.2 Lobby state machine

```
create_lobby → Open ──join_lobby──▶ Open
                 │  \                 │
    cancel_lobby │   \ start_match    │ start_match (count ≥ MIN, authority)
 (creator, or    │    ▼               ▼
  anyone after   │  Cancelled       Locked ──settle_match(authority)──▶ Settled → close
  JOIN_WINDOW)   │   → close          │
                 └────────────────────┴─timeout_refund (anyone, after SETTLE_TIMEOUT)─▶ Cancelled → close
```

Each instruction opens with `require!(lobby.status == Expected)`; `Settled`/`Cancelled` are terminal and `close` the Lobby (creator gets its rent), which frees the one-lobby seat.

### 3.3 Instruction set

| Ix | Signer(s) | Precondition (status) | SOL movement |
|---|---|---|---|
| `init_config` | admin | — (init guard) | none |
| `create_lobby(stake, max_players, match_id)` | creator | new PDA (`init`) | creator stakes → vault; pays Lobby+Entry rent |
| `join_lobby()` | player | Open | player stakes **exactly `lobby.stake_lamports`** → vault; pays Entry rent |
| `start_match()` (lock) | **settlement_authority** | Open, `count ≥ MIN`, within join window | none; sets `Locked`, freezes pot |
| `settle_match(winner_index, attestation)` | settlement_authority | Locked | rake → house, payout → winner; close Lobby+vault |
| `cancel_lobby()` | creator, or **anyone** after `JOIN_WINDOW` | Open | refund each staker in full; close |
| `timeout_refund()` | **anyone** | Locked, `now ≥ locked_at + SETTLE_TIMEOUT` | refund all in full; close |

Instruction detail worth pinning:

- **`create_lobby`** — checks `!paused`, `stake ≥ MIN_STAKE_LAMPORTS`, `2 ≤ max_players ≤ MAX_PLAYERS`. The **creator is player 0**: it deposits their stake and writes `players[0]=creator, player_count=1` atomically, so no "created but unpaid" state exists.
- **`join_lobby`** — checks `Open`, `player_count < max_players`, not already in `players[]` (Entry `init` also enforces), `now < created_at + JOIN_WINDOW_SECS`. **Exact amount is read from the Lobby, not client args** — no under/over-stake. Appends to `players[]`.
- **`start_match`** — **the settlement authority locks**, so the off-chain room and the on-chain pot seal atomically at match start; this keeps the room the single source of truth. After lock, `join_lobby` reverts.
- **`settle_match`** — checks `Locked`; `config.settlement_authority == signer`; `winner_index < player_count`; `winner.key() == players[winner_index]`; `house_wallet == config.house_wallet`; attestation valid & `match_id` matches the locked value. **Pot is computed from actual vault lamports minus the rent floor**, not naively from `stake × count`, so custody and bookkeeping can never disagree; assert `payout + rake + rent_floor == vault_lamports` before transfers. `rake = pot × rake_bps / 10_000` (checked, `rake_bps ≤ 1000`) → house; `payout = pot − rake` → winner. Closes Lobby (`close = creator`) and vault. Emits `MatchSettled{lobby, winner, payout, rake, match_id}`. Replay hits `status != Locked` / `AccountNotInitialized` and reverts.
- **`cancel_lobby` / `timeout_refund`** — refund recipients passed as `remaining_accounts` (each `players[i]` + its Entry). Refunds may be **chunked** across txs; `refunded_mask` is the ledger (bit-per-player) so no one is paid twice; flip to `Cancelled`/close only once the mask covers all `player_count` bits. **No rake on refund/cancel** — abandoned lobbies return 100%.

### 3.4 SOL / fee flows

- **Rent-exempt vault:** never let a payout leave the vault below its rent floor; drain to exactly-rent-floor-then-close.
- **Who pays what:** `create_lobby` — creator pays Lobby rent + own Entry rent + own stake + tx fee. `join_lobby` — joiner pays own Entry rent + stake + tx fee. `start_match` — authority pays tx fee. `settle_match` — authority pays tx fee; **winner receives payout net of rake, pays nothing**; creator gets Lobby rent back, winner gets Entry rent back on close. `cancel/timeout_refund` — the caller (creator or any permissionless reaper) pays tx fee; each player refunded stake **plus** Entry rent.
- **Priority fees:** server lock/settle txs attach `SetComputeUnitPrice`. Per SIMD-0096 priority fees go 100% to the validator — budget them as a real cost on the **server's fee wallet**, never the players'.
- **Pause switch:** `config.paused` blocks `create_lobby`/`join_lobby` only — settle and refund paths stay open so a discovered bug never traps in-flight pots.

---

## 4. Settlement authority

The chain can't see gameplay, so *something* must authorize the payout. That authority is the single trust point; harden it.

| Mechanism | Trust | Verdict |
|---|---|---|
| Single hot key on the game box | one leaked key drains every Locked pot | **rejected even for devnet** |
| Separate signer service + attestation | key isolated from the public game box; independently re-checks `winner ∈ roster` | **devnet** |
| Squads v4 M-of-N + attestation | no single key can pay a pot; leaked key ≠ theft | **mainnet** |
| Commit–reveal / optimistic dispute | anti-tamper / trust-min, but heavy & delays payout | Phase 2 (pairs with re-sim) |

**Devnet (recommended):** a **separate signer service on a different host** from the Colyseus/Express box. It accepts only `{lobbyPda, winner, matchId, transcriptHash}` carrying a valid **match-result attestation** (ed25519, signed by a *distinct* match-signing key held by the game server), independently re-derives `winner ∈ roster` from its own view of the locked lobby, then signs `settle_match`. Rationale (folds review C3): compromising the public game box no longer yields the payout key.

**Mainnet (recommended):** `settlement_authority = Squads v4 multisig`; settle needs M-of-N **and** the attestation. Mitigate multisig latency with a bounded automation member for small pots + a human threshold above a value cap. Swap devnet→mainnet by updating `Config.settlement_authority` — no redeploy.

**Always, everywhere:** the on-chain `winner ∈ players[]` assertion (§2) is the load-bearing floor and must be unconditional. `timeout_refund` caps an unavailable/compromised authority to "everyone refunded," never "funds stuck."

> Payout confirmation is **event-driven**. Do not hard-code a fixed confirmation wait in the UI — Alpenglow (~Q3–Q4 2026) cuts finality toward ~150ms; treat `finalized` as an event, not a timer.

---

## 5. Off-chain integration (Colyseus)

**Reuse `ArenaRoom`; add a `staked` definition, do not fork the class** (`server/src/index.ts`):

```ts
gameServer.define("arena",  ArenaRoom);                       // classic, free
gameServer.define("battle", ArenaRoom, { mode: "battle" });   // battle, free
gameServer.define("staked", ArenaRoom, { mode: "battle", staked: true }); // NEW
```

`onCreate` reads `this.staked = !!options.staked` and stores `lobbyPda, stakeLamports, creatorWallet, maxPlayers, minToStart`. When `staked`:
- **No bots** — skip the `CONFIG.botCount` loop; the winner is always a human `sessionId`.
- **No auto-start** — start in a waiting phase (`phase="waiting"`); the sim interval runs but `tick()` early-returns until `phase==="playing"`. Add `@type("string") lobbyState="open"` to `ArenaState` (`open|locked|playing|ended|settling|settled`).
- Open an `onAccountChange(lobbyPda)` subscription feeding an in-memory deposit cache (a *trigger*, not the admit decision — see gate (b)).

### 5.1 Two-gate join (`onAuth`)

```ts
async onAuth(client, options) {
  if (!this.staked) return true;                         // free rooms: open join
  const claim = verifySiws(options.siws);                // gate (a): wallet proof
  if (!claim) throw new ServerError(401, "bad wallet auth");
  const wallet = claim.pubkey;
  if (this.wallets.has(wallet)) throw new ServerError(409, "wallet already in lobby");
  const ok = await this.chain.hasFinalizedStake(this.lobbyPda, wallet, this.stakeLamports); // gate (b)
  if (!ok) throw new ServerError(402, "stake not confirmed");
  return { wallet };
}
```
- **Gate (a):** SIWS payload signed & bound to this room's `lobbyPda` + a single-use server nonce (§5.2).
- **Gate (b):** hard money gate. `hasFinalizedStake` reads the **`finalized`** Entry/deposit for *that wallet* and *that lobby* directly from chain (the subscription may trigger it but must not be the admit decision — folds review H8), and asserts the amount equals `stake_lamports` exactly and the Entry PDA is the program-derived one. No confirmed-but-not-finalized admits.

`onJoin` binds identity: `this.wallets.set(wallet, sessionId)`, add `@type("string") wallet` to `Hole` for short-address display. Everything else unchanged.

### 5.2 SIWS auth bound to sessionId

- Client calls `POST /siws/nonce` (added to the existing Express app) → single-use 32-byte nonce + issued-at + short TTL (~2 min), stored server-side keyed by nonce.
- Wallet signs a SIWS message: domain, pubkey, nonce, target `lobbyPda`, issued-at. Client passes `{siws:{message,signature,pubkey}}` into the Colyseus join call.
- `verifySiws` checks signature, nonce (exists/unexpired/unused), domain, and `lobbyPda` match, then **consumes the nonce** (replay-proof). Verified pubkey binds to `sessionId`.
- **Reconnect:** `allowReconnection`; on return the client re-runs SIWS with a fresh nonce and re-binds the new `sessionId` to the still-present staked hole. Gate (b) still requires that wallet's own on-chain stake, so no hole hijack.

### 5.3 Room lifecycle ↔ on-chain state

| On-chain | Room | Trigger | Actor |
|---|---|---|---|
| `Open` | `lobbyState=open, phase=waiting` | server observes `create_lobby` **finalized** before standing up the room | server |
| `Open` | funding | each joiner's stake finalizes → passes `onAuth` | joiners |
| `Locked` | `lobbyState=locked` + countdown | `minToStart` funded & ready → authority sends `start_match` | authority → server confirms |
| — | `phase=playing` | countdown hits 0 | **server** |
| `Locked` | `lobbyState=ended` | **staked win condition** fires (§7) | **server (authoritative)** |
| `Settling→Settled` | `lobbyState=settled` | signer service submits `settle_match`, waits `finalized`, broadcasts `payout` | **settlement authority** |

### 5.4 Deposit confirmation & settlement triggering (`server/src/chain.ts`)

New `ChainClient` wraps `@solana/web3.js` + the Anchor program:
- **Deposits:** subscription-triggered, **`finalized` read-through** admit (§5.1). Always `finalized` for money gates.
- **Settlement = a durable, idempotent job, not in-room fire-and-forget** (folds review H5/C2): before sending, persist `{lobbyPda, winner, matchId, transcriptHash}` to a store; a **settler worker** builds `settle_match`, retries with a fresh blockhash + escalating priority fee until `finalized`. Safe to re-run — the on-chain status gate makes a second settle revert. **Do not tear down settlement state on room disconnect.** `timeout_refund` is the ultimate backstop; a claim fallback surfaces in the UI if a payout keeps failing.

### 5.5 Staked-aware win condition & lifecycle (folds review C1/C2/C4/M11)

The existing `endMatch` heuristic **must not decide money.** Concretely, for staked rooms:

1. **No timed `endMatch`.** Disable the `roundSeconds` → `endMatch()` path (`ArenaRoom.ts:77`). A staked match ends **only** on last-alive/all-dead — never by score at the 2-minute mark (which today can pay a *dead* corpse via the line-473 fallback).
2. **Single winner source.** Winner = the unique hole with `dead === false`, computed over the **staked roster**, never from socket presence or score. Never pass a dead hole's wallet to `settle_match`.
3. **Fix the leave path.** Do **not** delete the hole in `onLeave` for staked rooms (today `ArenaRoom.ts:99` deletes it, which corrupts the `holes.size > 1` trigger at line 138 and can let a quitter win by score fallback). Instead mark the hole **abandoned but eliminable**, and drive the last-alive check off an `aliveCount()` over staked holes, not `holes.size`. A disconnect after `phase=playing` = **forfeit at current standing** (a loss), after a short **20–30s reconnect grace** during which the hole stays *in place and vulnerable*.
4. **Single-shot rooms.** In staked mode `endMatch` must **not** schedule `resetMatch()` (today `ArenaRoom.ts:477`). After the `payout` broadcast, `disconnect()` the room and free the wallet→room binding. A staked room never re-enters `phase="playing"` — otherwise it would try to settle an already-drained escrow.
5. **Tie / simultaneous elimination.** If a tick eliminates the last two at once (`zoneDamage` can set `alive=0`), apply a documented deterministic tiebreak — **radius at the prior tick → cumulative score → split pot minus rake** — and record which rule fired in the transcript. Support a `split`/`refund_all` settlement path for the true-tie.
6. **Committed RNG seed.** Replace physics-relevant `Math.random()` (city/boost/zone layout) with a **seeded PRNG** whose seed is **committed before lock** (derived from `lobbyPda` + a recent blockhash captured at `start_match`, stored in schema as `match_id`). Prerequisite to any future re-sim and prevents an operator retrofitting a favorable world.

Hook point: the `// Phase 4: server-authority key calls settle_match` comment at `ArenaRoom.ts:475`. `endMatch` (staked) maps `winnerId → winner.wallet`, sets `lobbyState=settling`, enqueues the settlement job, and does **not** reset.

### 5.6 Coexistence with free play

Free is default and untouched: Classic/Battle keep `joinOrCreate`, no wallet, `onAuth` early-returns `true`, bots on, auto-start, `resetMatch` recycles as today. Staking engages only when a user picks Staked **and** connects a wallet. Shared code is the simulation only — the anti-cheat model is identical whether or not money is attached.

---

## 6. Client flow

The existing `#status` panel, `#modeSel`, `#solPanel` (teaser), the locked **`Staked 💰 SOON`** button, and `#walletBtn` in `client3d/index.html` are the anchors. `#solPanel` evolves from teaser into the staking hub; the locked mode button becomes real; `#walletBtn` becomes a live connect button. A red **DEVNET** badge sits in `#solPanel` so no one confuses it with mainnet.

Every on-chain step exposes the four states the brief names — **pending / failed / insufficient balance / wrong network** — and every real-money action requires an explicit wallet signature (no silent auto-tx).

1. **Landing** — Classic/Battle unchanged (free `joinOrCreate`). "Staked" now enabled.
2. **Connect Wallet** — wallet-adapter modal (Phantom/Solflare). States: *not installed* (install link), *connecting*, *connected* (short address), *wrong network* (block: "switch to devnet"). Connection only — no SIWS yet.
3. **Staked hub** — **Create lobby** or **Browse lobbies**.
4. **Create** — form: stake (SOL), max players, min-to-start, public/private. **Balance check** (disable if `balance < stake + fees`). Confirm → wallet popup for `create_lobby`. States: *pending* (spinner + sig link) / *failed* (retry) / *confirmed* → enter waiting room as host. The room is only stood up **after** `create_lobby` is `finalized`.
5. **Browse** — live list from `GET /lobbies` (stake, filled/max, state badge). Click → **stake-confirm dialog** (buy-in + pot-if-won) → wallet popup for `join_lobby`. Same states → on *confirmed*, do SIWS (fetch nonce → sign) → `joinById`. Private lobbies join by share code, never listed.
6. **Waiting room** — player list with funded/ready flags, stake, live pot (funded × stake), min-to-start progress, ready toggle. A join that fails gate (b) surfaces *stake not confirmed* here.
7. **Locked → countdown** — host/authority locks: "Lobby locked — no new players", then the `countdown` overlay (3·2·1).
8. **Match** — identical to free Battle: same renderer, same `input` send loop, same shrinking zone. HUD adds a "POT: X SOL" chip.
9. **Results** — on `match_over` + `payout`: winner sees *You won — X SOL*; others *Eliminated*. On-chain states: *settling* (spinner, "paying out on-chain") / *settled* (tx sig link, updated balance) / *settlement failed* (claim/refund fallback button). Then "back to hub".

---

## 7. One-lobby-per-wallet

**Exact semantics:** a wallet may have **at most one CREATED lobby that is not yet settled** (`Open | Locked`). The seat frees the instant the match settles, is cancelled, or times out. It limits **hosting**, not holding stake — a wallet can still *join* elsewhere (subject to the §8 join-cap).

**Enforcement (source of truth = the chain):** the PDA seed `[b"lobby", creator]` + `init` (not `init_if_needed`) makes a second concurrent lobby per wallet **impossible on-chain**. The matchmaker's `Map<wallet, roomId>` is a **convenience cache in front of it, not the enforcement point** — and the server must only stand up a staked room **after** it has observed `create_lobby` `finalized` (folds review H7; prevents a multi-instance Colyseus deployment racing two rooms onto one PDA, and orphan rooms with no escrow).

**Residual gaps (stated plainly):** (a) it does **not** limit *joining* — add the §8 join-cap; (b) **alts defeat it** — N funded wallets = N lobbies; §8's rake + open matchmaking + fund-graph clustering are what contain rings; (c) never enforce it only in per-room memory.

---

## 8. Anti-abuse & fairness controls

Real SOL + a server that unilaterally names the winner is the whole risk surface. Controls ranked by impact:

**Fairness / accountability (ship in Phase 1):**
- **Signed, append-only match transcript** — server signs `{matchId, roster, stakes, committedSeed, winner, tiebreakRuleFired, finalStateHash}` with the match-signing key; **the transcript hash is written into the settlement tx**. Cheap cryptographic *commitment* to one outcome.
- **Stored input logs** — persist every client `{seq,dx,dz,tick}` + the committed seed per match (exposed for replay in a later minor version). Makes cheating *catchable*; the deterrent is auditability.
- **Deterministic re-simulation** (Phase 2) — a headless build re-runs the input log and must reproduce the signed winner. This is the actual verification; design the sim for it now (seeded RNG per §5.5, fixed timestep — `simHz:60` already helps, remove any wall-clock from physics). **Do not advertise "provably fair" until this exists.**

**Sybil / collusion / self-play** (alts are ~free on Solana, so identity defenses alone lose):
- **Rake makes wash-trading strictly unprofitable** — every self-played match burns `rake × pot` to the house regardless of who "wins." This is the single most effective lever and needs no identity model. Set rake so it exceeds any external reward edge (see §11); **3% is too low if any reward beyond the pot exists** — default **5%**.
- **Open, server-assigned matchmaking for anything with rewards beyond the pot.** A public quick-match pool removes an attacker's ability to guarantee an all-alt table; reserve hand-picked rosters for **private lobbies**, and make private results ineligible for leaderboards/promos.
- **Min players + min stake** raise the capital and live piloting an attacker needs (owner may set `MIN_PLAYERS=4`, §15).
- **Per-wallet join rate-limit** in the single authoritative matchmaker store (closes the "join many lobbies" gap the one-lobby rule doesn't).
- **Fund-graph clustering at settlement** — if all pot participants were funded from one address in a short window, **hold for review** before payout. Cheap off-chain analytics, high signal against rings.
- **Wallet-age / first-deposit heuristics** for *risk-flagging only* — never a hard on-chain block.

**Griefing (Battle has no respawns):**
- **Disconnect / leave after start = forfeit = loss.** The load-bearing rule: *you can never dodge a loss by leaving.* A disconnect is treated as elimination at current standing; if two remain and one leaves, the other **wins the pot**. Leaving *before* start = clean refund.
- **Reconnect grace 20–30s**, hole stays in place and vulnerable — distinguishes a flaky connection from a rage-quit without granting escape from a losing position.
- **AFK inside the zone** is naturally eliminated by `outDamage`; make it explicit as anti-stall, and treat no-input past grace as forfeit-at-standing.
- **Ready-up timeout** — once min players are funded, a countdown starts; not-ready-by-T is auto-kicked and **refunded** (never entered play).

---

## 9. Money edge cases

| Situation | Rule |
|---|---|
| Disconnect / reconnect mid-match | Hole stays live & vulnerable during 20–30s grace. Reconnect → resume. No reconnect → eliminated at current standing. **Never a refund; leaving can't beat a live opponent.** |
| Tie / simultaneous elimination | Deterministic tiebreak: prior-tick radius → cumulative score → **split pot minus rake**. Rule fired is recorded in the transcript; `split`/`refund_all` settle path used. |
| Lobby never fills (below `MIN_PLAYERS` at window end) | `cancel_lobby` (permissionless after `JOIN_WINDOW`) → **full refunds**, host slot freed. **No rake.** |
| Creator abandons an Open lobby | Permissionless `cancel_lobby` reaps & refunds joiners — no dependence on the creator. |
| Server crash mid-match / no signed transcript | Match is **void → full refunds** via `timeout_refund` after `SETTLE_TIMEOUT`. A crash never auto-declares a winner. |
| Payout tx to winner fails / reverts | Durable idempotent settler retries with fresh blockhash + escalating priority fee until `finalized`; on-chain status gate makes retries safe. `timeout_refund` is the ultimate backstop; UI exposes a claim fallback. |
| Winner never claims | **Push payout automatically** on settle (happy path — no manual claim). If a claim window is ever used, unclaimed funds recover to the **winner** via the multisig after a long window — **never swept to the house.** |
| Locked match never settles | `timeout_refund` (permissionless, after `SETTLE_TIMEOUT`) → full refunds. |

---

## 10. Fees & economics

- **Stake bounds:** `MIN_STAKE_LAMPORTS = 0.01 SOL` floor (above dust/rent). Upper bound is an owner decision (§15) — a cap limits blast radius per pot pre-audit.
- **Rake:** default **`RAKE_BPS = 500` (5%)**, guarded `0..=1000`. `pot = vault_lamports − rent_floor`; `rake = pot × rake_bps / 10_000` (checked); `payout = pot − rake`. Rake → `config.house_wallet` (a treasury PDA/multisig preferred over a raw wallet). **Rake only on `settle_match`** — refunds/cancels/voids return 100%.
- **Who pays tx/priority fees:** players pay their own create/join tx fees + Entry rent + stake; the **server fee wallet** pays lock/settle tx + priority fees (real budgeted cost, per SIMD-0096). Winner pays nothing on payout.
- **Rent:** vault topped to rent-exempt on first deposit, floor returned to creator on close; Lobby rent returned to creator, Entry rent returned to each player, on close.

---

## 11. Security checklist (pre-mainnet gate)

Critical & high items from the adversarial review, folded into the design above. All must be checked before mainnet holds real funds.

- [ ] **C1** Staked win condition is single-sourced on last-alive; **no timed `endMatch`**; never pay a dead/absent hole (§5.5).
- [ ] **C2** Staked rooms are **single-shot** — `endMatch` does not call `resetMatch`; room disconnects after payout (§5.5).
- [ ] **C3** Settlement key is **off the public game box** (devnet: separate signer service + attestation; mainnet: Squads M-of-N); `winner ∈ players[]` asserted unconditionally on-chain (§4).
- [ ] **C4** Staked `onLeave` does not delete the hole; last-alive driven by staked-roster `aliveCount()`, not `holes.size`; disconnect = forfeit-at-standing (§5.5).
- [ ] **H5** Settlement is a **durable, idempotent** job with retry + priority-fee escalation; state survives room teardown (§5.4).
- [ ] **H6** Rake set so wash-trading is unprofitable (default 5%); open matchmaking for reward-bearing play; join rate-limit; fund-graph hold-for-review (§8).
- [ ] **H7** One-lobby check is chain-enforced (`init`); room stood up only after `create_lobby` **finalized**; matchmaker map is cache-only (§7).
- [ ] **H8** Deposit admit reads **`finalized`** per-join, exact amount, program-derived Entry PDA — subscription only triggers (§5.1).
- [ ] **H9** `SETTLE_TIMEOUT_SECS` comfortably exceeds worst-case settle latency so `settle_match` and `timeout_refund` are never simultaneously valid; adequate priority fees budgeted (§3/§10).
- [ ] **H10** Deterministic tiebreak + `split`/`refund_all` settle path for simultaneous elimination (§9).
- [ ] **M11** Physics RNG seeded & **committed before lock** (§5.5).
- [ ] **M13** `settle_match` computes pot from **actual vault balance − rent floor**; asserts `payout + rake + rent_floor == vault_lamports` (§3.3).
- [ ] **M15** Unclaimed winnings recover to the **winner**, never swept to the house (§9).
- [ ] Anchor escrow program **audited**; devnet soak complete.

---

## 12. Regulatory & compliance

**Not legal advice — a flag to get qualified review.** Staking SOL in a winner-take-all match with a **house rake** is very likely **real-money gambling / skill-gaming** in many jurisdictions, and taking a rake makes the operator the **house**. Treat the following as **REQUIRED before any mainnet launch holding real funds**, not optional:

- Age-gating and **geoblocking** of prohibited jurisdictions (several US states + multiple countries).
- Published **Terms of Service** and a clear **prize/refund policy**.
- **KYC/AML** posture appropriate to volume and payout flows.
- A **responsible-play** stance.
- Qualified **legal counsel** in the operating jurisdiction signs off.

**Devnet only** until counsel signs off. Screenshots of "I lost SOL" become evidence — do not launch mainnet without this cleared.

---

## 13. Phased rollout

**Phase 0 — DONE.** Free-to-play Classic + Battle live; SOL surfaces present but **COMING SOON** (locked Staked button, Connect Wallet button, teaser `#solPanel`).

**Phase 1 — Devnet build.**
- [ ] Anchor `voidrun_escrow`: Config/Lobby/Vault/Entry, all instructions, state machine, `refunded_mask` chunked refunds, `timeout_refund`.
- [ ] `NETWORK=devnet` flag drives Anchor cluster + client RPC/wallet; red DEVNET badge.
- [ ] `server/src/chain.ts` (RPC + Anchor, finalized deposit gate, subscription trigger), `siws.ts`, `/siws/nonce` + `/lobbies` Express routes, `staked` room def.
- [ ] `schema.ts`: `wallet` + `ready` on `Hole`, `lobbyState` + committed `match_id`/seed on `ArenaState`.
- [ ] `ArenaRoom.ts` staked branch: no bots, waiting phase, two-gate `onAuth`, lock/countdown, staked-aware `onLeave`, **single-shot** `endMatch` at the line-475 hook, seeded PRNG.
- [ ] Separate **signer service** + match-result attestation; durable idempotent settler worker.
- [ ] Client: wallet-adapter connect, create/browse/waiting/results flow, four-state UX on every tx.
- [ ] Tests (`solana-test-validator` + headless Colyseus clients): full create→deposit→lock→scripted-battle→settle→payout; refund-on-abandonment; **second create from a live-lobby wallet rejected by both matchmaker map and PDA seed**; failure injection (deposit never finalizes → seat blocked; mid-match disconnect → surviving winner settled; settle RPC failure → retry then claim fallback; simultaneous elimination → tiebreak/split).

**Phase 2 — Audit + mainnet.**
- [ ] Program **audit** clears (fund-holding Anchor code).
- [ ] `settlement_authority` → **Squads v4 multisig** via a `Config` update (no redeploy).
- [ ] Deterministic re-simulation build + dispute window with staged escrow release.
- [ ] Legal/compliance gate (§12) cleared: geoblock, age-gate, KYC/AML, ToS, counsel sign-off.
- [ ] Mainnet Staked surface behind a flag until all of the above pass.

---

## 14. Open decisions for the owner

1. **Stake bounds** — keep the 0.01 SOL floor? Set an upper cap per pot (recommended pre-audit to bound blast radius)?
2. **Rake %** — default is 5%. Higher (up to the 10% guard) strengthens anti-wash-trading but costs UX. Confirm the number and where rake goes (treasury PDA vs multisig).
3. **Min players to start** — 2 (default) vs 4 (raises the cost of an all-alt table, at the price of slower fills).
4. **Public vs invite lobbies** — allow public open matchmaking, private invite-code lobbies, or both? Any rewards *beyond the pot* (leaderboard/promo) require open matchmaking + private-ineligibility.
5. **KYC / geoblock stance** — which jurisdictions to block, and what KYC threshold, pending counsel.
6. **Multisig signers** — who are the M-of-N Squads members for mainnet settlement, and the M/N threshold + any per-value automation cap?

---

*Grounding: `server/src/config.ts` (Battle params L46–52, `simHz`, no committed seed), `server/src/ArenaRoom.ts` (winner logic L468–478, zone trigger L127–139, `onLeave` L98–102, `resetMatch` L480–497, settle hook L475), `client3d/index.html` (`#solPanel`/`#walletBtn`/locked mode button), `DESIGN-BRIEF.md`.*
