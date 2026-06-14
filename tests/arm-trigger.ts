// Demo driver: arm -> delegate -> crank-fires-on-ER, then STOP — leaving the Fill in Triggered
// so a separately-running keeper (keeper-v2.ts) picks it up and confirms. This is kestrel.ts
// without the confirm step (the keeper owns that now).
//
//   ANCHOR_PROVIDER_URL=https://rpc.magicblock.app/devnet ANCHOR_WALLET=~/.config/solana/id.json \
//     yarn ts-mocha -p ./tsconfig.json -t 120000 tests/arm-trigger.ts

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

describe("kestrel arm+trigger (keeper picks up)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.kestrel as Program<Kestrel>;
  const wallet = anchor.Wallet.local();

  const router = new ConnectionMagicRouter(
    process.env.ROUTER_ENDPOINT || "https://devnet-router.magicblock.app",
    { wsEndpoint: process.env.ROUTER_WS_ENDPOINT || "wss://devnet-router.magicblock.app" }
  );

  const id = new BN(Date.now());
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
      sessionAuthority: wallet.publicKey, // must equal the keeper's KEEPER_KEYPAIR pubkey
      market: wallet.publicKey,
      kind: 0,
      side: 1,
      triggerPrice: new BN(100),
      trailOffset: new BN(0),
      referencePrice: new BN(150),
      size: new BN(1_000_000),
    };
    const tx = (await program.methods
      .createOrder(id, params as any)
      .accountsPartial({ order: orderPda, fill: fillPda, owner: wallet.publicKey, systemProgram: web3.SystemProgram.programId })
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
      .accountsPartial({ owner: wallet.publicKey, order: orderPda, validator: new web3.PublicKey(validator.identity) })
      .instruction();
    const tx = new Transaction().add(topUp, delegateIx);
    const sig = await sendAndConfirmTransaction(router, tx, [wallet.payer], { skipPreflight: true });
    console.log("✅ delegated:", sig);
  });

  it("Crank fires the trigger on the ER (Fill -> Triggered)", async () => {
    const tx = (await program.methods
      .check(new BN(90))
      .accountsPartial({ payer: wallet.publicKey, order: orderPda, fill: fillPda, programId: program.programId })
      .transaction()) as Transaction;
    const sig = await sendAndConfirmTransaction(router, tx, [wallet.payer], { skipPreflight: true });
    console.log("✅ triggered:", sig);

    await new Promise((r) => setTimeout(r, 5000));
    const fill = await program.account.fill.fetch(fillPda);
    if (fill.status !== 1) throw new Error(`expected Triggered(1), got ${fill.status}`);
    console.log("✅ Fill is Triggered and committed to devnet — keeper-v2 will catch it and confirm.");
    console.log("   Fill:", fillPda.toBase58());
  });
});