import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { WalletFundingRepository } from "../src/database/wallet-funding-repository";

const walletAddress = "wallet-address";

describe("wallet funding repository", () => {
  beforeEach(async () => {
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
  });

  it("creates at most one pending funding attempt per wallet", async () => {
    const repository = new WalletFundingRepository(env.DB);
    const attempts = await Promise.all([
      repository.createPending(walletAddress, 100),
      repository.createPending(walletAddress, 100),
    ]);

    expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.created)).toHaveLength(1);
  });

  it("uses completed successful attempts for the cooldown and excludes failures", async () => {
    const repository = new WalletFundingRepository(env.DB);
    const failed = await repository.createPending(walletAddress, 100);
    if (failed.id === null) throw new Error("Expected pending funding.");
    await repository.markFailed(failed.id, "funding-unavailable", 200);

    const succeeded = await repository.createPending(walletAddress, 300);
    if (succeeded.id === null) throw new Error("Expected pending funding.");
    await repository.recordTransactionSignature(succeeded.id, "signature");
    await repository.markSucceeded(succeeded.id, "signature", 400);

    await expect(
      repository.latestSucceeded(walletAddress)
    ).resolves.toMatchObject({
      status: "succeeded",
      completedAtMs: 400,
      transactionSignature: "signature",
    });
  });
});
