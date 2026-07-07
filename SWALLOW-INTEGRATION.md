# Swallow — $SWALLOW Staked Lobbies on Robinhood Chain (Engineering Spec)

Wire real staking onto **Battle mode**: a creator sets a buy-in in **$SWALLOW** (ERC-20), others stake the same amount into an on-chain escrow on **Robinhood Chain** (EVM, Arbitrum Orbit), one Battle match runs, and the **winner takes the pot** minus a house rake. Server authority over eat/elimination (the existing anti-cheat foundation) is untouched; staking adds only a *money + lifecycle* layer around a match.

**Status:** UI surfaces shipped as **COMING SOON placeholders** (simulated wallet flow, `$SWALLOW` amounts are illustrative). **Nothing on-chain exists or runs.** This document specifies **Phase 1 (testnet)** and gates Phase 2 (audit + mainnet). Testnet first; **no mainnet funds until an audit and legal review clear.**

> ### ⚠️ Token prerequisite
> **$SWALLOW is not deployed yet.** Do not repurpose any previously deployed token contract or its keys for this system. Before Phase 1: deploy a fresh `$SWALLOW` ERC-20 with a **fixed supply and no owner powers** (constructor-mint, no mint/pause/blacklist functions, or ownership renounced at deploy) from a clean, hardware-backed key, then verify source.

---

## 1. Goals & non-goals

**Goals**
- Free play stays **100% free and default**. Classic and Battle never require a wallet.
- Staking is strictly **opt-in**, and only on **Battle** mode (last-hole-standing).
- **Winner takes the pot** (`stake × players`) minus a fixed rake to the house.
- Enforce **~one live lobby per creator wallet** on-chain (anti-abuse).
- Funds are **never trapped**: every failure path resolves to payout or full refund.
- Reuse the existing `ArenaRoom` simulation byte-for-byte — money changes gating/lifecycle/settlement, never physics.

**Non-goals (Phase 1)**
- No "provably fair" claim (deterministic re-sim is a Phase 2 target — don't over-claim).
- No bots in staked rooms — real money is **PvP-only**.
- No mainnet launch or real-value custody until audit + legal gates clear.
- No on-chain adjudication of gameplay — the chain never sees `{dx,dz}`; a signed off-chain authority names the winner.

## 2. Trust model at a glance

The escrow contract is trustless (it custodies $SWALLOW, enforces one-lobby-per-wallet, guards double-settle/refund). **The one thing players must trust is that our off-chain server names the correct winner**, because only the server sees gameplay.

| Layer | Testnet posture | Mainnet posture |
|---|---|---|
| $SWALLOW custody | Escrow contract holds ERC-20 via `approve` + `transferFrom` | Same, **audited** |
| Winner authority | Separate signer service (**off the game box**) + match-result attestation | **Safe (Gnosis) M-of-N multisig** + attestation |
| One-lobby-per-wallet | `mapping(address => uint256) activeLobbyOf` — create reverts if non-zero | Same |
| Liveness backstop | Permissionless `timeoutRefund()` / `cancelLobby()` after deadlines | Same |
| Fairness evidence | Signed match transcript + stored input logs | + deterministic re-sim + dispute window |

**Non-negotiable on-chain invariant (all environments):** `settle(lobbyId, winner)` requires `winner ∈ lobby.players[]`. Even a fully compromised settlement key can then only pay *an actual staker* — theft-of-arbitrary-address becomes at-worst grief, and the timeout path caps an *unavailable* authority at "everyone refunded."

## 3. Escrow contract (Solidity) — lobby lifecycle

One contract, many lobbies. No upgradeability (immutable logic; redeploy to change rules).

```
struct Lobby {
  address creator;
  uint96  stake;          // per-player, in $SWALLOW base units
  uint8   maxPlayers;     // 2..16 (UI default 5)
  uint40  fillDeadline;   // unix — cancel/refund path opens after this
  uint40  settleDeadline; // unix — set when match starts; timeoutRefund after this
  uint8   state;          // 0 Open · 1 Full/Playing · 2 Settled · 3 Refunded
  address[] players;
}
```

- `createLobby(stake, maxPlayers)` — reverts if `activeLobbyOf[msg.sender] != 0`. Pulls creator's stake. Emits `LobbyCreated`.
- `joinLobby(id)` — pulls stake; auto-locks at `maxPlayers` (state → Playing, sets `settleDeadline = now + MATCH_TTL`).
- `settle(id, winner)` — **only settlement authority**; requires state Playing and `winner ∈ players`; pays `pot − rake` to winner, `rake` (**5%**, immutable constant) to the house address; clears `activeLobbyOf[creator]`.
- `cancelLobby(id)` — creator (or anyone after `fillDeadline`) refunds all stakes while still Open.
- `timeoutRefund(id)` — **permissionless** after `settleDeadline`: full refund to all players (authority went dark ⇒ nobody loses funds).
- Reentrancy-guarded; pull-over-push not needed for ERC-20 transfers but all external calls last; no ETH handled anywhere.

## 4. Auth & flow

1. **Connect** — any EVM wallet (MetaMask, Rabby, WalletConnect). Add/switch to Robinhood Chain via `wallet_addEthereumChain`.
2. **Sign-In-With-Ethereum (EIP-4361)** — free signature binds wallet ↔ game session (no gas).
3. **Stake** — `approve(escrow, stake)` then `createLobby`/`joinLobby` (two txs; or one with EIP-2612 permit if the fresh $SWALLOW implements it — recommended).
4. Server watches lobby events → when Full, spins up a **private staked ArenaRoom** (join gated by SIWE identity ∈ lobby players; **no bots**).
5. Match ends → server produces a signed result attestation → settlement service (separate box/key) submits `settle(id, winner)`.
6. Client results screen shows the payout tx hash; "Play again" creates/joins a fresh lobby.

## 5. Server integration points

- `gameServer.define("staked", ArenaRoom, { mode: "battle", staked: true })` — same sim; `onAuth` verifies SIWE session + lobby membership; `minClients = lobby.maxPlayers` (no bots, no mid-join).
- On `endMatch`, the existing settlement hook (`ArenaRoom.endMatch` comment) emits `{lobbyId, winnerAddress, transcriptHash}` to the settlement service (HTTP + signed payload). The game server itself **never holds a key that can move funds**.
- Disconnect policy in staked rooms: a disconnected player's hole idles (no respawn protection abuse); match still settles normally — the zone resolves it.

## 6. Phases & gates

| Phase | Scope | Gate to advance |
|---|---|---|
| **0 (done)** | Free game live; staking UI is a simulated placeholder | — |
| **1** | Deploy fresh $SWALLOW (see ⚠️) + escrow on **Robinhood Chain testnet**; wire wallet connect/SIWE/stake flow behind a `?staking=beta` flag; internal playtests with test tokens | All lifecycle paths exercised incl. both refund paths; no stuck-funds scenario found |
| **2** | **Security audit** of the escrow + settlement service; legal review (real-money gaming exposure by jurisdiction); Safe multisig for settlement | Audit issues resolved; legal sign-off |
| **3** | Mainnet: caps first (max stake, max concurrent lobbies), monitoring + alerting on every contract event, public launch | — |

## 7. Open decisions

- **$SWALLOW tokenomics** — supply, distribution, whether play rewards exist outside staking (out of scope here).
- **Rake destination** — plain house EOA vs Safe (recommend Safe from day one).
- **Match TTL** — `settleDeadline` window (suggest 30 min: battle ≤ 7 min + generous ops buffer).
- **Permit support** — build EIP-2612 into the fresh token to make staking one-tap.
