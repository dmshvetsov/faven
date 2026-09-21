import { env, SELF } from "cloudflare:test";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OPTIONS_PROGRAM = "FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT";
const SERIES = "Stake11111111111111111111111111111111111111";
const MARKET = "99rh3FNKgvuWigwrsaDLMSD9cX8XWkFAdTdHqLkW3BCC";
const BASE_MINT = "So11111111111111111111111111111111111111112";
const QUOTE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SIGNATURE = "5".repeat(88);

beforeEach(async () => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS option_series (
      series_address TEXT PRIMARY KEY,
      market_address TEXT NOT NULL,
      oracle_asset TEXT NOT NULL,
      base_asset TEXT NOT NULL,
      quote_asset TEXT NOT NULL,
      is_put INTEGER NOT NULL,
      expiry_ms INTEGER NOT NULL,
      strike TEXT NOT NULL,
      base_mint TEXT NOT NULL,
      quote_mint TEXT NOT NULL,
      confirmed_at_ms INTEGER NOT NULL,
      expiry_price TEXT,
      finalized_at_ms INTEGER,
      finalized_slot INTEGER,
      finalization_signature TEXT,
      finalization_method TEXT
    )`
  ).run();
  await env.DB.prepare("DELETE FROM option_series").run();
});

afterEach(() => vi.unstubAllGlobals());

describe("price finalization backfill", () => {
  it("rejects a request without the administrator bearer token", async () => {
    const response = await SELF.fetch(
      "https://example.com/internal/backfills/price-finalizations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature: "5".repeat(88) }),
      }
    );

    expect(response.status).toBe(401);
  });

  it("reports a pending transaction as not finalized", async () => {
    vi.stubGlobal("fetch", (async () =>
      Response.json({
        jsonrpc: "2.0",
        id: "getTransaction",
        result: null,
      })) as typeof fetch);

    const response = await backfillRequest();

    expect(response.status).toBe(409);
  });

  it("backfills a missing Series before notifying connected makers", async () => {
    const maker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    const notification = nextPersistedPriceFinalizationNotification(maker);
    vi.stubGlobal("fetch", solanaRpcFetch());

    const response = await SELF.fetch(
      "https://example.com/internal/backfills/price-finalizations",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-admin-auth-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ signature: SIGNATURE }),
      }
    );

    expect(response.status, await response.text()).toBe(204);
    await expect(notification).resolves.toEqual({
      message: {
        jsonrpc: "2.0",
        method: "series.priceFinalized",
        params: {
          seriesAddress: SERIES,
          expiryPrice: "6000000000",
          method: "pythUnverified",
          slot: 123,
          signature: SIGNATURE,
        },
      },
      persistedExpiryPrice: "6000000000",
    });
    await expect(
      env.DB.prepare(
        "SELECT confirmed_at_ms, expiry_price, finalized_at_ms, finalized_slot, finalization_signature, finalization_method FROM option_series WHERE series_address = ?"
      )
        .bind(SERIES)
        .first()
    ).resolves.toEqual({
      confirmed_at_ms: 0,
      expiry_price: "6000000000",
      finalized_at_ms: 1_735_689_600_000,
      finalized_slot: 123,
      finalization_signature: SIGNATURE,
      finalization_method: "pythUnverified",
    });
    maker.close();
  });

  it("accepts an identical finalized transaction retry", async () => {
    const maker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    vi.stubGlobal("fetch", solanaRpcFetch());

    const firstNotification = nextSocketMessage(maker);
    const first = await backfillRequest();
    await expect(firstNotification).resolves.toMatchObject({
      method: "series.priceFinalized",
    });

    const retryNotification = nextSocketMessage(maker);
    const second = await backfillRequest();

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    await expect(
      Promise.race([
        retryNotification.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
      ])
    ).resolves.toBe(false);
    maker.close();
  });

  it("records the first finalization for a Series created by an underwrite", async () => {
    await seedSeriesWithoutFinalization();
    vi.stubGlobal("fetch", solanaRpcFetch());

    const response = await backfillRequest();

    expect(response.status).toBe(204);
    await expect(
      env.DB.prepare(
        "SELECT expiry_price, finalized_slot FROM option_series WHERE series_address = ?"
      )
        .bind(SERIES)
        .first()
    ).resolves.toEqual({ expiry_price: "6000000000", finalized_slot: 123 });
  });

  it("rejects an older finalization than the one already stored", async () => {
    await env.DB.prepare(
      `INSERT INTO option_series (
        series_address, market_address, oracle_asset, base_asset, quote_asset,
        is_put, expiry_ms, strike, base_mint, quote_mint, confirmed_at_ms,
        expiry_price, finalized_slot, finalization_signature, finalization_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        SERIES,
        MARKET,
        "SOL",
        "wSOL",
        "USDC",
        0,
        1_735_689_600_000,
        "6000000000",
        BASE_MINT,
        QUOTE_MINT,
        0,
        "6100000000",
        124,
        "6".repeat(88),
        "pythUnverified"
      )
      .run();
    vi.stubGlobal("fetch", solanaRpcFetch());

    const response = await backfillRequest();

    expect(response.status).toBe(422);
  });

  it("replaces stored finalization data when the decoded slot is newer", async () => {
    await seedSeriesWithoutFinalization();
    await env.DB.prepare(
      `UPDATE option_series
       SET expiry_price = ?, finalized_slot = ?, finalization_signature = ?, finalization_method = ?
       WHERE series_address = ?`
    )
      .bind("6100000000", 122, "6".repeat(88), "pythUnverified", SERIES)
      .run();
    vi.stubGlobal("fetch", solanaRpcFetch());

    const response = await backfillRequest();

    expect(response.status).toBe(204);
    await expect(
      env.DB.prepare(
        "SELECT expiry_price, finalized_slot, finalization_method FROM option_series WHERE series_address = ?"
      )
        .bind(SERIES)
        .first()
    ).resolves.toEqual({
      expiry_price: "6000000000",
      finalized_slot: 123,
      finalization_method: "pythUnverified",
    });
  });

  it("notifies makers but not takers and removes a closed maker socket", async () => {
    const maker = acceptSocket(
      await SELF.fetch("https://example.com/maker", webSocketHeaders())
    );
    const taker = acceptSocket(
      await SELF.fetch("https://example.com/taker", webSocketHeaders())
    );
    const makerNotification = nextSocketMessage(maker);

    const response = await makerBroadcast();

    expect(response.status).toBe(204);
    await expect(makerNotification).resolves.toEqual({ event: "finalized" });
    await expect(
      Promise.race([
        nextSocketMessage(taker).then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
      ])
    ).resolves.toBe(false);

    maker.close();
    await expect(makerBroadcast()).resolves.toMatchObject({ status: 204 });
    taker.close();
  });
});

function backfillRequest(): Promise<Response> {
  return SELF.fetch(
    "https://example.com/internal/backfills/price-finalizations",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer test-admin-auth-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ signature: SIGNATURE }),
    }
  );
}

function makerBroadcast(): Promise<Response> {
  const connectionHub = env.CONNECTION_HUB;
  if (connectionHub === undefined) {
    throw new Error("Connection Hub binding is missing.");
  }
  const hub = connectionHub.get(connectionHub.idFromName("connections"));
  return hub.fetch(
    new Request("https://connection-hub/broadcast-maker", {
      method: "POST",
      body: JSON.stringify({ message: JSON.stringify({ event: "finalized" }) }),
    })
  );
}

async function seedSeriesWithoutFinalization(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO option_series (
      series_address, market_address, oracle_asset, base_asset, quote_asset,
      is_put, expiry_ms, strike, base_mint, quote_mint, confirmed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      SERIES,
      MARKET,
      "SOL",
      "wSOL",
      "USDC",
      0,
      1_735_689_600_000,
      "6000000000",
      BASE_MINT,
      QUOTE_MINT,
      0
    )
    .run();
}

function solanaRpcFetch(): typeof fetch {
  return (async (_input: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as {
      method: string;
      params: readonly [string];
    };
    if (request.method === "getTransaction") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.method,
        result: {
          slot: 123,
          blockTime: 1_735_689_600,
          meta: {
            err: null,
            loadedAddresses: { writable: [], readonly: [] },
            logMessages: [
              `Program ${OPTIONS_PROGRAM} invoke [1]`,
              `Program data: ${eventData(SERIES, 6_000_000_000n)}`,
              `Program ${OPTIONS_PROGRAM} success`,
            ],
          },
          transaction: {
            message: {
              accountKeys: [
                "11111111111111111111111111111111",
                MARKET,
                "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                BASE_MINT,
                QUOTE_MINT,
                SERIES,
                "So11111111111111111111111111111111111111112",
                OPTIONS_PROGRAM,
              ],
              instructions: [
                {
                  programIdIndex: 7,
                  accounts: [0, 1, 2, 2, 3, 4, 5, 6],
                  data: unverifiedInstructionData(),
                },
              ],
            },
          },
        },
      });
    }
    if (request.method === "getAccountInfo") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.method,
        result: {
          value: {
            owner: OPTIONS_PROGRAM,
            data: [
              Buffer.from(
                request.params[0] === SERIES
                  ? seriesAccountData()
                  : marketAccountData()
              ).toString("base64"),
              "base64",
            ],
          },
        },
      });
    }
    throw new Error(`Unexpected RPC method: ${request.method}`);
  }) as typeof fetch;
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
  if (response.status !== 101 || response.webSocket === null) {
    throw new Error(
      `Expected WebSocket response, received ${response.status}.`
    );
  }
  response.webSocket.accept();
  return response.webSocket;
}

function nextSocketMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      try {
        resolve(JSON.parse(String(event.data)));
      } catch (error) {
        reject(error);
      }
    });
    socket.addEventListener("error", () => reject(new Error("Socket failed.")));
  });
}

function nextPersistedPriceFinalizationNotification(
  socket: WebSocket
): Promise<{
  readonly message: unknown;
  readonly persistedExpiryPrice: string | null;
}> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      void env.DB.prepare(
        "SELECT expiry_price FROM option_series WHERE series_address = ?"
      )
        .bind(SERIES)
        .first<{ expiry_price: string | null }>()
        .then((stored) => {
          resolve({
            message: JSON.parse(String(event.data)),
            persistedExpiryPrice: stored?.expiry_price ?? null,
          });
        })
        .catch(reject);
    });
  });
}

function unverifiedInstructionData(): string {
  const data = new Uint8Array(68);
  data.set(
    createHash("sha256")
      .update("global:finalize_pyth_unverified_series")
      .digest()
      .subarray(0, 8)
  );
  data.fill(1, 8);
  return getBase58Decoder().decode(data);
}

function eventData(seriesAddress: string, price: bigint): string {
  const data = new Uint8Array(82);
  data.set(
    createHash("sha256")
      .update("event:ExpiryPriceFinalized")
      .digest()
      .subarray(0, 8)
  );
  data.set(getBase58Encoder().encode(seriesAddress), 8);
  new DataView(data.buffer).setBigUint64(40, price, true);
  data[81] = 1;
  return Buffer.from(data).toString("base64");
}

function seriesAccountData(): Uint8Array {
  const data = new Uint8Array(107);
  data.set(accountDiscriminator("Series"));
  data[8] = 1;
  data.set(getBase58Encoder().encode(MARKET), 9);
  const view = new DataView(data.buffer);
  view.setBigUint64(42, 6_000_000_000n, true);
  view.setBigUint64(50, 1_735_689_600_000n, true);
  data[66] = 1;
  view.setBigUint64(67, 6_000_000_000n, true);
  return data;
}

function marketAccountData(): Uint8Array {
  const data = new Uint8Array(152);
  data.set(accountDiscriminator("Market"));
  data[8] = 0;
  data.set(getBase58Encoder().encode(QUOTE_MINT), 76);
  data.set(getBase58Encoder().encode(BASE_MINT), 108);
  return data;
}

function accountDiscriminator(name: string): Uint8Array {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}
