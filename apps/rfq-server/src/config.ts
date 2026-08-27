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

const environmentConfig: Record<ProductEnvironment, EnvironmentConfig> = {
  "development:testnet": {
    cluster: "testnet",
    allowedOrigins: [LOCAL_ORIGIN],
    markets: [],
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
