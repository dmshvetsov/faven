export interface RfqTerms {
  readonly asset: string;
  readonly assetName: string;
  readonly chainId: string;
  readonly expiry: number;
  readonly isPut: boolean;
  readonly quantity: string;
  readonly strike: string;
  readonly collateralAsset: string;
  readonly premiumAsset: string;
  readonly requestDeadline: number;
  readonly underwriteTx: string;
}

export interface RfqOffer {
  readonly premium: string;
  readonly validUntil: number;
  readonly underwriteTxHash: string;
  readonly quote?: unknown;
}

export interface RfqSocket {
  send(message: string): void;
}

interface ActiveRfq {
  readonly terms: RfqTerms;
  readonly seller: RfqSocket;
  bestOffer: RfqOffer | undefined;
  quoteDelivered: boolean;
}

export type QuoteStatus =
  "best" | "not_best" | "best_received_later" | "deadline";

export interface QuoteResult {
  readonly isBest: boolean;
  readonly providedStatus: QuoteStatus;
  readonly bestOffer: RfqOffer | undefined;
}

export class RfqBook {
  private readonly rfqs = new Map<string, ActiveRfq>();

  create(rfqId: string, terms: RfqTerms, seller: RfqSocket): void {
    if (this.rfqs.has(rfqId)) throw new Error("duplicate-rfq-id");
    this.rfqs.set(rfqId, {
      terms,
      seller,
      bestOffer: undefined,
      quoteDelivered: false,
    });
  }

  addOffer(rfqId: string, offer: RfqOffer, nowMs: number): QuoteResult {
    const rfq = this.getActive(rfqId);
    if (nowMs >= rfq.terms.requestDeadline) {
      return {
        isBest: false,
        providedStatus: "deadline",
        bestOffer: rfq.bestOffer,
      };
    }
    if (
      offer.validUntil * 1_000 <= nowMs ||
      offer.validUntil * 1_000 > nowMs + 40_000
    ) {
      throw new Error("expired-or-overlong-offer");
    }
    const existingBest = rfq.bestOffer;
    const isBest =
      existingBest === undefined ||
      BigInt(offer.premium) > BigInt(existingBest.premium);
    if (isBest) {
      rfq.bestOffer = offer;
    }
    return {
      isBest,
      providedStatus: isBest
        ? "best"
        : BigInt(offer.premium) === BigInt(existingBest.premium)
          ? "best_received_later"
          : "not_best",
      bestOffer: rfq.bestOffer,
    };
  }

  consume(
    rfqId: string,
    seller: RfqSocket,
    transactionHash: string,
    nowMs: number
  ): RfqTerms {
    const rfq = this.getActive(rfqId);
    if (rfq.seller !== seller) throw new Error("unknown-or-consumed-rfq");
    if (nowMs < rfq.terms.requestDeadline) {
      throw new Error("rfq-aggregation-open");
    }
    if (
      rfq.bestOffer === undefined ||
      rfq.bestOffer.underwriteTxHash !== transactionHash
    ) {
      throw new Error("transaction-does-not-match-offer");
    }
    if (rfq.bestOffer.validUntil * 1_000 <= nowMs) {
      throw new Error("expired-or-overlong-offer");
    }
    this.rfqs.delete(rfqId);
    return rfq.terms;
  }

  closeAggregation(rfqId: string, nowMs: number): void {
    const rfq = this.rfqs.get(rfqId);
    if (
      rfq === undefined ||
      rfq.quoteDelivered ||
      nowMs < rfq.terms.requestDeadline
    ) {
      return;
    }
    if (
      rfq.bestOffer === undefined ||
      rfq.bestOffer.validUntil * 1_000 <= nowMs
    ) {
      return;
    }
    rfq.seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "quote.best",
        params: { rfqId, quote: rfq.bestOffer.quote ?? rfq.bestOffer },
      })
    );
    rfq.quoteDelivered = true;
  }

  removeForSeller(seller: RfqSocket): void {
    for (const [rfqId, rfq] of this.rfqs) {
      if (rfq.seller === seller) this.rfqs.delete(rfqId);
    }
  }

  details(rfqId: string): {
    readonly terms: RfqTerms;
    readonly bestOffer: RfqOffer | undefined;
  } {
    const rfq = this.getActive(rfqId);
    return { terms: rfq.terms, bestOffer: rfq.bestOffer };
  }

  private getActive(rfqId: string): ActiveRfq {
    const rfq = this.rfqs.get(rfqId);
    if (rfq === undefined) throw new Error("unknown-or-consumed-rfq");
    return rfq;
  }
}
