import type { MarketConfig, SolanaCluster } from "./config";
import { parseUnsignedInteger } from "./format";
import type { RfqTerms } from "./rfq-book";

export function validateRfqTerms(
  terms: RfqTerms,
  market: MarketConfig,
  cluster: SolanaCluster
): void {
  if (
    terms.asset !== market.baseCoinMint ||
    terms.assetName !== market.oracleBase ||
    terms.premiumAsset !== market.quoteCoinMint
  ) {
    throw new Error("RFQ does not match the configured market.");
  }
  if (terms.chainId !== `solana:${cluster}`) {
    throw new Error("RFQ uses the wrong Solana cluster.");
  }
  const expectedCollateral = terms.isPut
    ? market.quoteCoinMint
    : market.baseCoinMint;
  if (terms.collateralAsset !== expectedCollateral) {
    throw new Error("RFQ collateral asset does not match the option type.");
  }
  const quantity = parseUnsignedInteger(terms.quantity, "RFQ quantity");
  if (
    quantity < market.quantity.minimum ||
    quantity > market.quantity.maximum
  ) {
    throw new Error("RFQ quantity is outside the configured range.");
  }
  if ((quantity - market.quantity.minimum) % market.quantity.step !== 0n) {
    throw new Error("RFQ quantity does not use the configured quantity step.");
  }
  if (parseUnsignedInteger(terms.strike, "RFQ strike") === 0n) {
    throw new Error("RFQ strike must be greater than zero.");
  }
  if (!Number.isSafeInteger(terms.expiry) || terms.expiry <= 0) {
    throw new Error("RFQ expiry must be a Unix-second timestamp.");
  }
}
