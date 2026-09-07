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
  getSignatureFromTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
} from "@solana/kit";
import {
  autocomplete,
  confirm,
  isCancel,
  log,
  note,
  text,
} from "@clack/prompts";

import { PYTH_SOLANA_FEEDS } from "../pyth-feeds.js";
import {
  fetchMint,
  LEGACY_TOKEN_PROGRAM,
  loadSolanaCliConfig,
  loadSolanaKeypair,
  loadSolanaRpcClient,
  type SolanaKeypair,
  type SolanaMint,
  type SolanaRpcClient,
} from "../solana.js";
import type { CliCommand } from "../command-types.js";

const OPTIONS_PROGRAM = address("FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const CREATE_MARKET_DISCRIMINATOR = new Uint8Array([
  103, 226, 97, 235, 200, 188, 251, 254,
]);
const MAX_MINT_DECIMALS = 19;
const MAX_BPS = 10_000;
const U64_MAX = (1n << 64n) - 1n;

interface PreparedMarket {
  readonly admin: SolanaKeypair;
  readonly feedId: Uint8Array;
  readonly feedIdHex: string;
  readonly quoteMint: Address;
  readonly baseMint: Address;
  readonly minFee: bigint;
  readonly minOperationalFeeBps: number;
  readonly maxOperationalFeeBps: number;
  readonly market: Address;
}

interface LatestBlockhash {
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
}

export const createMarketCommand: CliCommand = {
  description: "Create a market.",
  async run(args) {
    if (args.length > 0) {
      throw new Error("faven market create does not accept arguments.");
    }

    const solanaConfig = await loadSolanaCliConfig();
    const rpc = loadSolanaRpcClient(solanaConfig);
    const admin = await loadSolanaKeypair(solanaConfig);

    const feedIdInput = await promptPythFeedId();
    if (feedIdInput === null) return { outcome: "cancelled" };
    const quoteMintInput = await promptText({
      message: "Quote mint public address",
      validate: validateAddress,
    });
    if (quoteMintInput === null) return { outcome: "cancelled" };
    const baseMintInput = await promptText({
      message: "Base mint public address",
      validate: validateAddress,
    });
    if (baseMintInput === null) return { outcome: "cancelled" };
    const minimumFeeInput = await promptText({
      message: "Minimum fee (quote token amount)",
      placeholder: "For example: 0.50",
      validate: validateHumanAmount,
    });
    if (minimumFeeInput === null) return { outcome: "cancelled" };
    const minOperationalFeeInput = await promptText({
      message: "Minimum operational fee (bps)",
      placeholder: "For example: 50",
      validate: validateBps,
    });
    if (minOperationalFeeInput === null) return { outcome: "cancelled" };
    const maxOperationalFeeInput = await promptText({
      message: "Maximum operational fee (bps)",
      placeholder: "For example: 100",
      validate: validateBps,
    });
    if (maxOperationalFeeInput === null) return { outcome: "cancelled" };

    const feedId = parseFeedId(feedIdInput);
    const quoteMint = parseAddress(quoteMintInput, "Quote mint");
    const baseMint = parseAddress(baseMintInput, "Base mint");
    const minOperationalFeeBps = parseBps(minOperationalFeeInput);
    const maxOperationalFeeBps = parseBps(maxOperationalFeeInput);
    if (quoteMint === baseMint)
      throw new Error("Quote and base mints must be different.");
    if (minOperationalFeeBps > maxOperationalFeeBps) {
      throw new Error(
        "Minimum operational fee cannot exceed maximum operational fee."
      );
    }

    const [quoteMintDetails, baseMintDetails] = await Promise.all([
      fetchMint(rpc, quoteMint),
      fetchMint(rpc, baseMint),
    ]);
    validateMarketMint(quoteMintDetails, "Quote mint");
    validateMarketMint(baseMintDetails, "Base mint");
    const minFee = parseQuoteAmount(minimumFeeInput, quoteMintDetails.decimals);
    const market = await deriveMarketAddress(
      feedId,
      quoteMint,
      baseMint,
      admin.address
    );
    const preparedMarket: PreparedMarket = {
      admin,
      feedId,
      feedIdHex: Buffer.from(feedId).toString("hex"),
      quoteMint,
      baseMint,
      minFee,
      minOperationalFeeBps,
      maxOperationalFeeBps,
      market,
    };
    const latestBlockhash = await fetchLatestBlockhash(rpc);
    await simulateMarketCreation(rpc, preparedMarket, latestBlockhash);

    note(
      [
        `RPC endpoint: ${rpc.label}`,
        `Admin public address: ${admin.address}`,
        `Oracle feed ID: ${preparedMarket.feedIdHex}`,
        `Quote mint: ${quoteMint}`,
        `Base mint: ${baseMint}`,
        `Minimum fee: ${formatQuoteAmount(minFee, quoteMintDetails.decimals)} quote token (${minFee} raw units)`,
        `Minimum operational fee: ${minOperationalFeeBps} bps (${formatBps(minOperationalFeeBps)}%)`,
        `Maximum operational fee: ${maxOperationalFeeBps} bps (${formatBps(maxOperationalFeeBps)}%)`,
        `Predicted market address: ${market}`,
      ].join("\n"),
      "Confirm market creation"
    );
    const confirmed = await confirm({
      message: "Sign and send this market creation transaction?",
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) return { outcome: "cancelled" };

    const signingBlockhash = await fetchLatestBlockhash(rpc);
    const signedTransaction = await signTransaction(
      [admin.keyPair],
      createMarketTransaction(preparedMarket, signingBlockhash)
    );
    const signature = getSignatureFromTransaction(signedTransaction);
    const returnedSignature = await rpc.call("sendTransaction", [
      getBase64EncodedWireTransaction(signedTransaction),
      {
        encoding: "base64",
        preflightCommitment: "confirmed",
        skipPreflight: false,
      },
    ]);
    if (
      typeof returnedSignature !== "string" ||
      returnedSignature !== signature
    ) {
      throw new Error(
        "RPC returned a transaction signature that does not match the signed transaction."
      );
    }
    log.success(`Market created: ${market}`);
    log.success(`Transaction signature: ${signature}`);
    return { outcome: "completed" };
  },
};

async function promptText(options: {
  readonly message: string;
  readonly placeholder?: string;
  readonly validate: (value: string) => string | undefined;
}): Promise<string | null> {
  const value = await text({
    ...options,
    validate: (input) => options.validate(input ?? ""),
  });
  return isCancel(value) ? null : value;
}

async function promptPythFeedId(): Promise<string | null> {
  const customValue = "custom";
  const value = await autocomplete({
    message: "Pyth TWAP feed ID",
    placeholder: "Search Solana feed symbols or IDs",
    maxItems: 10,
    options: [
      ...PYTH_SOLANA_FEEDS.map((feed) => ({
        value: feed.id,
        label: feed.symbol,
        hint: feed.id,
      })),
      {
        value: customValue,
        label: "Enter a custom feed ID",
        hint: "For a feed not in the Solana catalog",
      },
    ],
    filter: (search, option) =>
      (option.label ?? "").toLowerCase().includes(search.toLowerCase()) ||
      option.value.toLowerCase().includes(search.toLowerCase()),
  });
  if (isCancel(value)) return null;
  if (value !== customValue) return value;
  return promptText({
    message: "Custom Pyth TWAP feed ID",
    placeholder: "64-character hexadecimal value",
    validate: validateFeedId,
  });
}

function validateFeedId(value: string): string | undefined {
  return /^[\da-fA-F]{64}$/.test(value.trim())
    ? undefined
    : "Enter exactly 64 hexadecimal characters.";
}

function parseFeedId(value: string): Uint8Array {
  if (validateFeedId(value) !== undefined) {
    throw new Error(
      "Pyth TWAP feed ID must be exactly 64 hexadecimal characters."
    );
  }
  return new Uint8Array(Buffer.from(value.trim(), "hex"));
}

function validateAddress(value: string): string | undefined {
  try {
    address(value.trim());
    return undefined;
  } catch {
    return "Enter a valid Solana public address.";
  }
}

function parseAddress(value: string, name: string): Address {
  try {
    return address(value.trim());
  } catch {
    throw new Error(`${name} must be a valid Solana public address.`);
  }
}

function validateHumanAmount(value: string): string | undefined {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())
    ? undefined
    : "Enter a non-negative decimal amount without exponent notation.";
}

export function parseQuoteAmount(value: string, decimals: number): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_MINT_DECIMALS
  ) {
    throw new Error("Quote mint has unsupported decimals.");
  }
  const amount = value.trim();
  if (validateHumanAmount(amount) !== undefined) {
    throw new Error("Minimum fee must be a non-negative decimal amount.");
  }
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) {
    throw new Error(
      `Minimum fee supports at most ${decimals} decimal places for this quote token mint.`
    );
  }
  const raw =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (raw > U64_MAX)
    throw new Error("Minimum fee exceeds the maximum supported raw amount.");
  return raw;
}

function validateBps(value: string): string | undefined {
  if (!/^\d+$/.test(value.trim()))
    return "Enter a whole number of basis points.";
  return BigInt(value.trim()) <= BigInt(MAX_BPS)
    ? undefined
    : `Enter a value from 0 to ${MAX_BPS} bps.`;
}

function parseBps(value: string): number {
  if (validateBps(value) !== undefined) {
    throw new Error(
      `Operational fee must be a whole number from 0 to ${MAX_BPS} bps.`
    );
  }
  return Number(BigInt(value.trim()));
}

function validateMarketMint(mint: SolanaMint, name: string): void {
  if (mint.tokenProgram !== LEGACY_TOKEN_PROGRAM || !mint.isInitialized) {
    throw new Error(`${name} is not an initialized legacy SPL Token mint.`);
  }
  if (mint.decimals > MAX_MINT_DECIMALS) {
    throw new Error(
      `${name} has unsupported decimals (maximum is ${MAX_MINT_DECIMALS}).`
    );
  }
}

async function deriveMarketAddress(
  feedId: Uint8Array,
  quoteMint: Address,
  baseMint: Address,
  operator: Address
): Promise<Address> {
  const [market] = await getProgramDerivedAddress({
    programAddress: OPTIONS_PROGRAM,
    seeds: [
      new TextEncoder().encode("market"),
      new TextEncoder().encode("PythTwap"),
      feedId,
      getAddressEncoder().encode(quoteMint),
      getAddressEncoder().encode(baseMint),
      getAddressEncoder().encode(operator),
    ],
  });
  return market;
}

async function fetchLatestBlockhash(
  rpc: SolanaRpcClient
): Promise<LatestBlockhash> {
  const result = await rpc.call("getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  if (
    !isRecord(result) ||
    !isRecord(result.value) ||
    typeof result.value.blockhash !== "string" ||
    typeof result.value.lastValidBlockHeight !== "number" ||
    !Number.isSafeInteger(result.value.lastValidBlockHeight) ||
    result.value.lastValidBlockHeight < 0
  ) {
    throw new Error("RPC returned an invalid latest blockhash response.");
  }
  return {
    blockhash: result.value.blockhash,
    lastValidBlockHeight: BigInt(result.value.lastValidBlockHeight),
  };
}

async function simulateMarketCreation(
  rpc: SolanaRpcClient,
  market: PreparedMarket,
  latestBlockhash: LatestBlockhash
): Promise<void> {
  const result = await rpc.call("simulateTransaction", [
    getBase64EncodedWireTransaction(
      createMarketTransaction(market, latestBlockhash)
    ),
    { encoding: "base64", sigVerify: false, commitment: "confirmed" },
  ]);
  if (
    !isRecord(result) ||
    !isRecord(result.value) ||
    !("err" in result.value)
  ) {
    throw new Error("RPC returned an invalid simulation response.");
  }
  if (result.value.err !== null) {
    throw new Error(
      [
        "Market creation simulation failed.",
        `Reason: ${formatSimulationError(result.value.err)}`,
        formatSimulationLogs(result.value.logs),
        "No transaction was signed or sent.",
      ]
        .filter((line) => line !== undefined)
        .join("\n")
    );
  }
}

function formatSimulationError(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "The RPC returned an unreadable simulation error.";
  }
}

function formatSimulationLogs(logs: unknown): string | undefined {
  if (
    !Array.isArray(logs) ||
    !logs.every((logEntry) => typeof logEntry === "string")
  ) {
    return undefined;
  }
  return `Simulation logs:\n${logs.join("\n")}`;
}

function createMarketTransaction(
  market: PreparedMarket,
  latestBlockhash: LatestBlockhash
) {
  const message = appendTransactionMessageInstructions(
    [createMarketInstruction(market)],
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(latestBlockhash.blockhash),
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      setTransactionMessageFeePayer(
        market.admin.address,
        createTransactionMessage({ version: 0 })
      )
    )
  );
  return compileTransaction(message);
}

function createMarketInstruction(market: PreparedMarket) {
  return {
    programAddress: OPTIONS_PROGRAM,
    data: createMarketData(market),
    accounts: [
      writableSigner(market.admin.address),
      readonlySigner(market.admin.address),
      readonly(market.quoteMint),
      readonly(market.baseMint),
      writable(market.market),
      readonly(LEGACY_TOKEN_PROGRAM),
      readonly(SYSTEM_PROGRAM),
    ],
  };
}

export function createMarketData(input: {
  readonly feedId: Uint8Array;
  readonly minFee: bigint;
  readonly minOperationalFeeBps: number;
  readonly maxOperationalFeeBps: number;
}): Uint8Array {
  if (input.feedId.length !== 32)
    throw new Error("Oracle feed ID must be 32 bytes.");
  const data = new Uint8Array(53);
  data.set(CREATE_MARKET_DISCRIMINATOR);
  data[8] = 0;
  data.set(input.feedId, 9);
  writeU64(data, 41, input.minFee);
  writeU16(data, 49, input.minOperationalFeeBps);
  writeU16(data, 51, input.maxOperationalFeeBps);
  return data;
}

function writableSigner(account: Address) {
  return { address: account, role: AccountRole.WRITABLE_SIGNER };
}

function readonlySigner(account: Address) {
  return { address: account, role: AccountRole.READONLY_SIGNER };
}

function writable(account: Address) {
  return { address: account, role: AccountRole.WRITABLE };
}

function readonly(account: Address) {
  return { address: account, role: AccountRole.READONLY };
}

function writeU64(data: Uint8Array, offset: number, value: bigint): void {
  new DataView(data.buffer).setBigUint64(offset, value, true);
}

function writeU16(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer).setUint16(offset, value, true);
}

function formatQuoteAmount(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const digits = raw.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

function formatBps(value: number): string {
  const whole = Math.floor(value / 100);
  const fraction = value % 100;
  return fraction === 0
    ? String(whole)
    : `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
