# Swallow — Solana → Robinhood Chain swap plan

> ✅ **APPLIED 2026-07-02.** Decisions taken: token = **$SWALLOW** (placeholder, staking stays simulated/coming-soon), wallet = generic "Connect Wallet" (MetaMask/Rabby named), Sign-In-With-Ethereum, UI chrome reskinned to Robinhood greens (#00c805 primary, #0a8f3f deep, #8fe0a8 soft — in-game skins untouched), amounts = 500 / 2,500 $SWALLOW. Spec rewritten → `SWALLOW-INTEGRATION.md` (old SOL spec deleted). This file is kept as the change record.

---

## 0. Decisions you need to make first

| # | Decision | Options | My recommendation |
|---|----------|---------|-------------------|
| **A** | **Stake currency** | (1) a project ERC-20 token · (2) ETH (Robinhood Chain's gas token) | **Project token** — gives it utility. Example amounts below assume a `500`-token entry (tell me the real number you want shown). |
| **B** | **Wallet brand shown** | (1) **MetaMask** · (2) Robinhood Wallet · (3) generic "Connect Wallet" | **Generic "Connect Wallet"** with MetaMask named as the example — Robinhood Chain is EVM, so any EVM wallet works; don't marry the UI to one brand. |
| **C** | **Sign-in wording** | "Sign in with Ethereum" (SIWE — the real EVM standard) vs "Sign in with Robinhood Chain" | **"Sign in with Ethereum"** — it's the actual standard (EIP-4361) and stays technically true. |
| **D** | **Color palette** | The current purple/green gradient (#9945ff → #14f195) **is literally Solana's brand gradient.** (1) Keep it (it's just a pretty palette) · (2) Reskin to Robinhood green (#00C805) + dark | **Keep for now** — a reskin touches ~60 CSS spots + the 8 skins + server color allow-list. Do it later as its own pass if you want the Robinhood look. |
| **E** | **Example stake numbers** | "0.05 ◎ × 5 = 0.25 ◎" becomes e.g. "500 × 5 = 2,500 tokens" | Your call — give me the entry amount you want displayed. |

### ⚠️ Security flag (before any REAL staking is built)
The UI swap below is cosmetic and safe to do now — but the **real escrow integration must use a freshly deployed token with no owner powers, from a clean key**. Never grant any pre-existing deployment or its keys a role over staked funds. This is called out again in the spec rewrite (item 3).

---

## 1. Client UI copy — `client3d/index.html` (10 spots)

| Where (line ≈) | Current | Proposed |
|---|---|---|
| Hero ticker (290) | `staking coming soon` | *(keep — chain-agnostic)* |
| Stake band headline (337) | **"Ante up SOL."** | **"Ante up $SWALLOW."** |
| Stake band body (338) | "…stakes the same entry into an on-chain escrow…" | *(keep — chain-agnostic)* add "on Robinhood Chain" → "…into an on-chain escrow **on Robinhood Chain**…" |
| Stake stats (340–342) | `ENTRY 0.05 ◎` · `×5 PLAYERS 0.25 ◎` · `WINNER TAKES 0.25 ◎` | `ENTRY 500 $SWALLOW` · `×5 PLAYERS 2,500 $SWALLOW` · `WINNER TAKES 2,500 $SWALLOW` *(pending decision E)* |
| Footer note (350) | `Prototype · staking coming soon` | *(keep)* |
| Staked mode card (1263) | "Ante up SOL. Winner takes the pot." | "Ante up $SWALLOW. Winner takes the pot." |
| Wallet step 1 (1361) | "Connect with **Phantom**" | "Connect Wallet" (button) + body line gains "MetaMask, Rabby, or any EVM wallet." *(pending decision B)* |
| Wallet step 2 (1364) | "Sign in with **Solana**" + "no gas · no transaction · just a signature" | "Sign in with **Ethereum**" — gas line **stays** (true for SIWE too) |
| Wallet pending (1373) | "Confirming on **Solana**… " + `tx 5Kd9…a1c · ~2s` | "Confirming on **Robinhood Chain**…" + `tx 0x5d9f…a1c · ~2s` (EVM-style hash) |
| Wallet connected (1367) | address `9xQe…4f2a`, balance `1.20 ◎` | address `0x9fQe…4f2a`, balance `12,400 $SWALLOW` |
| Stake confirm (1370) | `Entry stake 0.05 ◎ · Winner takes 0.25 ◎ · Approve 0.05 ◎` | `500 $SWALLOW / 2,500 $SWALLOW / Approve 500 $SWALLOW` |
| Confirmed (1376) | "Staked 0.05 ◎ · pot is now 0.25 ◎" | "Staked 500 $SWALLOW · pot is now 2,500 $SWALLOW" |
| Lobby pot (1396) | `0.25 ◎` | `2,500 $SWALLOW` |
| Results payout (~1455) | "Free match · **SOL** staking coming soon" | "Free match · **$SWALLOW** staking coming soon" |

Also: every `◎` glyph disappears (it's the SOL symbol) → plain `$SWALLOW` text.

## 2. Docs

| File | Change |
|---|---|
| `SOL-INTEGRATION.md` (374 lines) | **Full rewrite → `SWALLOW-INTEGRATION.md`** — see item 3. Old file deleted. |
| `DESIGN-BRIEF.md` | Historical design doc. Options: light find/replace (Solana→Robinhood Chain, Phantom→MetaMask, SOL→$SWALLOW) or mark "historical — see SWALLOW-INTEGRATION.md". **Recommend the light find/replace.** |
| `LAUNCH.md` | 1 line: "The Solana/staking surfaces…" → "The staking surfaces…". |
| `README.md` | Check + swap any Solana mention. |
| Landing `og:` metas | No Solana references — untouched. |

## 3. Spec rewrite — `SOL-INTEGRATION.md` → `SWALLOW-INTEGRATION.md`

The staking spec is Solana-native (Anchor program, PDAs, Squads multisig, devnet). The EVM equivalent:

| Solana concept (current spec) | Robinhood Chain equivalent (new spec) |
|---|---|
| Anchor program + PDA vault escrow | **Solidity escrow contract** (audited pattern: pull-payment vault) holding **ERC-20 $SWALLOW** via `approve`+`transferFrom` |
| Sign-In-With-Solana | **SIWE (EIP-4361)** |
| One-lobby-per-wallet via PDA init collision | `mapping(address => uint256) activeLobby` guard in the contract |
| Squads v4 multisig settlement authority | **Safe (Gnosis) multisig** settlement authority |
| Devnet → mainnet gating | **Robinhood Chain testnet → mainnet** gating (same audit/legal gates) |
| `settle_match` asserts winner ∈ players | Same invariant, Solidity `require` |
| Permissionless `timeout_refund` | Same, public function after deadline |
| ~2s finality copy | Robinhood Chain is an Arbitrum Orbit L2 — near-instant soft finality; copy stays "~2s" |

Carries over unchanged: 5% rake, one-live-lobby-per-creator, PvP-only staked rooms, "funds never trapped" refund paths, server-authority winner attestation, **plus the new ⚠️: the escrow must never grant any pre-existing deployment or its keys a role over staked funds.**

## 4. Explicitly untouched (verified no Solana references)
- `server/src/*` (settlement comment is already chain-neutral)
- `client3d/local-sim.js` (pure gameplay)
- Game balance/config, skins system, achievements, Render/Vercel deploy configs

## 5. Order of work when you say go
1. Client copy swap (item 1) → verify wallet-flow screens in preview → deploy to Vercel + push GitHub.
2. Docs find/replace (item 2).
3. `SWALLOW-INTEGRATION.md` rewrite (item 3) — the big one, ~30 min.
4. (Optional, later) Decision D reskin pass.
