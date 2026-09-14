import { address, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deriveAssociatedTokenAddress,
  discoverEligiblePriceFinalizationGroups,
} from "../src/index.js";

const OPTIONS_PROGRAM = "FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT";
const MARKET = "So11111111111111111111111111111111111111112";
const SERIES = "Stake11111111111111111111111111111111111111";
const QUOTE_MINT = "SysvarC1ock11111111111111111111111111111111";
const OPERATOR = "11111111111111111111111111111111";
const FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

afterEach(() => vi.unstubAllGlobals());

describe("price finalization discovery", () => {
  it("groups open expired Series by Market and expiry with the market Pyth feed", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "getProgramAccounts") {
        return [
          {
            pubkey: SERIES,
            account: account(seriesAccount(1_735_689_600_000n)),
          },
          {
            pubkey: "Vote111111111111111111111111111111111111111",
            account: account(seriesAccount(1_735_689_599_000n, 2, 1)),
          },
        ];
      }
      if (method === "getMultipleAccounts") {
        return { value: [account(marketAccount())] };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });

    await expect(
      discoverEligiblePriceFinalizationGroups({
        rpc: { call },
        nowMs: 1_735_689_600_000,
      })
    ).resolves.toEqual([
      {
        marketAddress: MARKET,
        marketOperator: OPERATOR,
        expiryMs: 1_735_689_600_000,
        pythFeedId: FEED_ID,
        quoteMint: QUOTE_MINT,
        series: [{ seriesAddress: SERIES }],
      },
    ]);

    expect(call).toHaveBeenCalledWith("getProgramAccounts", [
      OPTIONS_PROGRAM,
      {
        commitment: "confirmed",
        encoding: "base64",
        filters: [
          { dataSize: 107 },
          {
            memcmp: {
              offset: 0,
              bytes: getBase58Decoder().decode(
                new Uint8Array([240, 97, 8, 183, 139, 77, 250, 162])
              ),
            },
          },
        ],
      },
    ]);
  });

  it("derives the legacy SPL Token associated account used for Series quote collateral", async () => {
    await expect(
      deriveAssociatedTokenAddress({
        owner: address(SERIES),
        mint: address(QUOTE_MINT),
      })
    ).resolves.toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});

function account(data: Uint8Array) {
  return {
    owner: OPTIONS_PROGRAM,
    executable: false,
    data: [Buffer.from(data).toString("base64"), "base64"],
  };
}

function seriesAccount(
  expiryMs: bigint,
  state = 0,
  hasExpiryPrice = 0
): Uint8Array {
  const data = new Uint8Array(107);
  data.set([240, 97, 8, 183, 139, 77, 250, 162]);
  data[8] = state;
  data.set(addressBytes(MARKET), 9);
  data[41] = 1;
  new DataView(data.buffer).setBigUint64(50, expiryMs, true);
  data[66] = hasExpiryPrice;
  return data;
}

function marketAccount(): Uint8Array {
  const data = new Uint8Array(152);
  data.set([219, 190, 213, 55, 0, 227, 198, 154]);
  data[8] = 0;
  data.set(Buffer.from(FEED_ID, "hex"), 9);
  data.set(addressBytes(OPERATOR), 43);
  data[75] = 0;
  data.set(addressBytes(QUOTE_MINT), 76);
  return data;
}

function addressBytes(value: string): Uint8Array {
  return new Uint8Array(getBase58Encoder().encode(value));
}
