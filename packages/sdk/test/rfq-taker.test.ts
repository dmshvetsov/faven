import { validate as validateUuid, version as uuidVersion } from "uuid";
import { describe, expect, it } from "vitest";

import {
  createRfqRequest,
  createUnderwriteSubmitRequest,
  parseTakerMessage,
  PREVIEW_SELLER_ADDRESS,
  quoteMatchesTerms,
  isQuoteValid,
  takerWebSocketUrl,
} from "../src/index.js";

describe("RFQ taker protocol", () => {
  it("derives the taker socket URL from an HTTP base URL", () => {
    expect(
      takerWebSocketUrl(
        "https://rfq.example.test/api?ignored=true#ignored"
      ).toString()
    ).toBe("wss://rfq.example.test/api/taker");
  });

  it("creates an RFQ request with separate UUIDv7 request and RFQ IDs", () => {
    const request = createRfqRequest({
      market: "market-address",
      expiry: 1_774_000_000,
      isPut: false,
      quantity: "1200000000000000000",
      strike: "15000000000",
      seller: PREVIEW_SELLER_ADDRESS,
      sellerCollateralSource: PREVIEW_SELLER_ADDRESS,
      sellerQuoteDestination: PREVIEW_SELLER_ADDRESS,
      premiumAsset: "quote-mint",
      collateralAsset: "base-mint",
    });

    expect(request).toMatchObject({
      jsonrpc: "2.0",
      method: "rfq.create",
      params: {
        market: "market-address",
        expiry: 1_774_000_000,
        isPut: false,
        quantity: "1200000000000000000",
        strike: "15000000000",
        seller: PREVIEW_SELLER_ADDRESS,
        sellerCollateralSource: PREVIEW_SELLER_ADDRESS,
        sellerQuoteDestination: PREVIEW_SELLER_ADDRESS,
      },
    });
    expect(validateUuid(request.id)).toBe(true);
    expect(uuidVersion(request.id)).toBe(7);
    expect(validateUuid(request.params.rfqId)).toBe(true);
    expect(uuidVersion(request.params.rfqId)).toBe(7);
    expect(request.id).not.toBe(request.params.rfqId);
  });

  it("rejects a create request with a non-integer fixed-point amount", () => {
    expect(() =>
      createRfqRequest({
        market: "market-address",
        expiry: 1_774_000_000,
        isPut: false,
        quantity: "1.2",
        strike: "15000000000",
        seller: PREVIEW_SELLER_ADDRESS,
        sellerCollateralSource: PREVIEW_SELLER_ADDRESS,
        premiumAsset: "quote-mint",
        collateralAsset: "base-mint",
      })
    ).toThrow("invalid_quantity");
  });

  it("parses a matching RFQ creation response", () => {
    expect(
      parseTakerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "0193c3c5-1967-7000-8000-000000000042",
          result: {
            rfqId: "0193c3c5-1967-7000-8000-000000000043",
            requestDeadline: 1_774_000_000_000,
          },
        })
      )
    ).toEqual({
      jsonrpc: "2.0",
      id: "0193c3c5-1967-7000-8000-000000000042",
      result: {
        rfqId: "0193c3c5-1967-7000-8000-000000000043",
        requestDeadline: 1_774_000_000_000,
      },
    });
  });

  it("creates and parses an underwrite submission response", () => {
    const request = createUnderwriteSubmitRequest({
      rfqId: "0193c3c5-1967-7000-8000-000000000043",
      underwriteTx: "signed-base64-transaction",
    });

    expect(request).toMatchObject({
      jsonrpc: "2.0",
      method: "underwrite.submit",
      params: {
        rfqId: "0193c3c5-1967-7000-8000-000000000043",
        underwriteTx: "signed-base64-transaction",
      },
    });
    expect(validateUuid(request.id)).toBe(true);
    expect(uuidVersion(request.id)).toBe(7);
    expect(
      parseTakerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            rfqId: request.params.rfqId,
            txSignature: "4vJ9JU1bJJ1AAgWnY8kC2fB4uNHt2uVXiCjfMxs4YzkW",
            status: "queued",
          },
        })
      )
    ).toEqual({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        rfqId: request.params.rfqId,
        txSignature: "4vJ9JU1bJJ1AAgWnY8kC2fB4uNHt2uVXiCjfMxs4YzkW",
        status: "queued",
      },
    });
  });

  it("parses a complete best-quote notification", () => {
    const notification = bestQuoteNotification();

    expect(parseTakerMessage(JSON.stringify(notification))).toEqual(
      notification
    );
  });

  it("rejects a malformed best quote", () => {
    const notification = bestQuoteNotification();
    const malformed = {
      ...notification,
      params: {
        ...notification.params,
        quote: { ...notification.params.quote, premium: "2.5" },
      },
    };

    expect(() => parseTakerMessage(JSON.stringify(malformed))).toThrow(
      "invalid_taker_message"
    );
  });

  it("parses the no-buyers quote notification", () => {
    expect(
      parseTakerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "quote.best",
          params: {
            rfqId: "0193c3c5-1967-7000-8000-000000000043",
            noQuoteReason: "no_buyers",
          },
        })
      )
    ).toEqual({
      jsonrpc: "2.0",
      method: "quote.best",
      params: {
        rfqId: "0193c3c5-1967-7000-8000-000000000043",
        noQuoteReason: "no_buyers",
      },
    });
  });

  it("parses a JSON-RPC error response", () => {
    expect(
      parseTakerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "0193c3c5-1967-7000-8000-000000000042",
          error: {
            code: 1002,
            message: "rfq-terms-do-not-match-market",
            data: { rfqId: "0193c3c5-1967-7000-8000-000000000043" },
          },
        })
      )
    ).toEqual({
      jsonrpc: "2.0",
      id: "0193c3c5-1967-7000-8000-000000000042",
      error: {
        code: 1002,
        message: "rfq-terms-do-not-match-market",
        data: { rfqId: "0193c3c5-1967-7000-8000-000000000043" },
      },
    });
  });

  it("accepts only a quote that matches every active RFQ term", () => {
    const quote = bestQuoteNotification().params.quote;
    const terms = {
      rfqId: quote.rfqId,
      market: "market-address",
      expiry: quote.expiry,
      isPut: quote.isPut,
      quantity: quote.quantity,
      strike: quote.strike,
      seller: PREVIEW_SELLER_ADDRESS,
      sellerCollateralSource: PREVIEW_SELLER_ADDRESS,
      premiumAsset: quote.premiumAsset,
      collateralAsset: quote.collateralAsset,
    };

    expect(quoteMatchesTerms(quote, terms)).toBe(true);
    expect(
      quoteMatchesTerms(
        { ...quote, collateralAsset: "unexpected-collateral-mint" },
        terms
      )
    ).toBe(false);
  });

  it("accepts a quote only before its valid-until second", () => {
    const quote = bestQuoteNotification().params.quote;

    expect(isQuoteValid(quote, 1_774_000_099_999)).toBe(true);
    expect(isQuoteValid(quote, 1_774_000_100_000)).toBe(false);
  });
});

function bestQuoteNotification() {
  return {
    jsonrpc: "2.0" as const,
    method: "quote.best" as const,
    params: {
      rfqId: "0193c3c5-1967-7000-8000-000000000043",
      quote: {
        rfqId: "0193c3c5-1967-7000-8000-000000000043",
        assetAddress: "base-mint",
        chainId: "solana:devnet",
        expiry: 1_774_000_000,
        isPut: false,
        maker: "maker-address",
        quantity: "1200000000000000000",
        strike: "15000000000",
        premiumAsset: "quote-mint",
        collateralAsset: "base-mint",
        validUntil: 1_774_000_100,
        premium: "2500000000000000000",
        underwriteTx: "base64-transaction",
      },
    },
  };
}
