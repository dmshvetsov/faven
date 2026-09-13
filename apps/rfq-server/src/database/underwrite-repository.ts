import { and, asc, eq, inArray } from "drizzle-orm";
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
  readonly oracleAsset: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly isPut: boolean;
  readonly expiryMs: number;
  /** USD strike using 8 decimals. */
  readonly strike: string;
  /** option contract quantity using 18 decimals. */
  readonly quantity: string;
  /** QuoteCoin premium per whole option contract using 18 decimals. */
  readonly premium: string;
  readonly baseMint: string;
  readonly quoteMint: string;
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
    const [inserted] = await this.database.batch([
      this.database
        .insert(underwrites)
        .values({ ...underwrite, status: "queued" })
        .onConflictDoNothing()
        .returning({ txSignature: underwrites.txSignature }),
      this.queuedAuditInsert(underwrite),
    ]);
    if (inserted.length === 0) return { created: false };
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

  async getStatus(
    txSignature: string,
    ixIndex: number
  ): Promise<UnderwriteStatus | null> {
    const underwrite = await this.get(txSignature, ixIndex);
    return underwrite?.status ?? null;
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
    confirmedAtMs: number,
    confirmedReceipt?: string
  ): Promise<void> {
    const underwrite = await this.get(txSignature, ixIndex);
    if (underwrite === null || underwrite.status !== "submitted") return;
    await this.database.batch([
      this.database
        .update(underwrites)
        .set({
          status: "confirmed",
          confirmedAtMs,
          confirmedReceipt: confirmedReceipt ?? null,
        })
        .where(
          and(
            keyWhere(txSignature, ixIndex),
            eq(underwrites.status, "submitted")
          )
        ),
      this.database
        .insert(underwriteAudit)
        .values({
          txSignature,
          ixIndex,
          createdAtMs: confirmedAtMs,
          status: "confirmed",
        })
        .onConflictDoNothing(),
      this.database
        .insert(optionSeries)
        .values({
          seriesAddress: underwrite.seriesAddress,
          marketAddress: underwrite.marketAddress,
          oracleAsset: underwrite.oracleAsset,
          baseAsset: underwrite.baseAsset,
          quoteAsset: underwrite.quoteAsset,
          isPut: underwrite.isPut,
          expiryMs: underwrite.expiryMs,
          strike: underwrite.strike,
          baseMint: underwrite.baseMint,
          quoteMint: underwrite.quoteMint,
          confirmedAtMs,
        })
        .onConflictDoUpdate({
          target: optionSeries.seriesAddress,
          set: { confirmedAtMs },
        }),
    ]);
  }

  async markFailed(
    txSignature: string,
    ixIndex: number,
    failedAtMs: number,
    error: string
  ): Promise<void> {
    const underwrite = await this.get(txSignature, ixIndex);
    if (
      underwrite === null ||
      (underwrite.status !== "queued" && underwrite.status !== "submitted")
    ) {
      return;
    }
    await this.database.batch([
      this.database
        .update(underwrites)
        .set({ status: "failed", lastError: error })
        .where(
          and(
            keyWhere(txSignature, ixIndex),
            inArray(underwrites.status, ["queued", "submitted"])
          )
        ),
      this.database
        .insert(underwriteAudit)
        .values({
          txSignature,
          ixIndex,
          createdAtMs: failedAtMs,
          status: "failed",
        })
        .onConflictDoNothing(),
    ]);
  }

  async getSeries(seriesAddress: string) {
    const result = await this.database
      .select()
      .from(optionSeries)
      .where(eq(optionSeries.seriesAddress, seriesAddress))
      .limit(1);
    return result[0] ?? null;
  }

  async listForSeller(
    sellerAddress: string,
    status: UnderwriteStatus = "confirmed"
  ): Promise<StoredUnderwrite[]> {
    return this.database
      .select()
      .from(underwrites)
      .where(
        and(
          eq(underwrites.sellerAddress, sellerAddress),
          eq(underwrites.status, status)
        )
      )
      .orderBy(asc(underwrites.expiryMs));
  }

  async listConfirmedPositions(
    buyerAddress: string,
    baseMint: string
  ): Promise<StoredUnderwrite[]> {
    return this.database
      .select()
      .from(underwrites)
      .where(
        and(
          eq(underwrites.buyerAddress, buyerAddress),
          eq(underwrites.baseMint, baseMint),
          eq(underwrites.status, "confirmed")
        )
      )
      .orderBy(asc(underwrites.expiryMs));
  }

  private async transition(
    txSignature: string,
    ixIndex: number,
    from: UnderwriteStatus,
    to: UnderwriteStatus,
    atMs: number,
    update: { readonly submittedAtMs?: number; readonly lastError?: string }
  ): Promise<void> {
    const underwrite = await this.get(txSignature, ixIndex);
    if (underwrite === null || underwrite.status !== from) return;
    await this.database.batch([
      this.database
        .update(underwrites)
        .set({ status: to, ...update })
        .where(
          and(keyWhere(txSignature, ixIndex), eq(underwrites.status, from))
        ),
      this.database
        .insert(underwriteAudit)
        .values({ txSignature, ixIndex, createdAtMs: atMs, status: to })
        .onConflictDoNothing(),
    ]);
  }

  private queuedAuditInsert(
    underwrite: Pick<
      QueuedUnderwrite,
      "txSignature" | "ixIndex" | "createdAtMs"
    >
  ) {
    return this.database
      .insert(underwriteAudit)
      .values({ ...underwrite, status: "queued" })
      .onConflictDoNothing();
  }
}

function keyWhere(txSignature: string, ixIndex: number) {
  return and(
    eq(underwrites.txSignature, txSignature),
    eq(underwrites.ixIndex, ixIndex)
  );
}
