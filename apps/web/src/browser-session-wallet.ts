import {
  createKeyPairSignerFromPrivateKeyBytes,
  type KeyPairSigner,
} from "@solana/kit";

const SESSION_WALLET_STORAGE_KEY = "faven.burner-session-wallet";
const PRIVATE_KEY_BYTE_LENGTH = 32;

type StoredBrowserSessionWallet = Readonly<{
  privateKey: string;
}>;

export type BrowserSessionWallet = KeyPairSigner;

function storageUnavailableError() {
  return new Error(
    "Browser session storage is unavailable. Temporary wallets cannot be used."
  );
}

function temporaryWalletUnavailableError() {
  return new Error("This browser cannot create a temporary wallet.");
}

function encodePrivateKey(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodePrivateKey(value: string) {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(`${base64}${padding}`);
    if (binary.length !== PRIVATE_KEY_BYTE_LENGTH) return null;

    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function storedPrivateKey(value: unknown) {
  if (value === null || typeof value !== "object") return null;

  const key = Reflect.get(value, "privateKey");
  if (typeof key === "string") return decodePrivateKey(key);

  // A prior version stored an extractable JWK. Its `d` field is the same
  // 32-byte Ed25519 secret; re-store it in the current session-only format.
  const legacyKey = Reflect.get(value, "d");
  return typeof legacyKey === "string" ? decodePrivateKey(legacyKey) : null;
}

function readStoredPrivateKey(storage: Storage) {
  let serializedWallet: string | null;
  try {
    serializedWallet = storage.getItem(SESSION_WALLET_STORAGE_KEY);
  } catch {
    throw storageUnavailableError();
  }

  if (!serializedWallet) return null;

  try {
    const storedWallet: unknown = JSON.parse(serializedWallet);
    const privateKey = storedPrivateKey(storedWallet);
    if (privateKey) return privateKey;
  } catch {
    // The invalid key is removed below.
  }

  try {
    storage.removeItem(SESSION_WALLET_STORAGE_KEY);
  } catch {
    throw storageUnavailableError();
  }
  throw new Error("The temporary wallet session could not be restored.");
}

function storePrivateKey(storage: Storage, privateKey: Uint8Array) {
  const storedWallet: StoredBrowserSessionWallet = {
    privateKey: encodePrivateKey(privateKey),
  };

  try {
    storage.setItem(SESSION_WALLET_STORAGE_KEY, JSON.stringify(storedWallet));
  } catch {
    throw storageUnavailableError();
  }
}

async function createWalletFromPrivateKey(privateKey: Uint8Array) {
  try {
    return await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  } catch {
    throw temporaryWalletUnavailableError();
  }
}

/** Returns true without reading or exposing the temporary wallet secret. */
export function hasBrowserSessionWallet(storage: Storage) {
  try {
    return storage.getItem(SESSION_WALLET_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Restores the keypair stored for this browser tab, if one exists. */
export async function loadBrowserSessionWallet(
  storage: Storage
): Promise<BrowserSessionWallet | null> {
  const privateKey = readStoredPrivateKey(storage);
  if (!privateKey) return null;

  const wallet = await createWalletFromPrivateKey(privateKey);
  storePrivateKey(storage, privateKey);
  return wallet;
}

/** Restores the tab's Kit signer or creates a new one without signing UI. */
export async function getOrCreateBrowserSessionWallet(
  storage: Storage
): Promise<BrowserSessionWallet> {
  const storedWallet = await loadBrowserSessionWallet(storage);
  if (storedWallet) return storedWallet;

  const privateKey = new Uint8Array(PRIVATE_KEY_BYTE_LENGTH);
  try {
    crypto.getRandomValues(privateKey);
  } catch {
    throw temporaryWalletUnavailableError();
  }

  const wallet = await createWalletFromPrivateKey(privateKey);
  storePrivateKey(storage, privateKey);
  return wallet;
}

/** Permanently removes the temporary keypair from this browser tab. */
export function clearBrowserSessionWallet(storage: Storage) {
  try {
    storage.removeItem(SESSION_WALLET_STORAGE_KEY);
  } catch {
    throw storageUnavailableError();
  }
}
