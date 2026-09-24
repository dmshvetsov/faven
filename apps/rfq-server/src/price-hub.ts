import {
  backpackTickerForOracleBase,
  configuredBackpackTickers,
  createPriceFeedsSnapshot,
  priceFromBackpackTickerEnvelope,
  type ObservedPrice,
} from "./price-feeds";
import { configuredMarketByAddress } from "./config";
import type { Env } from "./worker";

const BACKPACK_WEBSOCKET_URL = "wss://ws.backpack.exchange";
const INITIAL_RETRY_DELAY_MS = 1_000;
const INITIAL_CONNECTION_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 30_000;
const SNAPSHOT_INTERVAL_MS = 10_000;
const PRICE_FEED_SOCKET_TAG = "price-feed";
const PRICE_WAIT_TIMEOUT_MS = 5_000;

interface PendingPrice {
  readonly promise: Promise<ObservedPrice>;
  readonly reject: (error: Error) => void;
  readonly resolve: (price: ObservedPrice) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  requestCount: number;
}

export class PriceHub implements DurableObject {
  private readonly observedPrices = new Map<string, ObservedPrice>();
  private backpackSocket: WebSocket | null = null;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private closeUpstreamAfterConnect = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private readonly pendingPrices = new Map<string, PendingPrice>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = INITIAL_RETRY_DELAY_MS;

  constructor(
    readonly state: DurableObjectState,
    private readonly env: Env
  ) {
    if (this.clientCount() > 0) {
      this.startBroadcasting();
      this.scheduleUpstreamConnection();
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return this.priceResponse(request);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, [PRICE_FEED_SOCKET_TAG]);
    this.closeUpstreamAfterConnect = false;
    this.sendSnapshot(server);
    this.logClientCount();
    this.startBroadcasting();
    this.scheduleUpstreamConnection();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(): void {
    // Price-feed clients do not send requests in the MVP.
  }

  webSocketClose(): void {
    this.logClientCount();
    this.stopWhenNoClientsRemain();
  }

  webSocketError(): void {
    this.logClientCount();
    this.stopWhenNoClientsRemain();
  }

  private clientCount(): number {
    return this.state.getWebSockets(PRICE_FEED_SOCKET_TAG).length;
  }

  private startBroadcasting(): void {
    if (this.broadcastTimer !== null) return;
    this.broadcastTimer = setInterval(
      () => this.broadcastSnapshot(),
      SNAPSHOT_INTERVAL_MS
    );
  }

  private broadcastSnapshot(): void {
    for (const socket of this.state.getWebSockets(PRICE_FEED_SOCKET_TAG)) {
      this.sendSnapshot(socket);
    }
  }

  private sendSnapshot(socket: WebSocket): void {
    try {
      socket.send(
        JSON.stringify(
          createPriceFeedsSnapshot(
            this.env.PRODUCT_ENVIRONMENT,
            this.observedPrices
          )
        )
      );
    } catch {
      socket.close(1011, "Price feed snapshot failed.");
    }
  }

  private ensureUpstreamConnection(): void {
    if (!this.hasDemand() || this.backpackSocket !== null || this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      const socket = new WebSocket(BACKPACK_WEBSOCKET_URL);
      this.backpackSocket = socket;
      socket.addEventListener("open", () => this.subscribe(socket));
      socket.addEventListener("message", (event) =>
        this.handleBackpackMessage(event.data)
      );
      socket.addEventListener("close", () => this.closeUpstream(socket));
      socket.addEventListener("error", (event) =>
        this.errorUpstream(socket, event)
      );
    } catch (error) {
      this.connecting = false;
      console.error("Price feed upstream error.", {
        error: errorMessage(error),
      });
      this.scheduleReconnect();
    }
  }

  private scheduleUpstreamConnection(): void {
    if (this.connectTimer !== null) return;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.ensureUpstreamConnection();
    }, INITIAL_CONNECTION_DELAY_MS);
  }

  private subscribe(socket: WebSocket): void {
    if (this.backpackSocket !== socket) return;
    this.connecting = false;
    if (this.closeUpstreamAfterConnect || !this.hasDemand()) {
      this.closeUpstreamAfterConnect = false;
      this.backpackSocket = null;
      socket.close(1000, "No price-feed clients remain.");
      return;
    }
    this.retryDelayMs = INITIAL_RETRY_DELAY_MS;
    const tickers = configuredBackpackTickers(this.env.PRODUCT_ENVIRONMENT);
    console.info("Price feed upstream connected.", {
      tickerCount: tickers.length,
    });
    try {
      socket.send(
        JSON.stringify({
          method: "SUBSCRIBE",
          params: tickers.map((ticker) => `ticker.${ticker}`),
        })
      );
    } catch (error) {
      console.error("Price feed upstream subscription failed.", {
        error: errorMessage(error),
      });
      this.failPendingPrices(new PriceFeedUnavailableError());
      this.closeUpstream(socket);
      try {
        socket.close(1011, "Price feed subscription failed.");
      } catch {
        // The connection already closed.
      }
    }
  }

  private handleBackpackMessage(message: unknown): void {
    const update = priceFromBackpackTickerEnvelope(
      parseJson(message),
      new Set(configuredBackpackTickers(this.env.PRODUCT_ENVIRONMENT))
    );
    if (update === null) return;
    this.observedPrices.set(update.ticker, update.price);
    const pending = this.pendingPrices.get(update.ticker);
    if (pending === undefined) return;
    this.pendingPrices.delete(update.ticker);
    clearTimeout(pending.timeout);
    pending.resolve(update.price);
  }

  private closeUpstream(socket: WebSocket): void {
    if (this.backpackSocket !== socket) return;
    this.backpackSocket = null;
    this.closeUpstreamAfterConnect = false;
    this.connecting = false;
    console.info("Price feed upstream closed.", {});
    if (this.pendingPrices.size > 0) {
      this.failPendingPrices(new PriceFeedUnavailableError());
    }
    this.scheduleReconnect();
  }

  private errorUpstream(socket: WebSocket, error: unknown): void {
    if (this.backpackSocket !== socket) return;
    console.error("Price feed upstream error.", { error: errorMessage(error) });
    this.failPendingPrices(new PriceFeedUnavailableError());
    this.closeUpstream(socket);
  }

  private scheduleReconnect(): void {
    if (!this.hasDemand() || this.reconnectTimer !== null) return;
    const baseDelayMs = this.retryDelayMs;
    const delayMs = Math.round(baseDelayMs * (0.8 + Math.random() * 0.4));
    this.retryDelayMs = Math.min(baseDelayMs * 2, MAX_RETRY_DELAY_MS);
    console.info("Price feed upstream retry scheduled.", {
      delayMs,
      nextBaseDelayMs: this.retryDelayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureUpstreamConnection();
    }, delayMs);
  }

  private stopWhenNoClientsRemain(): void {
    this.stopWhenNoDemandRemains();
  }

  private stopWhenNoDemandRemains(): void {
    if (this.hasDemand()) return;
    if (this.broadcastTimer !== null) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.retryDelayMs = INITIAL_RETRY_DELAY_MS;
    const socket = this.backpackSocket;
    if (socket === null) {
      this.connecting = false;
      return;
    }
    if (this.connecting) {
      this.closeUpstreamAfterConnect = true;
      return;
    }
    this.backpackSocket = null;
    this.connecting = false;
    try {
      socket.close(1000, "No price-feed clients remain.");
    } catch {
      // The connection already closed.
    }
  }

  private logClientCount(): void {
    console.info("Price feed client count changed.", {
      clientCount: this.clientCount(),
    });
  }

  private async priceResponse(request: Request): Promise<Response> {
    const marketAddress = marketAddressFromPriceRequest(request.url);
    if (marketAddress === null) {
      return new Response("Price endpoint not found.", { status: 404 });
    }
    const market = configuredMarketByAddress(
      this.env.PRODUCT_ENVIRONMENT,
      marketAddress
    );
    if (market === null) return jsonError("RFQ market not found.", 404);
    const ticker = backpackTickerForOracleBase(market.oracleBase);
    if (ticker === null) return jsonError("Price feed is unavailable.", 503);
    try {
      const price = await this.waitForPrice(ticker, request.signal);
      return Response.json(price);
    } catch (error) {
      if (error instanceof PriceWaitTimeoutError) {
        return jsonError(
          `Timed out waiting for a price for market ${marketAddress}.`,
          504
        );
      }
      return jsonError("Price feed is unavailable.", 503);
    }
  }

  private async waitForPrice(
    ticker: string,
    signal: AbortSignal
  ): Promise<ObservedPrice> {
    const observed = this.observedPrices.get(ticker);
    if (observed !== undefined) return observed;
    const pending = this.pendingPrice(ticker);
    pending.requestCount += 1;
    this.scheduleUpstreamConnection();
    try {
      return await waitForPriceOrAbort(pending.promise, signal);
    } finally {
      pending.requestCount -= 1;
      if (
        pending.requestCount === 0 &&
        this.pendingPrices.get(ticker) === pending
      ) {
        this.pendingPrices.delete(ticker);
        clearTimeout(pending.timeout);
        pending.reject(new PriceRequestCancelledError());
      }
      this.stopWhenNoDemandRemains();
    }
  }

  private pendingPrice(ticker: string): PendingPrice {
    const existing = this.pendingPrices.get(ticker);
    if (existing !== undefined) return existing;
    let resolve!: (price: ObservedPrice) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ObservedPrice>(
      (resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      }
    );
    const pending: PendingPrice = {
      promise,
      reject,
      resolve,
      requestCount: 0,
      timeout: setTimeout(() => {
        if (this.pendingPrices.get(ticker) !== pending) return;
        this.pendingPrices.delete(ticker);
        pending.reject(new PriceWaitTimeoutError());
      }, PRICE_WAIT_TIMEOUT_MS),
    };
    this.pendingPrices.set(ticker, pending);
    return pending;
  }

  private failPendingPrices(error: Error): void {
    for (const [ticker, pending] of this.pendingPrices) {
      this.pendingPrices.delete(ticker);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private hasDemand(): boolean {
    return this.clientCount() > 0 || this.pendingPrices.size > 0;
  }
}

class PriceFeedUnavailableError extends Error {}

class PriceRequestCancelledError extends Error {}

class PriceWaitTimeoutError extends Error {}

function marketAddressFromPriceRequest(value: string): string | null {
  const url = new URL(value);
  const prefix = "/prices/";
  if (!url.pathname.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function waitForPriceOrAbort(
  price: Promise<ObservedPrice>,
  signal: AbortSignal
): Promise<ObservedPrice> {
  if (signal.aborted) return Promise.reject(new PriceRequestCancelledError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(new PriceRequestCancelledError());
    signal.addEventListener("abort", abort, { once: true });
    void price.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function parseJson(message: unknown): unknown {
  if (typeof message !== "string") return null;
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}
