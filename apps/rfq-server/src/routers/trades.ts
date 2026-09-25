import { Hono } from "hono";

import {
  UnderwriteRepository,
  type StoredUnderwrite,
} from "../database/underwrite-repository";
import type { Env } from "../worker";

export const tradesRouter = new Hono<{ Bindings: Env }>();

tradesRouter.get("/:sellerAddress", async (context) => {
  const repository = new UnderwriteRepository(context.env.DB);
  const underwrites = await repository.listForSeller(
    context.req.param("sellerAddress")
  );
  const positions = await Promise.all(
    underwrites.map((underwrite) => positionFor(repository, underwrite))
  );
  if (positions.some((position) => position === null)) {
    return context.json({ error: "Trade position data is unavailable." }, 500);
  }
  return context.json({ positions });
});

tradesRouter.get(
  "/:sellerAddress/sig/:txSignature/:ixIndex",
  async (context) => {
    const ixIndex = Number(context.req.param("ixIndex"));
    if (!Number.isSafeInteger(ixIndex) || ixIndex < 0) {
      return context.json({ error: "Not found." }, 404);
    }
    const repository = new UnderwriteRepository(context.env.DB);
    const underwrite = await repository.get(
      context.req.param("txSignature"),
      ixIndex
    );
    if (
      underwrite === null ||
      underwrite.status !== "confirmed" ||
      underwrite.sellerAddress !== context.req.param("sellerAddress")
    ) {
      return context.json({ error: "Not found." }, 404);
    }
    const position = await positionFor(repository, underwrite);
    if (position === null) {
      return context.json(
        { error: "Trade position data is unavailable." },
        500
      );
    }
    return context.json({ position });
  }
);

export interface UnderwritePosition {
  readonly txSignature: string;
  readonly ixIndex: number;
  readonly seriesAddress: string;
  readonly marketAddress: string;
  readonly isPut: boolean;
  /** When the underwrite transaction was confirmed. */
  readonly confirmedAtMs: number;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly expiryMs: number;
  readonly strike: string;
  readonly quantity: string;
  readonly premium: string;
  readonly seriesState: "open" | "expiration_price_finalized" | "closed";
  readonly expiryPrice: string | null;
  readonly positionState: "open" | "closed";
  readonly closeReason:
    "expired_worthless" | "expired_unexercised" | "exercised" | null;
}

async function positionFor(
  repository: UnderwriteRepository,
  underwrite: StoredUnderwrite
): Promise<UnderwritePosition | null> {
  const series = await repository.getSeries(underwrite.seriesAddress);
  if (series === null || underwrite.confirmedAtMs === null) return null;

  return {
    txSignature: underwrite.txSignature,
    ixIndex: underwrite.ixIndex,
    seriesAddress: underwrite.seriesAddress,
    marketAddress: underwrite.marketAddress,
    isPut: underwrite.isPut,
    confirmedAtMs: underwrite.confirmedAtMs,
    baseAsset: underwrite.baseAsset,
    quoteAsset: underwrite.quoteAsset,
    expiryMs: underwrite.expiryMs,
    strike: underwrite.strike,
    quantity: underwrite.quantity,
    premium: underwrite.premium,
    seriesState:
      series.expiryPrice === null ? "open" : "expiration_price_finalized",
    expiryPrice: series.expiryPrice,
    positionState: "open",
    closeReason: null,
  };
}
