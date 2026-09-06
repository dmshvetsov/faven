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
} from "@solana/kit";

import { DEVNET_FUNDING } from "./config";

const ASSOCIATED_TOKEN_PROGRAM = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const TOKEN_PROGRAM = address(DEVNET_FUNDING.tokenProgram);
const FUNDING_MINT = address(DEVNET_FUNDING.mint);

export interface TreasurySigner {
  readonly address: string;
  readonly keyPair: CryptoKeyPair;
}

export interface WalletFundingTransaction {
  readonly signature: string;
  readonly wireTransaction: string;
}

export async function treasurySignerFromSecret(
  secret: string | undefined
): Promise<TreasurySigner> {
  if (secret === undefined) throw new Error("invalid-treasury-secret");
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error("invalid-treasury-secret");
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
    throw new Error("invalid-treasury-secret");
  }
  try {
    const keyPair = await createKeyPairFromBytes(new Uint8Array(parsed));
    return {
      address: await getAddressFromPublicKey(keyPair.publicKey),
      keyPair,
    };
  } catch {
    throw new Error("invalid-treasury-secret");
  }
}

export async function buildWalletFundingTransaction(input: {
  readonly recipient: string;
  readonly treasury: TreasurySigner;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}): Promise<WalletFundingTransaction> {
  const treasury = address(input.treasury.address);
  const recipient = address(input.recipient);
  const recipientAta = await deriveAssociatedTokenAddress(recipient);
  const message = appendTransactionMessageInstructions(
    [
      createAssociatedTokenAccountIdempotentInstruction(
        treasury,
        recipientAta,
        recipient
      ),
      mintToInstruction(treasury, recipientAta),
      systemTransferInstruction(treasury, recipient),
    ],
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(input.blockhash),
        lastValidBlockHeight: BigInt(input.lastValidBlockHeight),
      },
      setTransactionMessageFeePayer(
        treasury,
        createTransactionMessage({ version: 0 })
      )
    )
  );
  const signed = await signTransaction(
    [input.treasury.keyPair],
    compileTransaction(message)
  );
  return {
    signature: getSignatureFromTransaction(signed),
    wireTransaction: getBase64EncodedWireTransaction(signed),
  };
}

async function deriveAssociatedTokenAddress(owner: ReturnType<typeof address>) {
  const [associatedTokenAddress] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [
      getAddressEncoder().encode(owner),
      getAddressEncoder().encode(TOKEN_PROGRAM),
      getAddressEncoder().encode(FUNDING_MINT),
    ],
  });
  return associatedTokenAddress;
}

function createAssociatedTokenAccountIdempotentInstruction(
  payer: ReturnType<typeof address>,
  associatedTokenAccount: ReturnType<typeof address>,
  owner: ReturnType<typeof address>
) {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    data: new Uint8Array([1]),
    accounts: [
      writableSigner(payer),
      writable(associatedTokenAccount),
      readonly(owner),
      readonly(FUNDING_MINT),
      readonly(SYSTEM_PROGRAM),
      readonly(TOKEN_PROGRAM),
    ],
  };
}

function mintToInstruction(
  authority: ReturnType<typeof address>,
  recipientAta: ReturnType<typeof address>
) {
  const data = new Uint8Array(9);
  data[0] = 7;
  writeU64(data, 1, DEVNET_FUNDING.mintAmount);
  return {
    programAddress: TOKEN_PROGRAM,
    data,
    accounts: [
      writable(FUNDING_MINT),
      writable(recipientAta),
      readonlySigner(authority),
    ],
  };
}

function systemTransferInstruction(
  sender: ReturnType<typeof address>,
  recipient: ReturnType<typeof address>
) {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  writeU64(data, 4, DEVNET_FUNDING.solLamports);
  return {
    programAddress: SYSTEM_PROGRAM,
    data,
    accounts: [writableSigner(sender), writable(recipient)],
  };
}

function writableSigner(account: ReturnType<typeof address>) {
  return { address: account, role: AccountRole.WRITABLE_SIGNER };
}

function writable(account: ReturnType<typeof address>) {
  return { address: account, role: AccountRole.WRITABLE };
}

function readonly(account: ReturnType<typeof address>) {
  return { address: account, role: AccountRole.READONLY };
}

function readonlySigner(account: ReturnType<typeof address>) {
  return { address: account, role: AccountRole.READONLY_SIGNER };
}

function writeU64(data: Uint8Array, offset: number, value: bigint): void {
  new DataView(data.buffer).setBigUint64(offset, value, true);
}
