import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_PATH = fileURLToPath(
  new URL(
    "../.admin-cli-store/pending-price-finalizations.json",
    import.meta.url
  )
);
const STORE_VERSION = 1;

export interface PendingPriceFinalization {
  readonly signature: string;
  readonly serverUrl: string;
  readonly clusterGenesisHash: string;
}

interface PendingPriceFinalizationStore {
  readonly version: number;
  readonly pending: readonly PendingPriceFinalization[];
}

export async function readPendingPriceFinalizations(): Promise<
  readonly PendingPriceFinalization[]
> {
  let contents: string;
  try {
    contents = await readFile(STORE_PATH, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new Error("Could not read pending price finalizations.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("Pending price finalizations store contains invalid JSON.");
  }
  if (!isStore(parsed)) {
    throw new Error("Pending price finalizations store has an invalid format.");
  }
  return parsed.pending;
}

export async function enqueuePendingPriceFinalization(
  pending: PendingPriceFinalization
): Promise<void> {
  const existing = await readPendingPriceFinalizations();
  if (existing.some((entry) => entry.signature === pending.signature)) return;
  await writePendingPriceFinalizations([...existing, pending]);
}

export async function removePendingPriceFinalization(
  signature: string
): Promise<void> {
  const existing = await readPendingPriceFinalizations();
  await writePendingPriceFinalizations(
    existing.filter((entry) => entry.signature !== signature)
  );
}

async function writePendingPriceFinalizations(
  pending: readonly PendingPriceFinalization[]
): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const store: PendingPriceFinalizationStore = {
    version: STORE_VERSION,
    pending,
  };
  const temporaryPath = `${STORE_PATH}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, STORE_PATH);
  } catch {
    throw new Error("Could not atomically save pending price finalizations.");
  }
}

function isStore(value: unknown): value is PendingPriceFinalizationStore {
  return (
    isRecord(value) &&
    value.version === STORE_VERSION &&
    Array.isArray(value.pending) &&
    value.pending.every(isPendingEntry)
  );
}

function isPendingEntry(value: unknown): value is PendingPriceFinalization {
  if (!isRecord(value)) return false;
  if (
    typeof value.signature !== "string" ||
    typeof value.serverUrl !== "string" ||
    typeof value.clusterGenesisHash !== "string"
  ) {
    return false;
  }
  try {
    const serverUrl = new URL(value.serverUrl);
    return (
      (serverUrl.protocol === "http:" || serverUrl.protocol === "https:") &&
      serverUrl.username === "" &&
      serverUrl.password === "" &&
      value.signature.length > 0 &&
      value.clusterGenesisHash.length > 0
    );
  } catch {
    return false;
  }
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
