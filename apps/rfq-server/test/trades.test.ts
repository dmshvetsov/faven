import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  UnderwriteRepository,
  type QueuedUnderwrite,
} from "../src/database/underwrite-repository";

const sellerAddress = "seller-address";

describe("seller trade positions", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("lists a seller's confirmed positions with their finalized Series data", async () => {
    const repository = new UnderwriteRepository(env.DB);
    const finalized = position({
      expiryMs: 1_735_600_000_000,
      seriesAddress: "finalized-series",
      txSignature: "finalized-signature",
    });
    const open = position({
      expiryMs: 1_735_700_000_000,
      seriesAddress: "open-series",
      txSignature: "open-signature",
    });
    const otherSeller = position({
      sellerAddress: "another-seller",
      seriesAddress: "another-series",
      txSignature: "another-signature",
    });
    for (const underwrite of [finalized, open, otherSeller]) {
      await confirm(repository, underwrite);
    }
    await env.DB.prepare(
      "UPDATE option_series SET expiry_price = ? WHERE series_address = ?"
    )
      .bind("6100000000", finalized.seriesAddress)
      .run();

    const response = await SELF.fetch(
      `https://example.com/trades/${sellerAddress}`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      positions: [
        expectedPosition(finalized, {
          expiryPrice: "6100000000",
          seriesState: "expiration_price_finalized",
        }),
        expectedPosition(open, { expiryPrice: null, seriesState: "open" }),
      ],
    });
  });

  it("returns one confirmed position only for its seller and transaction key", async () => {
    const repository = new UnderwriteRepository(env.DB);
    const underwrite = position({
      ixIndex: 7,
      seriesAddress: "lookup-series",
      txSignature: "lookup-signature",
    });
    await confirm(repository, underwrite);

    const response = await SELF.fetch(
      `https://example.com/trades/${sellerAddress}/sig/${underwrite.txSignature}/${underwrite.ixIndex}`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      position: expectedPosition(underwrite, {
        expiryPrice: null,
        seriesState: "open",
      }),
    });

    const notFound = await SELF.fetch(
      `https://example.com/trades/another-seller/sig/${underwrite.txSignature}/${underwrite.ixIndex}`
    );
    expect(notFound.status).toBe(404);
  });
});

function position(changes: Partial<QueuedUnderwrite> = {}): QueuedUnderwrite {
  return {
    txSignature: "signature",
    ixIndex: 3,
    rfqId: "0193c3c5-1967-7000-8000-000000000000",
    sellerAddress,
    buyerAddress: "buyer-address",
    marketAddress: "market-address",
    seriesAddress: "series-address",
    oracleAsset: "BTC",
    baseAsset: "WBTC",
    quoteAsset: "USDC",
    isPut: false,
    expiryMs: 1_735_689_600_000,
    strike: "6000000000000",
    quantity: "1000000000000000000",
    premium: "25000000000000000000",
    baseMint: "base-mint",
    quoteMint: "quote-mint",
    feeRecipient: "fee-recipient",
    operationalFeeBps: 50,
    createdAtMs: 1_735_600_000_000,
    ...changes,
  };
}

function expectedPosition(
  underwrite: QueuedUnderwrite,
  series: {
    readonly expiryPrice: string | null;
    readonly seriesState: "open" | "expiration_price_finalized";
  }
) {
  return {
    txSignature: underwrite.txSignature,
    ixIndex: underwrite.ixIndex,
    seriesAddress: underwrite.seriesAddress,
    marketAddress: underwrite.marketAddress,
    isPut: underwrite.isPut,
    confirmedAtMs: 2,
    baseAsset: underwrite.baseAsset,
    quoteAsset: underwrite.quoteAsset,
    expiryMs: underwrite.expiryMs,
    strike: underwrite.strike,
    quantity: underwrite.quantity,
    premium: underwrite.premium,
    ...series,
    positionState: "open",
    closeReason: null,
  };
}

async function confirm(
  repository: UnderwriteRepository,
  underwrite: QueuedUnderwrite
): Promise<void> {
  await repository.createQueued(underwrite);
  await repository.markSubmitted(underwrite.txSignature, underwrite.ixIndex, 1);
  await repository.markConfirmed(underwrite.txSignature, underwrite.ixIndex, 2);
}

async function resetDatabase(): Promise<void> {
  for (const statement of [
    "DROP TABLE IF EXISTS underwrite_audit",
    "DROP TABLE IF EXISTS underwrites",
    "DROP TABLE IF EXISTS option_series",
    `CREATE TABLE underwrites (
      tx_signature TEXT NOT NULL, ix_index INTEGER NOT NULL, rfq_id TEXT NOT NULL,
      status TEXT NOT NULL, seller_address TEXT NOT NULL, buyer_address TEXT NOT NULL,
      market_address TEXT NOT NULL, series_address TEXT NOT NULL, oracle_asset TEXT NOT NULL,
      base_asset TEXT NOT NULL, quote_asset TEXT NOT NULL, is_put INTEGER NOT NULL,
      expiry_ms INTEGER NOT NULL, strike TEXT NOT NULL, quantity TEXT NOT NULL,
      premium TEXT NOT NULL, base_mint TEXT NOT NULL, quote_mint TEXT NOT NULL,
      fee_recipient TEXT NOT NULL, operational_fee_bps INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL, submitted_at_ms INTEGER, confirmed_at_ms INTEGER,
      confirmed_receipt TEXT, last_error TEXT, PRIMARY KEY (tx_signature, ix_index)
    )`,
    `CREATE TABLE underwrite_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tx_signature TEXT NOT NULL,
      ix_index INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
      UNIQUE (tx_signature, ix_index, status)
    )`,
    `CREATE TABLE option_series (
      series_address TEXT PRIMARY KEY, market_address TEXT NOT NULL,
      oracle_asset TEXT NOT NULL, base_asset TEXT NOT NULL, quote_asset TEXT NOT NULL,
      is_put INTEGER NOT NULL, expiry_ms INTEGER NOT NULL, strike TEXT NOT NULL,
      base_mint TEXT NOT NULL, quote_mint TEXT NOT NULL, confirmed_at_ms INTEGER NOT NULL,
      expiry_price TEXT, finalized_at_ms INTEGER, finalized_slot INTEGER,
      finalization_signature TEXT, finalization_method TEXT
    )`,
  ]) {
    await env.DB.prepare(statement).run();
  }
}
