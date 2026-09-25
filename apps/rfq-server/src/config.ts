import { inspect } from "node:util";

import { baseUnits } from "./math";

inspect.defaultOptions.depth = 4;

export type ProductEnvironment = Env["PRODUCT_ENVIRONMENT"];

export type SolanaCluster = Env["SOLANA_CLUSTER"];

export interface MarketConfig {
  readonly optionsProgramId: string;
  readonly marketAddress: string;
  readonly oracleBase: string;
  readonly baseMintCategory: "crypto" | "tokenized_stocks";
  readonly baseMint: string;
  /** SPL Token program that owns the BaseCoin mint. */
  readonly baseTokenProgram: string;
  readonly baseMintDecimals: number;
  readonly quoteMint: string;
  /** SPL Token program that owns the QuoteCoin mint. */
  readonly quoteTokenProgram: string;
  /**
   * USD QuoteCoin token decimals used to validate signed premium terms.
   * RFQ server currently supports only USD quote markets.
   */
  readonly quoteMintDecimals: number;
  readonly baseTokenSymbol: string;
  readonly quoteTokenSymbol: string;
  readonly feeRecipient: string;
  readonly operationalFeeBps: number;
  /** QuoteCoin minimal required fee to pay for underwrite, base units, 18 decimals as premium */
  readonly minFee: bigint;
  readonly exerciseWindowMs: number;
  readonly quantity: {
    /** minimum underwrite quantity, base units, 18 decimals. */
    readonly minimum: bigint;
    /** 18 decimals. */
    readonly step: bigint;
    /** maximum underwrite quantity, base units, 18 decimals. */
    readonly maximum: bigint;
  };
}

export interface EnvironmentConfig {
  readonly cluster: SolanaCluster;
  readonly allowedOrigins: readonly string[];
  readonly markets: readonly MarketConfig[];
}

export type WalletFunding = DevnetSplTokenFunding | DevnetSolFunding;

export interface DevnetSplTokenFunding {
  readonly kind: "spl-token";
  readonly mint: string;
  readonly tokenProgram: string;
  readonly decimals: number;
  readonly mintAmount: bigint;
}

export interface DevnetSolFunding {
  readonly kind: "sol";
  readonly lamports: bigint;
}

export const DEVNET_FUNDING: readonly WalletFunding[] = [
  {
    kind: "spl-token",
    mint: "wSoLCzXHe214cjx7CFjP1axzXyqLkEwq5Xf873hy1JP",
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    decimals: 9,
    mintAmount: 1_000_000_000_000n,
  },
  {
    kind: "spl-token",
    mint: "usdcHvyN6fvECJ1poPYkt1vztze1pQ6psC8i4cji2Ly",
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    decimals: 6,
    mintAmount: 250_000_000_000n,
  },
  { kind: "sol", lamports: 50_000_000n },
];

/**
 * Used with Sufrpool development env
 */
export const LOCALHOST_FUNDING: readonly WalletFunding[] = [
  {
    kind: "spl-token",
    mint: "So11111111111111111111111111111111111111112",
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    decimals: 9,
    mintAmount: 1_000_000_000_000n,
  },
  {
    kind: "spl-token",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    decimals: 6,
    mintAmount: 250_000_000_000n,
  },
  {
    kind: "spl-token",
    mint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimals: 6,
    mintAmount: 1_000_000_000_000n,
  },
  {
    kind: "spl-token",
    mint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimals: 6,
    mintAmount: 1_000_000_000_000n,
  },
  { kind: "sol", lamports: 5_000_000_000n },
];

export const WALLET_FUNDING_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

const LOCAL_ORIGIN = "http://localhost:5173";
const BETA_ORIGIN = "https://beta.faven.markets";
const PRODUCTION_ORIGIN = "https://faven.markets";

const FAVEN_TREASURY = "FvNtr5ZWQxcJPkknFNTSWLBtg3UhP431CxtapqSodVXe";

const OPTIONS_PROGRAM_ID = "FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT";

const ONE_HOUR_MS = 60 * 60 * 1000;

const LOCALHOST_SOL_MARKET: MarketConfig = {
  optionsProgramId: OPTIONS_PROGRAM_ID,
  marketAddress: "99rh3FNKgvuWigwrsaDLMSD9cX8XWkFAdTdHqLkW3BCC",
  oracleBase: "SOL", // Pyth SOLUSD
  baseMintCategory: "crypto",
  baseMint: "So11111111111111111111111111111111111111112",
  baseTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  baseMintDecimals: 9,
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  quoteMintDecimals: 6,
  baseTokenSymbol: "wSOL",
  quoteTokenSymbol: "USDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 500,
  minFee: 200_000_000_000_000_000n, // 0.25 usdc e18
  exerciseWindowMs: ONE_HOUR_MS,
  quantity: {
    minimum: baseUnits(5n, 18),
    step: baseUnits(1n, 18),
    maximum: baseUnits(200n, 18),
  },
};
const LOCALHOST_PUMP_MARKET: MarketConfig = {
  optionsProgramId: OPTIONS_PROGRAM_ID,
  marketAddress: "GJiEFYsYKdX39hkhSs9WLF8AfGgXRjEtegGj3UrHbpXW",
  oracleBase: "PUMP", // Crypto.PUMP/USD, feed 1578
  baseMintCategory: "crypto",
  baseMint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
  baseTokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  baseMintDecimals: 6,
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  quoteMintDecimals: 6,
  baseTokenSymbol: "PUMP",
  quoteTokenSymbol: "USDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 500,
  minFee: 200_000_000_000_000_000n,
  exerciseWindowMs: ONE_HOUR_MS,
  quantity: {
    minimum: baseUnits(50_000n, 18),
    step: baseUnits(10_000n, 18),
    maximum: baseUnits(5_000_000n, 18),
  },
};
const LOCALHOST_SPCX_MARKET: MarketConfig = {
  optionsProgramId: OPTIONS_PROGRAM_ID,
  marketAddress: "6gL1TzV6e4QSffGJdvM7hCoVfe1nTZiB68QPD9ye6NDW",
  oracleBase: "SPCXX", // Crypto.SPCXX/USD, feed 3329
  baseMintCategory: "tokenized_stocks",
  baseMint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
  baseTokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  baseMintDecimals: 6,
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  quoteMintDecimals: 6,
  baseTokenSymbol: "SPCX",
  quoteTokenSymbol: "USDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 500,
  minFee: 200_000_000_000_000_000n,
  exerciseWindowMs: ONE_HOUR_MS,
  quantity: {
    minimum: baseUnits(1n, 18),
    step: baseUnits(1n, 18),
    maximum: baseUnits(100n, 18),
  },
};
const DEVNET_WSOL_MARKET: MarketConfig = {
  optionsProgramId: OPTIONS_PROGRAM_ID,
  marketAddress: "CY7qdovcTnpA6qo3Mp1J9Zws2ZnSnM7uXLyEXWGY3EUo",
  oracleBase: "SOL", // Pyth SOLUSD
  baseMintCategory: "crypto",
  baseMint: "wSoLCzXHe214cjx7CFjP1axzXyqLkEwq5Xf873hy1JP",
  baseTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  baseMintDecimals: 9,
  quoteMint: "usdcHvyN6fvECJ1poPYkt1vztze1pQ6psC8i4cji2Ly",
  quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  quoteMintDecimals: 6,
  baseTokenSymbol: "twSOL",
  quoteTokenSymbol: "tUSDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 523,
  minFee: 250_000_000_000_000_000n, // 0.25 usdc e18
  exerciseWindowMs: ONE_HOUR_MS,
  quantity: {
    minimum: baseUnits(5n, 18),
    step: baseUnits(1n, 18),
    maximum: baseUnits(200n, 18),
  },
};
const MAINNET_WSOL_MARKET: MarketConfig = {
  optionsProgramId: OPTIONS_PROGRAM_ID,
  marketAddress: "aXzusofq35owo8zRWoSAPD9L1wRqtdA7dTn9umNV2mQ",
  oracleBase: "SOL", // Pyth SOLUSD
  baseMintCategory: "crypto",
  baseMint: "So11111111111111111111111111111111111111112",
  baseTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  baseMintDecimals: 9,
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  quoteMintDecimals: 6,
  baseTokenSymbol: "wSOL",
  quoteTokenSymbol: "USDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 500,
  minFee: 750_000_000_000_000_000n, // 0.75 USDC e18
  exerciseWindowMs: ONE_HOUR_MS,
  quantity: {
    minimum: baseUnits(1n, 18),
    step: 250_000_000_000_000_000n,
    maximum: baseUnits(5n, 18),
  },
};
const MAINNET_SPCX_MARKET: MarketConfig = {
  optionsProgramId: OPTIONS_PROGRAM_ID,
  marketAddress: "BGuVF4TUfCsgLKfMTsdvbP6y9voFpY3uYjcgwHLvwDZm",
  oracleBase: "SPCXX", // Crypto.SPCXX/USD
  baseMintCategory: "tokenized_stocks",
  baseMint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
  baseTokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  baseMintDecimals: 6,
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  quoteMintDecimals: 6,
  baseTokenSymbol: "SPCX",
  quoteTokenSymbol: "USDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 500,
  minFee: 750_000_000_000_000_000n, // 0.75 USDC e18
  exerciseWindowMs: ONE_HOUR_MS,
  quantity: {
    minimum: baseUnits(1n, 18),
    step: baseUnits(1n, 18),
    maximum: baseUnits(10n, 18),
  },
};
const MAINNET_QUBT_MARKET: MarketConfig = {
  optionsProgramId: OPTIONS_PROGRAM_ID,
  marketAddress: "BSgY2pyXmN3B3eCaDVciPZEDJA6Q7uH3a2nohi58jCYY",
  oracleBase: "QUBT", // Equity.US.QUBT/USD
  baseMintCategory: "tokenized_stocks",
  baseMint: "QUBTAD8C9bMU9LvmMNgKPhrmBGbHvxpu6vfWQtThxxw",
  baseTokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  baseMintDecimals: 6,
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  quoteMintDecimals: 6,
  baseTokenSymbol: "QUBT",
  quoteTokenSymbol: "USDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 500,
  minFee: 750_000_000_000_000_000n, // 0.75 USDC e18
  exerciseWindowMs: ONE_HOUR_MS,
  quantity: {
    minimum: baseUnits(10n, 18),
    step: baseUnits(10n, 18),
    maximum: baseUnits(250n, 18),
  },
};
const MAINNET_URA_MARKET: MarketConfig = {
  optionsProgramId: OPTIONS_PROGRAM_ID,
  marketAddress: "7FdmveiaYgwhHdD2S7BjZPHJQ3gc7eeEqHPZhkXBXaKq",
  oracleBase: "URA", // Equity.US.URA/USD
  baseMintCategory: "tokenized_stocks",
  baseMint: "URARfsinxCRw4JpvQhuT4CxavdZXZEMjv9ZwWmWpwag",
  baseTokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  baseMintDecimals: 6,
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  quoteMintDecimals: 6,
  baseTokenSymbol: "URA",
  quoteTokenSymbol: "USDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 500,
  minFee: 750_000_000_000_000_000n, // 0.75 USDC e18
  exerciseWindowMs: ONE_HOUR_MS,
  quantity: {
    minimum: baseUnits(10n, 18),
    step: baseUnits(10n, 18),
    maximum: baseUnits(250n, 18),
  },
};
// const DEVNET_Tk22_MARKET: MarketConfig = {
//   optionsProgramId: OPTIONS_PROGRAM_ID,
//   marketAddress: "TBD",
//   oracleBase: "SOL", // Pyth SOLUSD
//   baseMintCategory: "crypto",
//   baseMint: "Tk22yqDFYZq4ydpL1quxzBjCFNkkczAjSNx6uZXtBbm",
//   baseTokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
//   baseMintDecimals: 9,
//   quoteMint: "usdcHvyN6fvECJ1poPYkt1vztze1pQ6psC8i4cji2Ly",
//   quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
//   quoteMintDecimals: 6,
//   baseTokenSymbol: "tk22SOL",
//   quoteTokenSymbol: "tUSDC",
//   feeRecipient: FAVEN_TREASURY,
//   operationalFeeBps: 400, // 4%
//   minFee: 200_000_000_000_000_000n, // 0.2 usdc e18
//   exerciseWindowMs: ONE_HOUR_MS,
//   quantity: {
//     minimum: baseUnits(1n, 18),
//     step: baseUnits(1n, 18),
//     maximum: baseUnits(100n, 18),
//   },
// };

/** RFQ server market configurations support USD QuoteCoin markets only. */
const environmentConfig: Record<ProductEnvironment, EnvironmentConfig> = {
  "development:localhost": {
    cluster: "localhost",
    allowedOrigins: [LOCAL_ORIGIN],
    markets: [
      LOCALHOST_SOL_MARKET,
      LOCALHOST_PUMP_MARKET,
      LOCALHOST_SPCX_MARKET,
    ],
  },
  "stagingdevelopment:devnet": {
    cluster: "devnet",
    allowedOrigins: [BETA_ORIGIN],
    markets: [DEVNET_WSOL_MARKET],
  },
  "staging:devnet": {
    cluster: "devnet",
    allowedOrigins: [BETA_ORIGIN],
    markets: [DEVNET_WSOL_MARKET],
  },
  "production:mainnetbeta": {
    cluster: "mainnet-beta",
    allowedOrigins: [PRODUCTION_ORIGIN, BETA_ORIGIN],
    markets: [
      MAINNET_WSOL_MARKET,
      MAINNET_SPCX_MARKET,
      MAINNET_QUBT_MARKET,
      MAINNET_URA_MARKET,
    ],
  },
};

export function getEnvironmentConfig(
  environment: ProductEnvironment
): EnvironmentConfig {
  return environmentConfig[environment];
}

export function isAllowedOrigin(
  environment: ProductEnvironment,
  origin: string | null
): boolean {
  return (
    origin !== null &&
    getEnvironmentConfig(environment).allowedOrigins.includes(origin)
  );
}

export function configuredMarket(
  environment: ProductEnvironment,
  baseMint: string
): MarketConfig | null {
  return (
    getEnvironmentConfig(environment).markets.find(
      (market) => market.baseMint === baseMint
    ) ?? null
  );
}

export function configuredMarketByAddress(
  environment: ProductEnvironment,
  marketAddress: string
): MarketConfig | null {
  return (
    getEnvironmentConfig(environment).markets.find(
      (market) => market.marketAddress === marketAddress
    ) ?? null
  );
}
