import {
  address,
  getBase58Decoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeFinalizedPriceFinalizations,
  createPythTwapPriceFinalizationTransaction,
  fetchSeriesBackfill,
} from "../src/index.js";

const OPTIONS_PROGRAM = "FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT";
const SERIES = "Stake11111111111111111111111111111111111111";
const MARKET = "So11111111111111111111111111111111111111112";
const BASE_MINT = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const QUOTE_MINT = "SysvarC1ock11111111111111111111111111111111";
const SIGNATURE = "5".repeat(88);

afterEach(() => vi.unstubAllGlobals());

describe("price-finalization SDK", () => {
  it("decodes each finalized Pyth TWAP event for a matching instruction", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jsonrpc: "2.0",
          id: "getTransaction",
          result: {
            slot: 123,
            blockTime: 1_735_689_600,
            meta: {
              err: null,
              logMessages: [
                `Program ${OPTIONS_PROGRAM} invoke [1]`,
                `Program data: ${eventData(SERIES, 6_000_000_000n, 0)}`,
                `Program ${OPTIONS_PROGRAM} success`,
              ],
            },
            transaction: {
              message: {
                accountKeys: [
                  "11111111111111111111111111111111",
                  "So11111111111111111111111111111111111111112",
                  "SysvarC1ock11111111111111111111111111111111",
                  SERIES,
                  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                  OPTIONS_PROGRAM,
                ],
                instructions: [
                  {
                    programIdIndex: 5,
                    accounts: [0, 1, 2, 3, 4],
                    data: instructionData("finalize_pyth_twap_series"),
                  },
                ],
              },
            },
          },
        })
      )
    );

    await expect(
      decodeFinalizedPriceFinalizations({
        rpcUrl: "https://rpc.example.test",
        signature: SIGNATURE,
      })
    ).resolves.toEqual([
      {
        seriesAddress: SERIES,
        expiryPrice: "6000000000",
        method: "pythTwap",
        slot: 123,
        signature: SIGNATURE,
        finalizedAtMs: 1_735_689_600_000,
      },
    ]);
  });

  it("loads immutable Series metadata needed by a missing RFQ-server row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as {
          params: readonly [string];
        };
        return Response.json({
          jsonrpc: "2.0",
          id: "getAccountInfo",
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
      })
    );

    await expect(
      fetchSeriesBackfill({
        rpcUrl: "https://rpc.example.test",
        seriesAddress: SERIES,
        minContextSlot: 123,
      })
    ).resolves.toEqual({
      seriesAddress: SERIES,
      marketAddress: MARKET,
      isPut: false,
      strike: "6000000000",
      expiryMs: 1_735_689_600_000,
      expiryPrice: "6000000000",
      baseMint: BASE_MINT,
      quoteMint: QUOTE_MINT,
    });
  });

  it("creates a Pyth TWAP finalization transaction for every Series-vault pair", () => {
    const transaction = createPythTwapPriceFinalizationTransaction({
      feePayer: address("11111111111111111111111111111111"),
      caller: address("11111111111111111111111111111111"),
      market: address(MARKET),
      twapUpdate: address("SysvarC1ock11111111111111111111111111111111"),
      series: [
        {
          seriesAddress: address(SERIES),
          quoteCollateralVault: address(
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          ),
        },
      ],
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100n,
    });

    const message = getCompiledTransactionMessageDecoder().decode(
      new Uint8Array(transaction.messageBytes)
    );
    expect(message.instructions).toHaveLength(1);
    expect(message.instructions[0]?.data).toEqual(
      new Uint8Array([43, 32, 59, 241, 94, 80, 21, 32])
    );
    expect(message.instructions[0]?.accountIndices).toHaveLength(5);
  });

  it("rejects a transaction that is not finalized yet", async () => {
    vi.stubGlobal("fetch", rpcResult(null));

    await expect(
      decodeFinalizedPriceFinalizations({
        rpcUrl: "https://rpc.example.test",
        signature: SIGNATURE,
      })
    ).rejects.toMatchObject({ kind: "not-finalized" });
  });

  it("rejects a failed transaction", async () => {
    vi.stubGlobal(
      "fetch",
      rpcResult({
        slot: 123,
        blockTime: null,
        meta: { err: { InstructionError: [0, "Custom"] }, logMessages: [] },
        transaction: { message: { accountKeys: [], instructions: [] } },
      })
    );

    await expect(
      decodeFinalizedPriceFinalizations({
        rpcUrl: "https://rpc.example.test",
        signature: SIGNATURE,
      })
    ).rejects.toMatchObject({ kind: "failed" });
  });

  it("rejects a transaction without an Options finalization instruction", async () => {
    vi.stubGlobal(
      "fetch",
      rpcResult({
        slot: 123,
        blockTime: null,
        meta: { err: null, logMessages: [] },
        transaction: {
          message: {
            accountKeys: ["11111111111111111111111111111111"],
            instructions: [
              { programIdIndex: 0, accounts: [], data: "11111111" },
            ],
          },
        },
      })
    );

    await expect(
      decodeFinalizedPriceFinalizations({
        rpcUrl: "https://rpc.example.test",
        signature: SIGNATURE,
      })
    ).rejects.toMatchObject({ kind: "unrelated" });
  });

  it("rejects duplicate finalization events for one Series", async () => {
    vi.stubGlobal(
      "fetch",
      rpcResult({
        slot: 123,
        blockTime: null,
        meta: {
          err: null,
          logMessages: [
            `Program ${OPTIONS_PROGRAM} invoke [1]`,
            `Program data: ${eventData(SERIES, 6_000_000_000n, 0)}`,
            `Program data: ${eventData(SERIES, 6_000_000_000n, 0)}`,
            `Program ${OPTIONS_PROGRAM} success`,
          ],
        },
        transaction: matchingTransaction(),
      })
    );

    await expect(
      decodeFinalizedPriceFinalizations({
        rpcUrl: "https://rpc.example.test",
        signature: SIGNATURE,
      })
    ).rejects.toMatchObject({ kind: "malformed" });
  });
});

function rpcResult(result: unknown): typeof fetch {
  return (async () =>
    Response.json({
      jsonrpc: "2.0",
      id: "getTransaction",
      result,
    })) as typeof fetch;
}

function matchingTransaction() {
  return {
    message: {
      accountKeys: [
        "11111111111111111111111111111111",
        MARKET,
        "SysvarC1ock11111111111111111111111111111111",
        SERIES,
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        OPTIONS_PROGRAM,
      ],
      instructions: [
        {
          programIdIndex: 5,
          accounts: [0, 1, 2, 3, 4],
          data: instructionData("finalize_pyth_twap_series"),
        },
      ],
    },
  };
}

function instructionData(name: string): string {
  return getBase58Decoder().decode(
    createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)
  );
}

function eventData(
  seriesAddress: string,
  price: bigint,
  method: 0 | 1
): string {
  const data = new Uint8Array(8 + 32 + 8 + 1 + 32 + 1);
  data.set(
    createHash("sha256")
      .update("event:ExpiryPriceFinalized")
      .digest()
      .subarray(0, 8)
  );
  data.set(getBase58Encoder().encode(seriesAddress), 8);
  new DataView(data.buffer).setBigUint64(40, price, true);
  data[48] = 0;
  data[81] = method;
  return Buffer.from(data).toString("base64");
}

function seriesAccountData(): Uint8Array {
  const data = new Uint8Array(107);
  data.set(accountDiscriminator("Series"));
  data[8] = 1;
  data.set(getBase58Encoder().encode(MARKET), 9);
  data[41] = 0;
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
