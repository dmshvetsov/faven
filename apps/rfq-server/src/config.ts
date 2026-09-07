import { baseUnits } from "./math";

export type ProductEnvironment =
  | "development:testnet"
  | "development:devnet"
  | "staging:devnet"
  | "production:mainnet";

export type SolanaCluster = "testnet" | "devnet" | "mainnet-beta";

export interface MarketConfig {
  readonly optionsProgramId: string;
  readonly marketAddress: string;
  readonly oracleBase: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly baseCoinSymbol: string;
  readonly quoteCoinSymbol: string;
  readonly feeRecipient: string;
  readonly operationalFeeBps: number;
  readonly quantity: {
    /** minimum underwrite quantity, 18 decimals. */
    readonly minimum: bigint;
    /** 18 decimals. */
    readonly step: bigint;
    /** maximum underwrite quantity, 18 decimals. */
    readonly maximum: bigint;
  };
}

export interface EnvironmentConfig {
  readonly cluster: SolanaCluster;
  readonly allowedOrigins: readonly string[];
  readonly markets: readonly MarketConfig[];
}

export const DEVNET_FUNDING = {
  mint: "4CzuKBggjWZ6SMxQgrrtJbQhJ3Vz4nXPvb7dKfvzqVQX",
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  decimals: 9,
  mintAmount: 100_000_000_000_000n,
  solLamports: 5_000_000n,
} as const;

export const WALLET_FUNDING_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

const LOCAL_ORIGIN = "http://localhost:5173";

const FAVEN_TREASURY = "FvNtr5ZWQxcJPkknFNTSWLBtg3UhP431CxtapqSodVXe";

const TESTNET_WSOL_MARKET: MarketConfig = {
  optionsProgramId: "11111111111111111111111111111111", // TBD
  marketAddress: "11111111111111111111111111111111", // TBD
  oracleBase: "SOL", // Pyth SOLUSD
  baseMint: "wSoLCzXHe214cjx7CFjP1axzXyqLkEwq5Xf873hy1JP",
  quoteMint: "usdcHvyN6fvECJ1poPYkt1vztze1pQ6psC8i4cji2Ly",
  baseCoinSymbol: "twSOL",
  quoteCoinSymbol: "tUSDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 50,
  quantity: {
    minimum: baseUnits(1n, 18),
    step: baseUnits(1n, 18),
    maximum: baseUnits(100n, 18),
  },
};

const environmentConfig: Record<ProductEnvironment, EnvironmentConfig> = {
  "development:testnet": {
    cluster: "testnet",
    allowedOrigins: [LOCAL_ORIGIN],
    markets: [TESTNET_WSOL_MARKET],
  },
  "development:devnet": { cluster: "devnet", allowedOrigins: [], markets: [] },
  "staging:devnet": { cluster: "devnet", allowedOrigins: [], markets: [] },
  "production:mainnet": {
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
