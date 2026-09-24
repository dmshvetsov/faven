export type MarketCategory = "crypto" | "tokenized_stocks";

export type ApiMarket = {
  readonly marketAddress: string;
  readonly baseTokenSymbol: string;
  readonly quoteTokenSymbol: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly optionsProgramId: string;
  readonly baseTokenProgram: string;
  readonly quoteTokenProgram: string;
  readonly baseMintDecimals: number;
  readonly quoteMintDecimals: number;
  readonly quantityDecimals: number;
  readonly baseMintCategory: MarketCategory;
  readonly quantity: {
    readonly minimum: string;
    readonly step: string;
    readonly maximum: string;
  };
  readonly lastPrice: string;
};

export type ApiSeriesItem = {
  readonly expiryUnixMs: number;
  readonly strikePriceDecimals: string;
  readonly updateAt: number;
};

export type ApiSeries = {
  readonly call: readonly ApiSeriesItem[];
  readonly put: readonly ApiSeriesItem[];
};

export type MarketsResponse = { readonly markets: readonly ApiMarket[] };
export type MarketSeriesResponse = {
  readonly market: ApiMarket;
  readonly series: ApiSeries;
};

export type RfqServerQueryKey =
  readonly ["markets"] | readonly ["markets", string, "series"];

const serverUrl = requiredServerUrl();

export async function rfqServerQueryFn({
  queryKey,
}: {
  readonly queryKey: readonly unknown[];
}): Promise<MarketsResponse | MarketSeriesResponse> {
  if (!isRfqServerQueryKey(queryKey)) {
    throw new Error("Unsupported RFQ server query key.");
  }
  const response = await fetch(endpointFor(queryKey));
  if (!response.ok) {
    throw new Error(
      `RFQ server request failed with status ${response.status}.`
    );
  }
  return parseResponse(queryKey, await response.json());
}

function isRfqServerQueryKey(
  queryKey: readonly unknown[]
): queryKey is RfqServerQueryKey {
  return (
    (queryKey.length === 1 && queryKey[0] === "markets") ||
    (queryKey.length === 3 &&
      queryKey[0] === "markets" &&
      typeof queryKey[1] === "string" &&
      queryKey[2] === "series")
  );
}

export function endpointFor(queryKey: RfqServerQueryKey): string {
  if (queryKey.length === 1) return `${serverUrl}/markets`;
  return `${serverUrl}/markets/${encodeURIComponent(queryKey[1])}/series`;
}

/**
 * Localhost and devnet servers can prepare a connected wallet with the test
 * SOL and tokens needed to underwrite. Production deliberately returns 404.
 */
export async function requestDevelopmentWalletFunding(
  walletAddress: string
): Promise<void> {
  const response = await fetch(`${serverUrl}/wallet-fundings`, {
    body: JSON.stringify({ walletAddress }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  // Production has no faucet; a wallet funded in the preceding 24 hours does
  // not need another one. Both cases may proceed with the normal RFQ flow.
  if (response.ok || response.status === 404 || response.status === 429) return;
  throw new Error(
    `Wallet funding request failed with status ${response.status}.`
  );
}

function requiredServerUrl(): string {
  const value = import.meta.env.VITE_RFQ_SERVER_URL?.trim();
  if (!value) throw new Error("VITE_RFQ_SERVER_URL must be configured.");
  return value.replace(/\/+$/, "");
}

function parseResponse(
  queryKey: RfqServerQueryKey,
  value: unknown
): MarketsResponse | MarketSeriesResponse {
  const record = recordValue(value, "RFQ server response");
  if (queryKey.length === 1) {
    return { markets: arrayValue(record.markets, "markets").map(parseMarket) };
  }
  return {
    market: parseMarket(record.market),
    series: parseSeries(record.series),
  };
}

function parseMarket(value: unknown): ApiMarket {
  const record = recordValue(value, "market");
  const category = stringValue(record.baseMintCategory, "baseMintCategory");
  if (category !== "crypto" && category !== "tokenized_stocks") {
    throw new Error("RFQ server returned an unknown market category.");
  }
  const quantity = recordValue(record.quantity, "quantity");
  const minimum = unsignedInteger(quantity.minimum, "quantity.minimum");
  const step = unsignedInteger(quantity.step, "quantity.step");
  const maximum = unsignedInteger(quantity.maximum, "quantity.maximum");
  if (
    BigInt(step) === 0n ||
    BigInt(minimum) > BigInt(maximum) ||
    (BigInt(maximum) - BigInt(minimum)) % BigInt(step) !== 0n
  ) {
    throw new Error("RFQ server returned invalid quantity terms.");
  }
  return {
    marketAddress: stringValue(record.marketAddress, "marketAddress"),
    baseTokenSymbol: stringValue(record.baseTokenSymbol, "baseTokenSymbol"),
    quoteTokenSymbol: stringValue(record.quoteTokenSymbol, "quoteTokenSymbol"),
    baseMint: stringValue(record.baseMint, "baseMint"),
    quoteMint: stringValue(record.quoteMint, "quoteMint"),
    optionsProgramId: stringValue(record.optionsProgramId, "optionsProgramId"),
    baseTokenProgram: stringValue(record.baseTokenProgram, "baseTokenProgram"),
    quoteTokenProgram: stringValue(
      record.quoteTokenProgram,
      "quoteTokenProgram"
    ),
    baseMintDecimals: nonNegativeInteger(
      record.baseMintDecimals,
      "baseMintDecimals"
    ),
    quoteMintDecimals: nonNegativeInteger(
      record.quoteMintDecimals,
      "quoteMintDecimals"
    ),
    quantityDecimals: nonNegativeInteger(
      record.quantityDecimals,
      "quantityDecimals"
    ),
    baseMintCategory: category,
    quantity: { minimum, step, maximum },
    lastPrice: decimal(record.lastPrice, "lastPrice"),
  };
}

function parseSeries(value: unknown): ApiSeries {
  const record = recordValue(value, "series");
  return {
    call: arrayValue(record.call, "series.call").map(parseSeriesItem),
    put: arrayValue(record.put, "series.put").map(parseSeriesItem),
  };
}

function parseSeriesItem(value: unknown): ApiSeriesItem {
  const record = recordValue(value, "series item");
  return {
    expiryUnixMs: nonNegativeInteger(record.expiryUnixMs, "expiryUnixMs"),
    strikePriceDecimals: positiveInteger(
      record.strikePriceDecimals,
      "strikePriceDecimals"
    ),
    updateAt: nonNegativeInteger(record.updateAt, "updateAt"),
  };
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`RFQ server returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value))
    throw new Error(`RFQ server returned invalid ${label}.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`RFQ server returned invalid ${label}.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`RFQ server returned invalid ${label}.`);
  }
  return value;
}

function unsignedInteger(value: unknown, label: string): string {
  const string = stringValue(value, label);
  if (!/^\d+$/.test(string))
    throw new Error(`RFQ server returned invalid ${label}.`);
  return string;
}

function positiveInteger(value: unknown, label: string): string {
  const string = unsignedInteger(value, label);
  if (BigInt(string) === 0n)
    throw new Error(`RFQ server returned invalid ${label}.`);
  return string;
}

function decimal(value: unknown, label: string): string {
  const string = stringValue(value, label);
  if (!/^\d+(?:\.\d+)?$/.test(string)) {
    throw new Error(`RFQ server returned invalid ${label}.`);
  }
  return string;
}
