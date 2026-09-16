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
const COMPUTE_BUDGET_PROGRAM = address(
  "ComputeBudget111111111111111111111111111111"
);
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const LONG_TOKEN_PROGRAM = address(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const UNDERWRITE_CALL_DISCRIMINATOR = [
  0x7e, 0xf6, 0x59, 0xa5, 0x6a, 0xaa, 0x78, 0x93,
];
const UNDERWRITE_PUT_DISCRIMINATOR = [
  0xac, 0x0e, 0xf6, 0x1b, 0x1c, 0x27, 0xe5, 0xe1,
];
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const FIRST_UNDERWRITE_COMPUTE_UNITS = 400_000;

export const UNDERWRITE_INSTRUCTION_INDEX = 1;

export interface UnderwriteTransactionInput {
  readonly market: MarketConfig;
  readonly expiry: number;
  readonly isPut: boolean;
  /** option contract quantity using 18 decimals. */
  readonly quantity: string;
  /** USD strike using 8 decimals. */
  readonly strike: string;
  readonly seller: string;
  /** BaseCoin collateral source for calls and QuoteCoin collateral source for puts. */
  readonly sellerCollateralSource: string;
  /** QuoteCoin premium destination for calls. Puts reuse sellerCollateralSource. */
  readonly sellerQuoteDestination?: string;
  readonly maker: string;
  readonly buyerQuoteSource: string;
  /** QuoteCoin premium per whole option contract token using 18 decimals. */
  readonly premium: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
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
  const instructions = [
    computeBudgetInstruction(),
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
  const baseMint = address(input.market.baseMint);
  const baseTokenProgram = address(input.market.baseTokenProgram);
  const quoteMint = address(input.market.quoteMint);
  const quoteTokenProgram = address(input.market.quoteTokenProgram);
  const seller = address(input.seller);
  const buyer = address(input.maker);
  const buyerQuoteSource = address(input.buyerQuoteSource);
  const sellerCollateralSource = address(input.sellerCollateralSource);
  const sellerQuoteDestination = input.isPut
    ? sellerCollateralSource
    : address(requiredSellerQuoteDestination(input));
  const feeRecipient = address(input.market.feeRecipient);
  const [series, longMint, sellerVault] = await Promise.all([
    deriveOptionSeriesAddress(input),
    deriveSeriesPda("option_series_mint", input, programAddress, market),
    deriveSellerVault(input, programAddress, market, seller),
  ]);
  const [
    buyerLongAta,
    feeRecipientQuoteAta,
    baseCollateralVault,
    quoteCollateralVault,
  ] = await Promise.all([
    deriveAta(buyer, longMint, LONG_TOKEN_PROGRAM),
    deriveAta(feeRecipient, quoteMint, quoteTokenProgram),
    deriveAta(series, baseMint, baseTokenProgram),
    deriveAta(series, quoteMint, quoteTokenProgram),
  ]);
  return {
    programAddress,
    market,
    baseMint,
    baseTokenProgram,
    quoteMint,
    quoteTokenProgram,
    seller,
    buyer,
    buyerQuoteSource,
    sellerCollateralSource,
    sellerQuoteDestination,
    feeRecipient,
    series,
    longMint,
    buyerLongAta,
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

function computeBudgetInstruction() {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, FIRST_UNDERWRITE_COMPUTE_UNITS, true);
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    data,
    accounts: [],
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
      readonly(LONG_TOKEN_PROGRAM),
      readonly(accounts.baseTokenProgram),
      readonly(accounts.quoteTokenProgram),
      readonly(accounts.baseMint),
      readonly(accounts.quoteMint),
      writable(accounts.series),
      writable(accounts.longMint),
      writable(accounts.buyerLongAta),
      writable(accounts.buyerQuoteSource),
      ...(input.isPut
        ? [writable(accounts.sellerCollateralSource)]
        : [
            writable(accounts.sellerCollateralSource),
            writable(accounts.sellerQuoteDestination),
          ]),
      readonly(accounts.feeRecipient),
      writable(accounts.feeRecipientQuoteAta),
      writable(accounts.sellerVault),
      ...(input.isPut
        ? [
            writable(accounts.quoteCollateralVault),
            writable(accounts.baseCollateralVault),
          ]
        : [
            writable(accounts.baseCollateralVault),
            writable(accounts.quoteCollateralVault),
          ]),
      readonly(ASSOCIATED_TOKEN_PROGRAM),
      readonly(SYSTEM_PROGRAM),
    ],
  };
}

function requiredSellerQuoteDestination(
  input: UnderwriteTransactionInput
): string {
  if (input.sellerQuoteDestination === undefined) {
    throw new Error("missing-seller-quote-destination");
  }
  return input.sellerQuoteDestination;
}

function underwriteData(input: UnderwriteTransactionInput): Uint8Array {
  const data = new Uint8Array(58);
  data.set(
    input.isPut ? UNDERWRITE_PUT_DISCRIMINATOR : UNDERWRITE_CALL_DISCRIMINATOR
  );
  writeU64(data, 8, BigInt(input.expiry) * 1_000n);
  writeU64(data, 16, BigInt(input.strike));
  writeU128(data, 24, BigInt(input.quantity));
  writeU128(data, 40, BigInt(input.premium));
  writeU16(data, 56, input.market.operationalFeeBps);
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
  mint: ReturnType<typeof address>,
  tokenProgram: ReturnType<typeof address>
) {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [
      getAddressEncoder().encode(owner),
      getAddressEncoder().encode(tokenProgram),
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
