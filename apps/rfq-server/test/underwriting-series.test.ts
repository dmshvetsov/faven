import { describe, expect, it } from "vitest";

import { generateUnderwritingSeries } from "../src/underwriting-series";

describe("underwriting series generation", () => {
  it("offers sorted call and positive put strikes for every eligible expiry", () => {
    expect(
      generateUnderwritingSeries({
        nowMs: Date.UTC(2025, 0, 30),
        priceUpdatedAt: 1_735_689_600_000,
        spotPriceUsd: "12.50",
      })
    ).toEqual({
      call: [
        {
          expiryUnixMs: Date.UTC(2025, 0, 31, 8),
          strikePriceDecimals: "1500000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 0, 31, 8),
          strikePriceDecimals: "1750000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 0, 31, 8),
          strikePriceDecimals: "2000000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 0, 31, 8),
          strikePriceDecimals: "2250000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 0, 31, 8),
          strikePriceDecimals: "2500000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 0, 31, 8),
          strikePriceDecimals: "2750000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 7, 8),
          strikePriceDecimals: "1500000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 7, 8),
          strikePriceDecimals: "1750000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 7, 8),
          strikePriceDecimals: "2000000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 7, 8),
          strikePriceDecimals: "2250000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 7, 8),
          strikePriceDecimals: "2500000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 7, 8),
          strikePriceDecimals: "2750000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 28, 8),
          strikePriceDecimals: "1500000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 28, 8),
          strikePriceDecimals: "1750000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 28, 8),
          strikePriceDecimals: "2000000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 28, 8),
          strikePriceDecimals: "2250000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 28, 8),
          strikePriceDecimals: "2500000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 28, 8),
          strikePriceDecimals: "2750000000",
          updateAt: 1_735_689_600_000,
        },
      ],
      put: [
        {
          expiryUnixMs: Date.UTC(2025, 0, 31, 8),
          strikePriceDecimals: "250000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 0, 31, 8),
          strikePriceDecimals: "500000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 0, 31, 8),
          strikePriceDecimals: "750000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 0, 31, 8),
          strikePriceDecimals: "1000000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 7, 8),
          strikePriceDecimals: "250000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 7, 8),
          strikePriceDecimals: "500000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 7, 8),
          strikePriceDecimals: "750000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 7, 8),
          strikePriceDecimals: "1000000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 28, 8),
          strikePriceDecimals: "250000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 28, 8),
          strikePriceDecimals: "500000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 28, 8),
          strikePriceDecimals: "750000000",
          updateAt: 1_735_689_600_000,
        },
        {
          expiryUnixMs: Date.UTC(2025, 1, 28, 8),
          strikePriceDecimals: "1000000000",
          updateAt: 1_735_689_600_000,
        },
      ],
    });
  });

  it("uses the prescribed price intervals and removes an expiry exactly eight hours away", () => {
    const input = {
      nowMs: Date.UTC(2025, 0, 31),
      priceUpdatedAt: 1_735_689_600_000,
    };

    expect(
      ["0.125", "0.26", "2.01", "10.01", "25.01", "200.01"].map(
        (spotPriceUsd) =>
          generateUnderwritingSeries({ ...input, spotPriceUsd }).call[0]
            ?.strikePriceDecimals
      )
    ).toEqual([
      "14000000",
      "30000000",
      "220000000",
      "1250000000",
      "3000000000",
      "21000000000",
    ]);
    expect(
      generateUnderwritingSeries({ ...input, spotPriceUsd: "0.125" })
        .call.map((item) => item.expiryUnixMs)
        .filter((expiry, index, all) => all.indexOf(expiry) === index)
    ).toEqual([
      Date.UTC(2025, 1, 1, 8),
      Date.UTC(2025, 1, 7, 8),
      Date.UTC(2025, 1, 28, 8),
    ]);
  });
});
