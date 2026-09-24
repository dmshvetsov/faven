import type { ApiMarket, ApiSeries, ApiSeriesItem } from "./rfq-server-api";

export type AssetKind = "crypto" | "stock";
export type Direction = "buyLower" | "sellHigher";
export type SeriesSide = "call" | "put";

export type MarketChoice = {
  readonly marketAddress: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly baseTokenSymbol: string;
  readonly quoteTokenSymbol: string;
  readonly assetKind: AssetKind;
  readonly icon: string;
  readonly price: string;
  readonly quantityDecimals: number;
  readonly quoteTokenDecimals: number;
  readonly quantity: QuantityTerms;
};

export type QuantityTerms = {
  readonly minimum: bigint;
  readonly step: bigint;
  readonly maximum: bigint;
};

export type SeriesTerm = {
  readonly expiryUnixMs: number;
  readonly strike: bigint;
};

export type SelectedTerms = {
  readonly strike: bigint;
  readonly expiryUnixMs: number;
};

export function toMarketChoices(
  markets: readonly ApiMarket[]
): readonly MarketChoice[] {
  return markets.map((market) => ({
    marketAddress: market.marketAddress,
    baseMint: market.baseMint,
    quoteMint: market.quoteMint,
    baseTokenSymbol: market.baseTokenSymbol,
    quoteTokenSymbol: market.quoteTokenSymbol,
    assetKind:
      market.baseMintCategory === "tokenized_stocks" ? "stock" : "crypto",
    icon: iconFor(market.baseMintCategory, market.baseTokenSymbol),
    price: market.price,
    quantityDecimals: market.quantityDecimals,
    quoteTokenDecimals: market.quoteMintDecimals,
    quantity: {
      minimum: BigInt(market.quantity.minimum),
      step: BigInt(market.quantity.step),
      maximum: BigInt(market.quantity.maximum),
    },
  }));
}

export function firstMarketForKind(
  choices: readonly MarketChoice[],
  assetKind: AssetKind
): MarketChoice | null {
  return choices.find((choice) => choice.assetKind === assetKind) ?? null;
}

export function initialMarket(
  choices: readonly MarketChoice[]
): MarketChoice | null {
  return firstMarketForKind(choices, "stock") ?? choices[0] ?? null;
}

export function sideForDirection(direction: Direction): SeriesSide {
  return direction === "buyLower" ? "put" : "call";
}

export function termsForDirection(
  series: ApiSeries,
  direction: Direction
): readonly SeriesTerm[] {
  return series[sideForDirection(direction)].map(toTerm);
}

export function uniqueStrikes(
  series: ApiSeries,
  direction: Direction
): readonly bigint[] {
  const strikes = new Set(
    termsForDirection(series, direction).map((term) => term.strike)
  );
  return [...strikes].sort(compareBigInt);
}

export function availableExpiries(
  series: ApiSeries,
  direction: Direction,
  strike: bigint
): readonly number[] {
  return [
    ...new Set(
      termsForDirection(series, direction)
        .filter((term) => term.strike === strike)
        .map((term) => term.expiryUnixMs)
    ),
  ].sort((left, right) => left - right);
}

export function defaultTerms(
  series: ApiSeries,
  direction: Direction
): SelectedTerms | null {
  const strikes = uniqueStrikes(series, direction);
  const strike = direction === "buyLower" ? strikes.at(-1) : strikes[0];
  if (strike === undefined) return null;
  const expiryUnixMs = availableExpiries(series, direction, strike)[0];
  return expiryUnixMs === undefined ? null : { strike, expiryUnixMs };
}

export function isTermAvailable(
  series: ApiSeries,
  direction: Direction,
  terms: SelectedTerms
): boolean {
  return termsForDirection(series, direction).some(
    (term) =>
      term.strike === terms.strike && term.expiryUnixMs === terms.expiryUnixMs
  );
}

export function isQuantityValid(
  quantity: bigint,
  terms: QuantityTerms
): boolean {
  return (
    quantity >= terms.minimum &&
    quantity <= terms.maximum &&
    (quantity - terms.minimum) % terms.step === 0n
  );
}

export function defaultQuantity(terms: QuantityTerms): bigint {
  const spread = terms.maximum - terms.minimum;
  const increment = ceilDivide(spread, 4n * terms.step) * terms.step;
  return terms.minimum + increment;
}

export function formatExpiryUtc(expiryUnixMs: number): string {
  const date = new Date(expiryUnixMs);
  const month = date
    .toLocaleString("en-US", { month: "short", timeZone: "UTC" })
    .toUpperCase();
  return `${month} ${date.getUTCDate().toString().padStart(2, "0")}`;
}

export function formatUsdE8(value: bigint): string {
  return formatFixedPoint(value, 8, { grouping: true, prefix: "$" });
}

export function formatQuantity(value: bigint, decimals: number): string {
  return formatFixedPoint(value, decimals, { grouping: false, prefix: "" });
}

function toTerm(item: ApiSeriesItem): SeriesTerm {
  return {
    expiryUnixMs: item.expiryUnixMs,
    strike: BigInt(item.strikePriceDecimals),
  };
}

function iconFor(
  category: ApiMarket["baseMintCategory"],
  symbol: string
): string {
  if (symbol.toUpperCase() === "SPCX") return "/assets/spacex.svg";
  if (category === "tokenized_stocks") return "/assets/apple.svg";
  switch (symbol.toUpperCase()) {
    case "BTC":
      return "/assets/bitcoin.svg";
    case "ETH":
      return "/assets/ethereum.svg";
    case "SOL":
      return "/assets/solana.svg";
    case "PUMP":
      return "/assets/pump-fun.svg";
    default:
      return "/assets/solana.svg";
  }
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatFixedPoint(
  value: bigint,
  decimals: number,
  options: { readonly grouping: boolean; readonly prefix: string }
): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  const wholeText = options.grouping
    ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : whole.toString();
  return `${options.prefix}${wholeText}${fraction ? `.${fraction}` : ""}`;
}
