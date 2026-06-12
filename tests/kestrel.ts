// Kestrel spine test — modeled on the proven magic-actions devnet harness.
// Flow: arm a stop-loss -> delegate to ER (+ fund the Magic Action escrow) ->
// crank check() on the ER with a triggering price -> read the Fill receipt on base layer.
//
// Run after `anchor build` is green:
//   anchor deploy && yarn ts-mocha -p ./tsconfig.json -t 120000 tests/kestrel.ts
// (or `anchor test --skip-local-validator` if your Anchor.toml test script points here)

import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import { Kestrel } from "../target/types/kestrel";
import {
  ConnectionMagicRouter,
  createTopUpEscrowInstruction,
  escrowPdaFromEscrowAuthority,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

const ORDER_SEED = "order";
const FILL_SEED = "fill";

describe("kestrel", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.kestrel as Program<Kestrel>;
  const wallet = anchor.Wallet.local();

  const router = new ConnectionMagicRouter(
    process.env.ROUTER_ENDPOINT || "https://devnet-router.magicblock.app",
    { wsEndpoint: process.env.ROUTER_WS_ENDPOINT || "wss://devnet-router.magicblock.app" }
  );

  const [orderPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(ORDER_SEED), wallet.publicKey.toBuffer()],
    program.programId
  );
  const [fillPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(FILL_SEED), orderPda.toBuffer()],
    program.programId
  );

  console.log("Program:", program.programId.toBase58());
  console.log("Order PDA:", orderPda.toBase58(), "| Fill PDA:", fillPda.toBase58());

  it("Arms a stop-loss", async () => {
    const params = {
      sessionAuthority: wallet.publicKey,
      market: wallet.publicKey,        // placeholder until a FlashTrade market is wired
      kind: 0,                         // StopLoss
      side: 1,                         // close
      triggerPrice: new BN(100),
      trailOffset: new BN(0),
      referencePrice: new BN(150),
      size: new BN(1_000_000),
    };
    const tx = (await program.methods
      .createOrder(params as any)
      .accounts({
        order: orderPda,
        fill: fillPda,
        owner: wallet.publicKey,
        systemProgram: web3.SystemProgram.programId,
      })
      .transaction()) as Transaction;
    const sig = await sendAndConfirmTransaction(router, tx, [wallet.payer], { skipPreflight: true });
    console.log("✅ armed:", sig);
  });

  it("Delegates to the ER + funds the Magic Action escrow", async () => {
    const validator = await router.getClosestValidator();
    const topUp = createTopUpEscrowInstruction(
      escrowPdaFromEscrowAuthority(wallet.publicKey),
      wallet.publicKey,
      wallet.publicKey,
      1_000_000 // lamports to fund base-layer action fees
    );
    const delegateIx = await program.methods
      .delegateOrder()
      .accounts({
        owner: wallet.publicKey,
        order: orderPda,
        validator: new web3.PublicKey(validator.identity),
      })
      .instruction();
    const tx = new Transaction().add(topUp, delegateIx);
    const sig = await sendAndConfirmTransaction(router, tx, [wallet.payer], { skipPreflight: true });
    console.log("✅ delegated:", sig);
  });

  it("Crank fires on the ER and settles on the base layer", async () => {
    // price 90 <= trigger 100 => StopLoss fires
    const tx = (await program.methods
      .check(new BN(90))
      .accounts({
        payer: wallet.publicKey,
        order: orderPda,
        fill: fillPda,
        programId: program.programId,
      })
      .transaction()) as Transaction;
    const sig = await sendAndConfirmTransaction(router, tx, [wallet.payer], { skipPreflight: true });
    console.log("✅ triggered + settle action:", sig);

    // Give the commit + post-commit action a moment, then read the receipt on the base layer.
    await new Promise((r) => setTimeout(r, 5000));
    const fill = await program.account.fill.fetch(fillPda);
    console.log("Fill:", { status: fill.status, firedPrice: fill.firedPrice.toString(), slot: fill.slot.toString() });
    if (fill.status !== 2) throw new Error(`expected Settled(2), got status ${fill.status}`);
    console.log("🎉 spine works: trigger on ER -> Magic Action settled on base layer");
  });
});