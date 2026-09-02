import { env, evictDurableObject, SELF } from "cloudflare:test";
import {
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isRecord } from "../src/rfq-rpc";

Object.defineProperty(globalThis, "isSecureContext", { value: true });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { method: string };
      if (request.method === "getLatestBlockhash") {
        return Response.json({
          jsonrpc: "2.0",
          id: request.method,
          result: {
            value: {
              blockhash: "11111111111111111111111111111111",
              lastValidBlockHeight: 100,
            },
          },
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: request.method,
        result: { value: null },
      });
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("RFQ server", () => {
  it("rejects seller terms outside the configured market range", async () => {
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const response = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000070",
        method: "rfq.create",
        params: {
          ...canonicalRfq("0193c3c5-1967-7000-8000-000000000069"),
          quantity: "1001",
        },
      })
    );

    await expect(response).resolves.toMatchObject({
      id: "0193c3c5-1967-7000-8000-000000000070",
      error: { code: 1002, data: { reason: "quantity-outside-market-range" } },
    });
    seller.close();
  });

  it("rejects an RFQ with an invalid seller collateral account", async () => {
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const response = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000075",
        method: "rfq.create",
        params: {
          ...canonicalRfq("0193c3c5-1967-7000-8000-000000000074"),
          sellerCollateralSource: "not-a-solana-address",
        },
      })
    );

    await expect(response).resolves.toMatchObject({
      id: "0193c3c5-1967-7000-8000-000000000075",
      error: {
        code: 1002,
        data: { reason: "invalid-rfq-sellerCollateralSource" },
      },
    });
    seller.close();
  });

  it("uses the stored blockhash and existing Series when generating a quote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as { method: string };
        if (request.method === "getLatestBlockhash") {
          return Response.json({
            jsonrpc: "2.0",
            id: request.method,
            result: {
              value: {
                blockhash: "So11111111111111111111111111111111111111112",
                lastValidBlockHeight: 42,
              },
            },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: request.method,
          result: { value: { lamports: 1 } },
        });
      })
    );
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const maker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    const rfqId = "0193c3c5-1967-7000-8000-000000000071";
    const created = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000072",
        method: "rfq.create",
        params: canonicalRfq(rfqId),
      })
    );
    await created;

    const generated = nextSocketMessage(maker);
    maker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000073",
        method: "underwriteTx.generate",
        params: generationParams(
          rfqId,
          "So11111111111111111111111111111111111111112"
        ),
      })
    );
    const transaction = getTransactionDecoder().decode(
      base64Bytes(resultField(await generated, "underwriteTx"))
    );
    const message = getCompiledTransactionMessageDecoder().decode(
      new Uint8Array(transaction.messageBytes)
    );

    expect(message.lifetimeToken).toBe(
      "So11111111111111111111111111111111111111112"
    );
    expect(message.instructions).toHaveLength(1);
    seller.close();
    maker.close();
  });

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

  it("keeps the persisted aggregation deadline after RFQ object eviction", async () => {
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const rfqId = "0193c3c5-1967-7000-8000-000000000076";
    const created = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000077",
        method: "rfq.create",
        params: canonicalRfq(rfqId),
      })
    );
    await created;
    const rfqObject = env.RFQ_OBJECT;
    if (rfqObject === undefined)
      throw new Error("RFQ object binding is missing.");
    const rfq = rfqObject.get(rfqObject.idFromName(rfqId));
    await evictDurableObject(rfq);

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
    const compiledMessage = getCompiledTransactionMessageDecoder().decode(
      new Uint8Array(transaction.messageBytes)
    );
    expect(compiledMessage.version).toBe(0);
    expect("addressTableLookups" in compiledMessage).toBe(false);
    expect(compiledMessage.instructions).toHaveLength(2);
    seller.close();
    maker.close();
  });

  it("accepts a maker signature for its persisted generated transaction", async () => {
    const sellerSigner = await generateKeyPairSigner();
    const makerSigner = await generateKeyPairSigner();
    const buyerQuoteSource = await generateKeyPairSigner();
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
        params: generationParams(
          rfqId,
          makerSigner.address,
          buyerQuoteSource.address
        ),
      })
    );
    const unsignedTransaction = getTransactionDecoder().decode(
      base64Bytes(resultField(await generated, "underwriteTx"))
    );
    const signedTransaction = await partiallySignTransaction(
      [makerSigner.keyPair],
      unsignedTransaction
    );
    const rfqObject = env.RFQ_OBJECT;
    if (rfqObject === undefined)
      throw new Error("RFQ object binding is missing.");
    const rfq = rfqObject.get(rfqObject.idFromName(rfqId));
    await evictDurableObject(rfq);
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

  it("accepts only one quote from a maker across simultaneous connections", async () => {
    const sellerSigner = await generateKeyPairSigner();
    const makerSigner = await generateKeyPairSigner();
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const firstMaker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    const secondMaker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    const rfqId = "0193c3c5-1967-7000-8000-000000000078";
    const created = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000079",
        method: "rfq.create",
        params: canonicalRfq(rfqId, sellerSigner.address),
      })
    );
    await created;

    const generated = nextSocketMessage(firstMaker);
    firstMaker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000080",
        method: "underwriteTx.generate",
        params: generationParams(rfqId, makerSigner.address),
      })
    );
    const signedTransaction = getBase64EncodedWireTransaction(
      await partiallySignTransaction(
        [makerSigner.keyPair],
        getTransactionDecoder().decode(
          base64Bytes(resultField(await generated, "underwriteTx"))
        )
      )
    );
    const firstResponse = nextSocketMessage(firstMaker);
    const secondResponse = nextSocketMessage(secondMaker);
    const quote = {
      ...quoteFields(rfqId, makerSigner.address),
      underwriteTx: signedTransaction,
    };
    firstMaker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000081",
        method: "quote.submit",
        params: quote,
      })
    );
    secondMaker.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000082",
        method: "quote.submit",
        params: quote,
      })
    );

    await expect(Promise.all([firstResponse, secondResponse])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: expect.objectContaining({ rfqId, providedStatus: "best" }),
        }),
        expect.objectContaining({
          error: expect.objectContaining({
            code: 1004,
            data: expect.objectContaining({ reason: "maker-already-quoted" }),
          }),
        }),
      ])
    );
    seller.close();
    firstMaker.close();
    secondMaker.close();
  });

  it("rejects an expired signed quote", async () => {
    const sellerSigner = await generateKeyPairSigner();
    const makerSigner = await generateKeyPairSigner();
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const maker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    const rfqId = "0193c3c5-1967-7000-8000-000000000083";
    const created = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000084",
        method: "rfq.create",
        params: canonicalRfq(rfqId, sellerSigner.address),
      })
    );
    await created;

    await expect(
      signedQuote(
        maker,
        rfqId,
        makerSigner,
        "25",
        "0193c3c5-1967-7000-8000-000000000085",
        "0193c3c5-1967-7000-8000-000000000086",
        { validUntil: Math.floor(Date.now() / 1_000) - 1 }
      )
    ).resolves.toMatchObject({
      error: { code: 1003, data: { reason: "invalid-quote-validity" } },
    });
    seller.close();
    maker.close();
  });

  it("notifies the displaced maker when a higher quote becomes best", async () => {
    const sellerSigner = await generateKeyPairSigner();
    const firstMakerSigner = await generateKeyPairSigner();
    const secondMakerSigner = await generateKeyPairSigner();
    const seller = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const firstMaker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    const secondMaker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    const rfqId = "0193c3c5-1967-7000-8000-000000000057";

    const created = nextSocketMessage(seller);
    seller.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "0193c3c5-1967-7000-8000-000000000058",
        method: "rfq.create",
        params: canonicalRfq(rfqId, sellerSigner.address),
      })
    );
    await created;

    await signedQuote(
      firstMaker,
      rfqId,
      firstMakerSigner,
      "25",
      "0193c3c5-1967-7000-8000-000000000059",
      "0193c3c5-1967-7000-8000-000000000060"
    );
    const outbid = nextSocketMessage(firstMaker);
    await signedQuote(
      secondMaker,
      rfqId,
      secondMakerSigner,
      "30",
      "0193c3c5-1967-7000-8000-000000000061",
      "0193c3c5-1967-7000-8000-000000000062"
    );
    await expect(outbid).resolves.toEqual({
      jsonrpc: "2.0",
      method: "quote.outbid",
      params: {
        rfqId,
        bestQuote: "30",
        providedQuote: "25",
        providedStatus: "outbid",
      },
    });
    seller.close();
    firstMaker.close();
    secondMaker.close();
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
  maker: string,
  buyerQuoteSource = maker
): Record<string, unknown> {
  return { rfqId, maker, buyerQuoteSource, premium: "25" };
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

async function signedQuote(
  makerSocket: WebSocket,
  rfqId: string,
  makerSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  premium: string,
  generationRequestId: string,
  quoteRequestId: string,
  quoteOverrides: Readonly<Record<string, unknown>> = {}
): Promise<unknown> {
  const generated = nextSocketMessage(makerSocket);
  makerSocket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: generationRequestId,
      method: "underwriteTx.generate",
      params: {
        ...generationParams(rfqId, makerSigner.address),
        premium,
      },
    })
  );
  const unsignedTransaction = getTransactionDecoder().decode(
    base64Bytes(resultField(await generated, "underwriteTx"))
  );
  const quoteResult = nextSocketMessage(makerSocket);
  makerSocket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: quoteRequestId,
      method: "quote.submit",
      params: {
        ...quoteFields(rfqId, makerSigner.address),
        premium,
        ...quoteOverrides,
        underwriteTx: getBase64EncodedWireTransaction(
          await partiallySignTransaction(
            [makerSigner.keyPair],
            unsignedTransaction
          )
        ),
      },
    })
  );
  return quoteResult;
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
