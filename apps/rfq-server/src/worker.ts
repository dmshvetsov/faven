import { Hono } from "hono";
import {
  decodeFinalizedPriceFinalizations,
  fetchSeriesBackfill,
  PriceFinalizationError,
  validateSignature,
} from "sdk";

import {
  BroadcastProcessor,
  PendingConfirmationError,
  type BroadcastTask,
} from "./broadcast";
import {
  configuredMarket,
  configuredMarketByAddress,
  getEnvironmentConfig,
  isAllowedOrigin,
  type ProductEnvironment,
  type SolanaCluster,
} from "./config";
import {
  UnderwriteRepository,
  type UnderwriteStatus,
} from "./database/underwrite-repository";
import {
  PriceFinalizationConflictError,
  PriceFinalizationRepository,
  type BackfilledSeries,
  type PriceFinalizationWrite,
} from "./database/price-finalization-repository";
import { JsonSolanaRpc } from "./solana-rpc";
import {
  fundedResponse,
  fundWallet,
  retryAfterSeconds,
} from "./wallet-funding";
export { AssetHub } from "./asset-hub";
export { ConnectionHub } from "./connection-hub";
export { RfqDurableObject } from "./rfq-durable-object";

export interface Env {
  readonly DB: D1Database;
  readonly ASSET_HUB: DurableObjectNamespace;
  readonly CONNECTION_HUB: DurableObjectNamespace;
  readonly RFQ_OBJECT: DurableObjectNamespace;
  readonly BROADCAST_QUEUE: Queue;
  readonly PRODUCT_ENVIRONMENT: ProductEnvironment;
  readonly SOLANA_CLUSTER: SolanaCluster;
  readonly SOLANA_RPC_URL: string;
  readonly SOLANA_WEBSOCKET_URL: string;
  readonly ADMIN_AUTH_TOKEN: string;
  readonly FAUCET_PRIVATE_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (context, next) => {
  const config = getEnvironmentConfig(context.env.PRODUCT_ENVIRONMENT);
  if (config.cluster !== context.env.SOLANA_CLUSTER) {
    return context.json({ error: "Invalid deployment environment." }, 500);
  }

  const origin = context.req.header("Origin");
  if (
    origin !== undefined &&
    !isAllowedOrigin(context.env.PRODUCT_ENVIRONMENT, origin)
  ) {
    return context.json({ error: "Origin is not allowed." }, 403);
  }

  await next();
});

app.get("/", (context) => context.json({ health: "OK" }));

app.get("/health", (context) =>
  context.json({ environment: context.env.PRODUCT_ENVIRONMENT, status: "ok" })
);

app.post("/internal/backfills/price-finalizations", async (context) => {
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
    await repository.record(writes);
    await broadcastPriceFinalizations(context.env, finalizations);
    return new Response(null, { status: 204 });
  } catch (error) {
    return priceFinalizationErrorResponse(context, error);
  }
});

app.post("/wallet-fundings", async (context) => {
  if (context.env.SOLANA_CLUSTER !== "devnet") {
    console.warn(
      `wallet-funding is called not in devnet, SOLANA_CLUSTER=${context.env.SOLANA_CLUSTER}`
    );
    return context.json({ error: "Not found." }, 404);
  }
  const walletAddress = await walletAddressFromRequest(context.req.raw);
  if (walletAddress === null) {
    return context.json({ error: "invalid-wallet-address" }, 400);
  }
  const result = await fundWallet({
    database: context.env.DB,
    rpcUrl: context.env.SOLANA_RPC_URL,
    treasuryPrivateKey: context.env.FAUCET_PRIVATE_KEY,
    walletAddress,
  });
  switch (result.status) {
    case "invalid-wallet-address":
      return context.json({ error: result.status }, 400);
    case "funding-in-progress":
      return context.json({ error: result.status }, 409);
    case "wallet-cooldown-active":
      return context.json(
        { error: result.status, retryAt: result.retryAt.toISOString() },
        429,
        { "Retry-After": retryAfterSeconds(result.retryAt).toString() }
      );
    case "funding-unavailable":
      return context.json({ error: result.status }, 503);
    case "funded":
      return context.json(fundedResponse(result.signature), 201);
  }
});

app.get("/sellers/:sellerAddress/underwrites", async (context) => {
  const status = statusFromQuery(context.req.query("status"));
  if (status === null) {
    return context.json({ error: "Invalid underwrite status." }, 400);
  }
  const underwrites = await new UnderwriteRepository(
    context.env.DB
  ).listForSeller(context.req.param("sellerAddress"), status);
  return context.json({ underwrites });
});

app.get("/rfqs/:asset", (context) => assetHubFetch(context));
app.get("/maker", (context) => connectionHubFetch(context));
app.get("/taker", (context) => connectionHubFetch(context));

app.notFound((context) => context.json({ error: "Not found." }, 404));

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const processor = new BroadcastProcessor(
      new UnderwriteRepository(env.DB),
      new JsonSolanaRpc(env.SOLANA_RPC_URL)
    );
    for (const message of batch.messages) {
      try {
        if (!isBroadcastTask(message.body)) {
          throw new Error("Invalid broadcast queue message.");
        }
        const result = await processor.process(message.body, Date.now());
        if (
          result !== null &&
          (result.status === "confirmed" || result.buyerFault) &&
          message.body.rfqId !== undefined
        ) {
          await env.RFQ_OBJECT.get(
            env.RFQ_OBJECT.idFromName(message.body.rfqId)
          ).fetch(
            new Request("https://rfq/broadcast-result", {
              method: "POST",
              body: JSON.stringify({
                txSignature: message.body.txSignature,
                ...result,
              }),
            })
          );
        }
      } catch (error) {
        if (error instanceof PendingConfirmationError) {
          message.retry();
          continue;
        }
        logBroadcastProcessingError(error, message.body);
      }
    }
  },
} satisfies ExportedHandler<Env>;

function assetHubFetch(context: {
  readonly env: Env;
  readonly req: { readonly raw: Request };
}): Promise<Response> {
  const asset = assetFromRequest(context.req.raw.url);
  if (asset === null) {
    return Promise.resolve(
      new Response("BaseCoin asset is required.", { status: 400 })
    );
  }
  if (configuredMarket(context.env.PRODUCT_ENVIRONMENT, asset) === null) {
    return Promise.resolve(
      new Response("RFQ market not found.", { status: 404 })
    );
  }
  return context.env.ASSET_HUB.get(
    context.env.ASSET_HUB.idFromName(assetHubName(asset))
  ).fetch(context.req.raw);
}

function connectionHubFetch(context: {
  readonly env: Env;
  readonly req: { readonly raw: Request };
}): Promise<Response> {
  return context.env.CONNECTION_HUB.get(
    context.env.CONNECTION_HUB.idFromName("connections")
  ).fetch(context.req.raw);
}

export function assetHubName(asset: string): string {
  return `asset-hub:${asset}`;
}

function assetFromRequest(value: string): string | null {
  const url = new URL(value);
  const prefix = "/rfqs/";
  if (url.pathname.startsWith(prefix)) {
    try {
      return decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      return "";
    }
  }
  return null;
}

function isBroadcastTask(value: unknown): value is BroadcastTask {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.txSignature === "string" &&
    typeof value.ixIndex === "number" &&
    Number.isSafeInteger(value.ixIndex) &&
    (value.rfqId === undefined || typeof value.rfqId === "string") &&
    typeof value.signedTransaction === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logBroadcastProcessingError(error: unknown, body: unknown): void {
  const task = isBroadcastTask(body) ? body : null;
  console.error("RFQ broadcast queue message could not be processed.", {
    error: error instanceof Error ? error.message : "Unknown error.",
    ixIndex: task?.ixIndex,
    txSignature: task?.txSignature,
  });
}

function statusFromQuery(value: string | undefined): UnderwriteStatus | null {
  if (value === undefined) return "confirmed";
  return value === "queued" ||
    value === "submitted" ||
    value === "confirmed" ||
    value === "failed"
    ? value
    : null;
}

async function walletAddressFromRequest(
  request: Request
): Promise<string | null> {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.walletAddress !== "string") return null;
    return body.walletAddress;
  } catch {
    return null;
  }
}

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
    baseAsset: market.baseCoinSymbol,
    quoteAsset: market.quoteCoinSymbol,
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
              eventId: `${finalization.signature}:${finalization.seriesAddress}`,
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
