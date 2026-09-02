import { env, SELF } from "cloudflare:test";
import {
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";
import { describe, expect, it } from "vitest";

import { isRecord } from "../src/rfq-rpc";

Object.defineProperty(globalThis, "isSecureContext", { value: true });

describe("RFQ server", () => {
  it("fans out a canonical RFQ request without seller details", async () => {
    const baseCoinMint = "So11111111111111111111111111111111111111112";
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const buyer = acceptSocket(
      await SELF.fetch(
        `https://example.com/rfqs/${baseCoinMint}`,
        webSocketHeaders()
      )
    );
    const requestId = "0193c3c5-1967-7000-8000-000000000041";
    const rfqId = "0193c3c5-1967-7000-8000-000000000042";
    const sellerResponse = nextSocketMessage(seller);
    const buyerRequest = nextSocketMessage(buyer);

    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "rfq.create",
        params: {
          rfqId,
          market: "11111111111111111111111111111111",
          expiry: 1_735_689_600,
          isPut: false,
          quantity: "10",
          strike: "6000000000000",
          seller: "11111111111111111111111111111111",
          sellerCollateralSource: "11111111111111111111111111111111",
        },
      })
    );

    await expect(sellerResponse).resolves.toMatchObject({
      id: requestId,
      result: { rfqId, requestDeadline: expect.any(Number) },
    });
    await expect(buyerRequest).resolves.toEqual({
      jsonrpc: "2.0",
      method: "rfq.request",
      params: expect.objectContaining({
        rfqId,
        assetAddress: baseCoinMint,
        collateralAsset: baseCoinMint,
      }),
    });
    seller.close();
    buyer.close();
  });

  it("notifies the seller when aggregation closes with no quotes", async () => {
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const rfqId = "0193c3c5-1967-7000-8000-000000000044";
    const created = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000045",
        method: "rfq.create",
        params: canonicalRfq(rfqId),
      })
    );
    await created;

    await expect(nextSocketMessage(seller)).resolves.toEqual({
      jsonrpc: "2.0",
      method: "quote.best",
      params: { rfqId, noQuoteReason: "no_buyers" },
    });
    seller.close();
  }, 5_000);

  it("cancels an RFQ when its seller disconnects", async () => {
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const maker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    const rfqId = "0193c3c5-1967-7000-8000-000000000046";
    const created = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000047",
        method: "rfq.create",
        params: canonicalRfq(rfqId),
      })
    );
    await created;
    seller.close();

    const unavailable = nextSocketMessage(maker);
    maker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000048",
        method: "underwriteTx.generate",
        params: { rfqId },
      })
    );

    await expect(unavailable).resolves.toMatchObject({
      id: "0193c3c5-1967-7000-8000-000000000048",
      error: { code: 1001, data: { rfqId } },
    });
    maker.close();
  });

  it("generates an unsigned v0 underwrite transaction for a maker", async () => {
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const maker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    const rfqId = "0193c3c5-1967-7000-8000-000000000049";
    const created = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000050",
        method: "rfq.create",
        params: canonicalRfq(rfqId),
      })
    );
    await created;

    const generated = nextSocketMessage(maker);
    maker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000051",
        method: "underwriteTx.generate",
        params: {
          rfqId,
          maker: "So11111111111111111111111111111111111111112",
          buyerQuoteSource: "So11111111111111111111111111111111111111112",
          premium: "25",
        },
      })
    );

    const message = await generated;
    expect(message).not.toHaveProperty("error");
    expect(message).toMatchObject({
      id: "0193c3c5-1967-7000-8000-000000000051",
      result: { rfqId, lastValidBlockHeight: expect.any(Number) },
    });
    const underwriteTx = resultField(message, "underwriteTx");
    const transaction = getTransactionDecoder().decode(
      base64Bytes(underwriteTx)
    );
    expect(
      getCompiledTransactionMessageDecoder().decode(
        new Uint8Array(transaction.messageBytes)
      ).version
    ).toBe(0);
    seller.close();
    maker.close();
  });

  it("accepts a maker signature for exactly its generated transaction", async () => {
    const sellerSigner = await generateKeyPairSigner();
    const makerSigner = await generateKeyPairSigner();
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const maker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    const rfqId = "0193c3c5-1967-7000-8000-000000000052";
    const created = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000053",
        method: "rfq.create",
        params: canonicalRfq(rfqId, sellerSigner.address),
      })
    );
    await created;

    const generated = nextSocketMessage(maker);
    maker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000054",
        method: "underwriteTx.generate",
        params: generationParams(rfqId, makerSigner.address),
      })
    );
    const unsignedTransaction = getTransactionDecoder().decode(
      base64Bytes(resultField(await generated, "underwriteTx"))
    );
    const signedTransaction = await partiallySignTransaction(
      [makerSigner.keyPair],
      unsignedTransaction
    );
    const quoteResult = nextSocketMessage(maker);
    maker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000055",
        method: "quote.submit",
        params: {
          ...quoteFields(rfqId, makerSigner.address),
          underwriteTx: getBase64EncodedWireTransaction(signedTransaction),
        },
      })
    );

    await expect(quoteResult).resolves.toMatchObject({
      id: "0193c3c5-1967-7000-8000-000000000055",
      result: { rfqId, bestQuote: "25", providedStatus: "best" },
    });
    const selected = nextSocketMessage(seller);
    await expect(selected).resolves.toMatchObject({
      method: "quote.best",
      params: { rfqId, quote: { premium: "25" } },
    });
    const queued = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000056",
        method: "underwrite.submit",
        params: {
          rfqId,
          underwriteTx: getBase64EncodedWireTransaction(
            await partiallySignTransaction(
              [sellerSigner.keyPair],
              signedTransaction
            )
          ),
        },
      })
    );
    await expect(queued).resolves.toMatchObject({
      id: "0193c3c5-1967-7000-8000-000000000056",
      result: { rfqId, txSignature: expect.any(String), status: "queued" },
    });
    seller.close();
    maker.close();
  });

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
});

function canonicalRfq(
  rfqId: string,
  seller = "So11111111111111111111111111111111111111112"
): Record<string, unknown> {
  return {
    rfqId,
    market: "11111111111111111111111111111111",
    expiry: 1_735_689_600,
    isPut: false,
    quantity: "10",
    strike: "6000000000000",
    seller,
    sellerCollateralSource: seller,
  };
}

function generationParams(
  rfqId: string,
  maker: string
): Record<string, unknown> {
  return { rfqId, maker, buyerQuoteSource: maker, premium: "25" };
}

function quoteFields(rfqId: string, maker: string): Record<string, unknown> {
  return {
    rfqId,
    assetAddress: "So11111111111111111111111111111111111111112",
    chainId: "solana:testnet",
    expiry: 1_735_689_600,
    isPut: false,
    maker,
    quantity: "10",
    strike: "6000000000000",
    premiumAsset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    collateralAsset: "So11111111111111111111111111111111111111112",
    validUntil: Math.floor(Date.now() / 1_000) + 30,
    premium: "25",
  };
}

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

function nextSocketMessage(socket: WebSocket | null): Promise<unknown> {
  if (socket === null) throw new Error("WebSocket upgrade failed.");
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      resolve(JSON.parse(String(event.data)));
    });
  });
}

function resultField(message: unknown, field: string): string {
  if (
    !isRecord(message) ||
    !isRecord(message.result) ||
    typeof message.result[field] !== "string"
  ) {
    throw new Error(`Missing response result ${field}.`);
  }
  return message.result[field];
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
