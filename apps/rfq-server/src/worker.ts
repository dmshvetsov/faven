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
import { JsonSolanaRpc } from "./solana-rpc";
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

app.get("/health", (context) =>
  context.json({ environment: context.env.PRODUCT_ENVIRONMENT, status: "ok" })
);

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
        await processor.process(message.body, Date.now());
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
