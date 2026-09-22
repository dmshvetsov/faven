import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_PATH = fileURLToPath(
  new URL("../.admin-cli-store/pending-settlements.json", import.meta.url)
);
const STORE_VERSION = 1;

export interface PendingSettlement {
  readonly clusterGenesisHash: string;
  readonly marketAddress: string;
  readonly expiryMs: number;
}

interface PendingSettlementStore {
  readonly version: number;
  readonly pending: readonly PendingSettlement[];
}

export async function readPendingSettlements(): Promise<
  readonly PendingSettlement[]
> {
  let contents: string;
  try {
    contents = await readFile(STORE_PATH, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new Error("Could not read pending settlements.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("Pending settlements store contains invalid JSON.");
  }
  if (!isStore(parsed))
    throw new Error("Pending settlements store has an invalid format.");
  return parsed.pending;
}

export async function savePendingSettlement(
  pending: PendingSettlement
): Promise<void> {
  const existing = await readPendingSettlements();
  const withoutCurrent = existing.filter(
    (entry) => !sameSettlement(entry, pending)
  );
  await writePendingSettlements([...withoutCurrent, pending]);
}

export async function removePendingSettlement(
  pending: PendingSettlement
): Promise<void> {
  const existing = await readPendingSettlements();
  await writePendingSettlements(
    existing.filter((entry) => !sameSettlement(entry, pending))
  );
}

function sameSettlement(
  left: PendingSettlement,
  right: PendingSettlement
): boolean {
  return (
    left.clusterGenesisHash === right.clusterGenesisHash &&
    left.marketAddress === right.marketAddress &&
    left.expiryMs === right.expiryMs
  );
}

async function writePendingSettlements(
  pending: readonly PendingSettlement[]
): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const temporaryPath = `${STORE_PATH}.${process.pid}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: STORE_VERSION, pending }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await rename(temporaryPath, STORE_PATH);
  } catch {
    throw new Error("Could not atomically save pending settlements.");
  }
}

function isStore(value: unknown): value is PendingSettlementStore {
  return (
    isRecord(value) &&
    value.version === STORE_VERSION &&
    Array.isArray(value.pending) &&
    value.pending.every(isPendingSettlement)
  );
}

function isPendingSettlement(value: unknown): value is PendingSettlement {
  return (
    isRecord(value) &&
    typeof value.clusterGenesisHash === "string" &&
    value.clusterGenesisHash.length > 0 &&
    typeof value.marketAddress === "string" &&
    value.marketAddress.length > 0 &&
    typeof value.expiryMs === "number" &&
    Number.isSafeInteger(value.expiryMs) &&
    value.expiryMs >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
