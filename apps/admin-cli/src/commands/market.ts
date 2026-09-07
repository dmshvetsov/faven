import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createKeyPairFromBytes,
  createTransactionMessage,
  getAddressEncoder,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
} from "@solana/kit";
import { confirm, isCancel, log, note, text } from "@clack/prompts";

import { unavailableCommand } from "./unavailable-command.js";
import type { CliCommand, CommandGroup } from "./types.js";

const OPTIONS_PROGRAM = address("Hvfbh72e5Vw1Gq8RFsKLj9BLq1m5y9WFzBYn2fZR8UYX");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const CREATE_MARKET_DISCRIMINATOR = new Uint8Array([
  103, 226, 97, 235, 200, 188, 251, 254,
]);
const MAX_MINT_DECIMALS = 19;
const MAX_BPS = 10_000;
const U64_MAX = (1n << 64n) - 1n;

interface AdminSigner {
  readonly address: Address;
  readonly keyPair: CryptoKeyPair;
}

interface PreparedMarket {
  readonly admin: AdminSigner;
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

const createMarketCommand: CliCommand = {
  description: "Create a market.",
  async run(args) {
    if (args.length > 0) {
      throw new Error("faven market create does not accept arguments.");
    }

    const rpcEndpoint = requiredEnvironment("SOLANA_RPC_URL");
    validateRpcEndpoint(rpcEndpoint);
    const admin = await adminSignerFromEnvironment();

    const feedIdInput = await promptText({
      message: "Pyth TWAP feed ID",
      placeholder: "64-character hexadecimal value",
      validate: validateFeedId,
    });
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
      message: "Minimum fee (QuoteCoin amount)",
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

    const [quoteMintDetails] = await Promise.all([
      fetchMint(rpcEndpoint, quoteMint, "Quote mint"),
      fetchMint(rpcEndpoint, baseMint, "Base mint"),
    ]);
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
    const latestBlockhash = await fetchLatestBlockhash(rpcEndpoint);
    await simulateMarketCreation(rpcEndpoint, preparedMarket, latestBlockhash);

    note(
      [
        `RPC endpoint: ${rpcEndpoint}`,
        `Admin public address: ${admin.address}`,
        `Oracle feed ID: ${preparedMarket.feedIdHex}`,
        `Quote mint: ${quoteMint}`,
        `Base mint: ${baseMint}`,
        `Minimum fee: ${formatQuoteAmount(minFee, quoteMintDetails.decimals)} QuoteCoin (${minFee} raw units)`,
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

    const signingBlockhash = await fetchLatestBlockhash(rpcEndpoint);
    const signedTransaction = await signTransaction(
      [admin.keyPair],
      createMarketTransaction(preparedMarket, signingBlockhash)
    );
    const signature = getSignatureFromTransaction(signedTransaction);
    const returnedSignature = await rpcCall(rpcEndpoint, "sendTransaction", [
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

export const marketCommands: CommandGroup = {
  description: "Manage deployed markets.",
  commands: {
    create: createMarketCommand,
    backfill: unavailableCommand("Backfill market data."),
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

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} must be set.`);
  return value;
}

function validateRpcEndpoint(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SOLANA_RPC_URL must be a valid HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SOLANA_RPC_URL must be a valid HTTP(S) URL.");
  }
}

async function adminSignerFromEnvironment(): Promise<AdminSigner> {
  const secret = requiredEnvironment("FAVEN_ADMIN_KEYPAIR");
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error(
      "FAVEN_ADMIN_KEYPAIR must be a JSON array of 64 keypair bytes."
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 255
    )
  ) {
    throw new Error(
      "FAVEN_ADMIN_KEYPAIR must be a JSON array of 64 keypair bytes."
    );
  }
  try {
    const keyPair = await createKeyPairFromBytes(new Uint8Array(parsed));
    return {
      address: await getAddressFromPublicKey(keyPair.publicKey),
      keyPair,
    };
  } catch {
    throw new Error("FAVEN_ADMIN_KEYPAIR is not a valid Solana keypair.");
  }
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
      `Minimum fee supports at most ${decimals} decimal places for this QuoteCoin mint.`
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

async function fetchMint(
  rpcEndpoint: string,
  mint: Address,
  name: string
): Promise<{ readonly decimals: number }> {
  const result = await rpcCall(rpcEndpoint, "getAccountInfo", [
    mint,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const account = accountInfoValue(result);
  if (account === null)
    throw new Error(`${name} account does not exist on this network.`);
  if (account.owner !== TOKEN_PROGRAM)
    throw new Error(`${name} must be a legacy SPL Token mint.`);
  if (
    account.executable ||
    account.data.length !== 82 ||
    account.data[45] !== 1
  ) {
    throw new Error(`${name} is not an initialized legacy SPL Token mint.`);
  }
  const decimals = account.data[44];
  if (decimals === undefined || decimals > MAX_MINT_DECIMALS) {
    throw new Error(
      `${name} has unsupported decimals (maximum is ${MAX_MINT_DECIMALS}).`
    );
  }
  return { decimals };
}

function accountInfoValue(value: unknown): {
  readonly owner: string;
  readonly executable: boolean;
  readonly data: Uint8Array;
} | null {
  if (!isRecord(value) || !("value" in value))
    throw new Error("RPC returned an invalid account response.");
  if (value.value === null) return null;
  if (!isRecord(value.value))
    throw new Error("RPC returned an invalid account response.");
  const { owner, executable, data } = value.value;
  if (
    typeof owner !== "string" ||
    typeof executable !== "boolean" ||
    !Array.isArray(data) ||
    data.length !== 2 ||
    typeof data[0] !== "string" ||
    data[1] !== "base64"
  ) {
    throw new Error("RPC returned an invalid account response.");
  }
  return { owner, executable, data: Buffer.from(data[0], "base64") };
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
  rpcEndpoint: string
): Promise<LatestBlockhash> {
  const result = await rpcCall(rpcEndpoint, "getLatestBlockhash", [
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
  rpcEndpoint: string,
  market: PreparedMarket,
  latestBlockhash: LatestBlockhash
): Promise<void> {
  const result = await rpcCall(rpcEndpoint, "simulateTransaction", [
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
      "Market creation simulation failed. No transaction was signed or sent."
    );
  }
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
      readonly(TOKEN_PROGRAM),
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

async function rpcCall(
  rpcEndpoint: string,
  method: string,
  params: readonly unknown[]
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(rpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch {
    throw new Error(`Could not reach Solana RPC endpoint: ${rpcEndpoint}`);
  }
  if (!response.ok)
    throw new Error(`Solana RPC endpoint returned HTTP ${response.status}.`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Solana RPC endpoint returned invalid JSON.");
  }
  if (!isRecord(payload))
    throw new Error("Solana RPC endpoint returned an invalid response.");
  if ("error" in payload)
    throw new Error(`Solana RPC ${method} request failed.`);
  if (!("result" in payload))
    throw new Error("Solana RPC endpoint returned an invalid response.");
  return payload.result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
