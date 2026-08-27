import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  optionSeries,
  underwriteAudit,
  underwrites,
  type UnderwriteStatus,
} from "./schema";

export type { UnderwriteStatus } from "./schema";

export interface QueuedUnderwrite {
  readonly txSignature: string;
  readonly ixIndex: number;
  readonly rfqId: string;
  readonly sellerAddress: string;
  readonly buyerAddress: string;
  readonly marketAddress: string;
  readonly seriesAddress: string;
  readonly ticker: string;
  readonly isPut: boolean;
  readonly expiryMs: number;
  readonly strike: string;
  readonly quantity: string;
  readonly premium: string;
  readonly baseCoinMint: string;
  readonly quoteCoinMint: string;
  readonly feeRecipient: string;
  readonly operationalFeeBps: number;
  readonly createdAtMs: number;
}

export interface StoredUnderwrite extends QueuedUnderwrite {
  readonly status: UnderwriteStatus;
  readonly submittedAtMs: number | null;
  readonly confirmedAtMs: number | null;
  readonly lastError: string | null;
}

export class UnderwriteRepository {
  private readonly database;

  constructor(database: D1Database) {
    this.database = drizzle(database);
  }

  async createQueued(
    underwrite: QueuedUnderwrite
  ): Promise<{ created: boolean }> {
    const created = await this.database
      .insert(underwrites)
      .values({ ...underwrite, status: "queued" })
      .onConflictDoNothing()
      .returning({ txSignature: underwrites.txSignature });
    if (created.length === 0) return { created: false };

    await this.database.insert(underwriteAudit).values({
      txSignature: underwrite.txSignature,
      ixIndex: underwrite.ixIndex,
      createdAtMs: underwrite.createdAtMs,
      status: "queued",
    });
    return { created: true };
  }

  async get(
    txSignature: string,
    ixIndex: number
  ): Promise<StoredUnderwrite | null> {
    const result = await this.database
      .select()
      .from(underwrites)
      .where(keyWhere(txSignature, ixIndex))
      .limit(1);
    return result[0] ?? null;
  }

  async auditFor(txSignature: string, ixIndex: number) {
    return this.database
      .select({
        createdAtMs: underwriteAudit.createdAtMs,
        status: underwriteAudit.status,
      })
      .from(underwriteAudit)
      .where(
        and(
          eq(underwriteAudit.txSignature, txSignature),
          eq(underwriteAudit.ixIndex, ixIndex)
        )
      )
      .orderBy(asc(underwriteAudit.id));
  }

  async markSubmitted(
    txSignature: string,
    ixIndex: number,
    submittedAtMs: number
  ): Promise<void> {
    await this.transition(
      txSignature,
      ixIndex,
      "queued",
      "submitted",
      submittedAtMs,
      { submittedAtMs }
    );
  }

  async markConfirmed(
    txSignature: string,
    ixIndex: number,
    confirmedAtMs: number
  ): Promise<void> {
    const updated = await this.database
      .update(underwrites)
      .set({ status: "confirmed", confirmedAtMs })
      .where(
        and(keyWhere(txSignature, ixIndex), eq(underwrites.status, "submitted"))
      )
      .returning();
    const underwrite = updated[0];
    if (underwrite === undefined) return;

    await this.database.batch([
      this.database
        .insert(underwriteAudit)
        .values({
          txSignature,
          ixIndex,
          createdAtMs: confirmedAtMs,
          status: "confirmed",
        }),
      this.database
        .insert(optionSeries)
        .values({
          seriesAddress: underwrite.seriesAddress,
          marketAddress: underwrite.marketAddress,
          ticker: underwrite.ticker,
          isPut: underwrite.isPut,
          expiryMs: underwrite.expiryMs,
          strike: underwrite.strike,
          baseCoinMint: underwrite.baseCoinMint,
          quoteCoinMint: underwrite.quoteCoinMint,
          confirmedAtMs,
        })
        .onConflictDoNothing(),
    ]);
  }

  async markFailed(
    txSignature: string,
    ixIndex: number,
    failedAtMs: number,
    error: string
  ): Promise<void> {
    await this.transition(
      txSignature,
      ixIndex,
      "queued",
      "failed",
      failedAtMs,
      { lastError: error }
    );
  }

  async getSeries(seriesAddress: string) {
    const result = await this.database
      .select()
      .from(optionSeries)
      .where(eq(optionSeries.seriesAddress, seriesAddress))
      .limit(1);
    return result[0] ?? null;
  }

  private async transition(
    txSignature: string,
    ixIndex: number,
    from: UnderwriteStatus,
    to: UnderwriteStatus,
    atMs: number,
    update: { readonly submittedAtMs?: number; readonly lastError?: string }
  ): Promise<void> {
    const updated = await this.database
      .update(underwrites)
      .set({ status: to, ...update })
      .where(and(keyWhere(txSignature, ixIndex), eq(underwrites.status, from)))
      .returning({ txSignature: underwrites.txSignature });
    if (updated.length === 0) return;
    await this.database
      .insert(underwriteAudit)
      .values({ txSignature, ixIndex, createdAtMs: atMs, status: to });
  }
}

function keyWhere(txSignature: string, ixIndex: number) {
  return and(
    eq(underwrites.txSignature, txSignature),
    eq(underwrites.ixIndex, ixIndex)
  );
}
