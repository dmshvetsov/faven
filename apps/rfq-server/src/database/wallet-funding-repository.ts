import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { walletFundings, type WalletFundingStatus } from "./schema";

export type { WalletFundingStatus } from "./schema";

export interface StoredWalletFunding {
  readonly id: number;
  readonly walletAddress: string;
  readonly status: WalletFundingStatus;
  readonly createdAtMs: number;
  readonly transactionSignature: string | null;
  readonly completedAtMs: number | null;
  readonly failureReason: string | null;
}

export class WalletFundingRepository {
  private readonly database;

  constructor(database: D1Database) {
    this.database = drizzle(database);
  }

  async createPending(
    walletAddress: string,
    createdAtMs: number
  ): Promise<{ readonly created: boolean; readonly id: number | null }> {
    const inserted = await this.database
      .insert(walletFundings)
      .values({ walletAddress, status: "pending", createdAtMs })
      .onConflictDoNothing()
      .returning({ id: walletFundings.id });
    return inserted[0] === undefined
      ? { created: false, id: null }
      : { created: true, id: inserted[0].id };
  }

  async latestSucceeded(
    walletAddress: string
  ): Promise<StoredWalletFunding | null> {
    const rows = await this.database
      .select()
      .from(walletFundings)
      .where(
        and(
          eq(walletFundings.walletAddress, walletAddress),
          eq(walletFundings.status, "succeeded")
        )
      )
      .orderBy(desc(walletFundings.completedAtMs), desc(walletFundings.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async markSucceeded(
    id: number,
    transactionSignature: string,
    completedAtMs: number
  ): Promise<void> {
    await this.database
      .update(walletFundings)
      .set({
        status: "succeeded",
        transactionSignature,
        completedAtMs,
        failureReason: null,
      })
      .where(
        and(eq(walletFundings.id, id), eq(walletFundings.status, "pending"))
      );
  }

  async recordTransactionSignature(
    id: number,
    transactionSignature: string
  ): Promise<void> {
    await this.database
      .update(walletFundings)
      .set({ transactionSignature })
      .where(
        and(eq(walletFundings.id, id), eq(walletFundings.status, "pending"))
      );
  }

  async markFailed(
    id: number,
    failureReason: string,
    completedAtMs: number
  ): Promise<void> {
    await this.database
      .update(walletFundings)
      .set({ status: "failed", failureReason, completedAtMs })
      .where(
        and(eq(walletFundings.id, id), eq(walletFundings.status, "pending"))
      );
  }
}
