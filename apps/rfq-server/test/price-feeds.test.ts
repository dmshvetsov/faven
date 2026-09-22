import { describe, expect, it } from "vitest";

import { getEnvironmentConfig, type ProductEnvironment } from "../src/config";
import {
  backpackTickerForOracleBase,
  priceFromBackpackTickerEnvelope,
} from "../src/price-feeds";

const PRODUCT_ENVIRONMENTS: readonly ProductEnvironment[] = [
  "development:localhost",
  "stagingdevelopment:devnet",
  "staging:devnet",
  "production:mainnetbeta",
];

describe("Backpack price feeds", () => {
  it("maps every configured Faven market in every environment", () => {
    for (const environment of PRODUCT_ENVIRONMENTS) {
      for (const market of getEnvironmentConfig(environment).markets) {
        expect(backpackTickerForOracleBase(market.oracleBase)).not.toBeNull();
      }
    }
  });

  it("reads a configured ticker update from a Backpack stream envelope", () => {
    expect(
      priceFromBackpackTickerEnvelope(
        {
          stream: "ticker.SOL_USDC",
          data: { c: "142.37", E: 1_694_687_692_980_000 },
        },
        new Set(["SOL_USDC"])
      )
    ).toEqual({
      ticker: "SOL_USDC",
      price: { lastPriceUsd: "142.37", updatedAt: 1_694_687_692_980 },
    });
  });

  it("ignores malformed and unmapped Backpack updates", () => {
    const tickers = new Set(["SOL_USDC"]);

    expect(
      priceFromBackpackTickerEnvelope(
        { stream: "ticker.PUMP_USDC", data: { c: "0.004", E: 1_000_000 } },
        tickers
      )
    ).toBeNull();
    expect(
      priceFromBackpackTickerEnvelope({ stream: "ticker.SOL_USDC" }, tickers)
    ).toBeNull();
  });
});
