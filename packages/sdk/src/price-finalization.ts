import { getBase58Decoder, getBase58Encoder } from "@solana/kit";

const OPTIONS_PROGRAM_ADDRESS = "FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT";
const EXPIRY_PRICE_FINALIZED_EVENT_LENGTH = 82;
const SERIES_ACCOUNT_LENGTH = 107;
const MARKET_ACCOUNT_LENGTH = 152;
const SERIES_ACCOUNT_DISCRIMINATOR = new Uint8Array([
  240, 97, 8, 183, 139, 77, 250, 162,
]);
const MARKET_ACCOUNT_DISCRIMINATOR = new Uint8Array([
  219, 190, 213, 55, 0, 227, 198, 154,
]);

export type PriceFinalizationMethod = "pythTwap" | "pythUnverified";

export interface FinalizedPriceFinalization {
  readonly seriesAddress: string;
  /** USD price in e8 fixed-point units. */
  readonly expiryPrice: string;
  readonly method: PriceFinalizationMethod;
  readonly slot: number;
  readonly signature: string;
  /** Finalization transaction block time, when supplied by the RPC. */
  readonly finalizedAtMs: number | null;
}

export interface SeriesBackfill {
  readonly seriesAddress: string;
  readonly marketAddress: string;
  readonly isPut: boolean;
  /** USD strike in e8 fixed-point units. */
  readonly strike: string;
  readonly expiryMs: number;
  /** USD expiry price in e8 fixed-point units. */
  readonly expiryPrice: string;
  readonly baseMint: string;
  readonly quoteMint: string;
}

export class PriceFinalizationError extends Error {
  constructor(
    readonly kind:
      | "not-finalized"
      | "failed"
      | "unrelated"
      | "malformed"
      | "rpc-unavailable",
    message: string
  ) {
    super(message);
  }
}

export async function decodeFinalizedPriceFinalizations(input: {
  readonly rpcUrl: string;
  readonly signature: string;
}): Promise<readonly FinalizedPriceFinalization[]> {
  validateSignature(input.signature);
  const transaction = await fetchFinalizedTransaction(
    input.rpcUrl,
    input.signature
  );
  if (transaction === null) {
    throw new PriceFinalizationError(
      "not-finalized",
      "Transaction is not finalized."
    );
  }
  if (transaction.meta.err !== null) {
    throw new PriceFinalizationError("failed", "Transaction failed on-chain.");
  }

  const expectedSeries = await finalizationSeries(transaction);
  if (expectedSeries.size === 0) {
    throw new PriceFinalizationError(
      "unrelated",
      "Transaction contains no price-finalization instruction."
    );
  }

  const events = decodeEvents(transaction.meta.logMessages);
  const results: FinalizedPriceFinalization[] = [];
  const seenSeries = new Set<string>();
  for (const event of events) {
    const expectedMethod = expectedSeries.get(event.seriesAddress);
    if (expectedMethod === undefined || expectedMethod !== event.method) {
      throw new PriceFinalizationError(
        "malformed",
        "Transaction contains an unexpected price-finalization event."
      );
    }
    if (seenSeries.has(event.seriesAddress)) {
      throw new PriceFinalizationError(
        "malformed",
        "Transaction finalizes a series more than once."
      );
    }
    seenSeries.add(event.seriesAddress);
    results.push({
      seriesAddress: event.seriesAddress,
      expiryPrice: event.expiryPrice,
      method: event.method,
      slot: transaction.slot,
      signature: input.signature,
      finalizedAtMs:
        transaction.blockTime === null ? null : transaction.blockTime * 1_000,
    });
  }
  if (seenSeries.size !== expectedSeries.size) {
    throw new PriceFinalizationError(
      "malformed",
      "Transaction did not emit a price-finalization event for every series."
    );
  }
  return results;
}

export function validateSignature(signature: string): void {
  try {
    if (getBase58Encoder().encode(signature).length !== 64) throw new Error();
  } catch {
    throw new PriceFinalizationError(
      "malformed",
      "Transaction signature is invalid."
    );
  }
}

export async function fetchSeriesBackfill(input: {
  readonly rpcUrl: string;
  readonly seriesAddress: string;
  readonly minContextSlot: number;
}): Promise<SeriesBackfill> {
  validateAddress(input.seriesAddress, "Series address");
  if (!isSlot(input.minContextSlot)) {
    throw new PriceFinalizationError(
      "malformed",
      "Finalization slot is invalid."
    );
  }
  const series = parseSeriesAccount(
    await fetchAccount(input.rpcUrl, input.seriesAddress, input.minContextSlot)
  );
  const market = parseMarketAccount(
    await fetchAccount(input.rpcUrl, series.marketAddress, input.minContextSlot)
  );
  return {
    seriesAddress: input.seriesAddress,
    marketAddress: series.marketAddress,
    isPut: series.isPut,
    strike: series.strike,
    expiryMs: series.expiryMs,
    expiryPrice: series.expiryPrice,
    baseMint: market.baseMint,
    quoteMint: market.quoteMint,
  };
}

interface FinalizedTransaction {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly meta: {
    readonly err: unknown | null;
    readonly logMessages: readonly string[];
    readonly loadedAddresses: {
      readonly writable: readonly string[];
      readonly readonly: readonly string[];
    };
  };
  readonly accountKeys: readonly string[];
  readonly instructions: readonly CompiledInstruction[];
}

interface CompiledInstruction {
  readonly programIdIndex: number;
  readonly accounts: readonly number[];
  readonly data: string;
}

async function fetchFinalizedTransaction(
  rpcUrl: string,
  signature: string
): Promise<FinalizedTransaction | null> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "getTransaction",
        method: "getTransaction",
        params: [
          signature,
          {
            commitment: "finalized",
            encoding: "json",
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
    });
  } catch {
    throw new PriceFinalizationError(
      "rpc-unavailable",
      "Solana RPC is unavailable."
    );
  }
  if (!response.ok) {
    throw new PriceFinalizationError(
      "rpc-unavailable",
      "Solana RPC is unavailable."
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PriceFinalizationError(
      "rpc-unavailable",
      "Solana RPC is unavailable."
    );
  }
  if (!isRecord(body) || isRecord(body.error) || !("result" in body)) {
    throw new PriceFinalizationError(
      "rpc-unavailable",
      "Solana RPC is unavailable."
    );
  }
  if (body.result === null) return null;
  return parseTransaction(body.result);
}

async function fetchAccount(
  rpcUrl: string,
  address: string,
  minContextSlot: number
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "getAccountInfo",
        method: "getAccountInfo",
        params: [
          address,
          {
            commitment: "finalized",
            encoding: "base64",
            minContextSlot,
          },
        ],
      }),
    });
  } catch {
    throw new PriceFinalizationError(
      "rpc-unavailable",
      "Solana RPC is unavailable."
    );
  }
  if (!response.ok) {
    throw new PriceFinalizationError(
      "rpc-unavailable",
      "Solana RPC is unavailable."
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PriceFinalizationError(
      "rpc-unavailable",
      "Solana RPC is unavailable."
    );
  }
  if (!isRecord(body) || isRecord(body.error) || !isRecord(body.result)) {
    throw new PriceFinalizationError(
      "rpc-unavailable",
      "Solana RPC is unavailable."
    );
  }
  if (!isRecord(body.result.value)) throw malformedTransaction();
  const account = body.result.value;
  if (
    account.owner !== OPTIONS_PROGRAM_ADDRESS ||
    !isBase64Data(account.data)
  ) {
    throw malformedTransaction();
  }
  try {
    return Uint8Array.from(
      atob(account.data[0]),
      (character) => character.codePointAt(0) ?? 0
    );
  } catch {
    throw malformedTransaction();
  }
}

function parseSeriesAccount(data: Uint8Array): {
  readonly marketAddress: string;
  readonly isPut: boolean;
  readonly strike: string;
  readonly expiryMs: number;
  readonly expiryPrice: string;
} {
  if (
    data.length !== SERIES_ACCOUNT_LENGTH ||
    !equalBytes(data.slice(0, 8), SERIES_ACCOUNT_DISCRIMINATOR) ||
    (data[8] !== 1 && data[8] !== 2) ||
    (data[41] !== 0 && data[41] !== 1) ||
    data[66] !== 1
  ) {
    throw malformedTransaction();
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const expiryMs = view.getBigUint64(50, true);
  if (expiryMs > BigInt(Number.MAX_SAFE_INTEGER)) throw malformedTransaction();
  return {
    marketAddress: decodeAddress(data.slice(9, 41)),
    isPut: data[41] === 1,
    strike: view.getBigUint64(42, true).toString(),
    expiryMs: Number(expiryMs),
    expiryPrice: view.getBigUint64(67, true).toString(),
  };
}

function parseMarketAccount(data: Uint8Array): {
  readonly baseMint: string;
  readonly quoteMint: string;
} {
  if (
    data.length !== MARKET_ACCOUNT_LENGTH ||
    !equalBytes(data.slice(0, 8), MARKET_ACCOUNT_DISCRIMINATOR)
  ) {
    throw malformedTransaction();
  }
  return {
    quoteMint: decodeAddress(data.slice(76, 108)),
    baseMint: decodeAddress(data.slice(108, 140)),
  };
}

function parseTransaction(value: unknown): FinalizedTransaction {
  if (
    !isRecord(value) ||
    !isRecord(value.meta) ||
    !isRecord(value.transaction)
  ) {
    throw malformedTransaction();
  }
  const { slot, blockTime, meta, transaction } = value;
  if (!isSlot(slot) || (blockTime !== null && !isUnixTime(blockTime))) {
    throw malformedTransaction();
  }
  const logMessages = stringArray(meta.logMessages);
  if (!("err" in meta) || logMessages === null) throw malformedTransaction();
  if (!isRecord(transaction.message)) throw malformedTransaction();
  const accountKeys = stringArray(transaction.message.accountKeys);
  const instructions = compiledInstructions(transaction.message.instructions);
  if (accountKeys === null || instructions === null)
    throw malformedTransaction();
  const loadedAddresses = parseLoadedAddresses(meta.loadedAddresses);
  if (loadedAddresses === null) throw malformedTransaction();
  return {
    slot,
    blockTime,
    meta: {
      err: meta.err,
      logMessages,
      loadedAddresses,
    },
    accountKeys: [
      ...accountKeys,
      ...loadedAddresses.writable,
      ...loadedAddresses.readonly,
    ],
    instructions,
  };
}

async function finalizationSeries(
  transaction: FinalizedTransaction
): Promise<Map<string, PriceFinalizationMethod>> {
  const [twapDiscriminator, unverifiedDiscriminator] = await Promise.all([
    anchorDiscriminator("global:finalize_pyth_twap_series"),
    anchorDiscriminator("global:finalize_pyth_unverified_series"),
  ]);
  const expected = new Map<string, PriceFinalizationMethod>();
  for (const instruction of transaction.instructions) {
    const programAddress = transaction.accountKeys[instruction.programIdIndex];
    if (programAddress !== OPTIONS_PROGRAM_ADDRESS) continue;
    const data = decodeBase58(instruction.data);
    if (data === null) throw malformedTransaction();
    const method =
      equalBytes(data, twapDiscriminator) && data.length === 8
        ? { method: "pythTwap" as const, leadingAccounts: 3 }
        : equalBytes(data.slice(0, 8), unverifiedDiscriminator) &&
            data.length === 68
          ? { method: "pythUnverified" as const, leadingAccounts: 6 }
          : null;
    if (method === null) continue;
    const seriesIndexes = instruction.accounts.slice(method.leadingAccounts);
    if (seriesIndexes.length === 0 || seriesIndexes.length % 2 !== 0) {
      throw malformedTransaction();
    }
    for (let index = 0; index < seriesIndexes.length; index += 2) {
      const seriesAddress = transaction.accountKeys[seriesIndexes[index] ?? -1];
      if (seriesAddress === undefined || expected.has(seriesAddress)) {
        throw malformedTransaction();
      }
      expected.set(seriesAddress, method.method);
    }
  }
  return expected;
}

function decodeEvents(logMessages: readonly string[]): readonly {
  readonly seriesAddress: string;
  readonly expiryPrice: string;
  readonly method: PriceFinalizationMethod;
}[] {
  const activePrograms: string[] = [];
  const events: {
    seriesAddress: string;
    expiryPrice: string;
    method: PriceFinalizationMethod;
  }[] = [];
  for (const message of logMessages) {
    const invoked = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[\d+\]$/.exec(
      message
    );
    if (invoked !== null) {
      activePrograms.push(invoked[1] ?? "");
      continue;
    }
    if (
      /^Program [1-9A-HJ-NP-Za-km-z]+ (?:success|failed: .+)$/.test(message)
    ) {
      activePrograms.pop();
      continue;
    }
    const data = /^Program data: (.+)$/.exec(message)?.[1];
    if (
      data === undefined ||
      activePrograms.at(-1) !== OPTIONS_PROGRAM_ADDRESS
    ) {
      continue;
    }
    const event = decodeEvent(data);
    if (event !== null) events.push(event);
  }
  return events;
}

function decodeEvent(data: string): {
  readonly seriesAddress: string;
  readonly expiryPrice: string;
  readonly method: PriceFinalizationMethod;
} | null {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(
      atob(data),
      (character) => character.codePointAt(0) ?? 0
    );
  } catch {
    return null;
  }
  const expectedDiscriminator = eventDiscriminator();
  if (!equalBytes(bytes.slice(0, 8), expectedDiscriminator)) return null;
  if (bytes.length !== EXPIRY_PRICE_FINALIZED_EVENT_LENGTH || bytes[48] !== 0) {
    throw malformedTransaction();
  }
  const method =
    bytes[81] === 0 ? "pythTwap" : bytes[81] === 1 ? "pythUnverified" : null;
  if (method === null) throw malformedTransaction();
  try {
    return {
      seriesAddress: getBase58Decoder().decode(bytes.slice(8, 40)),
      expiryPrice: new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      )
        .getBigUint64(40, true)
        .toString(),
      method,
    };
  } catch {
    throw malformedTransaction();
  }
}

function eventDiscriminator(): Uint8Array {
  return new Uint8Array([140, 39, 122, 134, 92, 86, 63, 104]);
}

async function anchorDiscriminator(value: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return new Uint8Array(hash).slice(0, 8);
}

function decodeBase58(value: string): Uint8Array | null {
  try {
    return new Uint8Array(getBase58Encoder().encode(value));
  } catch {
    return null;
  }
}

function validateAddress(value: string, name: string): void {
  try {
    if (getBase58Encoder().encode(value).length !== 32) throw new Error();
  } catch {
    throw new PriceFinalizationError("malformed", `${name} is invalid.`);
  }
}

function decodeAddress(bytes: Uint8Array): string {
  try {
    return getBase58Decoder().decode(bytes);
  } catch {
    throw malformedTransaction();
  }
}

function isBase64Data(value: unknown): value is readonly [string, "base64"] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    value[1] === "base64"
  );
}

function parseLoadedAddresses(value: unknown): {
  readonly writable: readonly string[];
  readonly readonly: readonly string[];
} | null {
  if (value === undefined) return { writable: [], readonly: [] };
  if (!isRecord(value)) return null;
  const writable = stringArray(value.writable);
  const readonly = stringArray(value.readonly);
  return writable === null || readonly === null ? null : { writable, readonly };
}

function compiledInstructions(
  value: unknown
): readonly CompiledInstruction[] | null {
  if (!Array.isArray(value)) return null;
  const instructions: CompiledInstruction[] = [];
  for (const instruction of value) {
    if (!isRecord(instruction) || typeof instruction.data !== "string")
      return null;
    const accounts = numberArray(instruction.accounts);
    if (!isAccountIndex(instruction.programIdIndex) || accounts === null)
      return null;
    instructions.push({
      programIdIndex: instruction.programIdIndex,
      accounts,
      data: instruction.data,
    });
  }
  return instructions;
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function numberArray(value: unknown): readonly number[] | null {
  return Array.isArray(value) && value.every(isAccountIndex) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSlot(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUnixTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAccountIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function malformedTransaction(): PriceFinalizationError {
  return new PriceFinalizationError(
    "malformed",
    "Solana transaction is malformed."
  );
}
