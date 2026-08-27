import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { UnderwriteRepository } from "../src/database/underwrite-repository";

describe("RFQ server", () => {
  it("exposes a health endpoint for local development", async () => {
    const response = await SELF.fetch("https://example.com/health", {
      headers: { Origin: "http://localhost:5173" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      environment: env.PRODUCT_ENVIRONMENT,
      status: "ok",
    });
  });

  it("rejects unknown browser origins", async () => {
    const response = await SELF.fetch("https://example.com/health", {
      headers: { Origin: "https://untrusted.example" },
    });

    expect(response.status).toBe(403);
  });

  it("returns confirmed underwrites for a seller", async () => {
    const statements = [
      `CREATE TABLE underwrites (
      tx_signature TEXT NOT NULL, ix_index INTEGER NOT NULL, rfq_id TEXT NOT NULL,
      status TEXT NOT NULL, seller_address TEXT NOT NULL, buyer_address TEXT NOT NULL,
      market_address TEXT NOT NULL, series_address TEXT NOT NULL, ticker TEXT NOT NULL,
      is_put INTEGER NOT NULL, expiry_ms INTEGER NOT NULL, strike TEXT NOT NULL,
      quantity TEXT NOT NULL, premium TEXT NOT NULL, base_coin_mint TEXT NOT NULL,
      quote_coin_mint TEXT NOT NULL, fee_recipient TEXT NOT NULL,
      operational_fee_bps INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
      submitted_at_ms INTEGER, confirmed_at_ms INTEGER, last_error TEXT,
      PRIMARY KEY (tx_signature, ix_index)
    )`,
      `CREATE TABLE underwrite_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tx_signature TEXT NOT NULL,
      ix_index INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, status TEXT NOT NULL
    )`,
      `CREATE TABLE option_series (
      series_address TEXT PRIMARY KEY, market_address TEXT NOT NULL, ticker TEXT NOT NULL,
      is_put INTEGER NOT NULL, expiry_ms INTEGER NOT NULL, strike TEXT NOT NULL,
      base_coin_mint TEXT NOT NULL, quote_coin_mint TEXT NOT NULL, confirmed_at_ms INTEGER NOT NULL
    )`,
    ];
    for (const statement of statements) await env.DB.prepare(statement).run();
    const repository = new UnderwriteRepository(env.DB);
    await repository.createQueued({
      txSignature: "dashboard-transaction",
      ixIndex: 0,
      rfqId: "0193c3c5-1967-7000-8000-000000000000",
      sellerAddress: "seller-dashboard",
      buyerAddress: "buyer-address",
      marketAddress: "market-address",
      seriesAddress: "series-address",
      ticker: "BTC-USDC-WBTC-01JAN25-60000-C",
      isPut: false,
      expiryMs: 1_735_689_600_000,
      strike: "6000000000000",
      quantity: "1000000000000000000",
      premium: "25000000",
      baseCoinMint: "base-mint",
      quoteCoinMint: "quote-mint",
      feeRecipient: "fee-recipient",
      operationalFeeBps: 50,
      createdAtMs: 1_735_600_000_000,
    });
    await repository.markSubmitted(
      "dashboard-transaction",
      0,
      1_735_600_001_000
    );
    await repository.markConfirmed(
      "dashboard-transaction",
      0,
      1_735_600_002_000
    );

    const response = await SELF.fetch(
      "https://example.com/sellers/seller-dashboard/underwrites"
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      underwrites: [
        { txSignature: "dashboard-transaction", status: "confirmed" },
      ],
    });
  });

  it("returns an RFQ validation error over a real seller WebSocket", async () => {
    const response = await SELF.fetch("https://example.com/taker", {
      headers: {
        Connection: "Upgrade",
        Origin: "http://localhost:5173",
        Upgrade: "websocket",
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const message = nextSocketMessage(socket);

    socket?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000000",
        method: "rfq.create",
        params: {
          asset: "unknown-base-mint",
          assetName: "BTC",
          chainId: "solana:testnet",
          expiry: 1_735_689_600,
          isPut: false,
          quantity: "10",
          strike: "6000000000000",
          collateralAsset: "unknown-base-mint",
          premiumAsset: "unknown-quote-mint",
          requestDeadline: 0,
          underwriteTx: "",
        },
      })
    );

    await expect(message).resolves.toMatchObject({
      id: "0193c3c5-1967-7000-8000-000000000000",
      error: { code: -32002, data: { reason: "unknown-market" } },
    });
    socket?.close();
  });
});

function nextSocketMessage(socket: WebSocket | null): Promise<unknown> {
  if (socket === null) throw new Error("WebSocket upgrade failed.");
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      resolve(JSON.parse(String(event.data)));
    });
  });
}
