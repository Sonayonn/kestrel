// Kestrel keeper-bridge test (devnet). Proves the on-chain contract end to end:
//   arm -> delegate -> crank triggers on ER (Fill = Triggered) -> keeper confirm_fill (Fill = Settled, sig anchored)
// The actual FlashTrade mainnet fill lives in keeper.ts; here we simulate the keeper's confirm step.
//
// Run after `anchor build`:  anchor test --skip-build --skip-deploy

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

  const id = new BN(Date.now()); // fresh per run -> fresh PDAs
  const [orderPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(ORDER_SEED), wallet.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const [fillPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(FILL_SEED), orderPda.toBuffer()],
    program.programId
  );

  console.log("Program:", program.programId.toBase58());
  console.log("Order:", orderPda.toBase58(), "| Fill:", fillPda.toBase58());

  it("Arms a stop-loss", async () => {
    const params = {
      sessionAuthority: wallet.publicKey, // the keeper key authorized to confirm fills
      market: wallet.publicKey,           // placeholder; keeper maps this -> FlashTrade market
      kind: 0,                            // StopLoss
      side: 1,                            // close
      triggerPrice: new BN(100),
      trailOffset: new BN(0),
      referencePrice: new BN(150),
      size: new BN(1_000_000),
    };
    const tx = (await program.methods
      .createOrder(id, params as any)
      .accounts({ order: orderPda, fill: fillPda, owner: wallet.publicKey, systemProgram: web3.SystemProgram.programId })
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
      1_000_000
    );
    const delegateIx = await program.methods
      .delegateOrder(id)
      .accounts({ owner: wallet.publicKey, order: orderPda, validator: new web3.PublicKey(validator.identity) })
      .instruction();
    const tx = new Transaction().add(topUp, delegateIx);
    const sig = await sendAndConfirmTransaction(router, tx, [wallet.payer], { skipPreflight: true });
    console.log("✅ delegated:", sig);
  });

  it("Crank fires the trigger on the ER (Fill -> Triggered)", async () => {
    const tx = (await program.methods
      .check(new BN(90)) // 90 <= trigger 100 => StopLoss fires
      .accounts({ payer: wallet.publicKey, order: orderPda, fill: fillPda, programId: program.programId })
      .transaction()) as Transaction;
    const sig = await sendAndConfirmTransaction(router, tx, [wallet.payer], { skipPreflight: true });
    console.log("✅ triggered:", sig);

    await new Promise((r) => setTimeout(r, 5000));
    const fill = await program.account.fill.fetch(fillPda);
    console.log("Fill after trigger:", { status: fill.status, firedPrice: fill.firedPrice.toString() });
    if (fill.status !== 1) throw new Error(`expected Triggered(1), got ${fill.status}`);
    console.log("✅ on-chain fire signal set — keeper would now fill on FlashTrade mainnet");
  });

  it("Keeper confirms the mainnet fill (Fill -> Settled, sig anchored)", async () => {
    const fakeMainnetSig = Array(64).fill(7); // keeper passes the real 64-byte sig in production
    const tx = (await program.methods
      .confirmFill(new BN(142), fakeMainnetSig)
      .accounts({ keeper: wallet.publicKey, fill: fillPda })
      .transaction()) as Transaction;
    const sig = await sendAndConfirmTransaction(router, tx, [wallet.payer], { skipPreflight: true });
    console.log("✅ confirmed:", sig);

    const fill = await program.account.fill.fetch(fillPda);
    if (fill.status !== 2) throw new Error(`expected Settled(2), got ${fill.status}`);
    console.log("🎉 keeper-bridge contract proven: trigger on ER -> Settled with entry", fill.entryPrice.toString());
  });
});