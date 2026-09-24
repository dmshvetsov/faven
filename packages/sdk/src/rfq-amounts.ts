export const PRICE_E8_SCALE = 100_000_000n;
export const CONTRACT_E18_SCALE = 1_000_000_000_000_000_000n;
export const PREMIUM_E18_SCALE = CONTRACT_E18_SCALE;

export function isUnsignedDecimalInteger(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value);
}

export function calculateTotalPremiumE18({
  premiumE18,
  quantityE18,
}: {
  readonly premiumE18: string;
  readonly quantityE18: string;
}): string {
  if (!isUnsignedDecimalInteger(premiumE18)) {
    throw new Error("invalid_premium_e18");
  }
  if (!isUnsignedDecimalInteger(quantityE18)) {
    throw new Error("invalid_quantity_e18");
  }

  return (
    (BigInt(premiumE18) * BigInt(quantityE18)) /
    PREMIUM_E18_SCALE
  ).toString();
}
