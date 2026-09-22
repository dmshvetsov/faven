import {
  address,
  getAddressDecoder,
  getBase58Decoder,
  type Address,
} from "@solana/kit";

import { deriveAssociatedTokenAddress } from "./associated-token-account.js";

const OPTIONS_PROGRAM_ADDRESS = address(
  "FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT"
);
const SERIES_ACCOUNT_LENGTH = 107;
const MARKET_ACCOUNT_LENGTH = 152;
const SELLER_VAULT_ACCOUNT_LENGTH = 88;
const SERIES_ACCOUNT_DISCRIMINATOR = new Uint8Array([
  240, 97, 8, 183, 139, 77, 250, 162,
]);
const MARKET_ACCOUNT_DISCRIMINATOR = new Uint8Array([
  219, 190, 213, 55, 0, 227, 198, 154,
]);
const SELLER_VAULT_ACCOUNT_DISCRIMINATOR = new Uint8Array([
  40, 215, 104, 97, 10, 251, 107, 143,
]);
const MULTIPLE_ACCOUNTS_LIMIT = 100;

export interface SolanaRpcTransport {
  call(method: string, params: readonly unknown[]): Promise<unknown>;
}

export interface EligibleSettlementGroup {
  readonly marketAddress: Address;
  readonly expiryMs: number;
  readonly baseTokenProgram: Address;
  readonly quoteTokenProgram: Address;
  readonly baseMint: Address;
  readonly quoteMint: Address;
  readonly series: readonly EligibleSettlementSeries[];
}

export interface EligibleSettlementSeries {
  readonly seriesAddress: Address;
  readonly sellers: readonly EligibleSettlementSeller[];
}

export interface EligibleSettlementSeller {
  readonly sellerVault: Address;
  readonly seller: Address;
  readonly basePayoutAccount: Address | null;
  readonly quotePayoutAccount: Address | null;
  readonly requiresSellerAccount: boolean;
  readonly missingTokenAccounts: number;
}

/** Finds settlement-ready Series and seller payout accounts directly on-chain. */
export async function discoverEligibleSettlementGroups(input: {
  readonly rpc: SolanaRpcTransport;
  readonly nowMs: number;
}): Promise<readonly EligibleSettlementGroup[]> {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new Error("Current time is invalid.");
  }
  const [seriesResponse, vaultResponse] = await Promise.all([
    getProgramAccounts(
      input.rpc,
      SERIES_ACCOUNT_LENGTH,
      SERIES_ACCOUNT_DISCRIMINATOR
    ),
    getProgramAccounts(
      input.rpc,
      SELLER_VAULT_ACCOUNT_LENGTH,
      SELLER_VAULT_ACCOUNT_DISCRIMINATOR
    ),
  ]);
  const series = parseProgramAccounts(seriesResponse, "series").flatMap(
    (account) => {
      const parsed = parseSeries(account);
      return parsed === null ? [] : [parsed];
    }
  );
  const vaultsBySeries = new Map<Address, DecodedSellerVault[]>();
  for (const account of parseProgramAccounts(vaultResponse, "seller-vault")) {
    const vault = parseSellerVault(account);
    if (vault === null) continue;
    const existing = vaultsBySeries.get(vault.seriesAddress) ?? [];
    existing.push(vault);
    vaultsBySeries.set(vault.seriesAddress, existing);
  }
  const candidates = series.filter(
    (candidate) =>
      isSettlementReady(candidate, input.nowMs) &&
      (vaultsBySeries.get(candidate.address)?.length ?? 0) > 0
  );
  if (candidates.length === 0) return [];

  const markets = await fetchMarkets(input.rpc, [
    ...new Set(candidates.map((candidate) => candidate.marketAddress)),
  ]);
  const tokenPrograms = await fetchMintTokenPrograms(input.rpc, markets);
  const groups = new Map<
    string,
    {
      readonly market: DecodedMarket;
      readonly expiryMs: number;
      series: DecodedSeries[];
    }
  >();
  for (const candidate of candidates) {
    const market = markets.get(candidate.marketAddress);
    if (market === undefined || market.paused) continue;
    if (
      !tokenPrograms.has(market.baseMint) ||
      !tokenPrograms.has(market.quoteMint)
    ) {
      logInvalidLayout("market", market.address);
      continue;
    }
    const key = `${candidate.marketAddress}:${candidate.expiryMs}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        market,
        expiryMs: candidate.expiryMs,
        series: [candidate],
      });
    } else {
      group.series.push(candidate);
    }
  }

  return Promise.all(
    [...groups.values()]
      .sort(
        (left, right) =>
          left.expiryMs - right.expiryMs ||
          left.market.address.localeCompare(right.market.address)
      )
      .map(async (group) => {
        const baseTokenProgram = requiredMapValue(
          tokenPrograms,
          group.market.baseMint,
          "base token program"
        );
        const quoteTokenProgram = requiredMapValue(
          tokenPrograms,
          group.market.quoteMint,
          "quote token program"
        );
        const settlementSeries = await Promise.all(
          group.series
            .sort((left, right) => left.address.localeCompare(right.address))
            .map(async (series) => ({
              seriesAddress: series.address,
              sellers: await hydrateSellers({
                rpc: input.rpc,
                series,
                vaults: vaultsBySeries.get(series.address) ?? [],
                baseMint: group.market.baseMint,
                quoteMint: group.market.quoteMint,
                baseTokenProgram,
                quoteTokenProgram,
              }),
            }))
        );
        return {
          marketAddress: group.market.address,
          expiryMs: group.expiryMs,
          baseTokenProgram,
          quoteTokenProgram,
          baseMint: group.market.baseMint,
          quoteMint: group.market.quoteMint,
          series: settlementSeries,
        };
      })
  );
}

async function hydrateSellers(input: {
  readonly rpc: SolanaRpcTransport;
  readonly series: DecodedSeries;
  readonly vaults: readonly DecodedSellerVault[];
  readonly baseMint: Address;
  readonly quoteMint: Address;
  readonly baseTokenProgram: Address;
  readonly quoteTokenProgram: Address;
}): Promise<readonly EligibleSettlementSeller[]> {
  const payoutAccounts = await Promise.all(
    input.vaults.map(async (vault) => {
      const payout = sellerPayout(input.series, vault);
      const [basePayoutAccount, quotePayoutAccount] = await Promise.all([
        payout.base > 0n
          ? deriveAssociatedTokenAddress({
              owner: vault.owner,
              mint: input.baseMint,
              tokenProgram: input.baseTokenProgram,
            })
          : Promise.resolve(null),
        payout.quote > 0n
          ? deriveAssociatedTokenAddress({
              owner: vault.owner,
              mint: input.quoteMint,
              tokenProgram: input.quoteTokenProgram,
            })
          : Promise.resolve(null),
      ]);
      return { vault, basePayoutAccount, quotePayoutAccount };
    })
  );
  const addresses = payoutAccounts.flatMap(
    ({ basePayoutAccount, quotePayoutAccount }) =>
      [basePayoutAccount, quotePayoutAccount].filter(
        (account): account is Address => account !== null
      )
  );
  const accounts = await fetchAccounts(input.rpc, addresses);
  return payoutAccounts
    .map(({ vault, basePayoutAccount, quotePayoutAccount }) => {
      const missingTokenAccounts = [
        basePayoutAccount,
        quotePayoutAccount,
      ].filter(
        (account) => account !== null && accounts.get(account) === null
      ).length;
      return {
        sellerVault: vault.address,
        seller: vault.owner,
        basePayoutAccount,
        quotePayoutAccount,
        requiresSellerAccount: missingTokenAccounts > 0,
        missingTokenAccounts,
      };
    })
    .sort((left, right) => left.sellerVault.localeCompare(right.sellerVault));
}

function isSettlementReady(series: DecodedSeries, nowMs: number): boolean {
  if (
    series.state !== 1 ||
    series.expiryPrice === null ||
    series.totalContracts === 0n
  ) {
    return false;
  }
  const isItm =
    series.optionType === 0
      ? series.expiryPrice > series.strikePrice
      : series.expiryPrice < series.strikePrice;
  return !isItm || nowMs >= series.exerciseWindowEndMs;
}

function sellerPayout(series: DecodedSeries, vault: DecodedSellerVault) {
  const isItm =
    series.optionType === 0
      ? requiredExpiryPrice(series) > series.strikePrice
      : requiredExpiryPrice(series) < series.strikePrice;
  if (!isItm || series.totalManualExercised === 0n) {
    return series.optionType === 0
      ? { base: vault.collateralQuantity, quote: 0n }
      : { base: 0n, quote: vault.collateralQuantity };
  }
  if (series.totalManualExercised === series.totalContracts) {
    return series.optionType === 0
      ? {
          base: 0n,
          quote: floorProRata(
            series.totalQuoteAmount,
            vault.shortQuantity,
            series.totalContracts
          ),
        }
      : { base: vault.shortQuantity, quote: 0n };
  }
  const basePool =
    series.optionType === 0
      ? series.totalContracts - series.totalManualExercised
      : series.totalManualExercised;
  return {
    base: floorProRata(basePool, vault.shortQuantity, series.totalContracts),
    quote: floorProRata(
      series.totalQuoteAmount,
      vault.shortQuantity,
      series.totalContracts
    ),
  };
}

function requiredExpiryPrice(series: DecodedSeries): bigint {
  if (series.expiryPrice === null)
    throw new Error("Series has no expiry price.");
  return series.expiryPrice;
}

function floorProRata(pool: bigint, quantity: bigint, total: bigint): bigint {
  return (pool * quantity) / total;
}

async function getProgramAccounts(
  rpc: SolanaRpcTransport,
  dataSize: number,
  discriminator: Uint8Array
): Promise<unknown> {
  return rpc.call("getProgramAccounts", [
    OPTIONS_PROGRAM_ADDRESS,
    {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        { dataSize },
        {
          memcmp: {
            offset: 0,
            bytes: getBase58Decoder().decode(discriminator),
          },
        },
      ],
    },
  ]);
}

async function fetchMarkets(
  rpc: SolanaRpcTransport,
  addresses: readonly Address[]
): Promise<ReadonlyMap<Address, DecodedMarket>> {
  const accounts = await fetchAccounts(rpc, addresses);
  const markets = new Map<Address, DecodedMarket>();
  for (const addressValue of addresses) {
    const market = parseMarket(addressValue, accounts.get(addressValue));
    if (market !== null) markets.set(addressValue, market);
  }
  return markets;
}

async function fetchMintTokenPrograms(
  rpc: SolanaRpcTransport,
  markets: ReadonlyMap<Address, DecodedMarket>
): Promise<ReadonlyMap<Address, Address>> {
  const mints = [
    ...new Set(
      [...markets.values()].flatMap((market) => [
        market.baseMint,
        market.quoteMint,
      ])
    ),
  ];
  const accounts = await fetchAccounts(rpc, mints);
  const programs = new Map<Address, Address>();
  for (const mint of mints) {
    const account = accounts.get(mint);
    if (
      account !== null &&
      isRecord(account) &&
      account.executable === false &&
      typeof account.owner === "string"
    ) {
      const tokenProgram = parseAddress(account.owner);
      if (tokenProgram !== null) programs.set(mint, tokenProgram);
    }
  }
  return programs;
}

async function fetchAccounts(
  rpc: SolanaRpcTransport,
  addresses: readonly Address[]
): Promise<ReadonlyMap<Address, unknown | null>> {
  const accounts = new Map<Address, unknown | null>();
  for (
    let start = 0;
    start < addresses.length;
    start += MULTIPLE_ACCOUNTS_LIMIT
  ) {
    const chunk = addresses.slice(start, start + MULTIPLE_ACCOUNTS_LIMIT);
    const response = await rpc.call("getMultipleAccounts", [
      chunk,
      { commitment: "confirmed", encoding: "base64" },
    ]);
    if (
      !isRecord(response) ||
      !Array.isArray(response.value) ||
      response.value.length !== chunk.length
    ) {
      throw new Error("RPC returned an incomplete account response.");
    }
    for (const [index, value] of response.value.entries()) {
      const addressValue = chunk[index];
      if (addressValue === undefined)
        throw new Error("RPC returned an invalid account response.");
      accounts.set(addressValue, value);
    }
  }
  return accounts;
}

function parseProgramAccounts(
  value: unknown,
  accountType: "series" | "seller-vault"
): readonly { readonly address: Address; readonly data: Uint8Array }[] {
  if (!Array.isArray(value))
    throw new Error(`RPC returned an invalid ${accountType} account response.`);
  return value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.pubkey !== "string" ||
      !isRecord(entry.account)
    ) {
      throw new Error(
        `RPC returned an invalid ${accountType} account response.`
      );
    }
    const accountAddress = parseAddress(entry.pubkey);
    if (accountAddress === null) return [];
    const data = parseOptionsAccountData(
      entry.account,
      accountType,
      accountAddress
    );
    return data === null ? [] : [{ address: accountAddress, data }];
  });
}

function parseSeries(input: {
  readonly address: Address;
  readonly data: Uint8Array;
}): DecodedSeries | null {
  const { address: seriesAddress, data } = input;
  const state = seriesState(data[8]);
  const optionType = optionTypeValue(data[41]);
  if (
    data.length !== SERIES_ACCOUNT_LENGTH ||
    !equalBytes(data.slice(0, 8), SERIES_ACCOUNT_DISCRIMINATOR) ||
    state === null ||
    optionType === null ||
    (data[66] !== 0 && data[66] !== 1)
  ) {
    logInvalidLayout("series", seriesAddress);
    return null;
  }
  const view = viewOf(data);
  const expiryMs = safeNumber(view.getBigUint64(50, true));
  const exerciseWindowEndMs = safeNumber(view.getBigUint64(58, true));
  if (expiryMs === null || exerciseWindowEndMs === null) {
    logInvalidLayout("series", seriesAddress);
    return null;
  }
  return {
    address: seriesAddress,
    marketAddress: getAddressDecoder().decode(data.slice(9, 41)),
    state,
    optionType,
    strikePrice: view.getBigUint64(42, true),
    expiryMs,
    exerciseWindowEndMs,
    expiryPrice: data[66] === 1 ? view.getBigUint64(67, true) : null,
    totalContracts: view.getBigUint64(75, true),
    totalManualExercised: view.getBigUint64(83, true),
    totalQuoteAmount: view.getBigUint64(99, true),
  };
}

function parseSellerVault(input: {
  readonly address: Address;
  readonly data: Uint8Array;
}): DecodedSellerVault | null {
  const { address: vaultAddress, data } = input;
  if (
    data.length !== SELLER_VAULT_ACCOUNT_LENGTH ||
    !equalBytes(data.slice(0, 8), SELLER_VAULT_ACCOUNT_DISCRIMINATOR)
  ) {
    logInvalidLayout("seller-vault", vaultAddress);
    return null;
  }
  const view = viewOf(data);
  return {
    address: vaultAddress,
    owner: getAddressDecoder().decode(data.slice(8, 40)),
    seriesAddress: getAddressDecoder().decode(data.slice(40, 72)),
    shortQuantity: view.getBigUint64(72, true),
    collateralQuantity: view.getBigUint64(80, true),
  };
}

function parseMarket(
  addressValue: Address,
  value: unknown
): DecodedMarket | null {
  if (!isRecord(value)) {
    logInvalidLayout("market", addressValue);
    return null;
  }
  const data = parseOptionsAccountData(value, "market", addressValue);
  if (
    data === null ||
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
    paused: data[75] === 1,
    baseMint: getAddressDecoder().decode(data.slice(108, 140)),
    quoteMint: getAddressDecoder().decode(data.slice(76, 108)),
  };
}

function parseOptionsAccountData(
  value: Record<string, unknown>,
  accountType: "series" | "market" | "seller-vault",
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

function requiredMapValue(
  map: ReadonlyMap<Address, Address>,
  key: Address,
  label: string
): Address {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}

function parseAddress(value: string): Address | null {
  try {
    return address(value);
  } catch {
    return null;
  }
}

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function safeNumber(value: bigint): number | null {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

function seriesState(value: number | undefined): 0 | 1 | 2 | null {
  if (value === 0 || value === 1 || value === 2) return value;
  return null;
}

function optionTypeValue(value: number | undefined): 0 | 1 | null {
  if (value === 0 || value === 1) return value;
  return null;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function logInvalidLayout(
  accountType: "series" | "market" | "seller-vault",
  addressValue: string
): void {
  console.debug(
    `option.${accountType} ${addressValue} has an invalid on-chain layout`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DecodedSeries {
  readonly address: Address;
  readonly marketAddress: Address;
  readonly state: 0 | 1 | 2;
  readonly optionType: 0 | 1;
  readonly strikePrice: bigint;
  readonly expiryMs: number;
  readonly exerciseWindowEndMs: number;
  readonly expiryPrice: bigint | null;
  readonly totalContracts: bigint;
  readonly totalManualExercised: bigint;
  readonly totalQuoteAmount: bigint;
}

interface DecodedSellerVault {
  readonly address: Address;
  readonly owner: Address;
  readonly seriesAddress: Address;
  readonly shortQuantity: bigint;
  readonly collateralQuantity: bigint;
}

interface DecodedMarket {
  readonly address: Address;
  readonly paused: boolean;
  readonly baseMint: Address;
  readonly quoteMint: Address;
}
