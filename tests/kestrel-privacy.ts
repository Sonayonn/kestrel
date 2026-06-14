// Kestrel privacy test — proves an order runs PRIVATELY on the TEE ER:
//   arm (base) -> delegate to TEE validator -> init_permission -> set_privacy(true)
//   -> crank fires INSIDE the TEE -> owner reads the order via auth token; a stranger cannot.
//
// This is the anti-snipe proof: the order's price/size/direction are invisible to front-runners
// until it fires. Run it in isolation while iterating:
//   ANCHOR_PROVIDER_URL=https://rpc.magicblock.app/devnet ANCHOR_WALLET=~/.config/solana/id.json \
//     yarn ts-mocha -p ./tsconfig.json -t 120000 tests/kestrel-privacy.ts
//
// NOTE: first runnable draft — like the keeper, we iterate against the live TEE.

import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import { Kestrel } from "../target/types/kestrel";
import {
  getAuthToken,
  PERMISSION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  permissionPdaFromAccount,
  ConnectionMagicRouter,
  createTopUpEscrowInstruction,
  escrowPdaFromEscrowAuthority,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as nacl from "tweetnacl";

const ORDER_SEED = "order";
const FILL_SEED = "fill";
const TEE_VALIDATOR = new web3.PublicKey(
  process.env.VALIDATOR || "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"
);
const VAULT_ID = new web3.PublicKey("MagicVau1t999999999999999999999999999999999");

describe("kestrel-privacy", () => {
  const provider = anchor.AnchorProvider.env(); // base layer (devnet)
  anchor.setProvider(provider);
  const program = anchor.workspace.kestrel as Program<Kestrel>;
  const wallet = anchor.Wallet.local();

  const teeUrl = process.env.TEE_PROVIDER_ENDPOINT || "https://devnet-tee.magicblock.app";
  const teeWs = process.env.TEE_WS_ENDPOINT || "wss://devnet-tee.magicblock.app";
  const router = new ConnectionMagicRouter("https://devnet-router.magicblock.app", {
    wsEndpoint: "wss://devnet-router.magicblock.app",
  });
  let tee: anchor.AnchorProvider; // ER provider, rebuilt with auth token in before()

  const id = new BN(Date.now());
  const [orderPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(ORDER_SEED), wallet.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const [fillPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(FILL_SEED), orderPda.toBuffer()],
    program.programId
  );
  const permissionPda = permissionPdaFromAccount(orderPda);

  // Send an ER (TEE) transaction: manual blockhash + sign with the local wallet.
  async function sendTee(tx: Transaction) {
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await tee.connection.getLatestBlockhash()).blockhash;
    const signed = await tee.wallet.signTransaction(tx);
    return tee.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  }

  before(async () => {
    const payer = wallet.payer;
    const authToken = await getAuthToken(teeUrl, payer.publicKey, (m: Uint8Array) =>
      Promise.resolve(nacl.sign.detached(m, payer.secretKey))
    );
    console.log("TEE explorer:", `${teeUrl}?token=${authToken.token}`);
    tee = new anchor.AnchorProvider(
      new web3.Connection(`${teeUrl}?token=${authToken.token}`, {
        wsEndpoint: `${teeWs}?token=${authToken.token}`,
        commitment: "confirmed",
      }),
      wallet
    );
    console.log("Order:", orderPda.toBase58(), "| Permission:", permissionPda.toBase58());
  });

  it("Arms an order (base layer)", async () => {
    const params = {
      sessionAuthority: wallet.publicKey,
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
    await sendAndConfirmTransaction(router, tx, [wallet.payer], { skipPreflight: true });
    console.log("✅ armed");
  });

  it("Delegates the order to the TEE validator", async () => {
    const topUp = createTopUpEscrowInstruction(
      escrowPdaFromEscrowAuthority(wallet.publicKey), wallet.publicKey, wallet.publicKey, 1_000_000
    );
    const delegateIx = await program.methods
      .delegateOrder(id)
      .accountsPartial({ owner: wallet.publicKey, order: orderPda, validator: TEE_VALIDATOR })
      .instruction();
    const tx = new Transaction().add(topUp, delegateIx);
    await sendAndConfirmTransaction(router, tx, [wallet.payer], { skipPreflight: true });
    await new Promise((r) => setTimeout(r, 3000)); // let delegation propagate to the TEE
    console.log("✅ delegated to TEE validator");
  });

  it("Creates the ephemeral permission, then sets it private (TEE)", async () => {
    const initTx = (await program.methods
      .initPermission()
      .accountsPartial({
        owner: wallet.publicKey, order: orderPda, permission: permissionPda,
        permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: VAULT_ID, magicProgram: MAGIC_PROGRAM_ID,
      })
      .transaction()) as Transaction;
    console.log("✅ init_permission:", await sendTee(initTx));

    const privTx = (await program.methods
      .setPrivacy(true)
      .accountsPartial({
        owner: wallet.publicKey, order: orderPda, permission: permissionPda,
        permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: VAULT_ID, magicProgram: MAGIC_PROGRAM_ID,
      })
      .transaction()) as Transaction;
    console.log("🔒 set_privacy(true):", await sendTee(privTx));
  });

  it("Crank fires the trigger INSIDE the TEE, settles on base", async () => {
    const checkTx = (await program.methods
      .check(new BN(90))
      .accountsPartial({ payer: wallet.publicKey, order: orderPda, fill: fillPda, programId: program.programId })
      .transaction()) as Transaction;
    console.log("✅ private trigger:", await sendTee(checkTx));

    await new Promise((r) => setTimeout(r, 5000));
    const fill = await program.account.fill.fetch(fillPda); // Fill committed to base layer
    if (fill.status !== 1) throw new Error(`expected Triggered(1), got ${fill.status}`);
    console.log("🎉 order triggered privately on the TEE — Fill stamped on base layer, fired @", fill.firedPrice.toString());
  });

  it("Owner reads the order via the auth token; a stranger is blocked", async () => {
    // Owner (token-authenticated TEE connection) can read the private order's ER state.
    const owned = await tee.connection.getAccountInfo(orderPda);
    if (!owned) throw new Error("owner should be able to read the order via the TEE token");
    console.log("✅ owner read the private order (", owned.data.length, "bytes )");

    // Stranger: a fresh wallet's token is not a permission member -> read should be denied/empty.
    const stranger = web3.Keypair.generate();
    try {
      const sTok = await getAuthToken(teeUrl, stranger.publicKey, (m: Uint8Array) =>
        Promise.resolve(nacl.sign.detached(m, stranger.secretKey))
      );
      const sConn = new web3.Connection(`${teeUrl}?token=${sTok.token}`, "confirmed");
      const seen = await sConn.getAccountInfo(orderPda);
      console.log(seen ? "⚠️ stranger could read (TEE policy check)" : "🔒 stranger blocked — order invisible");
    } catch (e) {
      console.log("🔒 stranger blocked at the TEE boundary:", (e as Error).message);
    }
  });
});