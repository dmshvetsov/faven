import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("Price hub", () => {
  it("returns 404 for an unknown market series", async () => {
    const response = await SELF.fetch(
      "https://example.com/markets/unknown-market/series"
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "RFQ market not found.",
    });
  });

  it("allows the configured browser origin to request a market series", async () => {
    const response = await SELF.fetch(
      "https://example.com/markets/unknown-market/series",
      { headers: { Origin: "http://localhost:5173" } }
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173"
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("serves series after receiving the first requested market price", async () => {
    vi.stubGlobal("WebSocket", ControlledBackpackSocket);

    const response = await SELF.fetch(
      "https://example.com/markets/99rh3FNKgvuWigwrsaDLMSD9cX8XWkFAdTdHqLkW3BCC/series"
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      market: expect.objectContaining({
        marketAddress: "99rh3FNKgvuWigwrsaDLMSD9cX8XWkFAdTdHqLkW3BCC",
        lastPrice: "142.37",
      }),
      series: {
        call: expect.arrayContaining([
          expect.objectContaining({
            strikePriceDecimals: "14500000000",
            updateAt: 1_694_687_692_980,
          }),
        ]),
        put: expect.arrayContaining([
          expect.objectContaining({
            strikePriceDecimals: "13500000000",
            updateAt: 1_694_687_692_980,
          }),
        ]),
      },
    });
  });

  it("keeps the price feed available when a client reconnects during setup", async () => {
    vi.stubGlobal("WebSocket", ControlledBackpackSocket);

    const firstClient = acceptSocket(
      await SELF.fetch("https://example.com/price-feeds", webSocketHeaders())
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    await closeSocket(firstClient);

    const reconnectingClient = acceptSocket(
      await SELF.fetch("https://example.com/price-feeds", webSocketHeaders())
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    const laterClient = acceptSocket(
      await SELF.fetch("https://example.com/price-feeds", webSocketHeaders())
    );
    await expect(nextSocketMessage(laterClient)).resolves.toEqual(
      expect.objectContaining({
        method: "priceFeeds.snapshot",
        params: expect.objectContaining({
          prices: expect.arrayContaining([
            expect.objectContaining({
              oracleBase: "SOL",
              lastPriceUsd: "142.37",
              updatedAt: 1_694_687_692_980,
            }),
          ]),
        }),
      })
    );
    await closeSocket(reconnectingClient);
    await closeSocket(laterClient);
  });

  it("returns 504 when the requested market price does not arrive", async () => {
    vi.stubGlobal("WebSocket", SilentBackpackSocket);

    const response = await SELF.fetch(
      "https://example.com/markets/GJiEFYsYKdX39hkhSs9WLF8AfGgXRjEtegGj3UrHbpXW/series"
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error:
        "Timed out waiting for a price for market GJiEFYsYKdX39hkhSs9WLF8AfGgXRjEtegGj3UrHbpXW.",
    });
  }, 10_000);

  it("returns 503 when the price feed fails", async () => {
    vi.stubGlobal("WebSocket", FailingBackpackSocket);

    const response = await SELF.fetch(
      "https://example.com/markets/6gL1TzV6e4QSffGJdvM7hCoVfe1nTZiB68QPD9ye6NDW/series"
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Price feed is unavailable.",
    });
  });

  it("returns 503 when the price feed cannot be constructed", async () => {
    vi.stubGlobal("WebSocket", ThrowingBackpackSocket);

    const response = await SELF.fetch(
      "https://example.com/markets/6gL1TzV6e4QSffGJdvM7hCoVfe1nTZiB68QPD9ye6NDW/series"
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Price feed is unavailable.",
    });
  });
});

class ControlledBackpackSocket extends EventTarget {
  private closed = false;

  constructor() {
    super();
    setTimeout(() => this.open(), 200);
  }

  close(): void {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }

  private open(): void {
    if (this.closed) return;
    this.dispatchEvent(new Event("open"));
  }

  send(message: string): void {
    const request: unknown = JSON.parse(message);
    if (this.closed || !isRecord(request) || request.method !== "SUBSCRIBE") {
      return;
    }
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          stream: "ticker.SOL_USDC",
          data: {
            e: "ticker",
            s: "SOL_USDC",
            c: "142.37",
            E: 1_694_687_692_980_000,
          },
        }),
      })
    );
  }
}

class SilentBackpackSocket extends EventTarget {
  constructor() {
    super();
    setTimeout(() => this.dispatchEvent(new Event("open")), 0);
  }

  close(): void {
    this.dispatchEvent(new Event("close"));
  }

  send(): void {
    // The upstream remains connected but has no tick for the requested market.
  }
}

class FailingBackpackSocket extends EventTarget {
  constructor() {
    super();
    setTimeout(() => this.dispatchEvent(new Event("error")), 0);
  }

  close(): void {
    this.dispatchEvent(new Event("close"));
  }

  send(): void {
    // The upstream fails before it can receive a subscription request.
  }
}

class ThrowingBackpackSocket {
  constructor() {
    throw new Error("Unable to create WebSocket.");
  }
}

function acceptSocket(response: Response): WebSocket {
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).not.toBeNull();
  if (socket === null) throw new Error("WebSocket upgrade failed.");
  socket.accept();
  return socket;
}

async function closeSocket(socket: WebSocket): Promise<void> {
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nextSocketMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      resolve(JSON.parse(String(event.data)));
    });
  });
}

function webSocketHeaders(): RequestInit {
  return {
    headers: {
      Connection: "Upgrade",
      Origin: "http://localhost:5173",
      Upgrade: "websocket",
    },
  };
}
