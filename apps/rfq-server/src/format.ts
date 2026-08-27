const INTEGER_PATTERN = /^\d+$/;
const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export function parseFixedPoint(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("Fixed-point decimals must be a non-negative integer.");
  }

  const match = DECIMAL_PATTERN.exec(value);
  if (match === null) {
    throw new Error("Fixed-point value must be a non-negative decimal string.");
  }

  const integerPart = match[1];
  const fractionPart = match[2] ?? "";
  if (fractionPart.length > decimals) {
    throw new Error(
      `Fixed-point value has more than ${decimals} decimal places.`
    );
  }

  return BigInt(`${integerPart}${fractionPart.padEnd(decimals, "0")}`);
}

export function formatFixedPoint(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("Fixed-point decimals must be a non-negative integer.");
  }
  if (value < 0n) {
    throw new Error("Fixed-point value must not be negative.");
  }

  const raw = value.toString().padStart(decimals + 1, "0");
  if (decimals === 0) {
    return raw;
  }

  const integerPart = raw.slice(0, -decimals);
  const fractionPart = raw.slice(-decimals).replace(/0+$/, "");
  return fractionPart.length === 0
    ? integerPart
    : `${integerPart}.${fractionPart}`;
}

export interface TickerSeries {
  readonly oracleBase: string;
  readonly quoteCoinSymbol: string;
  readonly baseCoinSymbol: string;
  readonly expirySeconds: number;
  readonly isPut: boolean;
  readonly strike: bigint;
  readonly strikeDecimals: number;
}

export function tickerForSeries(series: TickerSeries): string {
  const expiry = new Date(series.expirySeconds * 1_000);
  if (
    !Number.isSafeInteger(series.expirySeconds) ||
    Number.isNaN(expiry.valueOf())
  ) {
    throw new Error("Expiry must be a valid Unix-second timestamp.");
  }

  const day = expiry.getUTCDate().toString().padStart(2, "0");
  const month = expiry
    .toLocaleString("en-US", { month: "short", timeZone: "UTC" })
    .toUpperCase();
  const year = expiry.getUTCFullYear().toString().slice(-2);
  const strike = formatFixedPoint(series.strike, series.strikeDecimals);

  return [
    series.oracleBase,
    series.quoteCoinSymbol,
    series.baseCoinSymbol,
    `${day}${month}${year}`,
    strike,
    series.isPut ? "P" : "C",
  ].join("-");
}

export function parseUnsignedInteger(value: string, label: string): bigint {
  if (!INTEGER_PATTERN.test(value)) {
    throw new Error(`${label} must be an unsigned integer string.`);
  }
  return BigInt(value);
}
