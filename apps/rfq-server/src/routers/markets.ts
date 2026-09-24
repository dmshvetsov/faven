import { Hono, type Context } from "hono";

import {
  configuredMarketByAddress,
  getEnvironmentConfig,
  type MarketConfig,
} from "../config";
import { generateUnderwritingSeries } from "../underwriting-series";
import type { Env } from "../worker";

export const marketsRouter = new Hono<{ Bindings: Env }>();

marketsRouter.get("/", async (context) => {
  const config = getEnvironmentConfig(context.env.PRODUCT_ENVIRONMENT);
  const marketsWithPrices = await Promise.all(
    config.markets.map(async (market) => ({
      market,
      price: await observedPriceForMarket(context, market.marketAddress),
    }))
  );
  const markets: Market[] = [];
  for (const { market, price } of marketsWithPrices) {
    if (price.status !== "available") {
      return priceErrorResponse(context, market.marketAddress, price.status);
    }
    markets.push(publicMarket(market, price.lastPriceUsd));
  }
  return marketJson(context, { markets });
});

marketsRouter.get("/:marketAddress/series", async (context) => {
  const marketAddress = context.req.param("marketAddress");
  const market = configuredMarketByAddress(
    context.env.PRODUCT_ENVIRONMENT,
    marketAddress
  );
  if (market === null)
    return marketJson(context, { error: "RFQ market not found." }, 404);

  const price = await observedPriceForMarket(context, marketAddress);
  if (price.status !== "available") {
    return priceErrorResponse(context, marketAddress, price.status);
  }
  return marketJson(context, {
    market: publicMarket(market, price.lastPriceUsd),
    series: generateUnderwritingSeries({
      nowMs: Date.now(),
      priceUpdatedAt: price.updatedAt,
      spotPriceUsd: price.lastPriceUsd,
    }),
  });
});

export interface Market {
  readonly marketAddress: string;
  readonly baseTokenSymbol: string;
  readonly quoteTokenSymbol: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly optionsProgramId: string;
  readonly baseTokenProgram: string;
  readonly quoteTokenProgram: string;
  readonly baseMintDecimals: number;
  readonly quoteMintDecimals: number;
  readonly quantityDecimals: 18;
  readonly baseMintCategory: "crypto" | "tokenized_stocks";
  readonly quantity: {
    readonly minimum: string;
    readonly step: string;
    readonly maximum: string;
  };
  readonly lastPrice: string;
}

export function publicMarket(market: MarketConfig, lastPrice: string): Market {
  return {
    marketAddress: market.marketAddress,
    baseTokenSymbol: market.baseTokenSymbol,
    quoteTokenSymbol: market.quoteTokenSymbol,
    baseMint: market.baseMint,
    quoteMint: market.quoteMint,
    optionsProgramId: market.optionsProgramId,
    baseTokenProgram: market.baseTokenProgram,
    quoteTokenProgram: market.quoteTokenProgram,
    baseMintDecimals: market.baseMintDecimals,
    quoteMintDecimals: market.quoteMintDecimals,
    quantityDecimals: 18,
    baseMintCategory: market.baseMintCategory,
    quantity: {
      minimum: market.quantity.minimum.toString(),
      step: market.quantity.step.toString(),
      maximum: market.quantity.maximum.toString(),
    },
    lastPrice,
  };
}

type ObservedPriceResult =
  | {
      readonly status: "available";
      readonly lastPriceUsd: string;
      readonly updatedAt: number;
    }
  | { readonly status: "timed-out" | "unavailable" };

async function observedPriceForMarket(
  context: Context<{ Bindings: Env }>,
  marketAddress: string
): Promise<ObservedPriceResult> {
  const priceResponse = await context.env.PRICE_HUB.get(
    context.env.PRICE_HUB.idFromName(
      `backpack-prices:${context.env.PRODUCT_ENVIRONMENT}`
    )
  ).fetch(
    new Request(
      `https://price-hub/prices/${encodeURIComponent(marketAddress)}`,
      { signal: context.req.raw.signal }
    )
  );
  if (priceResponse.status === 504) return { status: "timed-out" };
  if (!priceResponse.ok) return { status: "unavailable" };

  const price: unknown = await priceResponse.json();
  if (!isObservedPrice(price)) return { status: "unavailable" };
  return { status: "available", ...price };
}

function priceErrorResponse(
  context: Context<{ Bindings: Env }>,
  marketAddress: string,
  status: "timed-out" | "unavailable"
): Response {
  if (status === "timed-out") {
    return marketJson(
      context,
      { error: `Timed out waiting for a price for market ${marketAddress}.` },
      504
    );
  }
  return marketJson(context, { error: "Price feed is unavailable." }, 503);
}

function isObservedPrice(
  value: unknown
): value is { readonly lastPriceUsd: string; readonly updatedAt: number } {
  if (!isRecord(value)) return false;
  return (
    typeof value.lastPriceUsd === "string" &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function marketJson(
  context: Context<{ Bindings: Env }>,
  body: Record<string, unknown>,
  status = 200
): Response {
  const response = Response.json(body, { status });
  const origin = context.req.header("Origin");
  const config = getEnvironmentConfig(context.env.PRODUCT_ENVIRONMENT);
  if (origin !== undefined && config.allowedOrigins.includes(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
  }
  response.headers.set("Vary", "Origin");
  return response;
}
