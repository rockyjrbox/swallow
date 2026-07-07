# VOIDRUN — Visual Design Brief (UI/UX Handoff)

> Hand this to a design agent/designer. It is self-contained — assume no prior context.
> Goal: design every **2D UI surface** (screens, menus, HUD, overlays) that sits **on top of** the
> live 3D game. Do **not** redesign the 3D world itself (city, hole, models) — that is engine-rendered.

---

## 1. What VOIDRUN is

A browser **hole.io-style battle royale**: you are a black hole roaming a 3D city, swallowing everything
smaller than you (people → cars → buildings → skyscrapers → monuments), growing bigger, and out-massing
rivals. It is **real-time multiplayer** on an authoritative server (not fake bots — genuine netcode).

**The product goal:** a **Robinhood Chain-staked** version — pay $SWALLOW to enter a match, winner takes the pot. So the
UI must eventually support **wallet connect, stakes, a lobby, and payouts**, in addition to free play.

**Two modes today:**
- **Classic** — 2-minute timed free-for-all; highest mass wins; everyone respawns.
- **Battle** — last hole standing; a **shrinking danger zone** closes in; no respawns. (This is the format the staking plugs into.)

**Platform:** Web (desktop + mobile browser). The 3D runs on a `<canvas>` (Three.js); **all UI is HTML/CSS
overlaid on top** with `pointer-events` mostly disabled so it never blocks steering. Controls are
one-input: drag/point to steer (mobile), mouse or WASD (desktop). **Design mobile-first** — hole.io lives on phones.

---

## 2. Brand & art direction

**Name / wordmark:** `VOID` + `RUN`. Current treatment: "VOID" in ink, "RUN" in the purple→green gradient.
Keep a strong, ownable wordmark. A hole/void glyph (a dark circle with a conic purple-green rim) is the mascot mark.

**Voice:** crypto-arcade. Confident, punchy, a little sci-fi. Short verbs. "Swallow the city." "Winner takes the pot."

**Color tokens (from the live build — match these so UI and game feel like one product):**
| Token | Hex | Use |
|---|---|---|
| `--deep` | `#0a8f3f` | Deep green — gradient partner |
| `--green` | `#00c805` | Robinhood green — primary accent, player, success, CTAs |
| `--hot` | `#ff5c5c` / `#ff4040` | danger, threats, the battle zone, "eliminated" |
| `--ink` | `#0d1220` | near-black text / dark surfaces |
| gold rim | `#f0d48a`-ish | the hole's rim ring in-world (accent only) |
| sky | blue `#2f7fd6→#d3eeff`, sunset `#e79a44→#fbe6c2`, fresh `#3f9ec8→#e2f4ff` | 3 in-game themes exist; UI should read on all of them |

Signature accent = the **purple→green linear gradient** (`90deg, #9945ff, #14f195`) on the wordmark and primary buttons.

**Typography (current):** display = **Space Grotesk** (700/500/400); mono = **JetBrains Mono** (for numbers,
stats, timers, HUD). Keep a geometric display + a mono for "data." Use web fonts.

**HUD surface style ("glass pills"):** small rounded rects, `rgba(255,255,255,.78)` fill, 1px
`rgba(13,18,32,.1)` border, soft shadow `0 4-8px 18-22px rgba(20,30,60,.12-.14)`, radius ~9–16px, mono labels
in `#5a6072` uppercase micro-caps + bold value. These must stay legible over a **bright, busy 3D scene** —
lean on translucency + blur + shadow, not opaque panels.

**Motion / juice (core to the feel):** every eat has a crunch + particle burst + shake; level-ups flash; the
whole game is about the satisfying "gulp." UI should feel snappy and rewarding — micro-animations on
score ticks, level-ups, pot changes, and win/lose. Respect `prefers-reduced-motion`.

---

## 3. Surfaces to design (the work)

For **each** surface below, deliver: desktop + mobile layouts, all listed **states**, and the **content/data** shown.
Priority order is at the end.

### 3.1 Landing / Start screen  *(highest priority — the "starting web")*
First thing a visitor sees. Currently: a soft blue radial-gradient screen with a panel: wordmark, name input,
Classic/Battle toggle, a one-line mode hint, a best-score line, and a "Connect & play" button.
**Redesign it into a real front door.** Must include:
- Hero: **VOIDRUN wordmark** + the void glyph + a one-line tagline ("Swallow the city. Outgrow everyone.").
- Optional looping background (muted 3D city / hole motif) behind a readable panel.
- **Player name** input (max 16 chars).
- **Mode selector** — cards or segmented control for **Free / Classic**, **Battle**, and **Staked** (staked can be shown as "coming soon / connect wallet"). Each card: title, 1-line description, a badge (FREE, or "500 $SWALLOW", or "LAST STANDING").
- **Wallet area**: "Connect wallet" (MetaMask) button + connected state (truncated address `0x9fQe…4f`, $SWALLOW balance). When not connected, staked modes are gated with a nudge.
- **Meta strip**: best mass, games played, wins (from local stats now; account later).
- **Primary CTA**: "Play" / "Connect & play".
- **Skin picker** entry (see 3.10) — a few color swatches or "Customize" link.
- Small print: "Prototype — staking simulated" disclaimer slot.
- **States:** default, wallet-connecting, wallet-connected, staked-mode-selected-but-no-wallet (error nudge), returning player (shows stats), first-time (no stats).

### 3.2 Wallet connect flow
Modal/inline states for the EVM (MetaMask) wallet connection: **Connect → Signing (Sign-In-With-Ethereum) →
Connected**, plus errors (rejected, no wallet installed, wrong network). Show address + balance when connected.
For staked play: a **stake confirmation** step ("Stake 500 $SWALLOW to enter · pot 2,500 $SWALLOW · winner takes it") with
Approve/Cancel and a pending/confirmed transaction state. (Never asks for keys — wallet handles it.)

### 3.3 Lobby / matchmaking  *(for staked + battle)*
After choosing a staked/battle match: a waiting room. Content: **mode + stake**, **pot total** (stake × players),
list of **joined players** (name, avatar/skin dot, "staked ✓"), **N/max players**, a **countdown/looking-for-players**
state, "cancel / leave" (refund messaging for staked). **States:** searching, filling (3/5), full → starting, cancelled/refund.

### 3.4 Pre-match countdown
Big centered **3 · 2 · 1** over a dimmed scene, with the mode + stake line ("Battle · pot 2,500 $SWALLOW · winner takes all"
/ "Free run · play for the board"). Short, punchy.

### 3.5 In-game HUD  *(overlay — never blocks steering)*
The persistent play UI. Elements (all currently exist as glass pills — restyle cohesively):
- **Top-left cluster:** Level ("Lv 3"), Mass/score ("mass 431"), Match timer ("time 1:42", turns **red/urgent** near 0), latency ("42 ms").
- **Top-right:** **live leaderboard** (see 3.7).
- **Bottom-right:** **minimap** (see 3.6).
- **Center transient banners:** "**LEVEL 4**" flash on level-up; "**ELIMINATED**" (battle death); "**Nyx wins**" at match end. Design these as bold, animated, gradient-capable text moments.
- **Boost indicator:** when a speed **power-up** is active, show a timed boost badge/meter (cyan `#00e5ff`).
- **Battle-only:** a **zone status** cue — "Zone closing" warning + a directional/"you are outside the safe zone, get back!" alert with the red danger color; a shrink timer is a plus.
- **Fullscreen** + **mute** controls (small, corner).
- **Controls hint** for first-time players ("drag to steer") that fades out.
- **States:** classic vs battle (battle adds zone UI), player-alive vs eliminated (spectating), boosted vs normal, low-time urgency.

### 3.6 Minimap
Bottom-right panel. Shows the 300×300 world: **you** = white dot (green rim), **rivals** = their color (or **red** if
big enough to eat you), **big landmarks** = grey dots, and in **battle**, the **shrinking safe-zone circle** (red).
Currently a dark translucent rounded panel ~150×150. Style it; keep it readable and glanceable.

### 3.7 Live leaderboard (in-HUD)
Top-right, top ~6: rank color-dot + name (`·bot` tag for AI) + mass, **your row highlighted** (green, bold).
Updates continuously. Design compact rows that read over the bright scene.

### 3.8 Results / Scoreboard screen  *(highest priority alongside landing)*
End-of-match. Content:
- **Outcome headline:** "You win!" / "You placed #3" / "Eliminated".
- **Ranked list:** rank, skin dot, name (you tagged), final mass. Winner emphasized.
- **Payout line (staked):** "You won the pot — **+2,500 $SWALLOW** settles to your wallet (minus fee)" or "Pot goes to Nyx. Stake not recovered." (transaction state for real settlement).
- **Record badges:** "NEW HIGH SCORE", "BIGGEST VOID YET", milestone tags.
- **Your run stats:** this run mass, best combo/level, lifetime high score, wins/rounds.
- **CTAs:** "Play again" (same mode), "Back to lobby", "Share".
- **States:** win / lose / eliminated; staked (payout) vs free; new-record vs none.

### 3.9 Profile / stats / meta
A place for persistent progression: best mass, games, wins, win-rate, favorite mode, unlocked skins, (later) wallet/tx history.
Can be a panel off the landing screen. Design the empty (new player) and populated states.

### 3.10 Skins / cosmetics picker
hole.io's monetization is cosmetic hole skins. Design a **skin grid**: solid colors, gradients, animated/themed
skins, with locked (price/how-to-unlock) vs owned vs equipped states, and a live preview of the hole. Include a
"currency / shop" affordance for later. (Player color is currently auto-assigned — this replaces that with choice.)

### 3.11 Settings
Audio (master/SFX/music toggles + volume), controls (sensitivity, invert, touch layout), graphics (quality/shadows
toggle for weaker phones), account/wallet, language slot. Simple, sectioned.

### 3.12 System states (apply across the app)
- **Loading / connecting** (assets + server): branded spinner/void animation, "connecting…" + failure ("couldn't
  reach the server — retry").
- **Disconnected / reconnecting** mid-match.
- **Empty states** (no stats, no skins, no history).
- **Errors** (wallet rejected, match full, server down).
- **Toast/notification** style for events (pot updated, player joined, boost picked up).

---

## 4. Content & data reference (use realistic values in mocks)
- Names: `You / Player`, bots: `Nyx, Maw, Abyss, Rift, Hex, Void, Null, Gloom`.
- Levels 1–12; mass/score 0–~5000; match 2:00 countdown; ping ~5–60ms.
- Object tiers (for iconography if needed): person, cone, hydrant, bench, car, tree, bus, fountain, house, factory,
  building, crane, mall, skyscraper, office/hotel/tall tower, stadium, megatower, monument.
- Stake example: 500 $SWALLOW entry × 5 players = **2,500 $SWALLOW pot**; wallet balance e.g. `12,400 $SWALLOW`; address `0x9fQe…4f2a`.
- Power-up: **Speed boost** (cyan), 5s.

---

## 5. Constraints & delivery notes
- **HTML/CSS overlay over a WebGL canvas.** UI must be lightweight, translucent, and **non-blocking** (steering
  happens through the UI layer except on interactive controls). Provide CSS-implementable specs (web fonts, no
  exotic effects that tank mobile GPUs — the canvas already uses the GPU).
- **Mobile-first + desktop.** Breakpoints ≥ ~380px (phone) and ≥ ~1024px (desktop). Thumb-reachable controls; safe-area insets.
- **Readable over a bright, moving 3D scene** in 3 sky themes (day/sunset/fresh) — use translucency, blur, shadow, outline.
- **Deliverables:** Figma (or equivalent) with (a) a small **design-token sheet** (colors, type scale, radii, shadows,
  spacing), (b) each surface in desktop + mobile with all states, (c) the reusable **components** (glass pill,
  button, mode card, leaderboard row, minimap frame, banner, modal), (d) redlines/specs for handoff to CSS.
- **Accessibility:** WCAG AA contrast for text/controls over the busy scene; visible focus; reduced-motion variants;
  color-blind-safe rival differentiation (don't rely on red/green alone — add shape/label).
- **Don't touch** the 3D game world's look (hole, city, models, particles) — that's separate/engine-side. You *may*
  propose styling for the in-world text banners and the hole's rim/zone colors since those are art-directable.

---

## 6. Suggested priority order
1. **Landing / Start screen** (3.1) — the "starting web," + skin-picker entry (3.10) and meta strip (3.9).
2. **In-game HUD** (3.5) incl. **leaderboard** (3.7) and **minimap** (3.6).
3. **Results / Scoreboard** (3.8) + **pre-match countdown** (3.4).
4. **Battle-mode zone UI** (part of 3.5) + **boost indicator**.
5. **Wallet / stake flow** (3.2) + **lobby** (3.3) — needed for the staked product.
6. **Settings** (3.11), **skins shop** (3.10 full), **profile** (3.9 full), **system states** (3.12).

## 7. Reference
The working build (all surfaces exist in rough form) runs at `http://localhost:2567/` — start screen, HUD pills,
leaderboard, minimap, banners, and the two modes are live and can be screenshotted for "before" reference. The
current look is functional-but-plain; the goal is a cohesive, premium **crypto-arcade** identity across all of it.
