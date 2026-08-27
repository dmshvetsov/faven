import { Hono } from "hono";

import {
  BroadcastProcessor,
  RetryableBroadcastError,
  type BroadcastTask,
} from "./broadcast";
import {
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
  return context.env.RFQ_BROKER.get(
    context.env.RFQ_BROKER.idFromName("rfq-broker")
  ).fetch(context.req.raw);
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

function statusFromQuery(value: string | undefined): UnderwriteStatus | null {
  if (value === undefined) return "confirmed";
  return value === "queued" ||
    value === "submitted" ||
    value === "confirmed" ||
    value === "failed"
    ? value
    : null;
}
