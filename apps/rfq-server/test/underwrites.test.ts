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

  it("uses the fee-payer transaction signature as the idempotency key", async () => {
    const repository = new UnderwriteRepository(env.DB);
    const replayWithAnotherInstruction = {
      ...underwrite,
      ixIndex: 1,
    };

    await expect(repository.createQueued(underwrite)).resolves.toEqual({
      created: true,
    });
    await expect(
      repository.createQueued(replayWithAnotherInstruction)
    ).resolves.toEqual({
      created: false,
    });
    await expect(
      repository.get(
        underwrite.txSignature,
        replayWithAnotherInstruction.ixIndex
      )
    ).resolves.toBeNull();
    await expect(
      repository.auditFor(underwrite.txSignature, underwrite.ixIndex)
    ).resolves.toEqual([
      { createdAtMs: underwrite.createdAtMs, status: "queued" },
    ]);
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
      1_735_600_002_000,
      '{"confirmationStatus":"confirmed","slot":123}'
    );

    await expect(
      repository.get(underwrite.txSignature, 0)
    ).resolves.toMatchObject({
      status: "confirmed",
      submittedAtMs: 1_735_600_001_000,
      confirmedAtMs: 1_735_600_002_000,
      confirmedReceipt: '{"confirmationStatus":"confirmed","slot":123}',
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

  it("records a deterministic post-submission failure in the lifecycle history", async () => {
    const repository = new UnderwriteRepository(env.DB);
    await repository.createQueued(underwrite);
    await repository.markSubmitted(
      underwrite.txSignature,
      underwrite.ixIndex,
      1_735_600_001_000
    );

    await repository.markFailed(
      underwrite.txSignature,
      underwrite.ixIndex,
      1_735_600_002_000,
      "blockhash not found"
    );

    await expect(
      repository.get(underwrite.txSignature, underwrite.ixIndex)
    ).resolves.toMatchObject({
      status: "failed",
      lastError: "blockhash not found",
    });
    await expect(
      repository.auditFor(underwrite.txSignature, underwrite.ixIndex)
    ).resolves.toEqual([
      { createdAtMs: 1_735_600_000_000, status: "queued" },
      { createdAtMs: 1_735_600_001_000, status: "submitted" },
      { createdAtMs: 1_735_600_002_000, status: "failed" },
    ]);
  });

  it("keeps one terminal failed audit entry when a queue message is delivered again", async () => {
    const repository = new UnderwriteRepository(env.DB);
    await repository.createQueued(underwrite);

    await repository.markFailed(
      underwrite.txSignature,
      underwrite.ixIndex,
      1_735_600_001_000,
      "simulation failed"
    );
    await repository.markFailed(
      underwrite.txSignature,
      underwrite.ixIndex,
      1_735_600_002_000,
      "a later failure must not replace the terminal result"
    );

    await expect(
      repository.get(underwrite.txSignature, underwrite.ixIndex)
    ).resolves.toMatchObject({
      status: "failed",
      lastError: "simulation failed",
    });
    await expect(
      repository.auditFor(underwrite.txSignature, underwrite.ixIndex)
    ).resolves.toEqual([
      { createdAtMs: underwrite.createdAtMs, status: "queued" },
      { createdAtMs: 1_735_600_001_000, status: "failed" },
    ]);
  });

  it("updates an existing confirmed series when another underwrite confirms", async () => {
    const repository = new UnderwriteRepository(env.DB);
    const first = {
      ...underwrite,
      txSignature: "first-series-confirmation",
    };
    const second = {
      ...underwrite,
      txSignature: "second-series-confirmation",
      createdAtMs: 1_735_600_001_000,
    };
    for (const item of [first, second]) {
      await repository.createQueued(item);
      await repository.markSubmitted(item.txSignature, item.ixIndex, 1);
    }
    await repository.markConfirmed(first.txSignature, first.ixIndex, 2);
    await repository.markConfirmed(second.txSignature, second.ixIndex, 3);

    await expect(
      repository.getSeries(underwrite.seriesAddress)
    ).resolves.toMatchObject({
      seriesAddress: underwrite.seriesAddress,
      confirmedAtMs: 3,
    });
  });

  it("lists a seller's confirmed underwrites by nearest expiry", async () => {
    const repository = new UnderwriteRepository(env.DB);
    const later = {
      ...underwrite,
      txSignature: "later",
      expiryMs: 1_735_700_000_000,
    };
    const earlier = {
      ...underwrite,
      txSignature: "earlier",
      expiryMs: 1_735_650_000_000,
    };
    const queued = {
      ...underwrite,
      txSignature: "queued",
    };

    for (const item of [later, earlier, queued]) {
      await repository.createQueued(item);
    }
    await repository.markSubmitted(later.txSignature, 0, 1_735_600_001_000);
    await repository.markConfirmed(later.txSignature, 0, 1_735_600_002_000);
    await repository.markSubmitted(earlier.txSignature, 0, 1_735_600_001_000);
    await repository.markConfirmed(earlier.txSignature, 0, 1_735_600_002_000);

    await expect(
      repository.listForSeller("seller-address")
    ).resolves.toMatchObject([
      { txSignature: "earlier", status: "confirmed" },
      { txSignature: "later", status: "confirmed" },
    ]);
    await expect(
      repository.listForSeller("seller-address", "queued")
    ).resolves.toMatchObject([{ txSignature: "queued", status: "queued" }]);
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
      confirmed_receipt TEXT,
      last_error TEXT,
      PRIMARY KEY (tx_signature, ix_index)
    )`,
    `CREATE TABLE underwrite_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_signature TEXT NOT NULL,
      ix_index INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      UNIQUE (tx_signature, ix_index, status)
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
