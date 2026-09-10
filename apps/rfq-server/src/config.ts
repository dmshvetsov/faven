import { baseUnits } from "./math";

export type ProductEnvironment = Env["PRODUCT_ENVIRONMENT"];

export type SolanaCluster = Env["SOLANA_CLUSTER"];

export interface MarketConfig {
  readonly optionsProgramId: string;
  readonly marketAddress: string;
  readonly oracleBase: string;
  readonly baseMint: string;
  readonly baseMintDecimals: number;
  readonly quoteMint: string;
  /** QuoteCoin token decimals used to validate signed premium terms. */
  readonly quoteMintDecimals: number;
  readonly baseCoinSymbol: string;
  readonly quoteCoinSymbol: string;
  readonly feeRecipient: string;
  readonly operationalFeeBps: number;
  /** QuoteCoin minimal required fee to pay for underwrite, base units, 18 decimals as premium */
  readonly minFee: bigint;
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

export type DevnetFunding = DevnetSplTokenFunding | DevnetSolFunding;

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

export const DEVNET_FUNDING: readonly DevnetFunding[] = [
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
  { kind: "sol", lamports: 5_000_000n },
];

export const WALLET_FUNDING_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

const LOCAL_ORIGIN = "http://localhost:5173";

const FAVEN_TREASURY = "FvNtr5ZWQxcJPkknFNTSWLBtg3UhP431CxtapqSodVXe";

const OPTIONS_PROGRAM_ID = "FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT";

const DEVNET_WSOL_MARKET: MarketConfig = {
  optionsProgramId: OPTIONS_PROGRAM_ID,
  marketAddress: "CY7qdovcTnpA6qo3Mp1J9Zws2ZnSnM7uXLyEXWGY3EUo",
  oracleBase: "SOL", // Pyth SOLUSD
  baseMint: "wSoLCzXHe214cjx7CFjP1axzXyqLkEwq5Xf873hy1JP",
  baseMintDecimals: 9,
  quoteMint: "usdcHvyN6fvECJ1poPYkt1vztze1pQ6psC8i4cji2Ly",
  quoteMintDecimals: 6,
  baseCoinSymbol: "twSOL",
  quoteCoinSymbol: "tUSDC",
  feeRecipient: FAVEN_TREASURY,
  operationalFeeBps: 523,
  minFee: 250_000_000_000_000_000n, // 0.25 usdc e18
  quantity: {
    minimum: baseUnits(1n, 18),
    step: baseUnits(1n, 18),
    maximum: baseUnits(100n, 18),
  },
};

const environmentConfig: Record<ProductEnvironment, EnvironmentConfig> = {
  "localdevelopment:devnet": {
    cluster: "devnet",
    allowedOrigins: [LOCAL_ORIGIN],
    markets: [DEVNET_WSOL_MARKET],
  },
  "stagingdevelopment:devnet": {
    cluster: "devnet",
    allowedOrigins: [LOCAL_ORIGIN],
    markets: [DEVNET_WSOL_MARKET],
  },
  "staging:devnet": {
    cluster: "devnet",
    allowedOrigins: [],
    markets: [DEVNET_WSOL_MARKET],
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
