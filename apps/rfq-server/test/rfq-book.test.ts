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
    book.create("rfq-1", terms, sellerOne);
    book.create("rfq-2", terms, sellerTwo);

    expect(
      book.addOffer(
        "rfq-1",
        { premium: "12", validUntil: 1_735_600_030, underwriteTxHash: "one" },
        1_735_600_000_000
      )
    ).toEqual({ isBest: true });
    expect(
      book.addOffer(
        "rfq-1",
        { premium: "11", validUntil: 1_735_600_030, underwriteTxHash: "two" },
        1_735_600_000_000
      )
    ).toEqual({ isBest: false });

    expect(sellerOne.send).toHaveBeenCalledTimes(1);
    expect(sellerTwo.send).not.toHaveBeenCalled();
  });

  it("consumes an RFQ after the seller submits its selected, unexpired offer", () => {
    const book = new RfqBook();
    const seller = { send: vi.fn() };
    book.create("rfq-1", terms, seller);
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
      book.consume("rfq-1", seller, "selected", 1_735_600_001_000)
    ).toEqual(terms);
    expect(() =>
      book.consume("rfq-1", seller, "selected", 1_735_600_002_000)
    ).toThrow("unknown-or-consumed-rfq");
  });
});
