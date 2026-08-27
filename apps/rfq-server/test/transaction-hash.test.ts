import { describe, expect, it } from "vitest";

import {
  offerTransactionHash,
  signedTransactionHash,
} from "../src/transaction-validation";

describe("underwrite transaction hashes", () => {
  it("matches an offer after only the seller fee-payer signature is added", async () => {
    const partial = transactionWithSellerSignature(0);
    const fullySigned = transactionWithSellerSignature(7);

    await expect(offerTransactionHash(partial)).resolves.toBe(
      await offerTransactionHash(fullySigned)
    );
    await expect(signedTransactionHash(partial)).resolves.not.toBe(
      await signedTransactionHash(fullySigned)
    );
  });
});

function transactionWithSellerSignature(value: number): string {
  const bytes = new Uint8Array(1 + 64 + 64 + 3);
  bytes[0] = 2;
  bytes.fill(value, 1, 65);
  bytes.fill(9, 65, 129);
  bytes.set([1, 2, 3], 129);
  return btoa(String.fromCharCode(...bytes));
}
