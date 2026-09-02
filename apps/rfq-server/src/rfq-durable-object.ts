import {
  address,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import { validate as validateUuid, version as uuidVersion } from "uuid";

import { configuredMarketByAddress, type MarketConfig } from "./config";
import { jsonRpcError, jsonRpcResult, isRecord } from "./rfq-rpc";
import { JsonSolanaRpc } from "./solana-rpc";
import {
  buildUnderwriteTransaction,
  deriveOptionSeriesAddress,
} from "./underwrite-transaction-builder";
import type { Env } from "./worker";

const RFQ_AGGREGATION_MS = 2_500;
const TOMBSTONE_MS = 14 * 24 * 60 * 60 * 1_000;

interface CreateRequest {
  readonly requestId: string;
  readonly sellerConnectionId: string;
  readonly params: unknown;
}

interface RfqState {
  readonly rfqId: string;
  readonly sellerConnectionId: string;
  readonly market: string;
  readonly assetAddress: string;
  readonly assetName: string;
  readonly chainId: string;
  readonly expiry: number;
  readonly isPut: boolean;
  readonly quantity: string;
  readonly strike: string;
  readonly seller: string;
  readonly sellerCollateralSource: string;
  readonly collateralAsset: string;
  readonly premiumAsset: string;
  readonly requestDeadline: number;
  readonly status:
    "aggregating" | "selected" | "queued" | "no_quote" | "cancelled";
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly seriesExists: boolean;
  readonly generatedMessages: readonly GeneratedMessage[];
  readonly quotes: readonly StoredQuote[];
  readonly bestQuote: StoredQuote | undefined;
  readonly queuedUnderwriteTx: string | undefined;
  readonly queuedTxSignature: string | undefined;
}

interface GeneratedMessage {
  readonly maker: string;
  readonly buyerQuoteSource: string;
  readonly premium: string;
  readonly messageHash: string;
  readonly message: string;
}

interface StoredQuote extends Quote {
  readonly receivedAtMs: number;
  readonly makerConnectionId: string;
}

interface Quote {
  readonly rfqId: string;
  readonly assetAddress: string;
  readonly chainId: string;
  readonly expiry: number;
  readonly isPut: boolean;
  readonly maker: string;
  readonly quantity: string;
  readonly strike: string;
  readonly premiumAsset: string;
  readonly collateralAsset: string;
  readonly validUntil: number;
  readonly premium: string;
  readonly underwriteTx: string;
}

export class RfqDurableObject implements DurableObject {
  constructor(
    readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    return this.state.blockConcurrencyWhile(() =>
      this.fetchExclusively(request)
    );
  }

  private async fetchExclusively(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return new Response("Not found.", { status: 404 });
    }
    if (url.pathname === "/create") return this.create(request);
    if (url.pathname === "/cancel") return this.cancel(request);
    if (url.pathname === "/generate") return this.generate(request);
    if (url.pathname === "/quote") return this.quote(request);
    if (url.pathname === "/underwrite") return this.underwrite(request);
    return new Response("Not found.", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(() => this.runAlarm());
  }

  private async runAlarm(): Promise<void> {
    const rfq = await this.state.storage.get<RfqState>("rfq");
    if (rfq === undefined) return;
    if (rfq.status !== "aggregating") {
      await this.state.storage.deleteAll();
      return;
    }
    if (Date.now() < rfq.requestDeadline) {
      await this.state.storage.setAlarm(rfq.requestDeadline);
      return;
    }
    const selected = rfq.bestQuote;
    await this.state.storage.put("rfq", {
      ...rfq,
      status: selected === undefined ? "no_quote" : "selected",
    });
    await this.state.storage.setAlarm(Date.now() + TOMBSTONE_MS);
    await this.env.CONNECTION_HUB.get(
      this.env.CONNECTION_HUB.idFromName("connections")
    ).fetch(
      new Request("https://connection-hub/notify", {
        method: "POST",
        body: JSON.stringify({
          connectionId: rfq.sellerConnectionId,
          message: JSON.stringify({
            jsonrpc: "2.0",
            method: "quote.best",
            params:
              selected === undefined
                ? { rfqId: rfq.rfqId, noQuoteReason: "no_buyers" }
                : { rfqId: rfq.rfqId, quote: quoteNotification(selected) },
          }),
        }),
      })
    );
  }

  private async cancel(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.connectionId !== "string") {
      return new Response("Invalid cancellation.", { status: 400 });
    }
    const rfq = await this.state.storage.get<RfqState>("rfq");
    if (rfq !== undefined && rfq.sellerConnectionId === body.connectionId) {
      await this.state.storage.put("rfq", { ...rfq, status: "cancelled" });
      await this.state.storage.setAlarm(Date.now() + TOMBSTONE_MS);
    }
    return new Response(null, { status: 204 });
  }

  private async generate(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.requestId !== "string") {
      return response(
        jsonRpcError(null, 1002, "RFQ request was rejected.", "invalid-request")
      );
    }
    const rfqId = rfqIdFromParams(body.params);
    const rfq = await this.state.storage.get<RfqState>("rfq");
    if (rfq === undefined || rfq.status === "cancelled") {
      return response(
        jsonRpcError(
          body.requestId,
          1001,
          "RFQ is unavailable.",
          "unknown-or-inactive-rfq",
          rfqId
        )
      );
    }
    if (rfq.status !== "aggregating" || Date.now() >= rfq.requestDeadline) {
      return response(
        jsonRpcError(
          body.requestId,
          1005,
          "RFQ aggregation has closed.",
          "aggregation-closed",
          rfq.rfqId
        )
      );
    }
    try {
      const maker = parseGeneration(body.params);
      const market = configuredMarketByAddress(
        this.env.PRODUCT_ENVIRONMENT,
        rfq.market
      );
      if (market === null) throw new Error("unknown-market");
      const underwriteTx = await buildUnderwriteTransaction({
        market,
        expiry: rfq.expiry,
        isPut: rfq.isPut,
        quantity: rfq.quantity,
        strike: rfq.strike,
        seller: rfq.seller,
        sellerCollateralSource: rfq.sellerCollateralSource,
        maker: maker.maker,
        buyerQuoteSource: maker.buyerQuoteSource,
        premium: maker.premium,
        blockhash: rfq.blockhash,
        lastValidBlockHeight: rfq.lastValidBlockHeight,
        seriesExists: rfq.seriesExists,
      });
      const message = transactionMessage(underwriteTx);
      const messageHash = await generatedMessageHash(message);
      const generatedMessages = [
        ...rfq.generatedMessages,
        {
          maker: maker.maker,
          buyerQuoteSource: maker.buyerQuoteSource,
          premium: maker.premium,
          messageHash,
          message,
        },
      ];
      await this.state.storage.put("rfq", { ...rfq, generatedMessages });
      return response(
        jsonRpcResult(body.requestId, {
          rfqId: rfq.rfqId,
          underwriteTx,
          lastValidBlockHeight: rfq.lastValidBlockHeight,
        })
      );
    } catch (error) {
      return response(
        jsonRpcError(
          body.requestId,
          1002,
          "RFQ request was rejected.",
          errorMessage(error),
          rfq.rfqId
        )
      );
    }
  }

  private async quote(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.requestId !== "string" ||
      typeof body.connectionId !== "string"
    ) {
      return response(
        jsonRpcError(null, 1002, "RFQ request was rejected.", "invalid-request")
      );
    }
    let quote: Quote | undefined;
    try {
      const parsedQuote = parseQuote(body.params);
      quote = parsedQuote;
      const rfq = await this.state.storage.get<RfqState>("rfq");
      if (rfq === undefined || rfq.status === "cancelled") {
        throw new RfqRequestError(1001, "unknown-or-inactive-rfq");
      }
      if (rfq.status !== "aggregating" || Date.now() >= rfq.requestDeadline) {
        throw new RfqRequestError(1005, "aggregation-closed");
      }
      validateQuoteTerms(parsedQuote, rfq);
      const nowMs = Date.now();
      if (
        parsedQuote.validUntil * 1_000 <= rfq.requestDeadline ||
        parsedQuote.validUntil * 1_000 <= nowMs ||
        parsedQuote.validUntil * 1_000 > nowMs + 40_000
      ) {
        throw new RfqRequestError(1003, "invalid-quote-validity");
      }
      if (rfq.quotes.some((stored) => stored.maker === parsedQuote.maker)) {
        throw new RfqRequestError(1004, "maker-already-quoted");
      }
      const message = transactionMessage(parsedQuote.underwriteTx);
      const messageHash = await generatedMessageHash(message);
      if (
        !rfq.generatedMessages.some(
          (generated) =>
            generated.maker === parsedQuote.maker &&
            generated.premium === parsedQuote.premium &&
            generated.messageHash === messageHash &&
            generated.message === message
        )
      ) {
        throw new RfqRequestError(1004, "transaction-was-not-generated");
      }
      await verifyTransactionSignature(
        parsedQuote.underwriteTx,
        parsedQuote.maker
      );
      const stored: StoredQuote = {
        ...parsedQuote,
        receivedAtMs: nowMs,
        makerConnectionId: body.connectionId,
      };
      const displacedQuote = rfq.bestQuote;
      const bestQuote = isBetterQuote(stored, rfq.bestQuote)
        ? stored
        : rfq.bestQuote;
      const selectedQuote = bestQuote ?? stored;
      await this.state.storage.put("rfq", {
        ...rfq,
        quotes: [...rfq.quotes, stored],
        bestQuote: selectedQuote,
      });
      if (
        displacedQuote !== undefined &&
        displacedQuote.maker !== stored.maker &&
        selectedQuote === stored
      ) {
        await this.notifyOutbid(displacedQuote, stored.premium);
      }
      const providedStatus =
        selectedQuote === stored
          ? "best"
          : BigInt(stored.premium) === BigInt(selectedQuote.premium)
            ? "best_received_later"
            : "not_best";
      return response(
        jsonRpcResult(body.requestId, {
          rfqId: rfq.rfqId,
          bestQuote: selectedQuote.premium,
          providedQuote: stored.premium,
          providedStatus,
        })
      );
    } catch (error) {
      const details = quoteErrorDetails(error);
      return response(
        jsonRpcError(
          body.requestId,
          details.code,
          details.code === 1005
            ? "RFQ aggregation has closed."
            : "RFQ request was rejected.",
          details.reason,
          quote?.rfqId
        )
      );
    }
  }

  private async notifyOutbid(
    displacedQuote: StoredQuote,
    bestQuote: string
  ): Promise<void> {
    try {
      await this.env.CONNECTION_HUB.get(
        this.env.CONNECTION_HUB.idFromName("connections")
      ).fetch(
        new Request("https://connection-hub/notify", {
          method: "POST",
          body: JSON.stringify({
            connectionId: displacedQuote.makerConnectionId,
            message: JSON.stringify({
              jsonrpc: "2.0",
              method: "quote.outbid",
              params: {
                rfqId: displacedQuote.rfqId,
                bestQuote,
                providedQuote: displacedQuote.premium,
                providedStatus: "outbid",
              },
            }),
          }),
        })
      );
    } catch {
      // Outbid notifications are best effort and must not reject a valid quote.
    }
  }

  private async underwrite(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    if (
      !isRecord(body) ||
      typeof body.requestId !== "string" ||
      typeof body.connectionId !== "string"
    ) {
      return response(
        jsonRpcError(null, 1002, "RFQ request was rejected.", "invalid-request")
      );
    }
    let submission:
      { readonly rfqId: string; readonly underwriteTx: string } | undefined;
    try {
      submission = parseUnderwriteSubmission(body.params);
      const rfq = await this.state.storage.get<RfqState>("rfq");
      if (rfq === undefined || rfq.status === "cancelled") {
        throw new RfqRequestError(1001, "unknown-or-inactive-rfq");
      }
      if (rfq.sellerConnectionId !== body.connectionId) {
        throw new RfqRequestError(1001, "seller-connection-does-not-own-rfq");
      }
      if (rfq.status === "queued") {
        if (rfq.queuedUnderwriteTx !== submission.underwriteTx) {
          throw new RfqRequestError(
            1004,
            "transaction-does-not-match-queued-rfq"
          );
        }
        return response(jsonRpcResult(body.requestId, queuedResult(rfq)));
      }
      if (rfq.status !== "selected" || rfq.bestQuote === undefined) {
        throw new RfqRequestError(1001, "rfq-is-not-selected");
      }
      if (rfq.bestQuote.validUntil * 1_000 <= Date.now()) {
        throw new RfqRequestError(1003, "selected-quote-expired");
      }
      if (
        submission.rfqId !== rfq.rfqId ||
        transactionMessage(submission.underwriteTx) !==
          transactionMessage(rfq.bestQuote.underwriteTx)
      ) {
        throw new RfqRequestError(
          1004,
          "transaction-does-not-match-selected-quote"
        );
      }
      await Promise.all([
        verifyTransactionSignature(
          submission.underwriteTx,
          rfq.bestQuote.maker
        ),
        verifyTransactionSignature(submission.underwriteTx, rfq.seller),
      ]);
      const txSignature = getSignatureFromTransaction(
        getTransactionDecoder().decode(base64Bytes(submission.underwriteTx))
      );
      const queued: RfqState = {
        ...rfq,
        status: "queued",
        queuedUnderwriteTx: submission.underwriteTx,
        queuedTxSignature: txSignature,
      };
      await this.state.storage.put("rfq", queued);
      return response(jsonRpcResult(body.requestId, queuedResult(queued)));
    } catch (error) {
      const details = quoteErrorDetails(error);
      return response(
        jsonRpcError(
          body.requestId,
          details.code,
          "RFQ request was rejected.",
          details.reason,
          submission?.rfqId
        )
      );
    }
  }

  private async create(request: Request): Promise<Response> {
    let requestId: string | null = null;
    let rfqId: string | undefined;
    try {
      const payload: unknown = await request.json();
      const create = parseCreateRequest(payload);
      requestId = create.requestId;
      const parsed = parseRfq(create.params);
      rfqId = parsed.rfqId;
      if ((await this.state.storage.get<RfqState>("rfq")) !== undefined) {
        throw new Error("duplicate-rfq-id");
      }
      const market = configuredMarketByAddress(
        this.env.PRODUCT_ENVIRONMENT,
        parsed.market
      );
      if (market === null) throw new Error("unknown-market");
      validateRfqForMarket(parsed, market);
      const rpc = new JsonSolanaRpc(this.env.SOLANA_RPC_URL);
      const [latestBlockhash, seriesAddress] = await Promise.all([
        rpc.getLatestBlockhash(),
        deriveOptionSeriesAddress({
          market,
          expiry: parsed.expiry,
          isPut: parsed.isPut,
          strike: parsed.strike,
        }),
      ]);
      const seriesExists = await rpc.accountExists(seriesAddress);
      const requestDeadline = Date.now() + RFQ_AGGREGATION_MS;
      const rfq: RfqState = {
        ...parsed,
        sellerConnectionId: create.sellerConnectionId,
        assetAddress: market.baseCoinMint,
        assetName: market.oracleBase,
        chainId: `solana:${this.env.SOLANA_CLUSTER}`,
        collateralAsset: parsed.isPut
          ? market.quoteCoinMint
          : market.baseCoinMint,
        premiumAsset: market.quoteCoinMint,
        requestDeadline,
        status: "aggregating",
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        seriesExists,
        generatedMessages: [],
        quotes: [],
        bestQuote: undefined,
        queuedUnderwriteTx: undefined,
        queuedTxSignature: undefined,
      };
      await this.state.storage.put("rfq", rfq);
      await this.state.storage.setAlarm(requestDeadline);
      await this.env.ASSET_HUB.get(
        this.env.ASSET_HUB.idFromName(`asset-hub:${market.baseCoinMint}`)
      ).fetch(
        new Request("https://asset-hub/fanout", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "rfq.request",
            params: rfqRequest(rfq),
          }),
        })
      );
      return response(
        jsonRpcResult(create.requestId, { rfqId, requestDeadline })
      );
    } catch (error) {
      return response(
        jsonRpcError(
          requestId,
          requestErrorCode(error),
          "RFQ request was rejected.",
          errorMessage(error),
          rfqId
        )
      );
    }
  }
}

function parseCreateRequest(value: unknown): CreateRequest {
  if (!isRecord(value)) throw new Error("invalid-create-request");
  if (
    typeof value.requestId !== "string" ||
    typeof value.sellerConnectionId !== "string"
  ) {
    throw new Error("invalid-create-request");
  }
  return {
    requestId: value.requestId,
    sellerConnectionId: value.sellerConnectionId,
    params: value.params,
  };
}

function parseRfq(
  value: unknown
): Omit<
  RfqState,
  | "assetAddress"
  | "assetName"
  | "chainId"
  | "collateralAsset"
  | "premiumAsset"
  | "requestDeadline"
  | "sellerConnectionId"
  | "status"
  | "blockhash"
  | "lastValidBlockHeight"
  | "seriesExists"
  | "generatedMessages"
  | "quotes"
  | "bestQuote"
  | "queuedUnderwriteTx"
  | "queuedTxSignature"
> {
  if (!isRecord(value)) throw new Error("invalid-rfq");
  const rfqId = stringField(value, "rfqId");
  if (!validateUuid(rfqId) || uuidVersion(rfqId) !== 7) {
    throw new Error("invalid-rfq-id");
  }
  const quantity = stringField(value, "quantity");
  const strike = stringField(value, "strike");
  if (!/^\d+$/.test(quantity) || !/^\d+$/.test(strike) || strike === "0") {
    throw new Error("invalid-rfq-amount");
  }
  return {
    rfqId,
    market: stringField(value, "market"),
    expiry: numberField(value, "expiry"),
    isPut: booleanField(value, "isPut"),
    quantity,
    strike,
    seller: stringField(value, "seller"),
    sellerCollateralSource: stringField(value, "sellerCollateralSource"),
  };
}

function validateRfqForMarket(
  rfq: {
    readonly quantity: string;
    readonly expiry: number;
    readonly seller: string;
    readonly sellerCollateralSource: string;
  },
  market: MarketConfig
): void {
  const quantity = BigInt(rfq.quantity);
  if (
    quantity < market.quantity.minimum ||
    quantity > market.quantity.maximum
  ) {
    throw new Error("quantity-outside-market-range");
  }
  if ((quantity - market.quantity.minimum) % market.quantity.step !== 0n) {
    throw new Error("quantity-does-not-use-market-step");
  }
  if (rfq.expiry <= 0) throw new Error("invalid-rfq-expiry");
  validateAddress(rfq.seller, "seller");
  validateAddress(rfq.sellerCollateralSource, "sellerCollateralSource");
}

function validateAddress(value: string, field: string): void {
  try {
    getAddressEncoder().encode(address(value));
  } catch {
    throw new Error(`invalid-rfq-${field}`);
  }
}

function rfqRequest(rfq: RfqState): Record<string, unknown> {
  return {
    rfqId: rfq.rfqId,
    assetAddress: rfq.assetAddress,
    assetName: rfq.assetName,
    chainId: rfq.chainId,
    expiry: rfq.expiry,
    isPut: rfq.isPut,
    quantity: rfq.quantity,
    strike: rfq.strike,
    collateralAsset: rfq.collateralAsset,
    premiumAsset: rfq.premiumAsset,
    requestDeadline: rfq.requestDeadline,
  };
}

function response(message: string): Response {
  return Response.json({ message });
}

function stringField(value: Record<string, unknown>, name: string): string {
  if (typeof value[name] !== "string") throw new Error(`invalid-rfq-${name}`);
  return value[name];
}

function numberField(value: Record<string, unknown>, name: string): number {
  const field = value[name];
  if (typeof field !== "number" || !Number.isSafeInteger(field)) {
    throw new Error(`invalid-rfq-${name}`);
  }
  return field;
}

function booleanField(value: Record<string, unknown>, name: string): boolean {
  if (typeof value[name] !== "boolean") throw new Error(`invalid-rfq-${name}`);
  return value[name];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid-request";
}

function rfqIdFromParams(value: unknown): string | undefined {
  return isRecord(value) && typeof value.rfqId === "string"
    ? value.rfqId
    : undefined;
}

function parseGeneration(value: unknown): {
  readonly maker: string;
  readonly buyerQuoteSource: string;
  readonly premium: string;
} {
  if (!isRecord(value)) throw new Error("invalid-underwrite-generation");
  const premium = stringField(value, "premium");
  if (!/^\d+$/.test(premium)) throw new Error("invalid-underwrite-premium");
  return {
    maker: stringField(value, "maker"),
    buyerQuoteSource: stringField(value, "buyerQuoteSource"),
    premium,
  };
}

function parseQuote(value: unknown): Quote {
  if (!isRecord(value)) throw new Error("invalid-quote");
  const premium = stringField(value, "premium");
  if (!/^\d+$/.test(premium)) throw new Error("invalid-quote-premium");
  return {
    rfqId: stringField(value, "rfqId"),
    assetAddress: stringField(value, "assetAddress"),
    chainId: stringField(value, "chainId"),
    expiry: numberField(value, "expiry"),
    isPut: booleanField(value, "isPut"),
    maker: stringField(value, "maker"),
    quantity: stringField(value, "quantity"),
    strike: stringField(value, "strike"),
    premiumAsset: stringField(value, "premiumAsset"),
    collateralAsset: stringField(value, "collateralAsset"),
    validUntil: numberField(value, "validUntil"),
    premium,
    underwriteTx: stringField(value, "underwriteTx"),
  };
}

function parseUnderwriteSubmission(value: unknown): {
  readonly rfqId: string;
  readonly underwriteTx: string;
} {
  if (!isRecord(value)) throw new Error("invalid-underwrite-submission");
  return {
    rfqId: stringField(value, "rfqId"),
    underwriteTx: stringField(value, "underwriteTx"),
  };
}

function validateQuoteTerms(quote: Quote, rfq: RfqState): void {
  if (
    quote.rfqId !== rfq.rfqId ||
    quote.assetAddress !== rfq.assetAddress ||
    quote.chainId !== rfq.chainId ||
    quote.expiry !== rfq.expiry ||
    quote.isPut !== rfq.isPut ||
    quote.quantity !== rfq.quantity ||
    quote.strike !== rfq.strike ||
    quote.premiumAsset !== rfq.premiumAsset ||
    quote.collateralAsset !== rfq.collateralAsset
  ) {
    throw new RfqRequestError(1002, "quote-terms-do-not-match-rfq");
  }
}

function isBetterQuote(
  quote: StoredQuote,
  current: StoredQuote | undefined
): boolean {
  return (
    current === undefined || BigInt(quote.premium) > BigInt(current.premium)
  );
}

async function verifyTransactionSignature(
  encodedTransaction: string,
  signer: string
): Promise<void> {
  const transaction = getTransactionDecoder().decode(
    base64Bytes(encodedTransaction)
  );
  const messageBytes = new Uint8Array(transaction.messageBytes);
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
  if (message.version !== 0 || message.addressTableLookups !== undefined) {
    throw new RfqRequestError(1003, "transaction-must-be-inline-v0");
  }
  const signature = transaction.signatures[address(signer)];
  if (signature === null || signature === undefined) {
    throw new RfqRequestError(1003, "transaction-signature-is-missing");
  }
  const publicKey = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(getAddressEncoder().encode(address(signer))),
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  if (
    !(await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      arrayBuffer(signature),
      arrayBuffer(messageBytes)
    ))
  ) {
    throw new RfqRequestError(1003, "transaction-signature-is-invalid");
  }
}

function transactionMessage(encodedTransaction: string): string {
  const transaction = getTransactionDecoder().decode(
    base64Bytes(encodedTransaction)
  );
  return bytesBase64(new Uint8Array(transaction.messageBytes));
}

async function generatedMessageHash(message: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    arrayBuffer(base64Bytes(message))
  );
  return bytesBase64(new Uint8Array(digest));
}

function base64Bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new RfqRequestError(1003, "transaction-must-be-base64");
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function bytesBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function quoteNotification(quote: StoredQuote): Quote {
  return {
    rfqId: quote.rfqId,
    assetAddress: quote.assetAddress,
    chainId: quote.chainId,
    expiry: quote.expiry,
    isPut: quote.isPut,
    maker: quote.maker,
    quantity: quote.quantity,
    strike: quote.strike,
    premiumAsset: quote.premiumAsset,
    collateralAsset: quote.collateralAsset,
    validUntil: quote.validUntil,
    premium: quote.premium,
    underwriteTx: quote.underwriteTx,
  };
}

function queuedResult(rfq: RfqState): {
  readonly rfqId: string;
  readonly txSignature: string;
  readonly status: "queued";
} {
  if (rfq.queuedTxSignature === undefined) {
    throw new Error("queued-rfq-missing-transaction-signature");
  }
  return {
    rfqId: rfq.rfqId,
    txSignature: rfq.queuedTxSignature,
    status: "queued",
  };
}

function arrayBuffer(value: ArrayLike<number>): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

class RfqRequestError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string
  ) {
    super(reason);
  }
}

function quoteErrorDetails(error: unknown): {
  readonly code: number;
  readonly reason: string;
} {
  return error instanceof RfqRequestError
    ? { code: error.code, reason: error.reason }
    : { code: 1002, reason: errorMessage(error) };
}

function requestErrorCode(error: unknown): number {
  return errorMessage(error) === "duplicate-rfq-id" ? 1001 : 1002;
}
