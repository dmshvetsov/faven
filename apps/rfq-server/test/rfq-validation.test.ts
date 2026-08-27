import { describe, expect, it } from "vitest";

import type { MarketConfig } from "../src/config";
import { validateRfqTerms } from "../src/rfq-validation";

const market: MarketConfig = {
  optionsProgramId: "options-program",
  marketAddress: "market-address",
  oracleBase: "BTC",
  baseCoinMint: "base-mint",
  quoteCoinMint: "quote-mint",
  baseCoinSymbol: "WBTC",
  quoteCoinSymbol: "USDC",
  feeRecipient: "fee-recipient",
  operationalFeeBps: 50,
  quantity: { minimum: 10n, step: 10n, maximum: 100n },
};

const terms = {
  asset: "base-mint",
  assetName: "BTC",
  chainId: "solana:testnet",
  expiry: 1_735_689_600,
  isPut: false,
  quantity: "20",
  strike: "6000000000000",
  collateralAsset: "base-mint",
  premiumAsset: "quote-mint",
  requestDeadline: 1_735_600_040_000,
  underwriteTx: "transaction",
};

describe("RFQ terms validation", () => {
  it("accepts configured market terms and the configured quantity step", () => {
    expect(() => validateRfqTerms(terms, market, "testnet")).not.toThrow();
  });

  it("rejects an unknown asset and an off-step quantity", () => {
    expect(() =>
      validateRfqTerms({ ...terms, asset: "unknown" }, market, "testnet")
    ).toThrow("configured market");
    expect(() =>
      validateRfqTerms({ ...terms, quantity: "21" }, market, "testnet")
    ).toThrow("quantity step");
  });
});
