import {
  address,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import { validate as validateUuid, version as uuidVersion } from "uuid";

import {
  configuredMarketByAddress,
  type MarketConfig,
  type ProductEnvironment,
} from "./config";
import { UnderwriteRepository } from "./database/underwrite-repository";
import { jsonRpcError, jsonRpcResult, isRecord } from "./rfq-rpc";
import { JsonSolanaRpc } from "./solana-rpc";
import {
  FinalTransactionValidationError,
  validateFinalUnderwriteTransaction,
} from "./transaction-validation";
import {
  buildUnderwriteTransaction,
  deriveOptionSeriesAddress,
  UNDERWRITE_INSTRUCTION_INDEX,
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
  /** option contract quantity using 18 decimals. */
  readonly quantity: string;
  /** USD strike using 8 decimals. */
  readonly strike: string;
  readonly seller: string;
  readonly sellerCollateralSource: string;
  /** QuoteCoin premium destination for calls. Puts reuse sellerCollateralSource. */
  readonly sellerQuoteDestination: string | undefined;
  readonly collateralAsset: string;
  readonly premiumAsset: string;
  readonly requestDeadline: number;
  /**
   * aggregating - collecting quotes from buyers
   * selected - aggregation ended, a best quote selected from received quotes
   * no_quote - aggregation ended, no quotes provided, e.g. no buyers, buyer did not provide quotes
   * queued - RFQ underwrite transaction from the best quote was queued to be broadcasted on-chain
   * cancelled - RFQ was canceled by seller or seller related reasons
   */
  readonly status:
    "aggregating" | "selected" | "queued" | "no_quote" | "cancelled";
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly generatedMessages: readonly GeneratedMessage[];
  readonly quotes: readonly StoredQuote[];
  readonly bestQuote: StoredQuote | undefined;
  readonly queuedUnderwriteTx: string | undefined;
  readonly queuedTxSignature: string | undefined;
  readonly fillNotificationStatus: "confirmed" | "failed" | undefined;
}

interface GeneratedMessage {
  readonly maker: string;
  readonly buyerQuoteSource: string;
  /** QuoteCoin premium per whole option contract using 18 decimals. */
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
  /** option contract quantity using 18 decimals. */
  readonly quantity: string;
  /** USD strike using 8 decimals. */
  readonly strike: string;
  readonly premiumAsset: string;
  readonly collateralAsset: string;
  readonly validUntil: number;
  /** QuoteCoin premium per whole option contract using 18 decimals. */
  readonly premium: string;
  readonly underwriteTx: string;
}

interface QuoteSubmission {
  readonly rfqId: string;
  readonly chainId: string;
  readonly validUntil: number;
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
    if (url.pathname === "/broadcast-result")
      return this.broadcastResult(request);
    return new Response("Not found.", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(() => this.runAlarm());
  }

  /**
   * logic at the end of aggregating window undefined in requestDeadline
   */
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
    console.debug("RFQ aggregation completed.", {
      rfqId: rfq.rfqId,
      quoteCount: rfq.quotes.length,
      status: selected === undefined ? "no_quote" : "selected",
      selectedQuote:
        selected === undefined ? undefined : quoteLogParams(selected),
    });
    await this.state.storage.setAlarm(Date.now() + TOMBSTONE_MS);
    try {
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
    } catch (error) {
      console.error("Failed to notify seller of RFQ result.", {
        error,
        rfqId: rfq.rfqId,
      });
    }
  }

  private async cancel(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.connectionId !== "string") {
      return new Response("Invalid cancellation.", { status: 400 });
    }
    const rfq = await this.state.storage.get<RfqState>("rfq");
    if (
      rfq !== undefined &&
      rfq.sellerConnectionId === body.connectionId &&
      (rfq.status === "aggregating" || rfq.status === "selected")
    ) {
      await this.state.storage.put("rfq", { ...rfq, status: "cancelled" });
      await this.state.storage.setAlarm(Date.now() + TOMBSTONE_MS);
    }
    return new Response(null, { status: 204 });
  }

  /**
   * Generate solana transaction for give RFQ
   */
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
      validatePremiumPrecision(maker.premium, market.quoteMintDecimals);
      const underwriteTx = await buildUnderwriteTransaction({
        market,
        expiry: rfq.expiry,
        isPut: rfq.isPut,
        quantity: rfq.quantity,
        strike: rfq.strike,
        seller: rfq.seller,
        sellerCollateralSource: rfq.sellerCollateralSource,
        sellerQuoteDestination: rfq.sellerQuoteDestination,
        maker: maker.maker,
        buyerQuoteSource: maker.buyerQuoteSource,
        premium: maker.premium,
        blockhash: rfq.blockhash,
        lastValidBlockHeight: rfq.lastValidBlockHeight,
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

  /**
   * Provide a quote for given RFQ
   */
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
      const submission = parseQuoteSubmission(body.params);
      const rfq = await this.state.storage.get<RfqState>("rfq");
      if (rfq === undefined || rfq.status === "cancelled") {
        throw new RfqRequestError(1001, "unknown-or-inactive-rfq");
      }
      if (rfq.status !== "aggregating" || Date.now() >= rfq.requestDeadline) {
        throw new RfqRequestError(1005, "aggregation-closed");
      }
      const nowMs = Date.now();
      if (
        submission.chainId !== rfq.chainId ||
        submission.validUntil * 1_000 <= rfq.requestDeadline ||
        submission.validUntil * 1_000 <= nowMs ||
        submission.validUntil * 1_000 > nowMs + 40_000
      ) {
        throw new RfqRequestError(
          submission.chainId !== rfq.chainId ? 1002 : 1003,
          submission.chainId !== rfq.chainId
            ? "quote-chain-does-not-match-rfq"
            : "invalid-quote-validity"
        );
      }
      const message = transactionMessage(submission.underwriteTx);
      const messageHash = await generatedMessageHash(message);
      const generated = rfq.generatedMessages.find(
        (candidate) =>
          candidate.messageHash === messageHash && candidate.message === message
      );
      if (generated === undefined) {
        throw new RfqRequestError(1004, "transaction-was-not-generated");
      }
      if (rfq.quotes.some((stored) => stored.maker === generated.maker)) {
        throw new RfqRequestError(1004, "maker-already-quoted");
      }
      await verifyTransactionSignature(
        submission.underwriteTx,
        generated.maker
      );
      const stored: StoredQuote = {
        rfqId: rfq.rfqId,
        assetAddress: rfq.assetAddress,
        chainId: rfq.chainId,
        expiry: rfq.expiry,
        isPut: rfq.isPut,
        maker: generated.maker,
        quantity: rfq.quantity,
        strike: rfq.strike,
        premiumAsset: rfq.premiumAsset,
        collateralAsset: rfq.collateralAsset,
        validUntil: submission.validUntil,
        premium: generated.premium,
        underwriteTx: submission.underwriteTx,
        receivedAtMs: nowMs,
        makerConnectionId: body.connectionId,
      };
      quote = stored;
      console.debug("Buyer quote received.", {
        rfqId: stored.rfqId,
        quote: quoteLogParams(stored),
      });
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
      const market = configuredMarketByAddress(
        this.env.PRODUCT_ENVIRONMENT,
        rfq.market
      );
      if (market === null) throw new Error("unknown-market");
      const selectedMessage = transactionMessage(rfq.bestQuote.underwriteTx);
      const generated = rfq.generatedMessages.find(
        (candidate) =>
          candidate.message === selectedMessage &&
          candidate.maker === rfq.bestQuote?.maker &&
          candidate.premium === rfq.bestQuote?.premium
      );
      if (generated === undefined) {
        throw new RfqRequestError(
          1004,
          "selected-transaction-was-not-generated"
        );
      }
      const canonicalTransaction = await buildUnderwriteTransaction({
        market,
        expiry: rfq.expiry,
        isPut: rfq.isPut,
        quantity: rfq.quantity,
        strike: rfq.strike,
        seller: rfq.seller,
        sellerCollateralSource: rfq.sellerCollateralSource,
        sellerQuoteDestination: rfq.sellerQuoteDestination,
        maker: rfq.bestQuote.maker,
        buyerQuoteSource: generated.buyerQuoteSource,
        premium: rfq.bestQuote.premium,
        blockhash: rfq.blockhash,
        lastValidBlockHeight: rfq.lastValidBlockHeight,
      });
      try {
        validateFinalUnderwriteTransaction({
          underwriteTx: submission.underwriteTx,
          canonicalTransaction,
        });
      } catch (error) {
        if (error instanceof FinalTransactionValidationError) {
          throw new RfqRequestError(1003, error.message);
        }
        throw error;
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
      const seriesAddress = await deriveOptionSeriesAddress({
        market,
        expiry: rfq.expiry,
        isPut: rfq.isPut,
        strike: rfq.strike,
      });
      const createdAtMs = Date.now();
      await new UnderwriteRepository(this.env.DB).createQueued({
        txSignature,
        // TODO: do not assume underwrite will always be at index 1,
        // different clients might include more tx before compute-budget and underwrite ix
        ixIndex: UNDERWRITE_INSTRUCTION_INDEX,
        rfqId: rfq.rfqId,
        sellerAddress: rfq.seller,
        buyerAddress: rfq.bestQuote.maker,
        marketAddress: market.marketAddress,
        seriesAddress,
        oracleAsset: market.oracleBase,
        baseAsset: market.baseTokenSymbol,
        quoteAsset: market.quoteTokenSymbol,
        isPut: rfq.isPut,
        expiryMs: rfq.expiry * 1_000,
        strike: rfq.strike,
        quantity: rfq.quantity,
        premium: rfq.bestQuote.premium,
        baseMint: market.baseMint,
        quoteMint: market.quoteMint,
        feeRecipient: market.feeRecipient,
        operationalFeeBps: market.operationalFeeBps,
        createdAtMs,
      });
      await this.env.BROADCAST_QUEUE.send({
        txSignature,
        ixIndex: UNDERWRITE_INSTRUCTION_INDEX,
        rfqId: rfq.rfqId,
        signedTransaction: submission.underwriteTx,
      });
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

  private async broadcastResult(request: Request): Promise<Response> {
    const result = parseBroadcastResult(await request.json());
    if (result === null)
      return new Response("Invalid broadcast result.", { status: 400 });
    const rfq = await this.state.storage.get<RfqState>("rfq");
    if (
      rfq === undefined ||
      rfq.status !== "queued" ||
      rfq.queuedTxSignature !== result.txSignature ||
      rfq.bestQuote === undefined ||
      rfq.fillNotificationStatus !== undefined ||
      (result.status === "failed" && !result.buyerFault)
    ) {
      return new Response(null, { status: 204 });
    }
    const notification = await fillNotification(
      rfq,
      result,
      this.env.PRODUCT_ENVIRONMENT
    );
    await this.state.storage.put("rfq", {
      ...rfq,
      fillNotificationStatus: result.status,
    });
    try {
      await this.env.CONNECTION_HUB.get(
        this.env.CONNECTION_HUB.idFromName("connections")
      ).fetch(
        new Request("https://connection-hub/notify", {
          method: "POST",
          body: JSON.stringify({
            connectionId: rfq.bestQuote.makerConnectionId,
            message: JSON.stringify(notification),
          }),
        })
      );
    } catch {
      // Fill notifications are best effort and must not affect durable status.
    }
    return new Response(null, { status: 204 });
  }

  /**
   * Create a new RFQ for given undewrite terms
   */
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
      console.debug("RFQ request received.", {
        rfqId: parsed.rfqId,
        underwriteTerms: rfqUnderwriteTerms(parsed),
      });
      const rpc = new JsonSolanaRpc(this.env.SOLANA_RPC_URL);
      const latestBlockhash = await rpc.getLatestBlockhash();
      const requestDeadline = Date.now() + RFQ_AGGREGATION_MS;
      const rfq: RfqState = {
        ...parsed,
        sellerConnectionId: create.sellerConnectionId,
        assetAddress: market.baseMint,
        assetName: market.oracleBase,
        chainId: `solana:${this.env.SOLANA_CLUSTER}`,
        collateralAsset: parsed.isPut ? market.quoteMint : market.baseMint,
        premiumAsset: market.quoteMint,
        requestDeadline,
        status: "aggregating",
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        generatedMessages: [],
        quotes: [],
        bestQuote: undefined,
        queuedUnderwriteTx: undefined,
        queuedTxSignature: undefined,
        fillNotificationStatus: undefined,
      };
      await this.state.storage.put("rfq", rfq);
      await this.state.storage.setAlarm(requestDeadline);
      await this.env.ASSET_HUB.get(
        this.env.ASSET_HUB.idFromName(`asset-hub:${market.baseMint}`)
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
  | "generatedMessages"
  | "quotes"
  | "bestQuote"
  | "queuedUnderwriteTx"
  | "queuedTxSignature"
  | "fillNotificationStatus"
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
  const isPut = booleanField(value, "isPut");
  const sellerQuoteDestination = optionalStringField(
    value,
    "sellerQuoteDestination"
  );
  if (!isPut && sellerQuoteDestination === undefined) {
    throw new Error("missing-seller-quote-destination");
  }
  return {
    rfqId,
    market: stringField(value, "market"),
    expiry: numberField(value, "expiry"),
    isPut,
    quantity,
    strike,
    seller: stringField(value, "seller"),
    sellerCollateralSource: stringField(value, "sellerCollateralSource"),
    sellerQuoteDestination,
  };
}

function validateRfqForMarket(
  rfq: {
    readonly quantity: string;
    readonly expiry: number;
    readonly seller: string;
    readonly sellerCollateralSource: string;
    readonly sellerQuoteDestination: string | undefined;
    readonly isPut: boolean;
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
  if (rfq.sellerQuoteDestination !== undefined) {
    validateAddress(rfq.sellerQuoteDestination, "sellerQuoteDestination");
  }
}

function validatePremiumPrecision(
  premium: string,
  quoteMintDecimals: number
): void {
  if (
    !Number.isInteger(quoteMintDecimals) ||
    quoteMintDecimals < 0 ||
    quoteMintDecimals > 18
  ) {
    throw new Error("invalid-market-quote-mint-decimals");
  }
  const requiredE18Divisor = 10n ** BigInt(18 - quoteMintDecimals);
  if (BigInt(premium) % requiredE18Divisor !== 0n) {
    throw new Error("premium-exceeds-quote-mint-precision");
  }
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

function rfqUnderwriteTerms(rfq: {
  readonly market: string;
  readonly expiry: number;
  readonly isPut: boolean;
  readonly quantity: string;
  readonly strike: string;
  readonly seller: string;
  readonly sellerCollateralSource: string;
  readonly sellerQuoteDestination: string | undefined;
}): Record<string, string | number | boolean> {
  return {
    market: rfq.market,
    expiry: rfq.expiry,
    isPut: rfq.isPut,
    quantity: rfq.quantity,
    strike: rfq.strike,
    seller: rfq.seller,
    sellerCollateralSource: rfq.sellerCollateralSource,
    ...(rfq.sellerQuoteDestination === undefined
      ? {}
      : { sellerQuoteDestination: rfq.sellerQuoteDestination }),
  };
}

function quoteLogParams(
  quote: Quote
): Record<string, string | number | boolean> {
  return {
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
  };
}

function response(message: string): Response {
  return Response.json({ message });
}

function stringField(value: Record<string, unknown>, name: string): string {
  if (typeof value[name] !== "string") throw new Error(`invalid-rfq-${name}`);
  return value[name];
}

function optionalStringField(
  value: Record<string, unknown>,
  name: string
): string | undefined {
  const field = value[name];
  if (field === undefined) return undefined;
  if (typeof field !== "string") throw new Error(`invalid-rfq-${name}`);
  return field;
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

function parseQuoteSubmission(value: unknown): QuoteSubmission {
  if (!isRecord(value)) throw new Error("invalid-quote");
  return {
    rfqId: stringField(value, "rfqId"),
    chainId: stringField(value, "chainId"),
    validUntil: numberField(value, "validUntil"),
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

type BroadcastResult =
  | { readonly txSignature: string; readonly status: "confirmed" }
  | {
      readonly txSignature: string;
      readonly status: "failed";
      readonly error: string;
      readonly buyerFault: boolean;
    };

function parseBroadcastResult(value: unknown): BroadcastResult | null {
  if (!isRecord(value) || typeof value.txSignature !== "string") return null;
  if (value.status === "confirmed") {
    return { txSignature: value.txSignature, status: "confirmed" };
  }
  if (
    value.status === "failed" &&
    typeof value.error === "string" &&
    typeof value.buyerFault === "boolean"
  ) {
    return {
      txSignature: value.txSignature,
      status: "failed",
      error: value.error,
      buyerFault: value.buyerFault,
    };
  }
  return null;
}

async function fillNotification(
  rfq: RfqState,
  result: BroadcastResult,
  environment: ProductEnvironment
): Promise<Record<string, unknown>> {
  const market = configuredMarketByAddress(environment, rfq.market);
  if (market === null) throw new Error("unknown-market");
  const quote = rfq.bestQuote;
  if (quote === undefined) throw new Error("queued-rfq-missing-best-quote");
  const seriesId = await deriveOptionSeriesAddress({
    market,
    expiry: rfq.expiry,
    isPut: rfq.isPut,
    strike: rfq.strike,
  });
  const params: Record<string, unknown> = {
    rfqId: rfq.rfqId,
    txSig: result.txSignature,
    status: result.status,
    marketId: rfq.market,
    seriesId,
    strike: rfq.strike,
    isPut: rfq.isPut,
    expiry: rfq.expiry,
    quantity: rfq.quantity,
    premium: quote.premium,
  };
  if (result.status === "failed") params.error = result.error;
  return { jsonrpc: "2.0", method: "underwrite.fill", params };
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
