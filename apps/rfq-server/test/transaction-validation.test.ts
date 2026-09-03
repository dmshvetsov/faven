import {
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
} from "@solana/kit";
import { describe, expect, it } from "vitest";

import { configuredMarketByAddress } from "../src/config";
import { validateFinalUnderwriteTransaction } from "../src/transaction-validation";
import { buildUnderwriteTransaction } from "../src/underwrite-transaction-builder";

Object.defineProperty(globalThis, "isSecureContext", { value: true });

describe("final underwrite transaction validation", () => {
  it("rejects changes to canonical payer, account flags, program, accounts, and data", async () => {
    const market = configuredMarketByAddress(
      "development:testnet",
      "11111111111111111111111111111111"
    );
    if (market === null) throw new Error("test market is missing");
    const seller = await generateKeyPairSigner();
    const canonicalTransaction = await buildUnderwriteTransaction({
      market,
      expiry: 1_735_689_600,
      isPut: false,
      quantity: "10",
      strike: "6000000000000",
      seller: seller.address,
      sellerCollateralSource: "So11111111111111111111111111111111111111112",
      maker: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      buyerQuoteSource: "So11111111111111111111111111111111111111112",
      premium: "25",
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100,
      seriesExists: true,
    });
    const transaction = getTransactionDecoder().decode(
      base64Bytes(canonicalTransaction)
    );
    const message = getCompiledTransactionMessageDecoder().decode(
      new Uint8Array(transaction.messageBytes)
    );
    const instruction = message.instructions[0];
    if (instruction === undefined || instruction.accountIndices === undefined) {
      throw new Error("canonical underwrite instruction is missing accounts");
    }

    expectValidationFailure(
      "fee-payer-does-not-match-canonical-terms",
      transaction,
      canonicalTransaction,
      { ...message, staticAccounts: [...message.staticAccounts].reverse() }
    );
    expectValidationFailure(
      "account-flags-do-not-match-canonical-terms",
      transaction,
      canonicalTransaction,
      {
        ...message,
        header: {
          ...message.header,
          numReadonlyNonSignerAccounts:
            message.header.numReadonlyNonSignerAccounts + 1,
        },
      }
    );
    expectValidationFailure(
      "instruction-program-does-not-match-canonical-terms",
      transaction,
      canonicalTransaction,
      { ...message, instructions: [{ ...instruction, programAddressIndex: 0 }] }
    );
    expectValidationFailure(
      "instruction-accounts-do-not-match-canonical-terms",
      transaction,
      canonicalTransaction,
      {
        ...message,
        instructions: [
          {
            ...instruction,
            accountIndices: [...instruction.accountIndices].reverse(),
          },
        ],
      }
    );
    expectValidationFailure(
      "instruction-data-does-not-match-canonical-terms",
      transaction,
      canonicalTransaction,
      {
        ...message,
        instructions: [{ ...instruction, data: new Uint8Array([0]) }],
      }
    );
  });
});

function expectValidationFailure(
  reason: string,
  transaction: { readonly messageBytes: ArrayLike<number> },
  canonicalTransaction: string,
  message: Parameters<
    ReturnType<typeof getCompiledTransactionMessageEncoder>["encode"]
  >[0]
): void {
  const wireTransaction = base64Bytes(canonicalTransaction);
  const encodedMessage = getCompiledTransactionMessageEncoder().encode(message);
  const underwriteTx = bytesBase64(
    new Uint8Array([
      ...wireTransaction.slice(
        0,
        wireTransaction.length - transaction.messageBytes.length
      ),
      ...encodedMessage,
    ])
  );

  expect(() =>
    validateFinalUnderwriteTransaction({ underwriteTx, canonicalTransaction })
  ).toThrow(reason);
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function bytesBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}
