import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEnvironmentConfig } from "../src/config";
import { isRecord } from "../src/rfq-rpc";
import worker from "../src/worker";

const publicMarket = expect.objectContaining({
  marketAddress: expect.any(String),
  baseTokenSymbol: expect.any(String),
  quoteTokenSymbol: expect.any(String),
  baseMint: expect.any(String),
  quoteMint: expect.any(String),
  optionsProgramId: expect.any(String),
  baseTokenProgram: expect.any(String),
  quoteTokenProgram: expect.any(String),
  baseMintDecimals: expect.any(Number),
  quoteMintDecimals: expect.any(Number),
  quantityDecimals: 18,
  baseMintCategory: expect.any(String),
  quantity: expect.objectContaining({
    minimum: expect.any(String),
    step: expect.any(String),
    maximum: expect.any(String),
  }),
  lastPrice: expect.any(String),
});

async function expectMarketContract(response: Response, marketCount: number) {
  expect(response.status).toBe(200);

  const body: unknown = await response.json();
  expect(body).toEqual({ markets: expect.any(Array) });
  if (!isRecord(body) || !Array.isArray(body.markets)) {
    throw new Error("invalid-markets-response");
  }
  expect(body.markets).toHaveLength(marketCount);
  for (const market of body.markets) {
    expect(market).toEqual(publicMarket);
    expect(market).toMatchObject({ lastPrice: "142.37" });
  }
}

describe("market catalogue", () => {
  it("returns three local markets with the public contract", async () => {
    const response = await SELF.fetch("https://example.com/markets", {
      headers: { Origin: "http://localhost:5173" },
    });

    await expectMarketContract(response, 3);
  });

  it.each([
    ["stagingdevelopment:devnet", "devnet", 1],
    ["staging:devnet", "devnet", 1],
    ["production:mainnetbeta", "mainnet-beta", 1],
  ] as const)(
    "selects the correct market catalogue for %s",
    (environment, cluster, marketCount) => {
      const config = getEnvironmentConfig(environment);
      expect(config.cluster).toBe(cluster);
      expect(config.markets).toHaveLength(marketCount);
    }
  );

  it.each([
    ["http://localhost:5173", "development:localhost", "localhost"],
    ["https://beta.faven.markets", "staging:devnet", "devnet"],
    ["https://faven.markets", "production:mainnetbeta", "mainnet-beta"],
    ["https://beta.faven.markets", "production:mainnetbeta", "mainnet-beta"],
  ] as const)("allows CORS for %s", async (origin, environment, cluster) => {
    const response = await worker.fetch(
      new Request("https://example.com/markets", {
        headers: { Origin: origin },
      }),
      { ...env, PRODUCT_ENVIRONMENT: environment, SOLANA_CLUSTER: cluster }
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("does not allow CORS for an untrusted origin", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/markets", {
        headers: { Origin: "https://untrusted.example" },
      }),
      {
        ...env,
        PRODUCT_ENVIRONMENT: "development:localhost",
        SOLANA_CLUSTER: "localhost",
      }
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("accepts a wallet-funding preflight from the local web app", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/wallet-fundings", {
        headers: {
          "Access-Control-Request-Headers": "content-type",
          "Access-Control-Request-Method": "POST",
          Origin: "http://localhost:5173",
        },
        method: "OPTIONS",
      }),
      {
        ...env,
        PRODUCT_ENVIRONMENT: "development:localhost",
        SOLANA_CLUSTER: "localhost",
      }
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173"
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST"
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "content-type"
    );
  });
});

beforeEach(() => vi.stubGlobal("WebSocket", MarketPricesSocket));

afterEach(() => vi.unstubAllGlobals());

class MarketPricesSocket extends EventTarget {
  constructor() {
    super();
    setTimeout(() => this.dispatchEvent(new Event("open")), 0);
  }

  close(): void {
    this.dispatchEvent(new Event("close"));
  }

  send(message: string): void {
    const request: unknown = JSON.parse(message);
    if (!isRecord(request) || !Array.isArray(request.params)) return;

    for (const subscription of request.params) {
      if (typeof subscription !== "string") continue;
      const ticker = subscription.replace(/^ticker\./, "");
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            stream: `ticker.${ticker}`,
            data: {
              e: "ticker",
              s: ticker,
              c: "142.37",
              E: 1_694_687_692_980_000,
            },
          }),
        })
      );
    }
  }
}
