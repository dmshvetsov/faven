import { baseUnits } from "./math";

export type ProductEnvironment = Env["PRODUCT_ENVIRONMENT"];

export type SolanaCluster = Env["SOLANA_CLUSTER"];

export interface MarketConfig {
  readonly optionsProgramId: string;
  readonly marketAddress: string;
  readonly oracleBase: string;
  readonly baseMint: string;
  /** SPL Token program that owns the BaseCoin mint. */
  readonly baseTokenProgram: string;
  readonly baseMintDecimals: number;
  readonly quoteMint: string;
  /** SPL Token program that owns the QuoteCoin mint. */
  readonly quoteTokenProgram: string;
  /** QuoteCoin token decimals used to validate signed premium terms. */
  readonly quoteMintDecimals: number;
  readonly baseCoinSymbol: string;
  readonly quoteCoinSymbol: string;
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

const FAVEN_TREASURY = "FvNtr5ZWQxcJPkknFNTSWLBtg3UhP431CxtapqSodVXe";

const OPTIONS_PROGRAM_ID = "FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT";

const ONE_HOUR_MS = 60 * 60 * 1000;

const LOCALHOST_SOL_MARKET = {
  optionsProgramId: OPTIONS_PROGRAM_ID,
  marketAddress: "99rh3FNKgvuWigwrsaDLMSD9cX8XWkFAdTdHqLkW3BCC",
  oracleBase: "SOL", // Pyth SOLUSD
  baseMint: "So11111111111111111111111111111111111111112",
  baseTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  baseMintDecimals: 9,
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  quoteMintDecimals: 6,
  baseCoinSymbol: "wSOL",
  quoteCoinSymbol: "USDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 500,
  minFee: 200_000_000_000_000_000n, // 0.25 usdc e18
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
  baseMint: "wSoLCzXHe214cjx7CFjP1axzXyqLkEwq5Xf873hy1JP",
  baseTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  baseMintDecimals: 9,
  quoteMint: "usdcHvyN6fvECJ1poPYkt1vztze1pQ6psC8i4cji2Ly",
  quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  quoteMintDecimals: 6,
  baseCoinSymbol: "twSOL",
  quoteCoinSymbol: "tUSDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 523,
  minFee: 250_000_000_000_000_000n, // 0.25 usdc e18
  exerciseWindowMs: ONE_HOUR_MS,
  quantity: {
    minimum: baseUnits(1n, 18),
    step: baseUnits(1n, 18),
    maximum: baseUnits(100n, 18),
  },
};
const DEVNET_Tk22_MARKET: MarketConfig = {
  optionsProgramId: OPTIONS_PROGRAM_ID,
  marketAddress: "TBD",
  oracleBase: "SOL", // Pyth SOLUSD
  baseMint: "Tk22yqDFYZq4ydpL1quxzBjCFNkkczAjSNx6uZXtBbm",
  baseTokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  baseMintDecimals: 9,
  quoteMint: "usdcHvyN6fvECJ1poPYkt1vztze1pQ6psC8i4cji2Ly",
  quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  quoteMintDecimals: 6,
  baseCoinSymbol: "tk22SOL",
  quoteCoinSymbol: "tUSDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 400, // 4%
  minFee: 200_000_000_000_000_000n, // 0.2 usdc e18
  exerciseWindowMs: ONE_HOUR_MS,
  quantity: {
    minimum: baseUnits(1n, 18),
    step: baseUnits(1n, 18),
    maximum: baseUnits(100n, 18),
  },
};

const environmentConfig: Record<ProductEnvironment, EnvironmentConfig> = {
  "development:localhost": {
    cluster: "localhost",
    allowedOrigins: [LOCAL_ORIGIN],
    markets: [LOCALHOST_SOL_MARKET],
  },
  "stagingdevelopment:devnet": {
    cluster: "devnet",
    allowedOrigins: [LOCAL_ORIGIN],
    markets: [DEVNET_WSOL_MARKET, DEVNET_Tk22_MARKET],
  },
  "staging:devnet": {
    cluster: "devnet",
    allowedOrigins: [],
    markets: [DEVNET_WSOL_MARKET, DEVNET_Tk22_MARKET],
  },
  "production:mainnetbeta": {
    cluster: "mainnet-beta",
    allowedOrigins: [],
    markets: [],
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
