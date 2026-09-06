export function baseUnits(wholeTokens: bigint, decimals: number): bigint {
  return wholeTokens * 10n ** BigInt(decimals);
}
