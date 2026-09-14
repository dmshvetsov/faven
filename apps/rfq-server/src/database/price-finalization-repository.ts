import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { FinalizedPriceFinalization } from "sdk";

import { optionSeries } from "./schema";

export interface BackfilledSeries {
  readonly seriesAddress: string;
  readonly marketAddress: string;
  readonly oracleAsset: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly isPut: boolean;
  readonly expiryMs: number;
  readonly strike: string;
  readonly baseMint: string;
  readonly quoteMint: string;
}

export interface PriceFinalizationWrite {
  readonly finalization: FinalizedPriceFinalization;
  readonly backfilledSeries?: BackfilledSeries;
}

export class PriceFinalizationConflictError extends Error {
  constructor() {
    super("Price finalization conflicts with the stored Series.");
  }
}

export class PriceFinalizationRepository {
  private readonly database;

  constructor(database: D1Database) {
    this.database = drizzle(database);
  }

  async get(seriesAddress: string) {
    const rows = await this.database
      .select()
      .from(optionSeries)
      .where(eq(optionSeries.seriesAddress, seriesAddress))
      .limit(1);
    return rows[0] ?? null;
  }

  async record(
    writes: readonly PriceFinalizationWrite[]
  ): Promise<readonly FinalizedPriceFinalization[]> {
    const existing = new Map(
      await Promise.all(
        writes.map(
          async (write) =>
            [
              write.finalization.seriesAddress,
              await this.get(write.finalization.seriesAddress),
            ] as const
        )
      )
    );
    const statements: BatchItem<"sqlite">[] = [];
    const recordedFinalizations: FinalizedPriceFinalization[] = [];
    for (const write of writes) {
      const stored = existing.get(write.finalization.seriesAddress);
      if (stored === null) {
        if (write.backfilledSeries === undefined) {
          throw new PriceFinalizationConflictError();
        }
        statements.push(
          this.database.insert(optionSeries).values({
            ...write.backfilledSeries,
            confirmedAtMs: 0,
            ...finalizationColumns(write.finalization),
          })
        );
        recordedFinalizations.push(write.finalization);
        continue;
      }
      if (stored === undefined) throw new PriceFinalizationConflictError();
      if (isIdenticalFinalization(stored, write.finalization)) continue;
      if (hasNoFinalization(stored)) {
        statements.push(
          this.database
            .update(optionSeries)
            .set(finalizationColumns(write.finalization))
            .where(
              eq(optionSeries.seriesAddress, write.finalization.seriesAddress)
            )
        );
        recordedFinalizations.push(write.finalization);
        continue;
      }
      if (
        stored.finalizedSlot === null ||
        write.finalization.slot <= stored.finalizedSlot
      ) {
        throw new PriceFinalizationConflictError();
      }
      statements.push(
        this.database
          .update(optionSeries)
          .set(finalizationColumns(write.finalization))
          .where(
            eq(optionSeries.seriesAddress, write.finalization.seriesAddress)
          )
      );
      recordedFinalizations.push(write.finalization);
    }
    const [first, ...remaining] = statements;
    if (first !== undefined) await this.database.batch([first, ...remaining]);
    return recordedFinalizations;
  }
}

function finalizationColumns(finalization: FinalizedPriceFinalization) {
  return {
    expiryPrice: finalization.expiryPrice,
    finalizedAtMs: finalization.finalizedAtMs,
    finalizedSlot: finalization.slot,
    finalizationSignature: finalization.signature,
    finalizationMethod: finalization.method,
  };
}

function isIdenticalFinalization(
  stored: {
    readonly expiryPrice: string | null;
    readonly finalizedAtMs: number | null;
    readonly finalizedSlot: number | null;
    readonly finalizationSignature: string | null;
    readonly finalizationMethod: string | null;
  },
  finalization: FinalizedPriceFinalization
): boolean {
  return (
    stored.expiryPrice === finalization.expiryPrice &&
    stored.finalizedSlot === finalization.slot &&
    stored.finalizationSignature === finalization.signature &&
    stored.finalizationMethod === finalization.method
  );
}

function hasNoFinalization(stored: {
  readonly expiryPrice: string | null;
  readonly finalizedAtMs: number | null;
  readonly finalizedSlot: number | null;
  readonly finalizationSignature: string | null;
  readonly finalizationMethod: string | null;
}): boolean {
  return (
    stored.expiryPrice === null &&
    stored.finalizedAtMs === null &&
    stored.finalizedSlot === null &&
    stored.finalizationSignature === null &&
    stored.finalizationMethod === null
  );
}
