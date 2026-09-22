import {
  configuredBackpackTickers,
  createPriceFeedsSnapshot,
  priceFromBackpackTickerEnvelope,
  type ObservedPrice,
} from "./price-feeds";
import type { Env } from "./worker";

const BACKPACK_WEBSOCKET_URL = "wss://ws.backpack.exchange";
const INITIAL_RETRY_DELAY_MS = 1_000;
const INITIAL_CONNECTION_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 30_000;
const SNAPSHOT_INTERVAL_MS = 10_000;
const PRICE_FEED_SOCKET_TAG = "price-feed";

export class PriceHub implements DurableObject {
  private readonly observedPrices = new Map<string, ObservedPrice>();
  private backpackSocket: WebSocket | null = null;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private closeUpstreamAfterConnect = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
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

  fetch(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket endpoint not found.", { status: 404 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, [PRICE_FEED_SOCKET_TAG]);
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
    if (
      this.clientCount() === 0 ||
      this.backpackSocket !== null ||
      this.connecting
    ) {
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
    if (this.closeUpstreamAfterConnect || this.clientCount() === 0) {
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
    if (update !== null) this.observedPrices.set(update.ticker, update.price);
  }

  private closeUpstream(socket: WebSocket): void {
    if (this.backpackSocket !== socket) return;
    this.backpackSocket = null;
    this.closeUpstreamAfterConnect = false;
    this.connecting = false;
    console.info("Price feed upstream closed.", {});
    this.scheduleReconnect();
  }

  private errorUpstream(socket: WebSocket, error: unknown): void {
    if (this.backpackSocket !== socket) return;
    console.error("Price feed upstream error.", { error: errorMessage(error) });
    this.closeUpstream(socket);
  }

  private scheduleReconnect(): void {
    if (this.clientCount() === 0 || this.reconnectTimer !== null) return;
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
    if (this.clientCount() !== 0) return;
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
