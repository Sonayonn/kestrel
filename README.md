# Kestrel

**Private, programmable conditional orders for Solana perps.** Arm a stop-loss, take-profit, trailing stop or bracket — Kestrel watches the market and fires it the instant your price hits. On-chain, non-custodial, and invisible until it executes.

- **Live app:** _(your deployed URL)_ · **Docs:** `/docs.html`
- **Program (devnet):** `JXiSmxyKzXaiCQ28WawpQ3RBmCPuw3Gvvfzg4VTKyML`
- **Demo:** _(your video link)_

Built for the MagicBlock × FlashTrade hackathon.

---

## The problem

On-chain conditional orders are broken in three ways. They're **public** — your stop-loss trigger sits in plain view, so MEV bots can see it coming and hunt it. They're **rigid** — a venue natively offers only simple, exit-only triggers, not the entries, trailing, brackets and multi-condition logic traders actually want. And they're **hard to automate trustlessly** — watching a price every tick is impossible on mainnet (gas, latency), so today you either trust a centralized exchange's servers or run a bot that dies the moment your machine does.

## The idea

Kestrel is a layer *above* a perp venue, not a replacement for it. Each order is delegated into a **MagicBlock Ephemeral Rollup**, where a crank evaluates its condition every tick — sub-50ms, gasless — an always-on watch loop that's impossible on mainnet. Orders run inside a **Private Rollup (TEE)**, so the trigger price, size and direction stay sealed in the enclave until the order fires, which kills the stop-hunting that plagues public orders. When a trigger hits, a post-commit **Magic Action** stamps a tamper-proof receipt on-chain, and a keeper settles the position on **FlashTrade**, anchoring the execution back on-chain.

> Watched in a rollup, hidden in a TEE, settled on a real venue — exposed as one SDK call.

The Ephemeral Rollup isn't an add-on here; it's the engine. The whole product depends on a private, continuous watch loop only an ER can provide.

## How it works

```
arm ─▶ delegate to ER (TEE) ─▶ crank fires on trigger ─▶ Magic Action: on-chain receipt
                                                                   │
                                            keeper settles on FlashTrade ─▶ confirm_fill
                                                                   │
                                              Armed ─▶ Triggered ─▶ Settled (entry anchored)
```

The lifecycle is fully auditable on-chain: a `Fill` receipt moves Armed → Triggered → Settled, carrying the fired price and the settled entry price.

## What's live

- **The full private pipeline on devnet** — arm → delegate → private crank fires → on-chain receipt → settlement. Reproducible end to end.
- **Privacy proven (TEE):** the owner can read their order; a stranger is blocked. (5/5, `tests/kestrel-privacy.ts`.)
- **Keeper-bridge proven:** trigger → Triggered → `confirm_fill` → Settled, mainnet signature slot anchored. (`tests/kestrel.ts`.)
- **FlashTrade integration live-verified:** the keeper calls FlashTrade's mainnet API on every trigger, pulls a real executable quote, and anchors the real entry price on-chain.
- **Live console:** drives the whole lifecycle — arm, delegate, fire, settle — from the browser, signed by your wallet, with each order streaming Armed → Triggered → Settled. Plus a one-call SDK and an SDK reference.

**Honest note on the fill.** The integration runs end-to-end against real FlashTrade infrastructure; the one step withheld in the demo is signing the *funded* position, which needs real collateral we didn't wire in. `PREVIEW=0` with a funded basket executes that final step — the wiring is real and proven, minus the funded signature. No real-money position was opened in the demo.

## Why two clusters (devnet + mainnet)

The watch loop runs on devnet, where the MagicBlock ER and TEE were developed; FlashTrade settlement is on mainnet, where its liquidity and price feeds live (devnet FlashTrade has no working oracle). The keeper bridges them. **In production Kestrel deploys on a mainnet ER and collapses to a single cluster** — the split is a development convenience, not part of the design.

## Quickstart

```bash
# program
anchor build && anchor deploy            # deploys to the MagicBlock devnet endpoint

# tests (proof)
anchor test --skip-build --skip-deploy   # keeper-bridge spine
ANCHOR_PROVIDER_URL=https://devnet-tee.magicblock.app ANCHOR_WALLET=~/.config/solana/id.json \
  yarn ts-mocha -p ./tsconfig.json -t 120000 tests/kestrel-privacy.ts   # TEE privacy

# app (static; also deployable on Vercel)
cd site && npx serve .

# keeper (preview — live FlashTrade quotes, no funds)
KEEPER_KEYPAIR=~/.config/solana/id.json bun run keeper-v2.ts
```

## SDK

```ts
import { KestrelClient } from "@kestrel/sdk";

const k = new KestrelClient({ connection, wallet, programId, idl });

const { id } = await k.arm({
  kind: "stop_loss", side: "close",
  triggerPrice: 140, referencePrice: 150, size: 11_000_000, private: true,
});

k.watchFills(f => console.log(f.status, f.entryPrice));
```

Full reference on the **Docs** page (`/docs.html`).

## Architecture notes

- **Order** and **Fill** are id-keyed PDAs (multi-order per wallet). `Fill` is the lifecycle source of truth.
- **Privacy** uses MagicBlock ephemeral permissions: `init_permission` → `set_privacy(true)` on the TEE validator; reads are gated by an auth token.
- **Settlement** is a keeper-bridge: the on-chain program never holds funds; the keeper opens the FlashTrade position with a scoped session key and calls `confirm_fill` to anchor the result.

## Built with

Solana · Anchor · MagicBlock Ephemeral Rollups + Private Rollups (TEE) · FlashTrade.

## License

MIT.