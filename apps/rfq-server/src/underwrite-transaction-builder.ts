import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

import type { MarketConfig } from "./config";

const ASSOCIATED_TOKEN_PROGRAM = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const CREATE_SERIES_DISCRIMINATOR = [
  0xb5, 0x09, 0x34, 0x78, 0xc5, 0xdd, 0x2a, 0x8e,
];
const UNDERWRITE_CALL_DISCRIMINATOR = [
  0x7e, 0xf6, 0x59, 0xa5, 0x6a, 0xaa, 0x78, 0x93,
];
const UNDERWRITE_PUT_DISCRIMINATOR = [
  0xac, 0x0e, 0xf6, 0x1b, 0x1c, 0x27, 0xe5, 0xe1,
];
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export interface UnderwriteTransactionInput {
  readonly market: MarketConfig;
  readonly expiry: number;
  readonly isPut: boolean;
  /** option contract quantity using 18 decimals. */
  readonly quantity: string;
  /** USD strike using 8 decimals. */
  readonly strike: string;
  readonly seller: string;
  readonly sellerCollateralSource: string;
  readonly maker: string;
  readonly buyerQuoteSource: string;
  /** QuoteCoin premium per whole option contract token using 18 decimals. */
  readonly premium: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly seriesExists: boolean;
}

export interface OptionSeriesInput {
  readonly market: MarketConfig;
  readonly expiry: number;
  readonly isPut: boolean;
  readonly strike: string;
}

export async function buildUnderwriteTransaction(
  input: UnderwriteTransactionInput
): Promise<string> {
  const accounts = await deriveAccounts(input);
  const instructions = input.seriesExists
    ? [underwriteInstruction(input, accounts)]
    : [
        createSeriesInstruction(input, accounts),
        underwriteInstruction(input, accounts),
      ];
  const message = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(input.blockhash),
        lastValidBlockHeight: BigInt(input.lastValidBlockHeight),
      },
      setTransactionMessageFeePayer(
        accounts.seller,
        createTransactionMessage({ version: 0 })
      )
    )
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

async function deriveAccounts(input: UnderwriteTransactionInput) {
  const programAddress = address(input.market.optionsProgramId);
  const market = address(input.market.marketAddress);
  const baseCoinMint = address(input.market.baseCoinMint);
  const quoteCoinMint = address(input.market.quoteCoinMint);
  const seller = address(input.seller);
  const buyer = address(input.maker);
  const buyerQuoteSource = address(input.buyerQuoteSource);
  const sellerCollateralSource = address(input.sellerCollateralSource);
  const feeRecipient = address(input.market.feeRecipient);
  const [series, longMint, sellerVault] = await Promise.all([
    deriveOptionSeriesAddress(input),
    deriveSeriesPda("option_series_mint", input, programAddress, market),
    deriveSellerVault(input, programAddress, market, seller),
  ]);
  const [
    buyerLongAta,
    sellerQuoteAta,
    feeRecipientQuoteAta,
    baseCollateralVault,
    quoteCollateralVault,
  ] = await Promise.all([
    deriveAta(buyer, longMint),
    deriveAta(seller, quoteCoinMint),
    deriveAta(feeRecipient, quoteCoinMint),
    deriveAta(series, baseCoinMint),
    deriveAta(series, quoteCoinMint),
  ]);
  return {
    programAddress,
    market,
    baseCoinMint,
    quoteCoinMint,
    seller,
    buyer,
    buyerQuoteSource,
    sellerCollateralSource,
    feeRecipient,
    series,
    longMint,
    buyerLongAta,
    sellerQuoteAta,
    feeRecipientQuoteAta,
    sellerVault,
    baseCollateralVault,
    quoteCollateralVault,
  };
}

export async function deriveOptionSeriesAddress(
  input: OptionSeriesInput
): Promise<ReturnType<typeof address>> {
  const programAddress = address(input.market.optionsProgramId);
  const market = address(input.market.marketAddress);
  return deriveSeriesPda("option_series", input, programAddress, market);
}

function createSeriesInstruction(
  input: UnderwriteTransactionInput,
  accounts: Awaited<ReturnType<typeof deriveAccounts>>
) {
  return {
    programAddress: accounts.programAddress,
    data: createSeriesData(input),
    accounts: [
      writableSigner(accounts.seller),
      readonly(accounts.market),
      readonly(accounts.baseCoinMint),
      readonly(accounts.quoteCoinMint),
      writable(accounts.series),
      writable(accounts.longMint),
      writable(accounts.baseCollateralVault),
      writable(accounts.quoteCollateralVault),
      readonly(TOKEN_PROGRAM),
      readonly(ASSOCIATED_TOKEN_PROGRAM),
      readonly(SYSTEM_PROGRAM),
    ],
  };
}

function underwriteInstruction(
  input: UnderwriteTransactionInput,
  accounts: Awaited<ReturnType<typeof deriveAccounts>>
) {
  return {
    programAddress: accounts.programAddress,
    data: underwriteData(input),
    accounts: [
      readonlySigner(accounts.buyer),
      writableSigner(accounts.seller),
      readonly(accounts.market),
      readonly(accounts.baseCoinMint),
      readonly(accounts.quoteCoinMint),
      writable(accounts.series),
      writable(accounts.longMint),
      writable(accounts.buyerLongAta),
      writable(accounts.buyerQuoteSource),
      writable(accounts.sellerCollateralSource),
      writable(accounts.sellerQuoteAta),
      readonly(accounts.feeRecipient),
      writable(accounts.feeRecipientQuoteAta),
      writable(accounts.sellerVault),
      writable(accounts.baseCollateralVault),
      writable(accounts.quoteCollateralVault),
      readonly(TOKEN_PROGRAM),
      readonly(ASSOCIATED_TOKEN_PROGRAM),
      readonly(SYSTEM_PROGRAM),
    ],
  };
}

function createSeriesData(input: UnderwriteTransactionInput): Uint8Array {
  const data = new Uint8Array(25);
  data.set(CREATE_SERIES_DISCRIMINATOR);
  data[8] = input.isPut ? 1 : 0;
  writeU64(data, 9, BigInt(input.strike));
  writeU64(data, 17, BigInt(input.expiry) * 1_000n);
  return data;
}

function underwriteData(input: UnderwriteTransactionInput): Uint8Array {
  const data = new Uint8Array(42);
  data.set(
    input.isPut ? UNDERWRITE_PUT_DISCRIMINATOR : UNDERWRITE_CALL_DISCRIMINATOR
  );
  writeU128(data, 8, BigInt(input.quantity));
  writeU128(data, 24, BigInt(input.premium));
  writeU16(data, 40, input.market.operationalFeeBps);
  return data;
}

async function deriveSeriesPda(
  seed: string,
  input: OptionSeriesInput,
  programAddress: ReturnType<typeof address>,
  market: ReturnType<typeof address>
) {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [
      new TextEncoder().encode(seed),
      getAddressEncoder().encode(market),
      new Uint8Array([input.isPut ? 2 : 1]),
      u64Bytes(BigInt(input.expiry) * 1_000n),
      u64Bytes(BigInt(input.strike)),
    ],
  });
  return pda;
}

async function deriveSellerVault(
  input: UnderwriteTransactionInput,
  programAddress: ReturnType<typeof address>,
  market: ReturnType<typeof address>,
  seller: ReturnType<typeof address>
) {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [
      new TextEncoder().encode("option_series_seller_vault"),
      getAddressEncoder().encode(market),
      new Uint8Array([input.isPut ? 2 : 1]),
      u64Bytes(BigInt(input.expiry) * 1_000n),
      u64Bytes(BigInt(input.strike)),
      getAddressEncoder().encode(seller),
    ],
  });
  return pda;
}

async function deriveAta(
  owner: ReturnType<typeof address>,
  mint: ReturnType<typeof address>
) {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [
      getAddressEncoder().encode(owner),
      getAddressEncoder().encode(TOKEN_PROGRAM),
      getAddressEncoder().encode(mint),
    ],
  });
  return ata;
}

function writableSigner(account: ReturnType<typeof address>) {
  return { address: account, role: AccountRole.WRITABLE_SIGNER };
}

function readonlySigner(account: ReturnType<typeof address>) {
  return { address: account, role: AccountRole.READONLY_SIGNER };
}

function writable(account: ReturnType<typeof address>) {
  return { address: account, role: AccountRole.WRITABLE };
}

function readonly(account: ReturnType<typeof address>) {
  return { address: account, role: AccountRole.READONLY };
}

function writeU64(data: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value > U64_MAX) throw new Error("u64-out-of-range");
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(
    offset,
    value,
    true
  );
}

function writeU128(data: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value > U128_MAX) throw new Error("u128-out-of-range");
  writeU64(data, offset, value & U64_MAX);
  writeU64(data, offset + 8, value >> 64n);
}

function writeU16(data: Uint8Array, offset: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error("u16-out-of-range");
  }
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint16(
    offset,
    value,
    true
  );
}

function u64Bytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  writeU64(bytes, 0, value);
  return bytes;
}
