import { Hono } from 'hono';

import { getEnvironmentConfig, isAllowedOrigin, type ProductEnvironment, type SolanaCluster } from './config';

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

app.use('*', async (context, next) => {
  const config = getEnvironmentConfig(context.env.PRODUCT_ENVIRONMENT);
  if (config.cluster !== context.env.SOLANA_CLUSTER) {
    return context.json({ error: 'Invalid deployment environment.' }, 500);
  }

  const origin = context.req.header('Origin');
  if (origin !== undefined && !isAllowedOrigin(context.env.PRODUCT_ENVIRONMENT, origin)) {
    return context.json({ error: 'Origin is not allowed.' }, 403);
  }

  await next();
});

app.get('/health', (context) =>
  context.json({ environment: context.env.PRODUCT_ENVIRONMENT, status: 'ok' }),
);

app.notFound((context) => context.json({ error: 'Not found.' }, 404));

export class RfqBroker implements DurableObject {
  constructor(readonly state: DurableObjectState) {}

  fetch(): Response {
    return new Response('RFQ broker bootstrap is not implemented.', { status: 501 });
  }
}

export default {
  fetch: app.fetch,
  async queue(): Promise<void> {
    throw new Error('Broadcast queue consumer is not implemented.');
  },
} satisfies ExportedHandler<Env>;
