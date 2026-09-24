import { v7 as uuidv7 } from "uuid";

import { isUnsignedDecimalInteger } from "./rfq-amounts.js";

export const PREVIEW_SELLER_ADDRESS = "11111111111111111111111111111111";

export interface TakerRfqTerms {
  readonly market: string;
  /** Unix seconds. */
  readonly expiry: number;
  readonly isPut: boolean;
  /** Option contracts using 18 decimals. */
  readonly quantity: string;
  /** USD strike using 8 decimals. */
  readonly strike: string;
  readonly seller: string;
  readonly sellerCollateralSource: string;
  /** QuoteCoin premium destination for calls. */
  readonly sellerQuoteDestination?: string;
  readonly premiumAsset: string;
  readonly collateralAsset: string;
}

export interface ActiveTakerRfqTerms extends TakerRfqTerms {
  readonly rfqId: string;
}

export interface RfqCreateRequest {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: "rfq.create";
  readonly params: {
    readonly rfqId: string;
    readonly market: string;
    readonly expiry: number;
    readonly isPut: boolean;
    readonly quantity: string;
    readonly strike: string;
    readonly seller: string;
    readonly sellerCollateralSource: string;
    readonly sellerQuoteDestination?: string;
  };
}

export interface RfqCreateResponse {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result: {
    readonly rfqId: string;
    /** Unix milliseconds. */
    readonly requestDeadline: number;
  };
}

export interface UnderwriteSubmitRequest {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: "underwrite.submit";
  readonly params: {
    readonly rfqId: string;
    readonly underwriteTx: string;
  };
}

export interface UnderwriteSubmitResponse {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result: {
    readonly rfqId: string;
    readonly txSignature: string;
    readonly status: "queued";
  };
}

export interface BestQuote {
  readonly rfqId: string;
  readonly assetAddress: string;
  readonly chainId: string;
  /** Unix seconds. */
  readonly expiry: number;
  readonly isPut: boolean;
  readonly maker: string;
  readonly quantity: string;
  readonly strike: string;
  readonly premiumAsset: string;
  readonly collateralAsset: string;
  /** Unix seconds. */
  readonly validUntil: number;
  readonly premium: string;
  readonly underwriteTx: string;
}

export interface NoQuote {
  readonly rfqId: string;
  readonly noQuoteReason: "no_buyers";
}

export type QuoteBestNotification =
  | {
      readonly jsonrpc: "2.0";
      readonly method: "quote.best";
      readonly params: { readonly rfqId: string; readonly quote: BestQuote };
    }
  | {
      readonly jsonrpc: "2.0";
      readonly method: "quote.best";
      readonly params: NoQuote;
    };

export interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: string | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type TakerMessage =
  | RfqCreateResponse
  | UnderwriteSubmitResponse
  | QuoteBestNotification
  | JsonRpcError;

export function createRfqRequest(terms: TakerRfqTerms): RfqCreateRequest {
  if (!isUnsignedDecimalInteger(terms.quantity)) {
    throw new Error("invalid_quantity");
  }
  if (!isUnsignedDecimalInteger(terms.strike)) {
    throw new Error("invalid_strike");
  }

  return {
    jsonrpc: "2.0",
    id: uuidv7(),
    method: "rfq.create",
    params: {
      rfqId: uuidv7(),
      market: terms.market,
      expiry: terms.expiry,
      isPut: terms.isPut,
      quantity: terms.quantity,
      strike: terms.strike,
      seller: terms.seller,
      sellerCollateralSource: terms.sellerCollateralSource,
      ...(terms.sellerQuoteDestination === undefined
        ? {}
        : { sellerQuoteDestination: terms.sellerQuoteDestination }),
    },
  };
}

export function createUnderwriteSubmitRequest(input: {
  readonly rfqId: string;
  readonly underwriteTx: string;
}): UnderwriteSubmitRequest {
  if (!input.rfqId || !input.underwriteTx) {
    throw new Error("invalid_underwrite_submission");
  }
  return {
    jsonrpc: "2.0",
    id: uuidv7(),
    method: "underwrite.submit",
    params: input,
  };
}

export function quoteMatchesTerms(
  quote: BestQuote,
  terms: ActiveTakerRfqTerms
): boolean {
  return (
    quote.rfqId === terms.rfqId &&
    quote.expiry === terms.expiry &&
    quote.isPut === terms.isPut &&
    quote.quantity === terms.quantity &&
    quote.strike === terms.strike &&
    quote.premiumAsset === terms.premiumAsset &&
    quote.collateralAsset === terms.collateralAsset
  );
}

export function isQuoteValid(quote: BestQuote, nowMs: number): boolean {
  return Number.isFinite(nowMs) && quote.validUntil * 1_000 > nowMs;
}

export function parseTakerMessage(raw: string): TakerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_taker_message");
  }

  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
    throw new Error("invalid_taker_message");
  }
  if ("result" in parsed) return parseTakerResult(parsed);
  if (parsed.method === "quote.best") return parseQuoteBestNotification(parsed);
  if ("error" in parsed) return parseJsonRpcError(parsed);
  throw new Error("invalid_taker_message");
}

function parseTakerResult(
  value: Record<string, unknown>
): RfqCreateResponse | UnderwriteSubmitResponse {
  if (!isRecord(value.result)) throw new Error("invalid_taker_message");
  if ("requestDeadline" in value.result && !("status" in value.result)) {
    return parseRfqCreateResponse(value);
  }
  if ("status" in value.result && !("requestDeadline" in value.result)) {
    return parseUnderwriteSubmitResponse(value);
  }
  throw new Error("invalid_taker_message");
}

export function takerWebSocketUrl(rfqBaseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rfqBaseUrl);
  } catch {
    throw new Error("invalid_rfq_base_url");
  }

  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("invalid_rfq_base_url");
  }

  url.search = "";
  url.hash = "";
  if (url.pathname.endsWith("/taker")) return url;
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return new URL("taker", url);
}

function parseRfqCreateResponse(
  value: Record<string, unknown>
): RfqCreateResponse {
  if (
    typeof value.id !== "string" ||
    !isRecord(value.result) ||
    typeof value.result.rfqId !== "string" ||
    !isUnixMilliseconds(value.result.requestDeadline) ||
    "error" in value ||
    "method" in value
  ) {
    throw new Error("invalid_taker_message");
  }

  return {
    jsonrpc: "2.0",
    id: value.id,
    result: {
      rfqId: value.result.rfqId,
      requestDeadline: value.result.requestDeadline,
    },
  };
}

function parseUnderwriteSubmitResponse(
  value: Record<string, unknown>
): UnderwriteSubmitResponse {
  if (
    typeof value.id !== "string" ||
    !isRecord(value.result) ||
    !value.result.rfqId ||
    typeof value.result.rfqId !== "string" ||
    !value.result.txSignature ||
    typeof value.result.txSignature !== "string" ||
    value.result.status !== "queued" ||
    "error" in value ||
    "method" in value
  ) {
    throw new Error("invalid_taker_message");
  }

  return {
    jsonrpc: "2.0",
    id: value.id,
    result: {
      rfqId: value.result.rfqId,
      txSignature: value.result.txSignature,
      status: "queued",
    },
  };
}

function parseQuoteBestNotification(
  value: Record<string, unknown>
): QuoteBestNotification {
  if (
    !isRecord(value.params) ||
    "id" in value ||
    "result" in value ||
    "error" in value
  ) {
    throw new Error("invalid_taker_message");
  }

  const rfqId = nonEmptyString(value.params.rfqId);
  if (
    value.params.noQuoteReason === "no_buyers" &&
    !("quote" in value.params)
  ) {
    return {
      jsonrpc: "2.0",
      method: "quote.best",
      params: { rfqId, noQuoteReason: "no_buyers" },
    };
  }
  if (!isRecord(value.params.quote)) throw new Error("invalid_taker_message");
  const quote = parseBestQuote(value.params.quote);
  if (quote.rfqId !== rfqId) throw new Error("invalid_taker_message");

  return {
    jsonrpc: "2.0",
    method: "quote.best",
    params: { rfqId, quote },
  };
}

function parseJsonRpcError(value: Record<string, unknown>): JsonRpcError {
  if (
    (typeof value.id !== "string" && value.id !== null) ||
    !isRecord(value.error) ||
    !isJsonRpcErrorCode(value.error.code) ||
    typeof value.error.message !== "string" ||
    "result" in value ||
    "method" in value
  ) {
    throw new Error("invalid_taker_message");
  }

  return {
    jsonrpc: "2.0",
    id: value.id,
    error: {
      code: value.error.code,
      message: value.error.message,
      ...("data" in value.error ? { data: value.error.data } : {}),
    },
  };
}

function parseBestQuote(value: Record<string, unknown>): BestQuote {
  const quantity = nonEmptyString(value.quantity);
  const strike = nonEmptyString(value.strike);
  const premium = nonEmptyString(value.premium);
  if (
    !isUnsignedDecimalInteger(quantity) ||
    !isUnsignedDecimalInteger(strike) ||
    !isUnsignedDecimalInteger(premium) ||
    !isUnixSeconds(value.expiry) ||
    !isUnixSeconds(value.validUntil) ||
    typeof value.isPut !== "boolean"
  ) {
    throw new Error("invalid_taker_message");
  }

  return {
    rfqId: nonEmptyString(value.rfqId),
    assetAddress: nonEmptyString(value.assetAddress),
    chainId: nonEmptyString(value.chainId),
    expiry: value.expiry,
    isPut: value.isPut,
    maker: nonEmptyString(value.maker),
    quantity,
    strike,
    premiumAsset: nonEmptyString(value.premiumAsset),
    collateralAsset: nonEmptyString(value.collateralAsset),
    validUntil: value.validUntil,
    premium,
    underwriteTx: nonEmptyString(value.underwriteTx),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnixMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isJsonRpcErrorCode(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid_taker_message");
  }
  return value;
}
