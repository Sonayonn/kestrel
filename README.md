# Kestrel

Trustless, private conditional-order execution for Solana perps.

Arm a stop-loss / trailing stop / bracket order. It is watched in real time inside a
MagicBlock **Private Ephemeral Rollup** (invisible to front-runners until it fires), and
settled on **FlashTrade** the instant the trigger hits — non-custodial, sub-second, gasless
to watch. Exposed as a one-call SDK any Solana trading app can build on.

## How it uses MagicBlock (each piece load-bearing)
- **Ephemeral Rollup** — the always-on watcher. The watch loop is impossible/too expensive on mainnet.
- **Private ER (TEE)** — order price + size hidden (owner-only) until execution. Anti-snipe.
- **Pricing Oracle** — Pyth Lazer pushed into the rollup every 50–200ms = our trigger heartbeat.
- **Magic Actions** — `add_post_commit_actions` fires the FlashTrade settle on mainnet right after commit.
- **FlashTrade** (partner) — the venue. Settle via openPosition/closePosition with the partner builder code (rebate).

## Build plan — 5 pillars (the 30 feature ideas collapse into these)

The crank evaluating a condition tree is the core primitive; most "features" are just
condition types or observability on the same pipeline. Build the pillar, the behaviors fall out.

**Pillar A — Condition engine.** The ER crank evaluates an AND/OR condition tree each tick.
Delivers: stop-loss, take-profit, trailing stop (#3), multi-condition AND/OR (#6),
funding-rate trigger (#22), max-drawdown circuit breaker (#23), expiry + auto-undelegate (#14).

**Pillar B — Order groups.** Linked orders with cancel-surviving-leg.
Delivers: bracket / OCO (#2), light if-then chaining (#12).

**Pillar C — Privacy (TEE).** Ephemeral permission, owner-only read.
Delivers: private order book (#1) — wraps every order. The centerpiece.

**Pillar D — Settlement + observability.** Magic Action → FlashTrade fill, instrumented.
Delivers: live fill, slippage guardrail / auto-abort (#13), referral hook (#15),
on-chain execution receipts (#8), live latency SLA (#30), Telegram fill notify (#18).

**Pillar E — SDK + dashboard.** The layer surface + a live UI.
Delivers: one-call SDK (#5), gasless order amendment (#28), live P&L dashboard (#7),
multi-asset portfolio view (#10).

### Sequencing (each tier ships on a green spine)
- **T0 spine (in progress):** create_order → delegate → check → Magic Action → live FlashTrade fill.
- **T1 must-ship:** Pillar C privacy, Pillar B bracket, Pillar A (SL/TP/trailing), Pillar D (fill + receipts + latency + notify + referral + guardrail), Pillar E SDK.
- **T2 if spine green by end of Day 2:** Pillar A extensions (#6 multi-condition, #22 funding, #23 drawdown), Pillar E dashboard (#7, #10), amendment (#28).

## Status (tick as we go)
- [x] Toolchain validated (solana 3.1.9, anchor-cli 0.32.1, node 22)
- [x] Reference `magic-actions` builds + deploys to MagicBlock devnet ER (id FkDA…GZE)
- [ ] ER round-trip test runs (install ts-mocha deps, re-run)  ← we are here
- [x] Kestrel spine `lib.rs` written against ephemeral-rollups-sdk 0.14.3
- [ ] `kestrel-app` workspace builds (`anchor build` green)
- [ ] Spine on ER: create_order → delegate → check → Magic Action settle
- [ ] FlashTrade settle wired into `settle_on_flashtrade` (needs the signing answer)
- [ ] T1: privacy (C), bracket (B), SL/TP/trailing (A), receipts+latency+notify+referral+guardrail (D), SDK (E)
- [ ] T2: multi-condition / funding / drawdown (A), dashboard (E), amendment

## Roadmap (deliberately out of scope for the 48h build — the "what's next" narrative)
Vault / shared strategy pool (#29), permissionless keeper incentive network (#17),
on-chain backtesting (#26), ER health-monitor + multi-region failover (#20),
cross-asset hedge trigger (#16), iceberg orders (#11), strategy template marketplace (#19),
social M-of-N stop-loss (#25), order fingerprinting (#24), volatility-adaptive sizing (#21),
liquidation-defense partial close (#27 — pull forward first if FlashTrade exposes position health cheaply),
sponsored gasless onboarding (#9).

## Two blocking questions (must be answered before settlement code)
- **FlashTrade:** can a PDA / pre-authorized session key sign open/close for a user's position
  (delegated trading authority via Privilege / NFT trading account)? This decides if the live fill is real.
- **MagicBlock:** do post-commit Magic Actions work from the **TEE** (PER) validator, not just plain ERs?
  If not, fallback: commit a `triggered` flag to mainnet and let the keeper submit the FlashTrade tx.

## Reference implementations we fork
- `magicblock-labs/magicblock-engine-examples` — anchor-counter (public + private), magic-actions
- `magicblock-labs/real-time-pricing-oracle` — chain pusher + example price consumer
- `flash-trade/flash-trade-sdk` — examples/src/trade.ts (openPosition / closePosition)

## Toolchain
Clone anchor-counter first and match its lockfile versions exactly (doc version tables disagree).
Install the MagicBlock dev skill for AI-assisted coding:
`npx add-skill https://github.com/magicblock-labs/magicblock-dev-skill`