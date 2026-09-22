import { getEnvironmentConfig, type ProductEnvironment } from "./config";

export const BACKPACK_TICKER_BY_ORACLE_BASE: Readonly<Record<string, string>> =
  {
    SOL: "SOL_USDC",
    PUMP: "PUMP_USDC",
    SPCXX: "SPCX.US_USDC",
  };

export interface ObservedPrice {
  readonly lastPriceUsd: string;
  readonly updatedAt: number;
}

export interface PriceFeedSnapshot {
  readonly jsonrpc: "2.0";
  readonly method: "priceFeeds.snapshot";
  readonly params: {
    readonly prices: readonly {
      readonly oracleBase: string;
      readonly marketAddress: string;
      readonly lastPriceUsd: string | null;
      readonly updatedAt: number | null;
    }[];
  };
}

export function backpackTickerForOracleBase(oracleBase: string): string | null {
  return BACKPACK_TICKER_BY_ORACLE_BASE[oracleBase] ?? null;
}

export function createPriceFeedsSnapshot(
  environment: ProductEnvironment,
  observedPrices: ReadonlyMap<string, ObservedPrice> = new Map()
): PriceFeedSnapshot {
  return {
    jsonrpc: "2.0",
    method: "priceFeeds.snapshot",
    params: {
      prices: getEnvironmentConfig(environment).markets.map((market) => {
        const ticker = backpackTickerForOracleBase(market.oracleBase);
        const price = ticker === null ? undefined : observedPrices.get(ticker);
        return {
          oracleBase: market.oracleBase,
          marketAddress: market.marketAddress,
          lastPriceUsd: price?.lastPriceUsd ?? null,
          updatedAt: price?.updatedAt ?? null,
        };
      }),
    },
  };
}

export function configuredBackpackTickers(
  environment: ProductEnvironment
): readonly string[] {
  const tickers = new Set<string>();
  for (const market of getEnvironmentConfig(environment).markets) {
    const ticker = backpackTickerForOracleBase(market.oracleBase);
    if (ticker !== null) tickers.add(ticker);
  }
  return [...tickers];
}

export function priceFromBackpackTickerEnvelope(
  message: unknown,
  configuredTickers: ReadonlySet<string>
): { readonly ticker: string; readonly price: ObservedPrice } | null {
  if (!isRecord(message) || !isRecord(message.data)) return null;
  if (typeof message.stream !== "string") return null;
  const ticker = message.stream.startsWith("ticker.")
    ? message.stream.slice("ticker.".length)
    : null;
  if (ticker === null || !configuredTickers.has(ticker)) return null;
  if (
    message.data.e !== "ticker" ||
    message.data.s !== ticker ||
    typeof message.data.c !== "string" ||
    typeof message.data.E !== "number"
  ) {
    return null;
  }
  if (!Number.isFinite(message.data.E)) return null;
  return {
    ticker,
    price: {
      lastPriceUsd: message.data.c,
      updatedAt: Math.trunc(message.data.E / 1_000),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
