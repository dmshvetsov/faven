import {
  createPythUnverifiedPriceFinalizationTransaction,
  deriveAssociatedTokenAddress,
  discoverEligiblePriceFinalizationGroups,
  type EligiblePriceFinalizationGroup,
} from "sdk";
import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransaction,
  type Address,
} from "@solana/kit";
import { confirm, isCancel, log, note, select, text } from "@clack/prompts";

import type { CliCommand, CliCommandResult } from "../command-types.js";
import {
  enqueuePendingPriceFinalization,
  readPendingPriceFinalizations,
  removePendingPriceFinalization,
  type PendingPriceFinalization,
} from "../pending-price-finalizations.js";
import { PYTH_SOLANA_FEEDS } from "../pyth-feeds.js";
import { formatSimulationFailure } from "../simulation.js";
import {
  loadSolanaCliConfig,
  loadSolanaKeypair,
  loadSolanaRpcClient,
  type SolanaKeypair,
  type SolanaRpcClient,
} from "../solana.js";

const CONFIDENCE = 1_000_000n;
const EXPONENT = -8;
const MAX_SERIES_PER_TRANSACTION = 16;
const MAX_RETRIES = 3;
const FINALIZATION_POLL_INTERVAL_MS = 1_000;
const PENDING_FINALIZATION_WAIT_TIMEOUT_MS = 60_000;

interface LatestBlockhash {
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
}

interface FinalizationPlan {
  readonly group: EligiblePriceFinalizationGroup;
  readonly price: bigint;
  readonly humanPrice: string;
  readonly chunks: readonly (readonly {
    readonly seriesAddress: Address;
    readonly quoteCollateralVault: Address;
  }[])[];
}

interface RfqServerConfig {
  readonly serverUrl: string;
  readonly authToken: string;
}

export const seriesFinalizeCommand: CliCommand = {
  description: "Finalize expired option series.",
  async run(args) {
    if (args.length > 0) {
      throw new Error("faven series finalize does not accept arguments.");
    }

    const pendingResult = await offerPendingFinalizationRetry();
    if (pendingResult !== null) return pendingResult;

    const solanaConfig = await loadSolanaCliConfig();
    const rpc = loadSolanaRpcClient(solanaConfig);
    const operator = await loadSolanaKeypair(solanaConfig);
    const groups = await discoverEligiblePriceFinalizationGroups({
      rpc,
      nowMs: Date.now(),
    });
    if (groups.length === 0) {
      log.info("No open, expired Series are eligible for finalization.");
      return { outcome: "completed" };
    }

    const group = await chooseFinalizationGroup(groups);
    if (group === null) return { outcome: "cancelled" };
    const feed = PYTH_SOLANA_FEEDS.find(
      (candidate) => candidate.id === group.pythFeedId
    );
    if (feed === undefined || !feed.symbol.endsWith("/USD")) {
      throw new Error(
        "The selected Market uses an unknown or non-USD Pyth feed and cannot be finalized."
      );
    }
    if (group.marketOperator !== operator.address) {
      throw new Error(
        "The configured Solana keypair is not this Market's operator."
      );
    }

    const method = await select({
      message: "Price source",
      options: [
        {
          value: "pythTwap",
          label: "Pyth TWAP",
          hint: "Unimplemented",
        },
        {
          value: "pythUnverified",
          label: "Pyth unverified",
          hint: "Enter a USD price manually",
        },
      ],
    });
    if (isCancel(method)) return { outcome: "cancelled" };
    if (method === "pythTwap") {
      log.warn("Pyth TWAP finalization is not implemented yet.");
      return { outcome: "cancelled" };
    }

    const priceInput = await promptUsdPrice();
    if (priceInput === null) return { outcome: "cancelled" };
    const plan = await createFinalizationPlan(group, priceInput);
    const server = loadRfqServerConfig();
    const genesisHash = await fetchGenesisHash(rpc);
    const simulationBlockhash = await fetchLatestBlockhash(rpc);
    await simulateFinalizationChunks(rpc, operator, plan, simulationBlockhash);

    note(
      [
        `RPC endpoint: ${rpc.label}`,
        `Cluster genesis hash: ${genesisHash}`,
        `RFQ server: ${server.serverUrl}`,
        `Operator and fee payer: ${operator.address}`,
        `Market: ${plan.group.marketAddress}`,
        `Pyth feed: ${feed.symbol} (${plan.group.pythFeedId})`,
        `Expiry: ${new Date(plan.group.expiryMs).toISOString()}`,
        `Series: ${plan.group.series.length}`,
        `Raw Pyth price: ${plan.price} (expo ${EXPONENT}, conf ${CONFIDENCE})`,
        `USD price: ${plan.humanPrice}`,
        `Transactions: ${plan.chunks.length}`,
      ].join("\n"),
      "Confirm finalization"
    );
    const confirmed = await confirm({
      message: "Sign and send these price-finalization transactions?",
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) return { outcome: "cancelled" };

    return sendAndSyncFinalizations({
      rpc,
      operator,
      plan,
      server,
      genesisHash,
    });
  },
};

async function offerPendingFinalizationRetry(): Promise<CliCommandResult | null> {
  const pending = await readPendingPriceFinalizations();
  if (pending.length === 0) return null;
  const action = await select({
    message: `${pending.length} price finalization sync ${pending.length === 1 ? "is" : "are"} pending`,
    options: [
      { value: "retry", label: "Retry all" },
      { value: "create", label: "Create new" },
    ],
  });
  if (isCancel(action)) return { outcome: "cancelled" };
  if (action === "create") return null;

  const authToken = requiredEnvironment("RFQ_SERVER_ADMIN_AUTH_TOKEN");
  const solanaConfig = await loadSolanaCliConfig();
  const rpc = loadSolanaRpcClient(solanaConfig);
  const genesisHash = await fetchGenesisHash(rpc);
  const failed = await syncPendingPriceFinalizations(
    pending,
    rpc,
    genesisHash,
    authToken
  );
  if (failed === 0) {
    log.success(
      "All pending price finalizations were synced with the RFQ server."
    );
    return { outcome: "completed" };
  }
  log.error(
    `${failed} pending ${failed === 1 ? "entry remains" : "entries remain"}. Their on-chain finalization succeeded; RFQ server sync is pending.`
  );
  return { outcome: "pending" };
}

async function chooseFinalizationGroup(
  groups: readonly EligiblePriceFinalizationGroup[]
): Promise<EligiblePriceFinalizationGroup | null> {
  const byValue = new Map(groups.map((group) => [groupValue(group), group]));
  const selected = await select({
    message: "Expired Series group",
    options: groups.map((group) => ({
      value: groupValue(group),
      label: `${group.series.length} Series — ${new Date(group.expiryMs).toISOString()}`,
      hint: `Market ${group.marketAddress}`,
    })),
  });
  if (isCancel(selected)) return null;
  const group = byValue.get(selected);
  if (group === undefined)
    throw new Error("Selected Series group was not found.");
  return group;
}

function groupValue(group: EligiblePriceFinalizationGroup): string {
  return `${group.marketAddress}:${group.expiryMs}`;
}

async function promptUsdPrice(): Promise<string | null> {
  const value = await text({
    message: "Pyth unverified USD price",
    placeholder: "For example: 101.25",
    validate: (value) => validateUsdPrice(value ?? ""),
  });
  return isCancel(value) ? null : value.trim();
}

function validateUsdPrice(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(trimmed)) {
    return "Enter a positive USD decimal with at most 8 decimal places.";
  }
  try {
    const price = usdPriceToE8(trimmed);
    return price > 0n ? undefined : "Enter a positive USD price.";
  } catch {
    return "Price exceeds the supported Pyth range.";
  }
}

async function createFinalizationPlan(
  group: EligiblePriceFinalizationGroup,
  humanPrice: string
): Promise<FinalizationPlan> {
  const price = usdPriceToE8(humanPrice);
  const accounts = await Promise.all(
    group.series.map(async ({ seriesAddress }) => ({
      seriesAddress,
      quoteCollateralVault: await deriveAssociatedTokenAddress({
        owner: seriesAddress,
        mint: group.quoteMint,
      }),
    }))
  );
  return {
    group,
    price,
    humanPrice,
    chunks: chunk(accounts, MAX_SERIES_PER_TRANSACTION),
  };
}

async function simulateFinalizationChunks(
  rpc: SolanaRpcClient,
  operator: SolanaKeypair,
  plan: FinalizationPlan,
  latestBlockhash: LatestBlockhash
): Promise<void> {
  for (const series of plan.chunks) {
    const transaction = createPythUnverifiedPriceFinalizationTransaction({
      feePayer: operator.address,
      operator: operator.address,
      market: plan.group.marketAddress,
      baseTokenProgram: plan.group.baseTokenProgram,
      quoteTokenProgram: plan.group.quoteTokenProgram,
      baseMint: plan.group.baseMint,
      quoteMint: plan.group.quoteMint,
      series,
      feedId: new Uint8Array(Buffer.from(plan.group.pythFeedId, "hex")),
      price: plan.price,
      confidence: CONFIDENCE,
      exponent: EXPONENT,
      publishTime: BigInt(Math.floor(plan.group.expiryMs / 1_000)),
      ...latestBlockhash,
    });
    const result = await rpc.call("simulateTransaction", [
      getBase64EncodedWireTransaction(transaction),
      { encoding: "base64", sigVerify: false, commitment: "confirmed" },
    ]);
    if (!isSimulationSuccessful(result)) {
      throw new Error(
        [
          "Price finalization simulation failed.",
          formatSimulationFailure(result),
          "No transaction was signed or sent.",
        ].join("\n")
      );
    }
  }
}

async function sendAndSyncFinalizations(input: {
  readonly rpc: SolanaRpcClient;
  readonly operator: SolanaKeypair;
  readonly plan: FinalizationPlan;
  readonly server: RfqServerConfig;
  readonly genesisHash: string;
}): Promise<CliCommandResult> {
  let sent = 0;
  let syncFailures = 0;
  for (const series of input.plan.chunks) {
    let signature: string;
    try {
      const latestBlockhash = await fetchLatestBlockhash(input.rpc);
      const signedTransaction = await signTransaction(
        [input.operator.keyPair],
        createPythUnverifiedPriceFinalizationTransaction({
          feePayer: input.operator.address,
          operator: input.operator.address,
          market: input.plan.group.marketAddress,
          baseTokenProgram: input.plan.group.baseTokenProgram,
          quoteTokenProgram: input.plan.group.quoteTokenProgram,
          baseMint: input.plan.group.baseMint,
          quoteMint: input.plan.group.quoteMint,
          series,
          feedId: new Uint8Array(
            Buffer.from(input.plan.group.pythFeedId, "hex")
          ),
          price: input.plan.price,
          confidence: CONFIDENCE,
          exponent: EXPONENT,
          publishTime: BigInt(Math.floor(input.plan.group.expiryMs / 1_000)),
          ...latestBlockhash,
        })
      );
      signature = getSignatureFromTransaction(signedTransaction);
      const returnedSignature = await input.rpc.call("sendTransaction", [
        getBase64EncodedWireTransaction(signedTransaction),
        {
          encoding: "base64",
          preflightCommitment: "confirmed",
          skipPreflight: false,
        },
      ]);
      if (returnedSignature !== signature) {
        throw new Error(
          "RPC returned a transaction signature that does not match the signed transaction."
        );
      }
      log.info(`Waiting for finalization: ${signature}`);
      await waitForFinalizedTransaction(
        input.rpc,
        signature,
        latestBlockhash.lastValidBlockHeight
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown transaction error.";
      log.error(
        `Finalization stopped after ${sent} finalized transaction(s): ${message}`
      );
      return { outcome: "failed" };
    }

    sent += 1;
    log.success(`Finalization transaction finalized: ${signature}`);
    const pending: PendingPriceFinalization = {
      signature,
      serverUrl: input.server.serverUrl,
      clusterGenesisHash: input.genesisHash,
    };
    await enqueuePendingPriceFinalization(pending);
    if (
      !(await syncPendingPriceFinalization(pending, input.server.authToken))
    ) {
      syncFailures += 1;
      log.error(`RFQ server sync is pending for transaction: ${signature}`);
    }
  }
  if (syncFailures > 0) {
    log.error(
      `On-chain finalization succeeded for ${sent} transaction(s), but ${syncFailures} RFQ server sync ${syncFailures === 1 ? "is" : "are"} pending.`
    );
    return { outcome: "pending" };
  }
  log.success(
    `On-chain finalization and RFQ server sync completed for ${sent} transaction(s).`
  );
  return { outcome: "completed" };
}

async function syncPendingPriceFinalizations(
  pending: readonly PendingPriceFinalization[],
  rpc: SolanaRpcClient,
  genesisHash: string,
  authToken: string
): Promise<number> {
  let failed = 0;
  for (const entry of pending) {
    if (entry.clusterGenesisHash !== genesisHash) {
      log.error(
        `Pending transaction ${entry.signature} belongs to a different Solana cluster.`
      );
      failed += 1;
      continue;
    }
    try {
      log.info(
        `Waiting for finalization before RFQ server sync: ${entry.signature}`
      );
      await waitForFinalizedTransaction(rpc, entry.signature);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown transaction error.";
      log.error(
        `RFQ server sync was not attempted for ${entry.signature}: ${message}`
      );
      failed += 1;
      continue;
    }
    if (!(await syncPendingPriceFinalization(entry, authToken))) failed += 1;
  }
  return failed;
}

async function syncPendingPriceFinalization(
  pending: PendingPriceFinalization,
  authToken: string
): Promise<boolean> {
  for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
    let response: Response;
    try {
      response = await fetch(
        new URL(
          "internal/backfills/price-finalizations",
          `${pending.serverUrl}/`
        ),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${authToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ signature: pending.signature }),
        }
      );
    } catch (error) {
      const message = describeNetworkError(error);
      log.error(
        `Could not reach the RFQ server for ${pending.signature}: ${message}`
      );
      return false;
    }
    if (response.status === 204) {
      await removePendingPriceFinalization(pending.signature);
      return true;
    }
    if (
      response.status === 422 ||
      (response.status !== 409 && response.status !== 503)
    ) {
      log.error(
        `RFQ server rejected ${pending.signature} with HTTP ${response.status}.`
      );
      return false;
    }
    if (retry === MAX_RETRIES) {
      log.error(
        `RFQ server is not ready for ${pending.signature} (HTTP ${response.status}).`
      );
      return false;
    }
  }
  return false;
}

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown network error.";
  const cause = error.cause;
  if (cause instanceof Error) return `${error.message}: ${cause.message}`;
  return error.message;
}

function loadRfqServerConfig(): RfqServerConfig {
  const rawServerUrl = requiredEnvironment("RFQ_SERVER_URL");
  let parsed: URL;
  try {
    parsed = new URL(rawServerUrl);
  } catch {
    throw new Error("RFQ_SERVER_URL must be a valid HTTP(S) URL.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("RFQ_SERVER_URL must be a credential-free HTTP(S) URL.");
  }
  return {
    serverUrl: parsed.toString().replace(/\/$/, ""),
    authToken: requiredEnvironment("RFQ_SERVER_ADMIN_AUTH_TOKEN"),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set.`);
  }
  return value;
}

function usdPriceToE8(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  const price = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
  if (price <= 0n || price > (1n << 63n) - 1n) {
    throw new Error("Price exceeds the supported Pyth range.");
  }
  return price;
}

function chunk<T>(
  values: readonly T[],
  size: number
): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }
  return chunks;
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

async function fetchGenesisHash(rpc: SolanaRpcClient): Promise<string> {
  const result = await rpc.call("getGenesisHash", []);
  if (typeof result !== "string" || result === "") {
    throw new Error("RPC returned an invalid cluster genesis hash.");
  }
  return result;
}

async function waitForFinalizedTransaction(
  rpc: SolanaRpcClient,
  signature: string,
  lastValidBlockHeight?: bigint
): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    const status = await fetchSignatureStatus(rpc, signature);
    if (status.kind === "finalized") return;
    if (status.kind === "failed") {
      throw new Error(
        `Solana transaction failed before finalization: ${status.error}`
      );
    }
    if (lastValidBlockHeight !== undefined) {
      const blockHeight = await fetchBlockHeight(rpc);
      if (blockHeight > lastValidBlockHeight) {
        throw new Error("Solana transaction expired before finalization.");
      }
    } else if (Date.now() - startedAt >= PENDING_FINALIZATION_WAIT_TIMEOUT_MS) {
      throw new Error("Timed out waiting for Solana transaction finalization.");
    }
    await delay(FINALIZATION_POLL_INTERVAL_MS);
  }
}

async function fetchSignatureStatus(
  rpc: SolanaRpcClient,
  signature: string
): Promise<
  | { readonly kind: "pending" }
  | { readonly kind: "finalized" }
  | { readonly kind: "failed"; readonly error: string }
> {
  const result = await rpc.call("getSignatureStatuses", [
    [signature],
    { searchTransactionHistory: true },
  ]);
  if (!isRecord(result) || !Array.isArray(result.value)) {
    throw new Error("RPC returned an invalid transaction status response.");
  }
  const status = result.value[0];
  if (status === null) return { kind: "pending" };
  if (!isRecord(status) || !("err" in status)) {
    throw new Error("RPC returned an invalid transaction status response.");
  }
  if (status.err !== null) {
    return { kind: "failed", error: safelyStringify(status.err) };
  }
  return status.confirmationStatus === "finalized"
    ? { kind: "finalized" }
    : { kind: "pending" };
}

async function fetchBlockHeight(rpc: SolanaRpcClient): Promise<bigint> {
  const result = await rpc.call("getBlockHeight", [
    { commitment: "confirmed" },
  ]);
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < 0
  ) {
    throw new Error("RPC returned an invalid block height response.");
  }
  return BigInt(result);
}

function safelyStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "an unreadable error";
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isSimulationSuccessful(value: unknown): boolean {
  return isRecord(value) && isRecord(value.value) && value.value.err === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
