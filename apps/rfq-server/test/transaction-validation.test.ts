import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
} from "@solana/kit";
import { describe, expect, it } from "vitest";

import { configuredMarket } from "../src/config";
import { validateFinalUnderwriteTransaction } from "../src/transaction-validation";
import {
  buildUnderwriteTransaction,
  deriveOptionSeriesAddress,
} from "../src/underwrite-transaction-builder";

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
const MARKET = configuredMarket(
  "localdevelopment:devnet",
  "wSoLCzXHe214cjx7CFjP1axzXyqLkEwq5Xf873hy1JP"
);

if (MARKET === null) throw new Error("test market is missing");

describe("final underwrite transaction validation", () => {
  it("encodes the exact canonical e18 and e8 instruction values", async () => {
    const seller = await generateKeyPairSigner();
    const variants: readonly [boolean, Uint8Array][] = [
      [false, UNDERWRITE_CALL_E18_DISCRIMINATOR],
      [true, UNDERWRITE_PUT_E18_DISCRIMINATOR],
    ];

    for (const [isPut, discriminator] of variants) {
      const transaction = getTransactionDecoder().decode(
        base64Bytes(
          await buildUnderwriteTransaction({
            market: MARKET,
            expiry: EXPIRY_SECONDS,
            isPut,
            quantity: QUANTITY_E18.toString(),
            strike: STRIKE_E8.toString(),
            seller: seller.address,
            sellerCollateralSource:
              "So11111111111111111111111111111111111111112",
            sellerQuoteDestination:
              "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            maker: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            buyerQuoteSource: "So11111111111111111111111111111111111111112",
            premium: PREMIUM_E18.toString(),
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 100,
          })
        )
      );
      const message = getCompiledTransactionMessageDecoder().decode(
        new Uint8Array(transaction.messageBytes)
      );
      const underwrite = message.instructions[1]?.data;
      if (underwrite === undefined)
        throw new Error("canonical underwrite instruction is missing data");

      expect(message.instructions[0]?.data).toEqual(
        new Uint8Array([2, 128, 26, 6, 0])
      );
      expect(underwrite).toHaveLength(58);
      expect(underwrite.slice(0, 8)).toEqual(discriminator);
      expect(readU64(underwrite, 8)).toBe(BigInt(EXPIRY_SECONDS) * 1_000n);
      expect(readU64(underwrite, 16)).toBe(STRIKE_E8);
      expect(readU128(underwrite, 24)).toBe(QUANTITY_E18);
      expect(readU128(underwrite, 40)).toBe(PREMIUM_E18);
      expect(readU16(underwrite, 56)).toBe(MARKET.operationalFeeBps);
      expect(message.instructions[1]?.accountIndices).toHaveLength(
        isPut ? 18 : 19
      );
      const underwriteAccounts = message.instructions[1]?.accountIndices;
      if (underwriteAccounts === undefined) {
        throw new Error("canonical underwrite instruction is missing accounts");
      }
      const series = await deriveOptionSeriesAddress({
        market: MARKET,
        expiry: EXPIRY_SECONDS,
        isPut,
        strike: STRIKE_E8.toString(),
      });
      const [baseVault, quoteVault] = await Promise.all([
        deriveAta(series, address(MARKET.baseMint)),
        deriveAta(series, address(MARKET.quoteMint)),
      ]);
      const vaultAccounts = underwriteAccounts
        .slice(isPut ? 13 : 14, isPut ? 15 : 16)
        .map((index) => message.staticAccounts[index]);
      expect(vaultAccounts).toEqual(
        isPut ? [quoteVault, baseVault] : [baseVault, quoteVault]
      );
    }
  });

  it("rejects instruction integers outside their declared widths", async () => {
    const seller = await generateKeyPairSigner();
    const valid = {
      market: MARKET,
      expiry: EXPIRY_SECONDS,
      isPut: false,
      quantity: QUANTITY_E18.toString(),
      strike: STRIKE_E8.toString(),
      seller: seller.address,
      sellerCollateralSource: "So11111111111111111111111111111111111111112",
      sellerQuoteDestination: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      maker: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      buyerQuoteSource: "So11111111111111111111111111111111111111112",
      premium: PREMIUM_E18.toString(),
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100,
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
    const seller = await generateKeyPairSigner();
    const canonicalTransaction = await buildUnderwriteTransaction({
      market: MARKET,
      expiry: 1_735_689_600,
      isPut: false,
      quantity: QUANTITY_E18.toString(),
      strike: STRIKE_E8.toString(),
      seller: seller.address,
      sellerCollateralSource: "So11111111111111111111111111111111111111112",
      sellerQuoteDestination: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      maker: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      buyerQuoteSource: "So11111111111111111111111111111111111111112",
      premium: PREMIUM_E18.toString(),
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100,
    });
    const transaction = getTransactionDecoder().decode(
      base64Bytes(canonicalTransaction)
    );
    const message = getCompiledTransactionMessageDecoder().decode(
      new Uint8Array(transaction.messageBytes)
    );
    const computeBudgetInstruction = message.instructions[0];
    const instruction = message.instructions[1];
    if (
      computeBudgetInstruction === undefined ||
      instruction === undefined ||
      instruction.accountIndices === undefined
    ) {
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
      {
        ...message,
        instructions: [
          computeBudgetInstruction,
          { ...instruction, programAddressIndex: 0 },
        ],
      }
    );
    expectValidationFailure(
      "instruction-accounts-do-not-match-canonical-terms",
      transaction,
      canonicalTransaction,
      {
        ...message,
        instructions: [
          computeBudgetInstruction,
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
        instructions: [
          computeBudgetInstruction,
          { ...instruction, data: new Uint8Array([0]) },
        ],
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

function readU16(data: ArrayLike<number>, offset: number): number {
  const bytes = Uint8Array.from(data).slice(offset, offset + 2);
  return new DataView(bytes.buffer).getUint16(0, true);
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function bytesBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

async function deriveAta(
  owner: ReturnType<typeof address>,
  mint: ReturnType<typeof address>
) {
  const [ata] = await getProgramDerivedAddress({
    programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    seeds: [
      getAddressEncoder().encode(owner),
      getAddressEncoder().encode(
        address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
      ),
      getAddressEncoder().encode(mint),
    ],
  });
  return ata;
}
