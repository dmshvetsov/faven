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
  readonly baseCoinMint: string;
  readonly quoteCoinMint: string;
  readonly baseCoinSymbol: string;
  readonly quoteCoinSymbol: string;
  readonly feeRecipient: string;
  readonly operationalFeeBps: number;
  readonly quantity: {
    readonly minimum: bigint;
    readonly step: bigint;
    readonly maximum: bigint;
  };
}

export interface EnvironmentConfig {
  readonly cluster: SolanaCluster;
  readonly allowedOrigins: readonly string[];
  readonly markets: readonly MarketConfig[];
}

const LOCAL_ORIGIN = "http://localhost:5173";

const TESTNET_SOL_MARKET: MarketConfig = {
  optionsProgramId: "11111111111111111111111111111111",
  marketAddress: "11111111111111111111111111111111",
  oracleBase: "SOL",
  baseCoinMint: "So11111111111111111111111111111111111111112",
  quoteCoinMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  baseCoinSymbol: "SOL",
  quoteCoinSymbol: "USDC",
  feeRecipient: "11111111111111111111111111111111",
  operationalFeeBps: 50,
  quantity: { minimum: 1n, step: 1n, maximum: 1_000n },
};

const environmentConfig: Record<ProductEnvironment, EnvironmentConfig> = {
  "development:testnet": {
    cluster: "testnet",
    allowedOrigins: [LOCAL_ORIGIN],
    markets: [TESTNET_SOL_MARKET],
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
  baseCoinMint: string
): MarketConfig | null {
  return (
    getEnvironmentConfig(environment).markets.find(
      (market) => market.baseCoinMint === baseCoinMint
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
