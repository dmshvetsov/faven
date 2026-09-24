const PRICE_SCALE = 100_000_000n;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;
const SERIES_PER_SIDE = 6;

export interface SeriesItem {
  readonly expiryUnixMs: number;
  readonly strikePriceDecimals: string;
  readonly updateAt: number;
}

export interface UnderwritingSeries {
  readonly call: readonly SeriesItem[];
  readonly put: readonly SeriesItem[];
}

export function generateUnderwritingSeries(input: {
  readonly nowMs: number;
  readonly priceUpdatedAt: number;
  readonly spotPriceUsd: string;
}): UnderwritingSeries {
  const spotPrice = priceToE8(input.spotPriceUsd);
  const strikeStep = strikeStepFor(spotPrice);
  const atmStrike = roundHalfUp(spotPrice, strikeStep) * strikeStep;
  const expiries = underwritingExpiries(input.nowMs);
  const calls = Array.from(
    { length: SERIES_PER_SIDE },
    (_, index) => atmStrike + strikeStep * BigInt(index + 1)
  );
  const puts = Array.from(
    { length: SERIES_PER_SIDE },
    (_, index) => atmStrike - strikeStep * BigInt(index + 1)
  )
    .filter((strike) => strike > 0n)
    .sort(compareBigInt);

  return {
    call: seriesItems(expiries, calls, input.priceUpdatedAt),
    put: seriesItems(expiries, puts, input.priceUpdatedAt),
  };
}

function seriesItems(
  expiries: readonly number[],
  strikes: readonly bigint[],
  updateAt: number
): readonly SeriesItem[] {
  return expiries.flatMap((expiryUnixMs) =>
    strikes.map((strikePrice) => ({
      expiryUnixMs,
      strikePriceDecimals: strikePrice.toString(),
      updateAt,
    }))
  );
}

function underwritingExpiries(nowMs: number): readonly number[] {
  const now = new Date(nowMs);
  const tomorrow = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    8
  );
  const thisFriday = fridayAtUtc(nowMs, 0);
  const nextFriday = fridayAtUtc(nowMs, 7);
  const lastFridayThisMonth = lastFridayAtUtc(
    now.getUTCFullYear(),
    now.getUTCMonth()
  );
  const lastFridayNextMonth = lastFridayAtUtc(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1
  );
  return [
    ...new Set([
      tomorrow,
      thisFriday,
      nextFriday,
      lastFridayThisMonth,
      lastFridayNextMonth,
    ]),
  ]
    .filter((expiry) => expiry > nowMs + EIGHT_HOURS_MS)
    .sort((left, right) => left - right);
}

function fridayAtUtc(nowMs: number, additionalDays: number): number {
  const now = new Date(nowMs);
  const daysUntilFriday = (5 - now.getUTCDay() + 7) % 7;
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysUntilFriday + additionalDays,
    8
  );
}

function lastFridayAtUtc(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0, 8));
  const daysSinceFriday = (lastDay.getUTCDay() - 5 + 7) % 7;
  return Date.UTC(year, month + 1, -daysSinceFriday, 8);
}

function strikeStepFor(spotPrice: bigint): bigint {
  if (spotPrice <= 25_000_000n) return 1_000_000n;
  if (spotPrice <= 200_000_000n) return 5_000_000n;
  if (spotPrice <= 1_000_000_000n) return 20_000_000n;
  if (spotPrice <= 2_500_000_000n) return 250_000_000n;
  if (spotPrice <= 20_000_000_000n) return 500_000_000n;
  return 1_000_000_000n;
}

function priceToE8(value: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) throw new Error("Invalid USD price.");
  const whole = BigInt(match[1]);
  const fractional = match[2] ?? "";
  const scaledFraction = `${fractional.slice(0, 8).padEnd(8, "0")}`;
  const rounded = fractional.length > 8 && fractional[8] >= "5" ? 1n : 0n;
  return whole * PRICE_SCALE + BigInt(scaledFraction) + rounded;
}

function roundHalfUp(value: bigint, interval: bigint): bigint {
  const lower = value / interval;
  const remainder = value % interval;
  return remainder * 2n >= interval ? lower + 1n : lower;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
