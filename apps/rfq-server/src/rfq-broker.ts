import {
  getSignatureFromTransaction,
  getTransactionDecoder,
} from "@solana/kit";

import type { BroadcastTask } from "./broadcast";
import { configuredMarket } from "./config";
import { UnderwriteRepository } from "./database/underwrite-repository";
import { tickerForSeries } from "./format";
import { RfqBook } from "./rfq-book";
import { jsonRpcError, jsonRpcResult, parseJsonRpcRequest } from "./rfq-rpc";
import {
  offerTransactionHash,
  signedTransactionHash,
  validateSignedUnderwrite,
} from "./transaction-validation";
import {
  parseBuyerQuote,
  parseRfqTerms,
  parseUnderwriteSubmission,
  validateQuoteMatchesRfq,
} from "./wire";
import type { Env } from "./worker";

export class RfqBroker implements DurableObject {
  private readonly rfqs = new RfqBook();
  private readonly buyers = new Map<WebSocket, string>();
  private readonly sellers = new Set<WebSocket>();

  constructor(
    readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  fetch(request: Request): Response {
    const url = new URL(request.url);
    const asset = assetFromBuyerPath(url.pathname);
    const role =
      asset !== null || url.pathname === "/maker"
        ? "buyer"
        : url.pathname === "/taker"
          ? "seller"
          : null;
    if (role === null || request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket endpoint not found.", { status: 404 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    if (role === "buyer") this.buyers.set(server, asset ?? "");
    else this.sellers.add(server);
    server.addEventListener("message", (event) => {
      void this.handleMessage(server, role, event.data);
    });
    server.addEventListener("close", () => this.removeSocket(server));
    server.addEventListener("error", () => this.removeSocket(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleMessage(
    socket: WebSocket,
    role: "buyer" | "seller",
    data: unknown
  ): Promise<void> {
    let id: string | null = null;
    try {
      const request = parseJsonRpcRequest(await messageText(data));
      id = request.id;
      if (role === "seller" && request.method === "rfq.create") {
        await this.createRfq(socket, request.id, request.params);
        return;
      }
      if (role === "seller" && request.method === "underwrite.submit") {
        await this.submitUnderwrite(socket, request.id, request.params);
        return;
      }
      if (role === "buyer" && request.method === "quote") {
        await this.submitQuote(socket, request.id, request.params);
        return;
      }
      socket.send(
        jsonRpcError(id, -32601, "Unknown method.", "unknown-method")
      );
    } catch (error) {
      socket.send(
        jsonRpcError(
          id,
          -32002,
          "RFQ request was rejected.",
          errorMessage(error)
        )
      );
    }
  }

  private async createRfq(
    socket: WebSocket,
    rfqId: string,
    params: unknown
  ): Promise<void> {
    const original = parseRfqTerms(params);
    const market = configuredMarket(
      this.env.PRODUCT_ENVIRONMENT,
      original.asset
    );
    if (market === null) throw new Error("unknown-market");
    const terms = { ...original, requestDeadline: Date.now() + 40_000 };
    const { validateRfqTerms } = await import("./rfq-validation");
    validateRfqTerms(terms, market, this.env.SOLANA_CLUSTER);
    this.rfqs.create(rfqId, terms, socket);
    const rfqRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: rfqId,
      result: terms,
    });
    for (const [buyer, asset] of this.buyers) {
      if (asset === terms.asset) buyer.send(rfqRequest);
    }
    socket.send(
      jsonRpcResult(rfqId, { requestDeadline: terms.requestDeadline })
    );
  }

  private async submitQuote(
    socket: WebSocket,
    rfqId: string,
    params: unknown
  ): Promise<void> {
    const buyerAsset = this.buyers.get(socket);
    const details = this.rfqs.details(rfqId);
    if (buyerAsset !== "" && buyerAsset !== details.terms.asset) {
      throw new Error("buyer-not-subscribed-to-rfq-asset");
    }
    const quote = parseBuyerQuote(params);
    validateQuoteMatchesRfq(quote, details.terms);
    const market = configuredMarket(
      this.env.PRODUCT_ENVIRONMENT,
      details.terms.asset
    );
    if (market === null) throw new Error("unknown-market");
    await validateSignedUnderwrite(
      quote.underwriteTx,
      details.terms,
      quote.premium,
      market,
      false
    );
    const underwriteTxHash = await offerTransactionHash(quote.underwriteTx);
    this.rfqs.addOffer(
      rfqId,
      { ...quote, underwriteTxHash, quote },
      Date.now()
    );
  }

  private async submitUnderwrite(
    socket: WebSocket,
    requestId: string,
    params: unknown
  ): Promise<void> {
    const submission = parseUnderwriteSubmission(params);
    const details = this.rfqs.details(submission.rfqId);
    const offer = details.bestOffer;
    if (offer === undefined)
      throw new Error("transaction-does-not-match-offer");
    const market = configuredMarket(
      this.env.PRODUCT_ENVIRONMENT,
      details.terms.asset
    );
    if (market === null) throw new Error("unknown-market");
    const validated = await validateSignedUnderwrite(
      submission.underwriteTx,
      details.terms,
      offer.premium,
      market,
      true
    );
    const transactionHash = await signedTransactionHash(
      submission.underwriteTx
    );
    const offerHash = await offerTransactionHash(submission.underwriteTx);
    this.rfqs.consume(submission.rfqId, socket, offerHash, Date.now());
    const txSignature = sellerTransactionSignature(submission.underwriteTx);
    const createdAtMs = Date.now();
    const repository = new UnderwriteRepository(this.env.DB);
    const created = await repository.createQueued({
      txSignature,
      ixIndex: validated.ixIndex,
      rfqId: submission.rfqId,
      sellerAddress: validated.sellerAddress,
      buyerAddress: validated.buyerAddress,
      marketAddress: market.marketAddress,
      seriesAddress: validated.seriesAddress,
      ticker: tickerForSeries({
        oracleBase: market.oracleBase,
        quoteCoinSymbol: market.quoteCoinSymbol,
        baseCoinSymbol: market.baseCoinSymbol,
        expirySeconds: details.terms.expiry,
        isPut: details.terms.isPut,
        strike: BigInt(details.terms.strike),
        strikeDecimals: 8,
      }),
      isPut: details.terms.isPut,
      expiryMs: details.terms.expiry * 1_000,
      strike: details.terms.strike,
      quantity: details.terms.quantity,
      premium: offer.premium,
      baseCoinMint: market.baseCoinMint,
      quoteCoinMint: market.quoteCoinMint,
      feeRecipient: market.feeRecipient,
      operationalFeeBps: market.operationalFeeBps,
      createdAtMs,
    });
    if (created.created) {
      const task: BroadcastTask = {
        txSignature,
        ixIndex: validated.ixIndex,
        signedTransaction: submission.underwriteTx,
      };
      await this.env.BROADCAST_QUEUE.send(task);
    }
    socket.send(
      jsonRpcResult(requestId, {
        rfqId: submission.rfqId,
        txHash: transactionHash,
        status: "queued",
      })
    );
  }

  private removeSocket(socket: WebSocket): void {
    this.buyers.delete(socket);
    this.sellers.delete(socket);
    this.rfqs.removeForSeller(socket);
  }
}

function assetFromBuyerPath(pathname: string): string | null {
  const prefix = "/rfqs/";
  if (!pathname.startsWith(prefix) || pathname.length === prefix.length)
    return null;
  return decodeURIComponent(pathname.slice(prefix.length));
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Blob) return data.text();
  throw new Error("WebSocket message must be text.");
}

function sellerTransactionSignature(encodedTransaction: string): string {
  const bytes = Uint8Array.from(atob(encodedTransaction), (value) =>
    value.charCodeAt(0)
  );
  return getSignatureFromTransaction(getTransactionDecoder().decode(bytes));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid-request";
}
