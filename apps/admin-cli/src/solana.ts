import {
  address,
  createKeyPairFromBytes,
  getAddressDecoder,
  getAddressFromPublicKey,
  type Address,
} from "@solana/kit";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const SOLANA_CLI_CONFIG_PATH = join(
  homedir(),
  ".config",
  "solana",
  "cli",
  "config.yml"
);

const KEYPAIR_ERROR =
  "Solana CLI keypair_path cannot be used to initialize a keypair.";
const LEGACY_MINT_SIZE = 82;

export const LEGACY_TOKEN_PROGRAM = address(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
export const TOKEN_2022_PROGRAM = address(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

export interface SolanaCliConfig {
  readonly rpcEndpoint: string;
  readonly keypairPath: string;
}

export interface SolanaKeypair {
  readonly address: Address;
  readonly keyPair: CryptoKeyPair;
}

export interface SolanaRpcClient {
  readonly endpoint: string;
  readonly label: string;
  call(method: string, params: readonly unknown[]): Promise<unknown>;
}

export interface SolanaMint {
  readonly address: Address;
  readonly tokenProgram: Address;
  readonly mintAuthority: Address | null;
  readonly supply: bigint;
  readonly decimals: number;
  readonly isInitialized: boolean;
  readonly freezeAuthority: Address | null;
}

export async function loadSolanaCliConfig(): Promise<SolanaCliConfig> {
  let contents: string;
  try {
    contents = await readFile(SOLANA_CLI_CONFIG_PATH, "utf8");
  } catch {
    throw new Error(
      `Solana CLI config file does not exist: ${SOLANA_CLI_CONFIG_PATH}`
    );
  }

  const values = parseYamlValues(contents);
  const rpcEndpoint = values.json_rpc_url;
  const keypairPath = values.keypair_path;
  if (
    rpcEndpoint === undefined ||
    rpcEndpoint === "" ||
    keypairPath === undefined ||
    keypairPath === ""
  ) {
    throw new Error(
      "Solana CLI config must define json_rpc_url and keypair_path."
    );
  }
  validateRpcEndpoint(rpcEndpoint);

  return { rpcEndpoint, keypairPath };
}

export function loadSolanaRpcClient(config: SolanaCliConfig): SolanaRpcClient {
  return {
    endpoint: config.rpcEndpoint,
    label: rpcEndpointLabel(config.rpcEndpoint),
    call: (method, params) => rpcCall(config.rpcEndpoint, method, params),
  };
}

export async function loadSolanaKeypair(
  config: SolanaCliConfig
): Promise<SolanaKeypair> {
  let bytes: Uint8Array;
  try {
    const keypairPath = resolveKeypairPath(config.keypairPath);
    const parsed: unknown = JSON.parse(await readFile(keypairPath, "utf8"));
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
      throw new Error(KEYPAIR_ERROR);
    }
    bytes = new Uint8Array(parsed);
  } catch {
    throw new Error(KEYPAIR_ERROR);
  }

  try {
    const keyPair = await createKeyPairFromBytes(bytes);
    return {
      address: await getAddressFromPublicKey(keyPair.publicKey),
      keyPair,
    };
  } catch {
    throw new Error(KEYPAIR_ERROR);
  }
}

export async function fetchMint(
  rpc: SolanaRpcClient,
  mintAddress: Address
): Promise<SolanaMint> {
  const result = await rpc.call("getAccountInfo", [
    mintAddress,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const account = accountInfoValue(result);
  if (account === null)
    throw new Error("Mint account does not exist on this network.");
  if (
    account.owner !== LEGACY_TOKEN_PROGRAM &&
    account.owner !== TOKEN_2022_PROGRAM
  ) {
    throw new Error("Mint must use the SPL Token or Token-2022 program.");
  }
  if (account.executable || account.data.length < LEGACY_MINT_SIZE) {
    throw new Error("Account is not an SPL Token mint.");
  }

  const isInitialized = account.data[45];
  if (isInitialized !== 0 && isInitialized !== 1)
    throw new Error("Mint account has an invalid initialization state.");

  return {
    address: mintAddress,
    tokenProgram: account.owner,
    mintAuthority: decodeOptionalAddress(account.data, 0, 4),
    supply: new DataView(
      account.data.buffer,
      account.data.byteOffset,
      account.data.byteLength
    ).getBigUint64(36, true),
    decimals: account.data[44] ?? 0,
    isInitialized: isInitialized === 1,
    freezeAuthority: decodeOptionalAddress(account.data, 46, 50),
  };
}

function parseYamlValues(contents: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^(json_rpc_url|keypair_path):\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, key, value] = match;
    if (value === undefined || value === "") continue;
    values[key] = parseYamlScalar(value);
  }
  return values;
}

function parseYamlScalar(value: string): string {
  const withoutComment = stripYamlComment(value).trim();
  if (
    withoutComment.startsWith("'") &&
    withoutComment.endsWith("'") &&
    withoutComment.length >= 2
  ) {
    return withoutComment.slice(1, -1).replaceAll("''", "'");
  }
  if (
    withoutComment.startsWith('"') &&
    withoutComment.endsWith('"') &&
    withoutComment.length >= 2
  ) {
    try {
      const parsed: unknown = JSON.parse(withoutComment);
      return typeof parsed === "string" ? parsed : withoutComment;
    } catch {
      return withoutComment;
    }
  }
  return withoutComment;
}

function stripYamlComment(value: string): string {
  let quotedWith: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) continue;
    if (quotedWith === undefined && (character === "'" || character === '"')) {
      quotedWith = character;
      continue;
    }
    if (
      character === quotedWith &&
      !(quotedWith === '"' && isEscaped(value, index))
    ) {
      if (quotedWith === "'" && value[index + 1] === "'") {
        index += 1;
      } else {
        quotedWith = undefined;
      }
      continue;
    }
    if (
      quotedWith === undefined &&
      character === "#" &&
      (index === 0 || /\s/.test(value[index - 1] ?? ""))
    ) {
      return value.slice(0, index);
    }
  }
  return value;
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function accountInfoValue(value: unknown): {
  readonly owner: Address;
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
  try {
    return {
      owner: address(owner),
      executable,
      data: Buffer.from(data[0], "base64"),
    };
  } catch {
    throw new Error("RPC returned an invalid account response.");
  }
}

function decodeOptionalAddress(
  data: Uint8Array,
  optionOffset: number,
  addressOffset: number
): Address | null {
  const option = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength
  ).getUint32(optionOffset, true);
  if (option === 0) return null;
  if (option !== 1) throw new Error("Mint account has an invalid authority.");
  return getAddressDecoder().decode(
    data.slice(addressOffset, addressOffset + 32)
  );
}

function resolveKeypairPath(keypairPath: string): string {
  const expandedPath = keypairPath.startsWith("~/")
    ? join(homedir(), keypairPath.slice(2))
    : keypairPath;
  return isAbsolute(expandedPath) ? expandedPath : resolve(expandedPath);
}

function validateRpcEndpoint(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Solana CLI json_rpc_url must be a valid HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Solana CLI json_rpc_url must be a valid HTTP(S) URL.");
  }
}

function rpcEndpointLabel(value: string): string {
  const url = new URL(value);
  return url.origin;
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
    throw new Error("Could not reach the configured Solana RPC endpoint.");
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
