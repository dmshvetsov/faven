import {
  address,
  getAddressDecoder,
  getBase58Decoder,
  type Address,
} from "@solana/kit";

const OPTIONS_PROGRAM_ADDRESS = address(
  "FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT"
);
const SERIES_ACCOUNT_LENGTH = 107;
const MARKET_ACCOUNT_LENGTH = 152;
const SERIES_ACCOUNT_DISCRIMINATOR = new Uint8Array([
  240, 97, 8, 183, 139, 77, 250, 162,
]);
const MARKET_ACCOUNT_DISCRIMINATOR = new Uint8Array([
  219, 190, 213, 55, 0, 227, 198, 154,
]);

export interface SolanaRpcTransport {
  call(method: string, params: readonly unknown[]): Promise<unknown>;
}

export interface EligiblePriceFinalizationGroup {
  readonly marketAddress: Address;
  readonly marketOperator: Address;
  readonly expiryMs: number;
  /** Hexadecimal Pyth feed ID as stored in the on-chain Market. */
  readonly pythFeedId: string;
  readonly quoteMint: Address;
  readonly series: readonly { readonly seriesAddress: Address }[];
}

/**
 * Returns unfinalized, expired Series directly from Options-program accounts.
 * Account owners, fixed lengths, discriminators, and serialized enum values are
 * validated before any account is used.
 */
export async function discoverEligiblePriceFinalizationGroups(input: {
  readonly rpc: SolanaRpcTransport;
  readonly nowMs: number;
}): Promise<readonly EligiblePriceFinalizationGroup[]> {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new Error("Current time is invalid.");
  }
  const response = await input.rpc.call("getProgramAccounts", [
    OPTIONS_PROGRAM_ADDRESS,
    {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        { dataSize: SERIES_ACCOUNT_LENGTH },
        {
          memcmp: {
            offset: 0,
            bytes: getBase58Decoder().decode(SERIES_ACCOUNT_DISCRIMINATOR),
          },
        },
      ],
    },
  ]);
  const allSeries = parseProgramAccounts(response).flatMap((account) => {
    const series = parseSeriesAccount(account);
    return series === null ? [] : [series];
  });
  const eligibleSeries = allSeries.filter(
    (series) =>
      series.state === 0 &&
      !series.hasExpiryPrice &&
      series.expiryMs <= input.nowMs
  );
  if (eligibleSeries.length === 0) return [];

  const markets = await fetchMarkets(input.rpc, [
    ...new Set(eligibleSeries.map((series) => series.marketAddress)),
  ]);
  const groups = new Map<
    string,
    {
      market: DecodedMarket;
      expiryMs: number;
      series: { readonly seriesAddress: Address }[];
    }
  >();
  for (const series of eligibleSeries) {
    const market = markets.get(series.marketAddress);
    if (market === undefined) continue;
    if (market.paused) continue;
    const key = `${series.marketAddress}:${series.expiryMs}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        market,
        expiryMs: series.expiryMs,
        series: [{ seriesAddress: series.address }],
      });
    } else {
      existing.series.push({ seriesAddress: series.address });
    }
  }
  return [...groups.values()]
    .map(({ market, expiryMs, series }) => ({
      marketAddress: market.address,
      marketOperator: market.operator,
      expiryMs,
      pythFeedId: Buffer.from(market.feedId).toString("hex"),
      quoteMint: market.quoteMint,
      series: series.sort((left, right) =>
        left.seriesAddress.localeCompare(right.seriesAddress)
      ),
    }))
    .sort(
      (left, right) =>
        left.expiryMs - right.expiryMs ||
        left.marketAddress.localeCompare(right.marketAddress)
    );
}

interface DecodedSeries {
  readonly address: Address;
  readonly marketAddress: Address;
  readonly state: 0 | 1 | 2;
  readonly expiryMs: number;
  readonly hasExpiryPrice: boolean;
}

interface DecodedMarket {
  readonly address: Address;
  readonly operator: Address;
  readonly feedId: Uint8Array;
  readonly paused: boolean;
  readonly quoteMint: Address;
}

async function fetchMarkets(
  rpc: SolanaRpcTransport,
  marketAddresses: readonly Address[]
): Promise<ReadonlyMap<Address, DecodedMarket>> {
  const response = await rpc.call("getMultipleAccounts", [
    marketAddresses,
    { commitment: "confirmed", encoding: "base64" },
  ]);
  if (!isRecord(response) || !Array.isArray(response.value)) {
    throw new Error("RPC returned an invalid Market account response.");
  }
  if (response.value.length !== marketAddresses.length) {
    throw new Error("RPC returned an incomplete Market account response.");
  }
  const markets = new Map<Address, DecodedMarket>();
  for (const [index, account] of response.value.entries()) {
    const marketAddress = marketAddresses[index];
    if (marketAddress === undefined) {
      throw new Error("RPC returned an invalid Market account response.");
    }
    const market = parseMarketAccount(marketAddress, account);
    if (market !== null) markets.set(marketAddress, market);
  }
  return markets;
}

function parseProgramAccounts(value: unknown): readonly {
  readonly address: Address;
  readonly data: Uint8Array;
}[] {
  if (!Array.isArray(value)) {
    throw new Error("RPC returned an invalid Series account response.");
  }
  return value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.pubkey !== "string" ||
      !isRecord(entry.account)
    ) {
      throw new Error("RPC returned an invalid Series account response.");
    }
    const accountAddress = parseAddress(entry.pubkey);
    if (accountAddress === null) {
      logInvalidLayout("series", entry.pubkey);
      return [];
    }
    const data = parseOptionsAccountData(
      entry.account,
      "series",
      accountAddress
    );
    if (data === null) return [];
    return {
      address: accountAddress,
      data,
    };
  });
}

function parseSeriesAccount(input: {
  readonly address: Address;
  readonly data: Uint8Array;
}): DecodedSeries | null {
  const { address: seriesAddress, data } = input;
  if (
    data.length !== SERIES_ACCOUNT_LENGTH ||
    !equalBytes(data.slice(0, 8), SERIES_ACCOUNT_DISCRIMINATOR) ||
    (data[8] !== 0 && data[8] !== 1 && data[8] !== 2) ||
    (data[41] !== 0 && data[41] !== 1) ||
    (data[66] !== 0 && data[66] !== 1)
  ) {
    logInvalidLayout("series", seriesAddress);
    return null;
  }
  const expiry = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength
  ).getBigUint64(50, true);
  if (expiry > BigInt(Number.MAX_SAFE_INTEGER)) {
    logInvalidLayout("series", seriesAddress);
    return null;
  }
  return {
    address: seriesAddress,
    marketAddress: getAddressDecoder().decode(data.slice(9, 41)),
    state: data[8],
    expiryMs: Number(expiry),
    hasExpiryPrice: data[66] === 1,
  };
}

function parseMarketAccount(
  addressValue: Address,
  value: unknown
): DecodedMarket | null {
  if (!isRecord(value)) {
    logInvalidLayout("market", addressValue);
    return null;
  }
  const data = parseOptionsAccountData(value, "market", addressValue);
  if (data === null) return null;
  if (
    data.length !== MARKET_ACCOUNT_LENGTH ||
    !equalBytes(data.slice(0, 8), MARKET_ACCOUNT_DISCRIMINATOR) ||
    data[8] !== 0 ||
    (data[75] !== 0 && data[75] !== 1)
  ) {
    logInvalidLayout("market", addressValue);
    return null;
  }
  return {
    address: addressValue,
    feedId: data.slice(9, 41),
    operator: getAddressDecoder().decode(data.slice(43, 75)),
    paused: data[75] === 1,
    quoteMint: getAddressDecoder().decode(data.slice(76, 108)),
  };
}

function parseOptionsAccountData(
  value: Record<string, unknown>,
  accountType: "series" | "market",
  accountAddress: string
): Uint8Array | null {
  if (
    value.owner !== OPTIONS_PROGRAM_ADDRESS ||
    value.executable !== false ||
    !Array.isArray(value.data) ||
    value.data.length !== 2 ||
    typeof value.data[0] !== "string" ||
    value.data[1] !== "base64"
  ) {
    logInvalidLayout(accountType, accountAddress);
    return null;
  }
  try {
    return Buffer.from(value.data[0], "base64");
  } catch {
    logInvalidLayout(accountType, accountAddress);
    return null;
  }
}

function parseAddress(value: string): Address | null {
  try {
    return address(value);
  } catch {
    return null;
  }
}

function logInvalidLayout(
  accountType: "series" | "market",
  address: string
): void {
  console.debug(
    `option.${accountType} ${address} has an invalid on-chain layout`
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
