import { describe, expect, it } from "vitest";

import { parseJsonRpcRequest } from "../src/rfq-rpc";
import { parseRfqTerms } from "../src/wire";

describe("JSON-RPC requests", () => {
  it("accepts a UUIDv7 request envelope", () => {
    expect(
      parseJsonRpcRequest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "0193c3c5-1967-7000-8000-000000000000",
          method: "rfq.create",
          params: {},
        })
      )
    ).toMatchObject({ method: "rfq.create" });
  });

  it("rejects non-v7 and malformed request envelopes", () => {
    expect(() => parseJsonRpcRequest("{}")).toThrow("Invalid JSON-RPC request");
    expect(() =>
      parseJsonRpcRequest(
        JSON.stringify({ jsonrpc: "2.0", id: "not-a-uuid", method: "quote" })
      )
    ).toThrow("Invalid JSON-RPC request");
  });
});

describe("seller RFQ wire format", () => {
  it("lets the server generate the request deadline", () => {
    expect(
      parseRfqTerms({
        asset: "base-mint",
        assetName: "BTC",
        chainId: "solana:testnet",
        expiry: 1_735_689_600,
        isPut: false,
        quantity: "10",
        strike: "6000000000000",
        collateralAsset: "base-mint",
        premiumAsset: "quote-mint",
        underwriteTx: "transaction",
      })
    ).not.toHaveProperty("requestDeadline");
  });
});
