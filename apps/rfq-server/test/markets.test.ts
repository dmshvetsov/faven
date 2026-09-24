import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
  price: expect.any(String),
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
    ["stagingdevelopment:devnet", "devnet"],
    ["staging:devnet", "devnet"],
    ["production:mainnetbeta", "mainnet-beta"],
  ] as const)(
    "selects the correct market catalogue for %s",
    async (environment, cluster) => {
      const response = await worker.fetch(
        new Request("https://example.com/markets"),
        { ...env, PRODUCT_ENVIRONMENT: environment, SOLANA_CLUSTER: cluster }
      );

      await expectMarketContract(
        response,
        environment === "production:mainnetbeta" ? 0 : 1
      );
    }
  );

  it.each([
    ["http://localhost:5173", "development:localhost", "localhost"],
    ["https://beta.faven.markets", "staging:devnet", "devnet"],
    ["https://faven.markets", "production:mainnetbeta", "mainnet-beta"],
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
});
