import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  UnderwriteRepository,
  type QueuedUnderwrite,
} from "../src/database/underwrite-repository";

const underwrite: QueuedUnderwrite = {
  txSignature: "transaction-signature",
  ixIndex: 0,
  rfqId: "0193c3c5-1967-7000-8000-000000000000",
  sellerAddress: "seller-address",
  buyerAddress: "buyer-address",
  marketAddress: "market-address",
  seriesAddress: "series-address",
  ticker: "BTC-USDC-WBTC-01JAN25-60000-C",
  isPut: false,
  expiryMs: 1_735_689_600_000,
  strike: "6000000000000",
  quantity: "1000000000000000000",
  premium: "25000000",
  baseCoinMint: "base-mint",
  quoteCoinMint: "quote-mint",
  feeRecipient: "fee-recipient",
  operationalFeeBps: 50,
  createdAtMs: 1_735_600_000_000,
};

describe("underwrite repository", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("records an identical queued transaction only once with one audit entry", async () => {
    const repository = new UnderwriteRepository(env.DB);

    await expect(repository.createQueued(underwrite)).resolves.toEqual({
      created: true,
    });
    await expect(repository.createQueued(underwrite)).resolves.toEqual({
      created: false,
    });

    await expect(
      repository.get(underwrite.txSignature, 0)
    ).resolves.toMatchObject({
      status: "queued",
      ticker: "BTC-USDC-WBTC-01JAN25-60000-C",
      sellerAddress: "seller-address",
    });
    await expect(
      repository.auditFor(underwrite.txSignature, 0)
    ).resolves.toEqual([{ createdAtMs: 1_735_600_000_000, status: "queued" }]);
  });

  it("persists lifecycle receipts and creates the immutable series after confirmation", async () => {
    const repository = new UnderwriteRepository(env.DB);
    await repository.createQueued(underwrite);

    await repository.markSubmitted(
      underwrite.txSignature,
      0,
      1_735_600_001_000
    );
    await repository.markConfirmed(
      underwrite.txSignature,
      0,
      1_735_600_002_000
    );

    await expect(
      repository.get(underwrite.txSignature, 0)
    ).resolves.toMatchObject({
      status: "confirmed",
      submittedAtMs: 1_735_600_001_000,
      confirmedAtMs: 1_735_600_002_000,
    });
    await expect(
      repository.auditFor(underwrite.txSignature, 0)
    ).resolves.toEqual([
      { createdAtMs: 1_735_600_000_000, status: "queued" },
      { createdAtMs: 1_735_600_001_000, status: "submitted" },
      { createdAtMs: 1_735_600_002_000, status: "confirmed" },
    ]);
    await expect(repository.getSeries("series-address")).resolves.toEqual({
      seriesAddress: "series-address",
      marketAddress: "market-address",
      ticker: "BTC-USDC-WBTC-01JAN25-60000-C",
      isPut: false,
      expiryMs: 1_735_689_600_000,
      strike: "6000000000000",
      baseCoinMint: "base-mint",
      quoteCoinMint: "quote-mint",
      confirmedAtMs: 1_735_600_002_000,
    });
  });
});

async function resetDatabase(): Promise<void> {
  const statements = [
    "DROP TABLE IF EXISTS underwrite_audit",
    "DROP TABLE IF EXISTS underwrites",
    "DROP TABLE IF EXISTS option_series",
    `CREATE TABLE underwrites (
      tx_signature TEXT NOT NULL,
      ix_index INTEGER NOT NULL,
      rfq_id TEXT NOT NULL,
      status TEXT NOT NULL,
      seller_address TEXT NOT NULL,
      buyer_address TEXT NOT NULL,
      market_address TEXT NOT NULL,
      series_address TEXT NOT NULL,
      ticker TEXT NOT NULL,
      is_put INTEGER NOT NULL,
      expiry_ms INTEGER NOT NULL,
      strike TEXT NOT NULL,
      quantity TEXT NOT NULL,
      premium TEXT NOT NULL,
      base_coin_mint TEXT NOT NULL,
      quote_coin_mint TEXT NOT NULL,
      fee_recipient TEXT NOT NULL,
      operational_fee_bps INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      submitted_at_ms INTEGER,
      confirmed_at_ms INTEGER,
      last_error TEXT,
      PRIMARY KEY (tx_signature, ix_index)
    )`,
    `CREATE TABLE underwrite_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_signature TEXT NOT NULL,
      ix_index INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL
    )`,
    `CREATE TABLE option_series (
      series_address TEXT PRIMARY KEY,
      market_address TEXT NOT NULL,
      ticker TEXT NOT NULL,
      is_put INTEGER NOT NULL,
      expiry_ms INTEGER NOT NULL,
      strike TEXT NOT NULL,
      base_coin_mint TEXT NOT NULL,
      quote_coin_mint TEXT NOT NULL,
      confirmed_at_ms INTEGER NOT NULL
    )`,
  ];
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}
