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

const QUANTITY_E18 = 10_000_000_000_000_000_000n;
const PREMIUM_E18 = 25_000_000_000_000_000_000n;
const STRIKE_E8 = 6_000_000_000_000n;
const EXPIRY_SECONDS = 1_735_689_600;
const UNDERWRITE_CALL_E18_DISCRIMINATOR = new Uint8Array([
  126, 246, 89, 165, 106, 170, 120, 147,
]);
const UNDERWRITE_PUT_E18_DISCRIMINATOR = new Uint8Array([
  172, 14, 246, 27, 28, 39, 229, 225,
]);

describe("final underwrite transaction validation", () => {
  it("encodes the exact canonical e18 and e8 instruction values", async () => {
    const market = configuredMarketByAddress(
      "development:devnet",
      "11111111111111111111111111111111"
    );
    if (market === null) throw new Error("test market is missing");
    const seller = await generateKeyPairSigner();
    const variants: readonly [boolean, Uint8Array][] = [
      [false, UNDERWRITE_CALL_E18_DISCRIMINATOR],
      [true, UNDERWRITE_PUT_E18_DISCRIMINATOR],
    ];

    for (const [isPut, discriminator] of variants) {
      const transaction = getTransactionDecoder().decode(
        base64Bytes(
          await buildUnderwriteTransaction({
            market,
            expiry: EXPIRY_SECONDS,
            isPut,
            quantity: QUANTITY_E18.toString(),
            strike: STRIKE_E8.toString(),
            seller: seller.address,
            sellerCollateralSource:
              "So11111111111111111111111111111111111111112",
            maker: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            buyerQuoteSource: "So11111111111111111111111111111111111111112",
            premium: PREMIUM_E18.toString(),
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 100,
            seriesExists: false,
          })
        )
      );
      const message = getCompiledTransactionMessageDecoder().decode(
        new Uint8Array(transaction.messageBytes)
      );
      const createSeries = message.instructions[0]?.data;
      const underwrite = message.instructions[1]?.data;
      if (createSeries === undefined || underwrite === undefined) {
        throw new Error("canonical instructions are missing data");
      }

      expect(createSeries).toHaveLength(25);
      expect(createSeries[8]).toBe(isPut ? 1 : 0);
      expect(readU64(createSeries, 9)).toBe(STRIKE_E8);
      expect(readU64(createSeries, 17)).toBe(BigInt(EXPIRY_SECONDS) * 1_000n);
      expect(underwrite).toHaveLength(42);
      expect(underwrite.slice(0, 8)).toEqual(discriminator);
      expect(readU128(underwrite, 8)).toBe(QUANTITY_E18);
      expect(readU128(underwrite, 24)).toBe(PREMIUM_E18);
    }
  });

  it("rejects instruction integers outside their declared widths", async () => {
    const market = configuredMarketByAddress(
      "development:devnet",
      "11111111111111111111111111111111"
    );
    if (market === null) throw new Error("test market is missing");
    const seller = await generateKeyPairSigner();
    const valid = {
      market,
      expiry: EXPIRY_SECONDS,
      isPut: false,
      quantity: QUANTITY_E18.toString(),
      strike: STRIKE_E8.toString(),
      seller: seller.address,
      sellerCollateralSource: "So11111111111111111111111111111111111111112",
      maker: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      buyerQuoteSource: "So11111111111111111111111111111111111111112",
      premium: PREMIUM_E18.toString(),
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100,
      seriesExists: false,
    } as const;

    await expect(
      buildUnderwriteTransaction({
        ...valid,
        quantity: (1n << 128n).toString(),
      })
    ).rejects.toThrow("u128-out-of-range");
    await expect(
      buildUnderwriteTransaction({
        ...valid,
        premium: (1n << 128n).toString(),
      })
    ).rejects.toThrow("u128-out-of-range");
    await expect(
      buildUnderwriteTransaction({
        ...valid,
        strike: (1n << 64n).toString(),
      })
    ).rejects.toThrow("u64-out-of-range");
    await expect(
      buildUnderwriteTransaction({ ...valid, expiry: -1 })
    ).rejects.toThrow("u64-out-of-range");
  });

  it("rejects changes to canonical payer, account flags, program, accounts, and data", async () => {
    const market = configuredMarketByAddress(
      "development:devnet",
      "11111111111111111111111111111111"
    );
    if (market === null) throw new Error("test market is missing");
    const seller = await generateKeyPairSigner();
    const canonicalTransaction = await buildUnderwriteTransaction({
      market,
      expiry: 1_735_689_600,
      isPut: false,
      quantity: QUANTITY_E18.toString(),
      strike: STRIKE_E8.toString(),
      seller: seller.address,
      sellerCollateralSource: "So11111111111111111111111111111111111111112",
      maker: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      buyerQuoteSource: "So11111111111111111111111111111111111111112",
      premium: PREMIUM_E18.toString(),
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

function readU64(data: ArrayLike<number>, offset: number): bigint {
  const bytes = Uint8Array.from(data).slice(offset, offset + 8);
  return new DataView(bytes.buffer).getBigUint64(0, true);
}

function readU128(data: ArrayLike<number>, offset: number): bigint {
  return readU64(data, offset) + (readU64(data, offset + 8) << 64n);
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function bytesBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}
