import { isRecord } from "./rfq-rpc";
import type { RfqTerms } from "./rfq-book";

export type SellerRfqTerms = Omit<RfqTerms, "requestDeadline">;

export interface BuyerQuote {
  readonly assetAddress: string;
  readonly chainId: string;
  readonly expiry: number;
  readonly isPut: boolean;
  readonly maker: string;
  readonly quantity: string;
  readonly strike: string;
  readonly collateralAsset: string;
  readonly validUntil: number;
  readonly premium: string;
  readonly underwriteTx: string;
}

export interface UnderwriteSubmission {
  readonly rfqId: string;
  readonly underwriteTx: string;
}

export interface PositionRequest {
  readonly account: string;
}

export function parseRfqTerms(value: unknown): SellerRfqTerms {
  const record = recordValue(value, "RFQ");
  if ("requestDeadline" in record) {
    throw new Error("server-assigned-request-deadline");
  }
  return {
    asset: stringValue(record, "asset", "RFQ"),
    assetName: stringValue(record, "assetName", "RFQ"),
    chainId: stringValue(record, "chainId", "RFQ"),
    expiry: numberValue(record, "expiry", "RFQ"),
    isPut: booleanValue(record, "isPut", "RFQ"),
    quantity: stringValue(record, "quantity", "RFQ"),
    strike: stringValue(record, "strike", "RFQ"),
    collateralAsset: stringValue(record, "collateralAsset", "RFQ"),
    premiumAsset: stringValue(record, "premiumAsset", "RFQ"),
    underwriteTx: stringValue(record, "underwriteTx", "RFQ"),
  };
}

export function parseBuyerQuote(value: unknown): BuyerQuote {
  const record = recordValue(value, "quote");
  return {
    assetAddress: stringValue(record, "assetAddress", "quote"),
    chainId: stringValue(record, "chainId", "quote"),
    expiry: numberValue(record, "expiry", "quote"),
    isPut: booleanValue(record, "isPut", "quote"),
    maker: stringValue(record, "maker", "quote"),
    quantity: stringValue(record, "quantity", "quote"),
    strike: stringValue(record, "strike", "quote"),
    collateralAsset: stringValue(record, "collateralAsset", "quote"),
    validUntil: numberValue(record, "validUntil", "quote"),
    premium: stringValue(record, "premium", "quote"),
    underwriteTx: stringValue(record, "underwriteTx", "quote"),
  };
}

export function parseUnderwriteSubmission(
  value: unknown
): UnderwriteSubmission {
  const record = recordValue(value, "underwrite submission");
  return {
    rfqId: stringValue(record, "rfqId", "underwrite submission"),
    underwriteTx: stringValue(record, "underwriteTx", "underwrite submission"),
  };
}

export function parsePositionRequest(value: unknown): PositionRequest {
  const record = recordValue(value, "positions request");
  return { account: stringValue(record, "account", "positions request") };
}

export function validateQuoteMatchesRfq(
  quote: BuyerQuote,
  terms: RfqTerms
): void {
  if (
    quote.assetAddress !== terms.asset ||
    quote.chainId !== terms.chainId ||
    quote.expiry !== terms.expiry ||
    quote.isPut !== terms.isPut ||
    quote.quantity !== terms.quantity ||
    quote.strike !== terms.strike ||
    quote.collateralAsset !== terms.collateralAsset
  ) {
    throw new Error("Quote does not match RFQ terms.");
  }
  if (!/^\d+$/.test(quote.premium)) {
    throw new Error("Quote premium must be an unsigned integer string.");
  }
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

function stringValue(
  record: Record<string, unknown>,
  field: string,
  name: string
): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`Invalid ${name} ${field}.`);
  return value;
}

function numberValue(
  record: Record<string, unknown>,
  field: string,
  name: string
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${name} ${field}.`);
  }
  return value;
}

function booleanValue(
  record: Record<string, unknown>,
  field: string,
  name: string
): boolean {
  const value = record[field];
  if (typeof value !== "boolean") throw new Error(`Invalid ${name} ${field}.`);
  return value;
}
