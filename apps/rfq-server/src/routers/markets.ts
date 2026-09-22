import { Hono } from "hono";

import { getEnvironmentConfig } from "../config";
import type { Env } from "../worker";

export const marketsRouter = new Hono<{ Bindings: Env }>();

marketsRouter.get("/", (context) => {
  const config = getEnvironmentConfig(context.env.PRODUCT_ENVIRONMENT);
  const response = context.json({
    markets: config.markets.map((market) => ({
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
    })),
  });
  const origin = context.req.header("Origin");
  if (origin !== undefined && config.allowedOrigins.includes(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
  }
  response.headers.set("Vary", "Origin");
  return response;
});
