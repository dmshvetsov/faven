import { describe, expect, it } from "vitest";

import {
  formatFixedPoint,
  parseFixedPoint,
  tickerForSeries,
} from "../src/format";

describe("fixed-point values", () => {
  it("converts an exact decimal amount without using floating point", () => {
    expect(parseFixedPoint("12.34000001", 8)).toBe(1_234_000_001n);
    expect(formatFixedPoint(1_234_000_001n, 8)).toBe("12.34000001");
  });

  it("rejects values that cannot be represented at the requested scale", () => {
    expect(() => parseFixedPoint("1.001", 2)).toThrow(
      "more than 2 decimal places"
    );
  });
});

describe("canonical option ticker", () => {
  it("uses UTC expiry and removes redundant zeroes from the strike", () => {
    expect(
      tickerForSeries({
        oracleBase: "BTC",
        quoteCoinSymbol: "USDC",
        baseCoinSymbol: "WBTC",
        expirySeconds: 1_735_689_600,
        isPut: false,
        strike: 6_000_000_000_000n,
        strikeDecimals: 8,
      })
    ).toBe("BTC-USDC-WBTC-01JAN25-60000-C");
  });
});
