import { env, SELF } from "cloudflare:test";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { describe, expect, it } from "vitest";

import { UnderwriteRepository } from "../src/database/underwrite-repository";
import { rfqBrokerName } from "../src/worker";

Object.defineProperty(globalThis, "isSecureContext", { value: true });

describe("RFQ server", () => {
  it("uses a distinct broker name for each BaseCoin mint", () => {
    expect(rfqBrokerName("base-coin-one")).not.toBe(
      rfqBrokerName("base-coin-two")
    );
  });

  it("routes a configured seller RFQ only to buyers of its BaseCoin", async () => {
    const baseCoinMint = "So11111111111111111111111111111111111111112";
    const sellerResponse = await SELF.fetch(
      `https://example.com/taker?asset=${baseCoinMint}`,
      webSocketHeaders()
    );
    const buyerResponse = await SELF.fetch(
      `https://example.com/rfqs/${baseCoinMint}`,
      webSocketHeaders()
    );
    const seller = acceptSocket(sellerResponse);
    const buyer = acceptSocket(buyerResponse);
    const sellerMessage = nextSocketMessage(seller);
    const buyerMessage = nextSocketMessage(buyer);

    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000010",
        method: "rfq.create",
        params: configuredRfq(baseCoinMint),
      })
    );

    await expect(buyerMessage).resolves.toMatchObject({
      id: "0193c3c5-1967-7000-8000-000000000010",
      result: { asset: baseCoinMint, requestDeadline: expect.any(Number) },
    });
    await expect(sellerMessage).resolves.toMatchObject({
      id: "0193c3c5-1967-7000-8000-000000000010",
      result: { requestDeadline: expect.any(Number) },
    });
    seller.close();
    buyer.close();
  });

  it("privately selects one buyer quote and consumes it after seller submission", async () => {
    await createUnderwriteTables();
    const fixture = await createQuoteFixture();
    const seller = acceptSocket(
      await SELF.fetch(
        `https://example.com/taker?asset=${fixture.baseCoinMint}`,
        webSocketHeaders()
      )
    );
    const feed = acceptSocket(
      await SELF.fetch(
        `https://example.com/rfqs/${fixture.baseCoinMint}`,
        webSocketHeaders()
      )
    );
    const maker = acceptSocket(
      await SELF.fetch(
        `https://example.com/maker?asset=${fixture.baseCoinMint}`,
        webSocketHeaders()
      )
    );
    const rfqId = "0193c3c5-1967-7000-8000-000000000020";
    const sellerCreated = nextSocketMessage(seller);
    const buyerReceivedRfq = nextSocketMessage(feed);

    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rfqId,
        method: "rfq.create",
        params: configuredRfq(fixture.baseCoinMint, fixture.template),
      })
    );

    await expect(buyerReceivedRfq).resolves.toMatchObject({ id: rfqId });
    await expect(sellerCreated).resolves.toMatchObject({
      id: rfqId,
      result: { requestDeadline: expect.any(Number) },
    });
    const quote = {
      assetAddress: fixture.baseCoinMint,
      chainId: "solana:testnet",
      expiry: 1_735_689_600,
      isPut: false,
      maker: fixture.buyer.address,
      quantity: "10",
      strike: "6000000000000",
      collateralAsset: fixture.baseCoinMint,
      validUntil: Math.floor(Date.now() / 1_000) + 30,
      premium: "25",
      underwriteTx: fixture.buyerSigned,
    };
    const quoteStatus = nextSocketMessage(maker);
    const sellerBestQuote = nextSocketMessage(seller);
    maker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rfqId,
        method: "quote",
        params: quote,
      })
    );

    await expect(quoteStatus).resolves.toMatchObject({
      id: rfqId,
      result: { bestQuote: "25", providedStatus: "best" },
    });
    const tiedQuoteStatus = nextSocketMessage(maker);
    maker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rfqId,
        method: "quote",
        params: quote,
      })
    );
    await expect(tiedQuoteStatus).resolves.toMatchObject({
      id: rfqId,
      result: { bestQuote: "25", providedStatus: "best_received_later" },
    });
    await expect(sellerBestQuote).resolves.toMatchObject({
      method: "quote.best",
      params: { rfqId, quote: { premium: "25" } },
    });
    const lateQuoteStatus = nextSocketMessage(maker);
    maker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rfqId,
        method: "quote",
        params: { ...quote, premium: "26" },
      })
    );
    await expect(lateQuoteStatus).resolves.toMatchObject({
      id: rfqId,
      result: { bestQuote: "25", providedStatus: "deadline" },
    });

    const submissionId = "0193c3c5-1967-7000-8000-000000000021";
    const submitted = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: submissionId,
        method: "underwrite.submit",
        params: { rfqId, underwriteTx: fixture.fullySigned },
      })
    );
    await expect(submitted).resolves.toMatchObject({
      id: submissionId,
      result: { rfqId, status: "queued" },
    });

    const replay = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000022",
        method: "underwrite.submit",
        params: { rfqId, underwriteTx: fixture.fullySigned },
      })
    );
    await expect(replay).resolves.toMatchObject({
      error: {
        code: -32001,
        data: { reason: "unknown-or-consumed-rfq", rfqId },
      },
    });
    seller.close();
    feed.close();
    maker.close();
  }, 10_000);

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
      `CREATE TABLE IF NOT EXISTS underwrites (
      tx_signature TEXT NOT NULL, ix_index INTEGER NOT NULL, rfq_id TEXT NOT NULL,
      status TEXT NOT NULL, seller_address TEXT NOT NULL, buyer_address TEXT NOT NULL,
      market_address TEXT NOT NULL, series_address TEXT NOT NULL, ticker TEXT NOT NULL,
      is_put INTEGER NOT NULL, expiry_ms INTEGER NOT NULL, strike TEXT NOT NULL,
      quantity TEXT NOT NULL, premium TEXT NOT NULL, base_coin_mint TEXT NOT NULL,
      quote_coin_mint TEXT NOT NULL, fee_recipient TEXT NOT NULL,
      operational_fee_bps INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
      submitted_at_ms INTEGER, confirmed_at_ms INTEGER, confirmed_receipt TEXT, last_error TEXT,
      PRIMARY KEY (tx_signature, ix_index)
    )`,
      `CREATE TABLE IF NOT EXISTS underwrite_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tx_signature TEXT NOT NULL,
      ix_index INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
      UNIQUE (tx_signature, ix_index, status)
    )`,
      `CREATE TABLE IF NOT EXISTS option_series (
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
    const response = await SELF.fetch(
      "https://example.com/taker?asset=So11111111111111111111111111111111111111112",
      {
        headers: {
          Connection: "Upgrade",
          Origin: "http://localhost:5173",
          Upgrade: "websocket",
        },
      }
    );
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
          underwriteTx: "",
        },
      })
    );

    await expect(message).resolves.toMatchObject({
      id: "0193c3c5-1967-7000-8000-000000000000",
      error: {
        code: -32002,
        data: {
          reason: "unknown-market",
          rfqId: "0193c3c5-1967-7000-8000-000000000000",
        },
      },
    });
    socket?.close();
  });

  it("rejects a seller supplied RFQ aggregation deadline", async () => {
    const baseCoinMint = "So11111111111111111111111111111111111111112";
    const seller = acceptSocket(
      await SELF.fetch(
        `https://example.com/taker?asset=${baseCoinMint}`,
        webSocketHeaders()
      )
    );
    const response = nextSocketMessage(seller);
    const rfqId = "0193c3c5-1967-7000-8000-000000000030";

    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rfqId,
        method: "rfq.create",
        params: { ...configuredRfq(baseCoinMint), requestDeadline: 0 },
      })
    );

    await expect(response).resolves.toMatchObject({
      id: rfqId,
      error: {
        code: -32600,
        data: {
          reason: "server-assigned-request-deadline",
          rfqId,
        },
      },
    });
    seller.close();
  });

  it("returns confirmed positions for the requested buyer and market", async () => {
    await createUnderwriteTables();
    const repository = new UnderwriteRepository(env.DB);
    const position = {
      txSignature: "buyer-position-transaction",
      ixIndex: 0,
      rfqId: "0193c3c5-1967-7000-8000-000000000031",
      sellerAddress: "seller-address",
      buyerAddress: "buyer-position-address",
      marketAddress: "market-address",
      seriesAddress: "buyer-position-series",
      ticker: "SOL-USDC-SOL-01JAN25-60000-C",
      isPut: false,
      expiryMs: 1_735_689_600_000,
      strike: "6000000000000",
      quantity: "10",
      premium: "25",
      baseCoinMint: "So11111111111111111111111111111111111111112",
      quoteCoinMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      feeRecipient: "fee-recipient",
      operationalFeeBps: 50,
      createdAtMs: 1_735_600_000_000,
    };
    await repository.createQueued(position);
    await repository.markSubmitted(position.txSignature, position.ixIndex, 1);
    await repository.markConfirmed(position.txSignature, position.ixIndex, 2);
    const maker = acceptSocket(
      await SELF.fetch(
        `https://example.com/maker?asset=${position.baseCoinMint}`,
        webSocketHeaders()
      )
    );
    const response = nextSocketMessage(maker);

    maker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000032",
        method: "positions",
        params: { account: position.buyerAddress },
      })
    );

    await expect(response).resolves.toMatchObject({
      id: "0193c3c5-1967-7000-8000-000000000032",
      result: {
        positions: [
          {
            txSignature: position.txSignature,
            buyerAddress: position.buyerAddress,
            status: "confirmed",
          },
        ],
      },
    });
    maker.close();
  });

  it("rejects a buyer RFQ feed for an unconfigured BaseCoin", async () => {
    const response = await SELF.fetch(
      "https://example.com/rfqs/unconfigured-base-mint",
      {
        headers: {
          Connection: "Upgrade",
          Origin: "http://localhost:5173",
          Upgrade: "websocket",
        },
      }
    );

    expect(response.status).toBe(404);
  });
});

function webSocketHeaders(): RequestInit {
  return {
    headers: {
      Connection: "Upgrade",
      Origin: "http://localhost:5173",
      Upgrade: "websocket",
    },
  };
}

function acceptSocket(response: Response): WebSocket {
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).not.toBeNull();
  if (socket === null) throw new Error("WebSocket upgrade failed.");
  socket.accept();
  return socket;
}

function configuredRfq(
  asset: string,
  underwriteTx = "premium-free-transaction"
): Record<string, unknown> {
  return {
    asset,
    assetName: "SOL",
    chainId: "solana:testnet",
    expiry: 1_735_689_600,
    isPut: false,
    quantity: "10",
    strike: "6000000000000",
    collateralAsset: asset,
    premiumAsset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    underwriteTx,
  };
}

interface QuoteFixture {
  readonly baseCoinMint: string;
  readonly buyer: KeyPairSigner;
  readonly template: string;
  readonly buyerSigned: string;
  readonly fullySigned: string;
}

async function createQuoteFixture(): Promise<QuoteFixture> {
  const signers = await Promise.all(
    Array.from({ length: 16 }, () => generateKeyPairSigner())
  );
  const [
    buyer,
    seller,
    series,
    longMint,
    buyerLongAta,
    buyerQuoteSource,
    sellerCollateralSource,
    sellerQuoteAta,
    feeRecipientQuoteAta,
    sellerVault,
    baseCollateralVault,
    quoteCollateralVault,
    tokenProgram,
    associatedTokenProgram,
    systemProgram,
  ] = signers;
  const accounts = {
    buyer,
    seller,
    optionsProgram: address("11111111111111111111111111111111"),
    market: address("11111111111111111111111111111111"),
    baseCoinMint: address("So11111111111111111111111111111111111111112"),
    quoteCoinMint: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    series: series.address,
    longMint: longMint.address,
    buyerLongAta: buyerLongAta.address,
    buyerQuoteSource: buyerQuoteSource.address,
    sellerCollateralSource: sellerCollateralSource.address,
    sellerQuoteAta: sellerQuoteAta.address,
    feeRecipient: address("11111111111111111111111111111111"),
    feeRecipientQuoteAta: feeRecipientQuoteAta.address,
    sellerVault: sellerVault.address,
    baseCollateralVault: baseCollateralVault.address,
    quoteCollateralVault: quoteCollateralVault.address,
    tokenProgram: tokenProgram.address,
    associatedTokenProgram: associatedTokenProgram.address,
    systemProgram: systemProgram.address,
  };
  return {
    baseCoinMint: accounts.baseCoinMint,
    buyer,
    template: await encodeUnderwrite(accounts, 0, []),
    buyerSigned: await encodeUnderwrite(accounts, 25, [buyer]),
    fullySigned: await encodeUnderwrite(accounts, 25, [buyer, seller]),
  };
}

type UnderwriteAccounts = {
  readonly buyer: KeyPairSigner;
  readonly seller: KeyPairSigner;
  readonly optionsProgram: Address;
  readonly market: Address;
  readonly baseCoinMint: Address;
  readonly quoteCoinMint: Address;
  readonly series: Address;
  readonly longMint: Address;
  readonly buyerLongAta: Address;
  readonly buyerQuoteSource: Address;
  readonly sellerCollateralSource: Address;
  readonly sellerQuoteAta: Address;
  readonly feeRecipient: Address;
  readonly feeRecipientQuoteAta: Address;
  readonly sellerVault: Address;
  readonly baseCollateralVault: Address;
  readonly quoteCollateralVault: Address;
  readonly tokenProgram: Address;
  readonly associatedTokenProgram: Address;
  readonly systemProgram: Address;
};

async function encodeUnderwrite(
  accounts: UnderwriteAccounts,
  premium: number,
  signers: readonly KeyPairSigner[]
): Promise<string> {
  const data = new Uint8Array(26);
  data.set([0xe3, 0x33, 0x07, 0x44, 0xf3, 0xe8, 0x20, 0xf6]);
  new DataView(data.buffer).setBigUint64(8, 10n, true);
  new DataView(data.buffer).setBigUint64(16, BigInt(premium), true);
  new DataView(data.buffer).setUint16(24, 50, true);
  const message = appendTransactionMessageInstructions(
    [
      {
        programAddress: accounts.optionsProgram,
        data,
        accounts: [
          {
            address: accounts.buyer.address,
            role: AccountRole.READONLY_SIGNER,
          },
          {
            address: accounts.seller.address,
            role: AccountRole.WRITABLE_SIGNER,
          },
          { address: accounts.market, role: AccountRole.READONLY },
          { address: accounts.baseCoinMint, role: AccountRole.READONLY },
          { address: accounts.quoteCoinMint, role: AccountRole.READONLY },
          { address: accounts.series, role: AccountRole.WRITABLE },
          { address: accounts.longMint, role: AccountRole.WRITABLE },
          { address: accounts.buyerLongAta, role: AccountRole.WRITABLE },
          { address: accounts.buyerQuoteSource, role: AccountRole.WRITABLE },
          {
            address: accounts.sellerCollateralSource,
            role: AccountRole.WRITABLE,
          },
          { address: accounts.sellerQuoteAta, role: AccountRole.WRITABLE },
          { address: accounts.feeRecipient, role: AccountRole.READONLY },
          {
            address: accounts.feeRecipientQuoteAta,
            role: AccountRole.WRITABLE,
          },
          { address: accounts.sellerVault, role: AccountRole.WRITABLE },
          { address: accounts.baseCollateralVault, role: AccountRole.WRITABLE },
          {
            address: accounts.quoteCollateralVault,
            role: AccountRole.WRITABLE,
          },
          { address: accounts.tokenProgram, role: AccountRole.READONLY },
          {
            address: accounts.associatedTokenProgram,
            role: AccountRole.READONLY,
          },
          { address: accounts.systemProgram, role: AccountRole.READONLY },
        ],
      },
    ],
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash("11111111111111111111111111111111"),
        lastValidBlockHeight: 100n,
      },
      setTransactionMessageFeePayer(
        accounts.seller.address,
        createTransactionMessage({ version: "legacy" })
      )
    )
  );
  const transaction = await partiallySignTransaction(
    signers.map((signer) => signer.keyPair),
    compileTransaction(message)
  );
  return getBase64EncodedWireTransaction(transaction);
}

async function createUnderwriteTables(): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS underwrites (
      tx_signature TEXT NOT NULL, ix_index INTEGER NOT NULL, rfq_id TEXT NOT NULL,
      status TEXT NOT NULL, seller_address TEXT NOT NULL, buyer_address TEXT NOT NULL,
      market_address TEXT NOT NULL, series_address TEXT NOT NULL, ticker TEXT NOT NULL,
      is_put INTEGER NOT NULL, expiry_ms INTEGER NOT NULL, strike TEXT NOT NULL,
      quantity TEXT NOT NULL, premium TEXT NOT NULL, base_coin_mint TEXT NOT NULL,
      quote_coin_mint TEXT NOT NULL, fee_recipient TEXT NOT NULL,
      operational_fee_bps INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
      submitted_at_ms INTEGER, confirmed_at_ms INTEGER, confirmed_receipt TEXT, last_error TEXT,
      PRIMARY KEY (tx_signature, ix_index)
    )`,
    `CREATE TABLE IF NOT EXISTS underwrite_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tx_signature TEXT NOT NULL,
      ix_index INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
      UNIQUE (tx_signature, ix_index, status)
    )`,
    `CREATE TABLE IF NOT EXISTS option_series (
      series_address TEXT PRIMARY KEY, market_address TEXT NOT NULL, ticker TEXT NOT NULL,
      is_put INTEGER NOT NULL, expiry_ms INTEGER NOT NULL, strike TEXT NOT NULL,
      base_coin_mint TEXT NOT NULL, quote_coin_mint TEXT NOT NULL, confirmed_at_ms INTEGER NOT NULL
    )`,
  ];
  for (const statement of statements) await env.DB.prepare(statement).run();
}

function nextSocketMessage(socket: WebSocket | null): Promise<unknown> {
  if (socket === null) throw new Error("WebSocket upgrade failed.");
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      resolve(JSON.parse(String(event.data)));
    });
  });
}
