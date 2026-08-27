import { describe, expect, it, vi } from "vitest";

import { RfqBook } from "../src/rfq-book";

const terms = {
  asset: "base-mint",
  assetName: "BTC",
  chainId: "solana:testnet",
  expiry: 1_735_689_600,
  isPut: false,
  quantity: "1000000000000000000",
  strike: "6000000000000",
  collateralAsset: "base-mint",
  premiumAsset: "quote-mint",
  requestDeadline: 1_735_600_040_000,
  underwriteTx: "premium-free-transaction",
};

describe("RFQ book", () => {
  it("privately routes only the improving quote to its initiating seller", () => {
    const book = new RfqBook();
    const sellerOne = { send: vi.fn() };
    const sellerTwo = { send: vi.fn() };
    const aggregationTerms = {
      ...terms,
      requestDeadline: 1_735_600_002_500,
    };
    book.create("rfq-1", aggregationTerms, sellerOne);
    book.create("rfq-2", aggregationTerms, sellerTwo);

    expect(
      book.addOffer(
        "rfq-1",
        { premium: "12", validUntil: 1_735_600_030, underwriteTxHash: "one" },
        1_735_600_000_000
      )
    ).toMatchObject({ isBest: true, providedStatus: "best" });
    expect(
      book.addOffer(
        "rfq-1",
        { premium: "11", validUntil: 1_735_600_030, underwriteTxHash: "two" },
        1_735_600_000_000
      )
    ).toMatchObject({ isBest: false, providedStatus: "notbest" });

    book.closeAggregation("rfq-1", 1_735_600_002_500);

    expect(sellerOne.send).toHaveBeenCalledTimes(1);
    expect(sellerTwo.send).not.toHaveBeenCalled();
  });

  it("accepts one selected offer after its deadline even if delivery has not run", () => {
    const book = new RfqBook();
    const seller = { send: vi.fn() };
    const aggregationEndsAtMs = 1_735_600_002_500;
    book.create(
      "rfq-1",
      { ...terms, requestDeadline: aggregationEndsAtMs },
      seller
    );
    book.addOffer(
      "rfq-1",
      {
        premium: "12",
        validUntil: 1_735_600_030,
        underwriteTxHash: "selected",
      },
      1_735_600_000_000
    );

    expect(
      book.consume("rfq-1", seller, "selected", aggregationEndsAtMs)
    ).toEqual({ ...terms, requestDeadline: aggregationEndsAtMs });
    expect(() =>
      book.consume("rfq-1", seller, "selected", 1_735_600_002_000)
    ).toThrow("unknown-or-consumed-rfq");
  });

  it("passes only the highest premium quote to the seller after aggregation", () => {
    const book = new RfqBook();
    const seller = { send: vi.fn() };
    const aggregationEndsAtMs = 1_735_600_002_500;
    book.create(
      "rfq-1",
      { ...terms, requestDeadline: aggregationEndsAtMs },
      seller
    );
    book.addOffer(
      "rfq-1",
      { premium: "12", validUntil: 1_735_600_030, underwriteTxHash: "first" },
      1_735_600_000_000
    );
    book.addOffer(
      "rfq-1",
      { premium: "13", validUntil: 1_735_600_030, underwriteTxHash: "later" },
      1_735_600_001_000
    );
    book.addOffer(
      "rfq-1",
      { premium: "13", validUntil: 1_735_600_030, underwriteTxHash: "tie" },
      1_735_600_001_500
    );

    expect(seller.send).not.toHaveBeenCalled();
    book.closeAggregation("rfq-1", aggregationEndsAtMs);
    expect(seller.send).toHaveBeenCalledWith(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "quote.best",
        params: {
          rfqId: "rfq-1",
          quote: {
            premium: "13",
            validUntil: 1_735_600_030,
            underwriteTxHash: "later",
          },
        },
      })
    );
    expect(
      book.addOffer(
        "rfq-1",
        { premium: "14", validUntil: 1_735_600_030, underwriteTxHash: "late" },
        aggregationEndsAtMs
      )
    ).toMatchObject({ isBest: false, providedStatus: "deadline" });
  });

  it("uses the deadline rather than delivery state to close aggregation", () => {
    const book = new RfqBook();
    const seller = { send: vi.fn() };
    const aggregationEndsAtMs = 1_735_600_002_500;
    book.create(
      "rfq-1",
      { ...terms, requestDeadline: aggregationEndsAtMs },
      seller
    );
    book.addOffer(
      "rfq-1",
      { premium: "12", validUntil: 1_735_600_030, underwriteTxHash: "best" },
      aggregationEndsAtMs - 1
    );

    book.closeAggregation("rfq-1", aggregationEndsAtMs - 1);
    book.closeAggregation("rfq-1", aggregationEndsAtMs);
    book.closeAggregation("rfq-1", aggregationEndsAtMs + 1);

    expect(seller.send).toHaveBeenCalledTimes(1);
    expect(
      book.addOffer(
        "rfq-1",
        { premium: "13", validUntil: 1_735_600_030, underwriteTxHash: "late" },
        aggregationEndsAtMs
      )
    ).toMatchObject({ isBest: false, providedStatus: "deadline" });
  });
});
