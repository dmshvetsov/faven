import { Hono } from "hono";

import {
  BroadcastProcessor,
  PendingConfirmationError,
  type BroadcastTask,
} from "./broadcast";
import {
  configuredMarket,
  getEnvironmentConfig,
  isAllowedOrigin,
  type ProductEnvironment,
  type SolanaCluster,
} from "./config";
import {
  UnderwriteRepository,
  type UnderwriteStatus,
} from "./database/underwrite-repository";
import { backfillsRouter } from "./routers/backfills";
import { marketsRouter } from "./routers/markets";
import { JsonSolanaRpc } from "./solana-rpc";
import {
  fundedResponse,
  fundWallet,
  retryAfterSeconds,
} from "./wallet-funding";
export { AssetHub } from "./asset-hub";
export { ConnectionHub } from "./connection-hub";
export { PriceHub } from "./price-hub";
export { RfqDurableObject } from "./rfq-durable-object";

export interface Env {
  readonly DB: D1Database;
  readonly ASSET_HUB: DurableObjectNamespace;
  readonly CONNECTION_HUB: DurableObjectNamespace;
  readonly PRICE_HUB: DurableObjectNamespace;
  readonly RFQ_OBJECT: DurableObjectNamespace;
  readonly BROADCAST_QUEUE: Queue;
  readonly PRODUCT_ENVIRONMENT: ProductEnvironment;
  readonly SOLANA_CLUSTER: SolanaCluster;
  readonly SOLANA_RPC_URL: string;
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

  if (origin !== undefined) {
    context.header("Access-Control-Allow-Origin", origin);
    context.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    context.header("Access-Control-Allow-Headers", "content-type");
    context.header("Vary", "Origin");
  }
  if (context.req.method === "OPTIONS") return context.body(null, 204);

  await next();
});

app.get("/", (context) => context.json({ health: "OK" }));

app.get("/health", (context) =>
  context.json({ environment: context.env.PRODUCT_ENVIRONMENT, status: "ok" })
);

app.route("/markets", marketsRouter);
app.route("/internal/backfills", backfillsRouter);

app.post("/wallet-fundings", async (context) => {
  if (
    context.env.SOLANA_CLUSTER !== "devnet" &&
    context.env.SOLANA_CLUSTER !== "localhost"
  ) {
    console.warn(
      `wallet-funding is called outside localhost or devnet, SOLANA_CLUSTER=${context.env.SOLANA_CLUSTER}`
    );
    return context.json({ error: "Not found." }, 404);
  }
  const walletAddress = await walletAddressFromRequest(context.req.raw);
  if (walletAddress === null) {
    return context.json({ error: "invalid-wallet-address" }, 400);
  }
  const result = await fundWallet({
    database: context.env.DB,
    cluster: context.env.SOLANA_CLUSTER,
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
      return context.json(
        fundedResponse(result.signature, result.funding),
        201
      );
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
app.get("/price-feeds", (context) => priceHubFetch(context));

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

function priceHubFetch(context: {
  readonly env: Env;
  readonly req: { readonly raw: Request };
}): Promise<Response> {
  const id = context.env.PRICE_HUB.idFromName("all-backpack-prices");
  return context.env.PRICE_HUB.get(id).fetch(context.req.raw);
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
