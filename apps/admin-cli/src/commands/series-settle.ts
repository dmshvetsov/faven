import {
  createSettlementTransaction,
  deriveAssociatedTokenAddress,
  discoverEligibleSettlementGroups,
  SETTLEMENT_COMPUTE_UNIT_LIMIT,
  type EligibleSettlementGroup,
  type EligibleSettlementSeller,
} from "sdk";
import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransaction,
  type Address,
} from "@solana/kit";
import { confirm, isCancel, log, note, select, spinner } from "@clack/prompts";

import type { CliCommand, CliCommandResult } from "../command-types.js";
import {
  readPendingSettlements,
  removePendingSettlement,
  savePendingSettlement,
  type PendingSettlement,
} from "../pending-settlements.js";
import { formatSimulationFailure } from "../simulation.js";
import {
  loadSolanaCliConfig,
  loadSolanaKeypair,
  loadSolanaRpcClient,
  type SolanaKeypair,
  type SolanaRpcClient,
} from "../solana.js";

const MAX_TRANSACTION_BYTES = 1_100;
const MAX_SETTLEMENT_COMPUTE_UNITS = Math.floor(
  SETTLEMENT_COMPUTE_UNIT_LIMIT * 0.8
);
const TOKEN_ACCOUNT_RENT_SPACE_UPPER_BOUND = 10_000;
const ESTIMATED_BASE_TRANSACTION_FEE_LAMPORTS = 5_000n;
const POLL_INTERVAL_MS = 1_000;
const CONFIRMATION_TIMEOUT_MS = 60_000;

interface LatestBlockhash {
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
}

interface SettlementBatch {
  readonly seriesAddress: Address;
  readonly baseCollateralVault: Address;
  readonly quoteCollateralVault: Address;
  readonly sellers: readonly EligibleSettlementSeller[];
}

interface SettlementPlan {
  readonly group: EligibleSettlementGroup;
  readonly batches: readonly SettlementBatch[];
  readonly sellerCount: number;
  readonly missingTokenAccounts: number;
}

export const seriesSettleCommand: CliCommand = {
  description: "Settle ready option series sellers.",
  async run(args) {
    if (args.length > 0) {
      throw new Error("faven series settle does not accept arguments.");
    }
    const config = await loadSolanaCliConfig();
    const rpc = loadSolanaRpcClient(config);
    const settler = await loadSolanaKeypair(config);
    const genesisHash = await fetchGenesisHash(rpc);
    const pending = await choosePendingSettlement(genesisHash);
    if (pending === "cancelled") return { outcome: "cancelled" };
    const groups = await discoverEligibleSettlementGroups({
      rpc,
      nowMs: Date.now(),
    });
    if (groups.length === 0) {
      if (pending !== null) await removePendingSettlement(pending);
      log.info("No ready, non-settled Series are eligible for settlement.");
      return { outcome: "completed" };
    }
    const group =
      pending === null
        ? await chooseSettlementGroup(groups)
        : findSettlementGroup(groups, pending);
    if (group === null) {
      if (pending !== null) {
        await removePendingSettlement(pending);
        log.info(
          "The selected unfinished settlement has no remaining SellerVaults."
        );
        return { outcome: "completed" };
      }
      return { outcome: "cancelled" };
    }

    const simulationBlockhash = await fetchLatestBlockhash(rpc);
    const plan = await createSettlementPlan(
      rpc,
      settler,
      group,
      simulationBlockhash
    );
    const rentPerAccount = await fetchRentUpperBound(rpc);
    const checkpoint: PendingSettlement = {
      clusterGenesisHash: genesisHash,
      marketAddress: group.marketAddress,
      expiryMs: group.expiryMs,
    };
    note(
      [
        `RPC endpoint: ${rpc.label}`,
        `Cluster genesis hash: ${genesisHash}`,
        `Signer and fee payer: ${settler.address}`,
        `Market: ${group.marketAddress}`,
        `Expiry: ${new Date(group.expiryMs).toISOString()}`,
        `Ready Series: ${group.series.length}`,
        `SellerVaults to settle: ${plan.sellerCount}`,
        `Transactions: ${plan.batches.length}`,
        `Maximum temporary token-account rent: ${formatLamports(rentPerAccount * BigInt(plan.missingTokenAccounts))}`,
        `Estimated base transaction fees: ${formatLamports(ESTIMATED_BASE_TRANSACTION_FEE_LAMPORTS * BigInt(plan.batches.length))}`,
      ].join("\n"),
      "Confirm settlement"
    );
    const confirmed = await confirm({
      message: "Sign and send these settlement transactions?",
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) return { outcome: "cancelled" };

    await savePendingSettlement(checkpoint);
    return sendSettlementBatches({ rpc, settler, plan, checkpoint });
  },
};

async function choosePendingSettlement(
  genesisHash: string
): Promise<PendingSettlement | null | "cancelled"> {
  const pending = (await readPendingSettlements()).filter(
    (entry) => entry.clusterGenesisHash === genesisHash
  );
  if (pending.length === 0) return null;
  const byValue = new Map(pending.map((entry) => [pendingValue(entry), entry]));
  const selected = await select({
    message: "Unfinished settlement",
    options: [
      ...pending.map((entry) => ({
        value: pendingValue(entry),
        label: `Continue — ${new Date(entry.expiryMs).toISOString()}`,
        hint: `Market ${entry.marketAddress}`,
      })),
      { value: "create", label: "Create new settlement" },
    ],
  });
  if (isCancel(selected)) return "cancelled";
  if (selected === "create") return null;
  const entry = byValue.get(selected);
  if (entry === undefined)
    throw new Error("Selected unfinished settlement was not found.");
  return entry;
}

async function chooseSettlementGroup(
  groups: readonly EligibleSettlementGroup[]
): Promise<EligibleSettlementGroup | null> {
  const byValue = new Map(groups.map((group) => [groupValue(group), group]));
  const selected = await select({
    message: "Ready Series group",
    options: groups.map((group) => ({
      value: groupValue(group),
      label: `${group.series.length} Series — ${new Date(group.expiryMs).toISOString()}`,
      hint: `${sellerCount(group)} SellerVaults — Market ${group.marketAddress}`,
    })),
  });
  if (isCancel(selected)) return null;
  const group = byValue.get(selected);
  if (group === undefined)
    throw new Error("Selected Series group was not found.");
  return group;
}

function findSettlementGroup(
  groups: readonly EligibleSettlementGroup[],
  pending: PendingSettlement
): EligibleSettlementGroup | null {
  return (
    groups.find(
      (group) =>
        group.marketAddress === pending.marketAddress &&
        group.expiryMs === pending.expiryMs
    ) ?? null
  );
}

async function createSettlementPlan(
  rpc: SolanaRpcClient,
  settler: SolanaKeypair,
  group: EligibleSettlementGroup,
  blockhash: LatestBlockhash
): Promise<SettlementPlan> {
  const batches: SettlementBatch[] = [];
  for (const series of group.series) {
    const [baseCollateralVault, quoteCollateralVault] = await Promise.all([
      deriveAssociatedTokenAddress({
        owner: series.seriesAddress,
        mint: group.baseMint,
        tokenProgram: group.baseTokenProgram,
      }),
      deriveAssociatedTokenAddress({
        owner: series.seriesAddress,
        mint: group.quoteMint,
        tokenProgram: group.quoteTokenProgram,
      }),
    ]);
    batches.push(
      ...(await createSeriesBatches({
        rpc,
        settler,
        group,
        seriesAddress: series.seriesAddress,
        baseCollateralVault,
        quoteCollateralVault,
        sellers: series.sellers,
        blockhash,
      }))
    );
  }
  return {
    group,
    batches,
    sellerCount: sellerCount(group),
    missingTokenAccounts: group.series
      .flatMap((series) => series.sellers)
      .reduce((total, seller) => total + seller.missingTokenAccounts, 0),
  };
}

async function createSeriesBatches(input: {
  readonly rpc: SolanaRpcClient;
  readonly settler: SolanaKeypair;
  readonly group: EligibleSettlementGroup;
  readonly seriesAddress: Address;
  readonly baseCollateralVault: Address;
  readonly quoteCollateralVault: Address;
  readonly sellers: readonly EligibleSettlementSeller[];
  readonly blockhash: LatestBlockhash;
}): Promise<readonly SettlementBatch[]> {
  const batches: SettlementBatch[] = [];
  let current: EligibleSettlementSeller[] = [];
  for (const seller of input.sellers) {
    const candidate = [...current, seller];
    const batch: SettlementBatch = {
      seriesAddress: input.seriesAddress,
      baseCollateralVault: input.baseCollateralVault,
      quoteCollateralVault: input.quoteCollateralVault,
      sellers: candidate,
    };
    if (
      transactionBytes(createBatchTransaction(input, batch)) >
      MAX_TRANSACTION_BYTES
    ) {
      if (current.length === 0) {
        throw new Error(
          `SellerVault ${seller.sellerVault} exceeds the safe transaction size limit.`
        );
      }
      batches.push({ ...batch, sellers: current });
      current = [seller];
      await assertBatchSafe(input, { ...batch, sellers: current });
      continue;
    }
    try {
      await assertBatchSafe(input, batch);
      current = candidate;
    } catch (error) {
      if (current.length === 0) throw error;
      batches.push({ ...batch, sellers: current });
      current = [seller];
      await assertBatchSafe(input, { ...batch, sellers: current });
    }
  }
  if (current.length > 0) {
    batches.push({
      seriesAddress: input.seriesAddress,
      baseCollateralVault: input.baseCollateralVault,
      quoteCollateralVault: input.quoteCollateralVault,
      sellers: current,
    });
  }
  return batches;
}

async function assertBatchSafe(
  input: {
    readonly rpc: SolanaRpcClient;
    readonly settler: SolanaKeypair;
    readonly group: EligibleSettlementGroup;
    readonly blockhash: LatestBlockhash;
  },
  batch: SettlementBatch
): Promise<void> {
  const transaction = createBatchTransaction(input, batch);
  const result = await input.rpc.call("simulateTransaction", [
    getBase64EncodedWireTransaction(transaction),
    { encoding: "base64", sigVerify: false, commitment: "confirmed" },
  ]);
  if (!isSimulationSuccessful(result)) {
    throw new Error(
      [
        `Settlement simulation failed for Series ${batch.seriesAddress}.`,
        formatSimulationFailure(result),
        "No transaction was signed or sent.",
      ].join("\n")
    );
  }
  const units = simulationUnits(result);
  if (units === null || units > MAX_SETTLEMENT_COMPUTE_UNITS) {
    throw new Error(
      `Settlement simulation for Series ${batch.seriesAddress} exceeds the safe compute limit.`
    );
  }
}

function createBatchTransaction(
  input: {
    readonly settler: SolanaKeypair;
    readonly group: EligibleSettlementGroup;
    readonly blockhash: LatestBlockhash;
  },
  batch: SettlementBatch
) {
  return createSettlementTransaction({
    feePayer: input.settler.address,
    settler: input.settler.address,
    market: input.group.marketAddress,
    baseTokenProgram: input.group.baseTokenProgram,
    quoteTokenProgram: input.group.quoteTokenProgram,
    baseMint: input.group.baseMint,
    quoteMint: input.group.quoteMint,
    series: batch.seriesAddress,
    baseCollateralVault: batch.baseCollateralVault,
    quoteCollateralVault: batch.quoteCollateralVault,
    sellers: batch.sellers,
    ...input.blockhash,
  });
}

async function sendSettlementBatches(input: {
  readonly rpc: SolanaRpcClient;
  readonly settler: SolanaKeypair;
  readonly plan: SettlementPlan;
  readonly checkpoint: PendingSettlement;
}): Promise<CliCommandResult> {
  const progress = spinner();
  let completedBatches = 0;
  let settledSellers = 0;
  let completedSeries = 0;
  const signatures: string[] = [];
  const batchesPerSeries = new Map<Address, number>();
  for (const batch of input.plan.batches) {
    batchesPerSeries.set(
      batch.seriesAddress,
      (batchesPerSeries.get(batch.seriesAddress) ?? 0) + 1
    );
  }
  progress.start("Preparing settlement transactions");
  for (const batch of input.plan.batches) {
    try {
      progress.message(
        `Settling SellerVaults ${settledSellers + 1}-${settledSellers + batch.sellers.length} of ${input.plan.sellerCount} (transaction ${completedBatches + 1} of ${input.plan.batches.length})`
      );
      const blockhash = await fetchLatestBlockhash(input.rpc);
      const signed = await signTransaction(
        [input.settler.keyPair],
        createBatchTransaction(
          { settler: input.settler, group: input.plan.group, blockhash },
          batch
        )
      );
      const signature = getSignatureFromTransaction(signed);
      const returnedSignature = await input.rpc.call("sendTransaction", [
        getBase64EncodedWireTransaction(signed),
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
      await waitForConfirmedTransaction(
        input.rpc,
        signature,
        blockhash.lastValidBlockHeight
      );
      signatures.push(signature);
      log.info(`Settlement transaction confirmed: ${signature}`);
      completedBatches += 1;
      settledSellers += batch.sellers.length;
      const remainingBatches =
        (batchesPerSeries.get(batch.seriesAddress) ?? 1) - 1;
      batchesPerSeries.set(batch.seriesAddress, remainingBatches);
      if (remainingBatches === 0) completedSeries += 1;
      progress.message(
        `Confirmed ${signature} — Series ${completedSeries} of ${input.plan.group.series.length}, SellerVaults ${settledSellers} of ${input.plan.sellerCount}`
      );
    } catch (error) {
      progress.stop(
        "Settlement stopped; the unfinished process can be continued."
      );
      const message =
        error instanceof Error ? error.message : "Unknown transaction error.";
      log.error(
        `Settlement stopped after ${completedBatches} confirmed transaction(s): ${message}`
      );
      return { outcome: "failed" };
    }
  }
  await removePendingSettlement(input.checkpoint);
  progress.stop(
    `Settlement completed: ${completedSeries} Series and ${settledSellers} SellerVaults.`
  );
  log.success(
    `Confirmed settlement transaction signatures:\n${signatures.join("\n")}`
  );
  return { outcome: "completed" };
}

async function fetchRentUpperBound(rpc: SolanaRpcClient): Promise<bigint> {
  const result = await rpc.call("getMinimumBalanceForRentExemption", [
    TOKEN_ACCOUNT_RENT_SPACE_UPPER_BOUND,
    { commitment: "confirmed" },
  ]);
  if (!isNonNegativeSafeInteger(result)) {
    throw new Error("RPC returned an invalid token-account rent estimate.");
  }
  return BigInt(result);
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
    !isNonNegativeSafeInteger(result.value.lastValidBlockHeight)
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

async function waitForConfirmedTransaction(
  rpc: SolanaRpcClient,
  signature: string,
  lastValidBlockHeight: bigint
): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    const result = await rpc.call("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const status = signatureStatus(result);
    if (status === "confirmed") return;
    if (status === "failed")
      throw new Error("Solana transaction failed before confirmation.");
    if (Date.now() - startedAt >= CONFIRMATION_TIMEOUT_MS) {
      throw new Error("Timed out waiting for Solana transaction confirmation.");
    }
    const height = await rpc.call("getBlockHeight", [
      { commitment: "confirmed" },
    ]);
    if (!isNonNegativeSafeInteger(height))
      throw new Error("RPC returned an invalid block height response.");
    if (BigInt(height) > lastValidBlockHeight) {
      throw new Error("Solana transaction expired before confirmation.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function signatureStatus(value: unknown): "pending" | "confirmed" | "failed" {
  if (!isRecord(value) || !Array.isArray(value.value)) {
    throw new Error("RPC returned an invalid transaction status response.");
  }
  const status = value.value[0];
  if (status === null) return "pending";
  if (!isRecord(status) || !("err" in status)) {
    throw new Error("RPC returned an invalid transaction status response.");
  }
  if (status.err !== null) return "failed";
  return status.confirmationStatus === "confirmed" ||
    status.confirmationStatus === "finalized"
    ? "confirmed"
    : "pending";
}

function transactionBytes(
  transaction: Parameters<typeof getBase64EncodedWireTransaction>[0]
): number {
  return Buffer.from(getBase64EncodedWireTransaction(transaction), "base64")
    .length;
}

function sellerCount(group: EligibleSettlementGroup): number {
  return group.series.reduce(
    (total, series) => total + series.sellers.length,
    0
  );
}

function groupValue(group: EligibleSettlementGroup): string {
  return `${group.marketAddress}:${group.expiryMs}`;
}

function pendingValue(pending: PendingSettlement): string {
  return `${pending.clusterGenesisHash}:${pending.marketAddress}:${pending.expiryMs}`;
}

function isSimulationSuccessful(value: unknown): boolean {
  return isRecord(value) && isRecord(value.value) && value.value.err === null;
}

function simulationUnits(value: unknown): number | null {
  if (!isRecord(value) || !isRecord(value.value)) return null;
  const units = value.value.unitsConsumed;
  return isNonNegativeSafeInteger(units) ? units : null;
}

function formatLamports(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0");
  return `${whole}.${fraction} SOL`;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
