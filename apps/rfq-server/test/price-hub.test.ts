import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("Price hub", () => {
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
