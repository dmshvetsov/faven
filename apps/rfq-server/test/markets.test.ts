import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/worker";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const OPTIONS_PROGRAM = "FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const E18_QUANTITY = {
  minimum: "1000000000000000000",
  step: "1000000000000000000",
  maximum: "100000000000000000000",
};

const localMarkets = [
  {
    marketAddress: "99rh3FNKgvuWigwrsaDLMSD9cX8XWkFAdTdHqLkW3BCC",
    baseTokenSymbol: "wSOL",
    quoteTokenSymbol: "USDC",
    baseMint: "So11111111111111111111111111111111111111112",
    quoteMint: USDC_MINT,
    optionsProgramId: OPTIONS_PROGRAM,
    baseTokenProgram: TOKEN_PROGRAM,
    quoteTokenProgram: TOKEN_PROGRAM,
    baseMintDecimals: 9,
    quoteMintDecimals: 6,
    baseMintCategory: "crypto",
    quantity: E18_QUANTITY,
    price: "0",
  },
  {
    marketAddress: "GJiEFYsYKdX39hkhSs9WLF8AfGgXRjEtegGj3UrHbpXW",
    baseTokenSymbol: "PUMP",
    quoteTokenSymbol: "USDC",
    baseMint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
    quoteMint: USDC_MINT,
    optionsProgramId: OPTIONS_PROGRAM,
    baseTokenProgram: TOKEN_2022_PROGRAM,
    quoteTokenProgram: TOKEN_PROGRAM,
    baseMintDecimals: 6,
    quoteMintDecimals: 6,
    baseMintCategory: "crypto",
    quantity: E18_QUANTITY,
    price: "0",
  },
  {
    marketAddress: "6gL1TzV6e4QSffGJdvM7hCoVfe1nTZiB68QPD9ye6NDW",
    baseTokenSymbol: "SPCX",
    quoteTokenSymbol: "USDC",
    baseMint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
    quoteMint: USDC_MINT,
    optionsProgramId: OPTIONS_PROGRAM,
    baseTokenProgram: TOKEN_2022_PROGRAM,
    quoteTokenProgram: TOKEN_PROGRAM,
    baseMintDecimals: 6,
    quoteMintDecimals: 6,
    baseMintCategory: "tokenized_stocks",
    quantity: E18_QUANTITY,
    price: "0",
  },
];

const devnetMarkets = [
  {
    marketAddress: "CY7qdovcTnpA6qo3Mp1J9Zws2ZnSnM7uXLyEXWGY3EUo",
    baseTokenSymbol: "twSOL",
    quoteTokenSymbol: "tUSDC",
    baseMint: "wSoLCzXHe214cjx7CFjP1axzXyqLkEwq5Xf873hy1JP",
    quoteMint: "usdcHvyN6fvECJ1poPYkt1vztze1pQ6psC8i4cji2Ly",
    optionsProgramId: OPTIONS_PROGRAM,
    baseTokenProgram: TOKEN_PROGRAM,
    quoteTokenProgram: TOKEN_PROGRAM,
    baseMintDecimals: 9,
    quoteMintDecimals: 6,
    baseMintCategory: "crypto",
    quantity: E18_QUANTITY,
    price: "0",
  },
];

describe("market catalogue", () => {
  it("lists every local market with public catalogue fields", async () => {
    const response = await SELF.fetch("https://example.com/markets", {
      headers: { Origin: "http://localhost:5173" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173"
    );
    expect(response.headers.get("Vary")).toBe("Origin");
    await expect(response.json()).resolves.toEqual({ markets: localMarkets });
  });

  it.each([
    {
      environment: "stagingdevelopment:devnet",
      cluster: "devnet",
      origin: "https://beta.faven.markets",
      markets: devnetMarkets,
    },
    {
      environment: "staging:devnet",
      cluster: "devnet",
      origin: "https://beta.faven.markets",
      markets: devnetMarkets,
    },
    {
      environment: "production:mainnetbeta",
      cluster: "mainnet-beta",
      origin: "https://faven.markets",
      markets: [],
    },
  ] as const)(
    "allows $origin to read the $environment market catalogue",
    async ({ environment, cluster, origin, markets }) => {
      const response = await worker.fetch(
        new Request("https://example.com/markets", {
          headers: { Origin: origin },
        }),
        { ...env, PRODUCT_ENVIRONMENT: environment, SOLANA_CLUSTER: cluster }
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(response.headers.get("Vary")).toBe("Origin");
      await expect(response.json()).resolves.toEqual({ markets });
    }
  );
});
