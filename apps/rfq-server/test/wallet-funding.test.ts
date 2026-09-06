import {
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { describe, expect, it } from "vitest";

import { DEVNET_FUNDING, WALLET_FUNDING_COOLDOWN_MS } from "../src/config";
import {
  fundedResponse,
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
