import { Hono } from "hono";
import {
  decodeFinalizedPriceFinalizations,
  fetchSeriesBackfill,
  PriceFinalizationError,
  validateSignature,
} from "sdk";

import { configuredMarketByAddress } from "../../config";
import {
  PriceFinalizationConflictError,
  PriceFinalizationRepository,
  type BackfilledSeries,
  type PriceFinalizationWrite,
} from "../../database/price-finalization-repository";
import type { Env } from "../../worker";

export const backfillsRouter = new Hono<{ Bindings: Env }>();

backfillsRouter.post("/price-finalizations", async (context) => {
  if (
    !hasBearerToken(
      context.req.header("Authorization"),
      context.env.ADMIN_AUTH_TOKEN
    )
  ) {
    return context.json({ error: "Unauthorized." }, 401);
  }
  const signature = await backfillSignature(context.req.raw);
  if (signature === null) {
    return context.json({ error: "Invalid transaction signature." }, 400);
  }
  try {
    const finalizations = await decodeFinalizedPriceFinalizations({
      rpcUrl: context.env.SOLANA_RPC_URL,
      signature,
    });
    const repository = new PriceFinalizationRepository(context.env.DB);
    const writes = await Promise.all(
      finalizations.map((finalization) =>
        priceFinalizationWrite(repository, context.env, finalization)
      )
    );
    const recordedFinalizations = await repository.record(writes);
    await broadcastPriceFinalizations(context.env, recordedFinalizations);
    return new Response(null, { status: 204 });
  } catch (error) {
    return priceFinalizationErrorResponse(context, error);
  }
});

function hasBearerToken(
  authorization: string | undefined,
  token: string
): boolean {
  return authorization === `Bearer ${token}`;
}

async function backfillSignature(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.signature !== "string") return null;
    validateSignature(body.signature);
    return body.signature;
  } catch {
    return null;
  }
}

async function priceFinalizationWrite(
  repository: PriceFinalizationRepository,
  env: Env,
  finalization: Awaited<
    ReturnType<typeof decodeFinalizedPriceFinalizations>
  >[number]
): Promise<PriceFinalizationWrite> {
  if ((await repository.get(finalization.seriesAddress)) !== null) {
    return { finalization };
  }
  const series = await fetchSeriesBackfill({
    rpcUrl: env.SOLANA_RPC_URL,
    seriesAddress: finalization.seriesAddress,
    minContextSlot: finalization.slot,
  });
  if (series.expiryPrice !== finalization.expiryPrice) {
    throw new PriceFinalizationConflictError();
  }
  const market = configuredMarketByAddress(
    env.PRODUCT_ENVIRONMENT,
    series.marketAddress
  );
  if (
    market === null ||
    market.baseMint !== series.baseMint ||
    market.quoteMint !== series.quoteMint
  ) {
    throw new PriceFinalizationConflictError();
  }
  const backfilledSeries: BackfilledSeries = {
    seriesAddress: series.seriesAddress,
    marketAddress: series.marketAddress,
    oracleAsset: market.oracleBase,
    baseAsset: market.baseTokenSymbol,
    quoteAsset: market.quoteTokenSymbol,
    isPut: series.isPut,
    expiryMs: series.expiryMs,
    strike: series.strike,
    baseMint: series.baseMint,
    quoteMint: series.quoteMint,
  };
  return { finalization, backfilledSeries };
}

async function broadcastPriceFinalizations(
  env: Env,
  finalizations: Awaited<ReturnType<typeof decodeFinalizedPriceFinalizations>>
): Promise<void> {
  const hub = env.CONNECTION_HUB.get(
    env.CONNECTION_HUB.idFromName("connections")
  );
  for (const finalization of finalizations) {
    const response = await hub.fetch(
      new Request("https://connection-hub/broadcast-maker", {
        method: "POST",
        body: JSON.stringify({
          message: JSON.stringify({
            jsonrpc: "2.0",
            method: "series.priceFinalized",
            params: {
              seriesAddress: finalization.seriesAddress,
              expiryPrice: finalization.expiryPrice,
              method: finalization.method,
              slot: finalization.slot,
              signature: finalization.signature,
            },
          }),
        }),
      })
    );
    if (!response.ok) throw new Error("Maker notification broadcast failed.");
  }
}

function priceFinalizationErrorResponse(
  context: {
    json: (object: { error: string }, status: 409 | 422 | 503) => Response;
  },
  error: unknown
): Response {
  if (error instanceof PriceFinalizationError) {
    if (error.kind === "not-finalized") {
      return context.json({ error: error.message }, 409);
    }
    if (error.kind === "rpc-unavailable") {
      return context.json({ error: error.message }, 503);
    }
    return context.json({ error: error.message }, 422);
  }
  if (error instanceof PriceFinalizationConflictError) {
    return context.json({ error: error.message }, 422);
  }
  console.error("Price finalization backfill failed.", error);
  return context.json({ error: "Price finalization broadcast failed." }, 503);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
