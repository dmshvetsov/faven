import { Hono } from "hono";

import {
  BroadcastProcessor,
  RetryableBroadcastError,
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
export { RfqBroker } from "./rfq-broker";

export interface Env {
  readonly DB: D1Database;
  readonly RFQ_BROKER: DurableObjectNamespace;
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

app.get("/rfqs/:asset", (context) => brokerFetch(context));
app.get("/maker", (context) => brokerFetch(context));
app.get("/taker", (context) => brokerFetch(context));

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
        if (error instanceof RetryableBroadcastError) message.retry();
        else throw error;
      }
    }
  },
} satisfies ExportedHandler<Env>;

function brokerFetch(context: {
  readonly env: Env;
  readonly req: { readonly raw: Request };
}): Promise<Response> {
  const asset = brokerAssetFromRequest(context.req.raw.url);
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
  return context.env.RFQ_BROKER.get(
    context.env.RFQ_BROKER.idFromName(rfqBrokerName(asset))
  ).fetch(context.req.raw);
}

export function rfqBrokerName(asset: string): string {
  return `rfq-broker:${asset}`;
}

function brokerAssetFromRequest(value: string): string | null {
  const url = new URL(value);
  const { pathname } = url;
  const prefix = "/rfqs/";
  if (pathname.startsWith(prefix)) {
    try {
      return decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return "";
    }
  }
  if (pathname === "/maker" || pathname === "/taker") {
    return url.searchParams.get("asset");
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
    typeof value.signedTransaction === "string" &&
    typeof value.recentBlockhash === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
