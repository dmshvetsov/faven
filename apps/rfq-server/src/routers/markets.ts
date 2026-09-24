import { Hono, type Context } from "hono";

import {
  configuredMarketByAddress,
  getEnvironmentConfig,
  type MarketConfig,
} from "../config";
import { generateUnderwritingSeries } from "../underwriting-series";
import type { Env } from "../worker";

export const marketsRouter = new Hono<{ Bindings: Env }>();

marketsRouter.get("/", (context) => {
  const config = getEnvironmentConfig(context.env.PRODUCT_ENVIRONMENT);
  const response = context.json({
    markets: config.markets.map(publicMarket),
  });
  const origin = context.req.header("Origin");
  if (origin !== undefined && config.allowedOrigins.includes(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
  }
  response.headers.set("Vary", "Origin");
  return response;
});

marketsRouter.get("/:marketAddress/series", async (context) => {
  const marketAddress = context.req.param("marketAddress");
  const market = configuredMarketByAddress(
    context.env.PRODUCT_ENVIRONMENT,
    marketAddress
  );
  if (market === null)
    return marketJson(context, { error: "RFQ market not found." }, 404);

  const priceResponse = await context.env.PRICE_HUB.get(
    context.env.PRICE_HUB.idFromName("all-backpack-prices")
  ).fetch(
    new Request(
      `https://price-hub/prices/${encodeURIComponent(marketAddress)}`,
      {
        signal: context.req.raw.signal,
      }
    )
  );
  if (priceResponse.status === 504) {
    return marketJson(
      context,
      { error: `Timed out waiting for a price for market ${marketAddress}.` },
      504
    );
  }
  if (!priceResponse.ok) {
    return marketJson(context, { error: "Price feed is unavailable." }, 503);
  }
  const price: unknown = await priceResponse.json();
  if (!isObservedPrice(price)) {
    return marketJson(context, { error: "Price feed is unavailable." }, 503);
  }
  return marketJson(context, {
    market: publicMarket(market),
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
  readonly baseMintCategory: "crypto" | "tokenized_stocks";
  readonly quantity: {
    readonly minimum: string;
    readonly step: string;
    readonly maximum: string;
  };
  readonly price: string;
}

export function publicMarket(market: MarketConfig): Market {
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
    baseMintCategory: market.baseMintCategory,
    quantity: {
      minimum: market.quantity.minimum.toString(),
      step: market.quantity.step.toString(),
      maximum: market.quantity.maximum.toString(),
    },
    price: "0",
  };
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
