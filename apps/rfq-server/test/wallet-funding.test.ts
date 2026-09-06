import {
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { DEVNET_FUNDING, WALLET_FUNDING_COOLDOWN_MS } from "../src/config";
import {
  fundedResponse,
  fundWallet,
  isEoaWalletAddress,
  retryAfterSeconds,
} from "../src/wallet-funding";
import {
  buildWalletFundingTransaction,
  treasurySignerFromSecret,
} from "../src/wallet-funding-transaction";

Object.defineProperty(globalThis, "isSecureContext", { value: true });

describe("wallet funding", () => {
  it("rejects malformed treasury secrets without exposing their contents", async () => {
    await expect(treasurySignerFromSecret("[1,2,3]")).rejects.toThrow(
      "invalid-treasury-secret"
    );
  });

  it("accepts an on-curve EOA and rejects malformed addresses", async () => {
    const signer = await createKeyPairFromPrivateKeyBytes(
      new Uint8Array(32).fill(1)
    );
    const walletAddress = await getAddressFromPublicKey(signer.publicKey);

    expect(isEoaWalletAddress(walletAddress)).toBe(true);
    expect(isEoaWalletAddress("not-a-solana-address")).toBe(false);
  });

  it("uses base-unit strings and rounds retry headers up to one second", () => {
    expect(fundedResponse("signature")).toEqual({
      signature: "signature",
      funded: {
        [DEVNET_FUNDING.mint]: "100000000000000",
        solLamport: "5000000",
      },
    });
    expect(retryAfterSeconds(new Date(1_001), 1)).toBe(1);
    expect(retryAfterSeconds(new Date(1_002), 1)).toBe(2);
    expect(WALLET_FUNDING_COOLDOWN_MS).toBe(86_400_000);
  });

  it("rechecks the cooldown after claiming a pending funding attempt", async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS wallet_fundings").run();
    await env.DB.prepare(
      `CREATE TABLE wallet_fundings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_address TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        transaction_signature TEXT,
        completed_at_ms INTEGER,
        failure_reason TEXT
      )`
    ).run();
    await env.DB.prepare(
      `CREATE UNIQUE INDEX wallet_fundings_one_pending_per_wallet_idx
       ON wallet_fundings (wallet_address) WHERE status = 'pending'`
    ).run();
    await env.DB.prepare(
      `CREATE TRIGGER wallet_fundings_complete_previous_attempt
       AFTER INSERT ON wallet_fundings
       WHEN NEW.status = 'pending'
       BEGIN
         INSERT INTO wallet_fundings (
           wallet_address, status, created_at_ms, completed_at_ms
         ) VALUES (NEW.wallet_address, 'succeeded', NEW.created_at_ms, NEW.created_at_ms);
       END`
    ).run();
    const recipient = await createKeyPairFromPrivateKeyBytes(
      new Uint8Array(32).fill(2)
    );
    const treasuryPrivateKeyBytes = new Uint8Array(32).fill(1);
    const treasury = await createKeyPairFromPrivateKeyBytes(
      treasuryPrivateKeyBytes,
      true
    );
    const treasuryPublicKeyBytes = new Uint8Array(
      await crypto.subtle.exportKey("raw", treasury.publicKey)
    );
    const now = 1_000;

    await expect(
      fundWallet({
        database: env.DB,
        rpcUrl: "https://unused.example.com",
        treasuryPrivateKey: JSON.stringify([
          ...treasuryPrivateKeyBytes,
          ...treasuryPublicKeyBytes,
        ]),
        walletAddress: await getAddressFromPublicKey(recipient.publicKey),
        now,
      })
    ).resolves.toEqual({
      status: "wallet-cooldown-active",
      retryAt: new Date(now + WALLET_FUNDING_COOLDOWN_MS),
    });

    await expect(
      env.DB.prepare(
        "SELECT status FROM wallet_fundings WHERE status = 'pending'"
      ).first()
    ).resolves.toBeNull();
  });

  it("creates the ATA, mints tokens, then transfers SOL in one transaction", async () => {
    const treasuryKeyPair = await createKeyPairFromPrivateKeyBytes(
      new Uint8Array(32).fill(1)
    );
    const recipientKeyPair = await createKeyPairFromPrivateKeyBytes(
      new Uint8Array(32).fill(2)
    );
    const transaction = await buildWalletFundingTransaction({
      treasury: {
        address: await getAddressFromPublicKey(treasuryKeyPair.publicKey),
        keyPair: treasuryKeyPair,
      },
      recipient: await getAddressFromPublicKey(recipientKeyPair.publicKey),
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
    });
    const decoded = getTransactionDecoder().decode(
      base64Bytes(transaction.wireTransaction)
    );
    const message = getCompiledTransactionMessageDecoder().decode(
      new Uint8Array(decoded.messageBytes)
    );

    expect(message.instructions).toHaveLength(3);
    expect(
      message.instructions.map((instruction) => instruction.data?.[0])
    ).toEqual([1, 7, 2]);
  });
});

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
