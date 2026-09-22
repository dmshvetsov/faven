import { getBase58Encoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { discoverEligibleSettlementGroups } from "../src/index.js";

const OPTIONS_PROGRAM = "FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT";
const MARKET = "So11111111111111111111111111111111111111112";
const SERIES = "Stake11111111111111111111111111111111111111";
const SELLER_VAULT = "Vote111111111111111111111111111111111111111";
const SELLER = "11111111111111111111111111111111";
const QUOTE_MINT = "SysvarC1ock11111111111111111111111111111111";
const BASE_MINT = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

describe("settlement discovery", () => {
  it("finds a ready Series and derives a missing seller payout account", async () => {
    const call = vi.fn(async (method: string, params: readonly unknown[]) => {
      if (method === "getProgramAccounts") {
        const filters = programAccountFilters(params);
        if (filters.dataSize === 107) {
          return [{ pubkey: SERIES, account: optionsAccount(seriesAccount()) }];
        }
        if (filters.dataSize === 88) {
          return [
            {
              pubkey: SELLER_VAULT,
              account: optionsAccount(sellerVaultAccount()),
            },
          ];
        }
      }
      if (method === "getMultipleAccounts") {
        return multipleAccounts(params);
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });

    await expect(
      discoverEligibleSettlementGroups({
        rpc: { call },
        nowMs: 1_735_689_600_000,
      })
    ).resolves.toEqual([
      {
        marketAddress: MARKET,
        expiryMs: 1_735_689_600_000,
        baseTokenProgram: TOKEN_PROGRAM,
        quoteTokenProgram: TOKEN_PROGRAM,
        baseMint: BASE_MINT,
        quoteMint: QUOTE_MINT,
        series: [
          {
            seriesAddress: SERIES,
            sellers: [
              {
                sellerVault: SELLER_VAULT,
                seller: SELLER,
                basePayoutAccount: expect.any(String),
                quotePayoutAccount: null,
                requiresSellerAccount: true,
                missingTokenAccounts: 1,
              },
            ],
          },
        ],
      },
    ]);
  });

  it("excludes an in-the-money Series until its exercise window ends", async () => {
    const call = vi.fn(async (method: string, params: readonly unknown[]) => {
      if (method === "getProgramAccounts") {
        const filters = programAccountFilters(params);
        if (filters.dataSize === 107) {
          return [
            {
              pubkey: SERIES,
              account: optionsAccount(seriesAccount(200n, 1_735_689_601_000n)),
            },
          ];
        }
        if (filters.dataSize === 88) {
          return [
            {
              pubkey: SELLER_VAULT,
              account: optionsAccount(sellerVaultAccount()),
            },
          ];
        }
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });

    await expect(
      discoverEligibleSettlementGroups({
        rpc: { call },
        nowMs: 1_735_689_600_000,
      })
    ).resolves.toEqual([]);
  });
});

function programAccountFilters(params: readonly unknown[]) {
  if (!Array.isArray(params[1]) && typeof params[1] !== "object") {
    throw new Error("Unexpected getProgramAccounts parameters");
  }
  const config = params[1];
  if (
    typeof config !== "object" ||
    config === null ||
    !("filters" in config) ||
    !Array.isArray(config.filters) ||
    config.filters.length === 0
  ) {
    throw new Error("Unexpected getProgramAccounts parameters");
  }
  const first = config.filters[0];
  if (typeof first !== "object" || first === null || !("dataSize" in first)) {
    throw new Error("Unexpected getProgramAccounts parameters");
  }
  return first;
}

function multipleAccounts(params: readonly unknown[]) {
  const addresses = params[0];
  if (!Array.isArray(addresses)) throw new Error("Unexpected account request");
  if (addresses[0] === MARKET) {
    return { value: [optionsAccount(marketAccount())] };
  }
  if (addresses.includes(BASE_MINT) || addresses.includes(QUOTE_MINT)) {
    return { value: addresses.map(() => mintAccount()) };
  }
  return { value: addresses.map(() => null) };
}

function optionsAccount(data: Uint8Array) {
  return {
    owner: OPTIONS_PROGRAM,
    executable: false,
    data: [Buffer.from(data).toString("base64"), "base64"],
  };
}

function mintAccount() {
  return { owner: TOKEN_PROGRAM, executable: false };
}

function seriesAccount(
  expiryPrice = 100n,
  exerciseWindowEndMs = 1_735_689_600_000n
): Uint8Array {
  const data = new Uint8Array(107);
  data.set([240, 97, 8, 183, 139, 77, 250, 162]);
  data[8] = 1;
  data.set(addressBytes(MARKET), 9);
  data[41] = 0;
  const view = new DataView(data.buffer);
  view.setBigUint64(42, 101n, true);
  view.setBigUint64(50, 1_735_689_600_000n, true);
  view.setBigUint64(58, exerciseWindowEndMs, true);
  data[66] = 1;
  view.setBigUint64(67, expiryPrice, true);
  view.setBigUint64(75, 10n, true);
  return data;
}

function sellerVaultAccount(): Uint8Array {
  const data = new Uint8Array(88);
  data.set([40, 215, 104, 97, 10, 251, 107, 143]);
  data.set(addressBytes(SELLER), 8);
  data.set(addressBytes(SERIES), 40);
  const view = new DataView(data.buffer);
  view.setBigUint64(72, 10n, true);
  view.setBigUint64(80, 10n, true);
  return data;
}

function marketAccount(): Uint8Array {
  const data = new Uint8Array(152);
  data.set([219, 190, 213, 55, 0, 227, 198, 154]);
  data[8] = 0;
  data[75] = 0;
  data.set(addressBytes(QUOTE_MINT), 76);
  data.set(addressBytes(BASE_MINT), 108);
  return data;
}

function addressBytes(value: string): Uint8Array {
  return new Uint8Array(getBase58Encoder().encode(value));
}
