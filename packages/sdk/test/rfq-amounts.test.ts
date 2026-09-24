import { describe, expect, it } from "vitest";

import {
  calculateTotalPremiumE18,
  isUnsignedDecimalInteger,
} from "../src/index.js";

describe("RFQ amounts", () => {
  it("calculates total premium from e18 values", () => {
    expect(
      calculateTotalPremiumE18({
        premiumE18: "2500000000000000000",
        quantityE18: "3200000000000000000",
      })
    ).toBe("8000000000000000000");
  });

  it("accepts only unsigned decimal integer strings", () => {
    expect(isUnsignedDecimalInteger("0")).toBe(true);
    expect(isUnsignedDecimalInteger("001")).toBe(false);
    expect(isUnsignedDecimalInteger("1.25")).toBe(false);
    expect(isUnsignedDecimalInteger("-1")).toBe(false);
  });

  it("rejects invalid fixed-point inputs", () => {
    expect(() =>
      calculateTotalPremiumE18({ premiumE18: "2.5", quantityE18: "1" })
    ).toThrow("invalid_premium_e18");
  });
});
