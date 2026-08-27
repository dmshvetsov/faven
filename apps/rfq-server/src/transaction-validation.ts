import {
  address,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";

import type { MarketConfig } from "./config";
import type { RfqTerms } from "./rfq-book";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const CREATE_SERIES = "b5093478c5dd2a8e";
const UNDERWRITE_CALL = "e3330744f3e820f6";
const UNDERWRITE_PUT = "f189eb039c4ce302";
type ReadonlyBytes = ArrayLike<number> & {
  readonly byteLength: number;
  slice(start?: number, end?: number): Uint8Array;
};
type CompiledMessage = ReturnType<
  ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]
>;

export interface ValidatedUnderwrite {
  readonly buyerAddress: string;
  readonly sellerAddress: string;
  readonly seriesAddress: string;
  readonly ixIndex: number;
  readonly premium: string;
}

export async function signedTransactionHash(
  encodedTransaction: string
): Promise<string> {
  return hashBytes(decodeBase64(encodedTransaction));
}

export async function offerTransactionHash(
  encodedTransaction: string
): Promise<string> {
  const normalized = decodeBase64(encodedTransaction);
  const firstSignatureOffset = signatureSectionOffset(normalized);
  normalized.fill(0, firstSignatureOffset, firstSignatureOffset + 64);
  return hashBytes(normalized);
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer(bytes));
  return hex(new Uint8Array(digest));
}

export async function validateSignedUnderwrite(
  encodedTransaction: string,
  terms: RfqTerms,
  premium: string,
  market: MarketConfig,
  requireSellerSignature: boolean
): Promise<ValidatedUnderwrite> {
  const bytes = decodeBase64(encodedTransaction);
  const transaction = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(
    new Uint8Array(transaction.messageBytes)
  );
  if (message.version !== "legacy") {
    throw new Error("Versioned transactions are not supported for RFQs.");
  }
  validateMatchesPremiumFreeRfq(message, terms.underwriteTx, premium);
  await validateSignatures(
    transaction.signatures,
    transaction.messageBytes,
    requireSellerSignature
  );
  const accounts = message.staticAccounts;
  const underwrites: ValidatedUnderwrite[] = [];
  const createdSeries: string[] = [];
  for (const [ixIndex, instruction] of message.instructions.entries()) {
    const programAddress = accounts[instruction.programAddressIndex];
    if (programAddress === COMPUTE_BUDGET_PROGRAM) continue;
    if (programAddress !== market.optionsProgramId) {
      throw new Error("Transaction includes an unconfigured instruction.");
    }
    const data = instruction.data;
    if (data === undefined)
      throw new Error("Options instruction data is missing.");
    const discriminator = hex(data.slice(0, 8));
    const instructionAccounts = (instruction.accountIndices ?? []).map(
      (index) => accounts[index]
    );
    if (instructionAccounts.some((account) => account === undefined)) {
      throw new Error("Instruction has an unresolved account.");
    }
    if (discriminator === CREATE_SERIES) {
      createdSeries.push(
        validateCreateSeries(data, instructionAccounts, terms, market)
      );
      continue;
    }
    if (discriminator !== UNDERWRITE_CALL && discriminator !== UNDERWRITE_PUT) {
      throw new Error("Transaction uses an unsupported options instruction.");
    }
    underwrites.push(
      validateUnderwrite(
        data,
        instructionAccounts,
        discriminator === UNDERWRITE_PUT,
        terms,
        premium,
        market,
        ixIndex
      )
    );
  }
  if (underwrites.length !== 1) {
    throw new Error(
      "Transaction must contain exactly one underwrite instruction."
    );
  }
  if (
    createdSeries.some(
      (seriesAddress) => seriesAddress !== underwrites[0].seriesAddress
    )
  ) {
    throw new Error(
      "Create-series instruction does not match the underwrite series."
    );
  }
  if (accounts[0] !== underwrites[0].sellerAddress) {
    throw new Error("Seller must be the transaction fee payer.");
  }
  return underwrites[0];
}

function validateMatchesPremiumFreeRfq(
  quoteMessage: CompiledMessage,
  premiumFreeTransaction: string,
  premium: string
): void {
  const templateTransaction = getTransactionDecoder().decode(
    decodeBase64(premiumFreeTransaction)
  );
  const templateMessage = getCompiledTransactionMessageDecoder().decode(
    new Uint8Array(templateTransaction.messageBytes)
  );
  if (templateMessage.version !== "legacy") {
    throw new Error("Premium-free RFQ transaction must be legacy.");
  }
  if (
    !sameStringArray(
      quoteMessage.staticAccounts,
      templateMessage.staticAccounts
    ) ||
    quoteMessage.instructions.length !== templateMessage.instructions.length
  ) {
    throw new Error(
      "Transaction differs from the premium-free RFQ transaction."
    );
  }
  for (const [index, instruction] of quoteMessage.instructions.entries()) {
    const template = templateMessage.instructions[index];
    if (
      instruction.programAddressIndex !== template.programAddressIndex ||
      !sameBytes(
        instruction.accountIndices ?? [],
        template.accountIndices ?? []
      ) ||
      !sameInstructionData(instruction.data, template.data, premium)
    ) {
      throw new Error(
        "Transaction differs from the premium-free RFQ transaction."
      );
    }
  }
}

function sameInstructionData(
  actual: ReadonlyBytes | undefined,
  template: ReadonlyBytes | undefined,
  premium: string
): boolean {
  if (actual === undefined || template === undefined) {
    return actual === template;
  }
  const isUnderwrite =
    hex(template.slice(0, 8)) === UNDERWRITE_CALL ||
    hex(template.slice(0, 8)) === UNDERWRITE_PUT;
  if (!isUnderwrite || actual.length !== 26 || template.length !== 26) {
    return sameBytes(actual, template);
  }
  if (readU64(template, 16) !== 0n || readU64(actual, 16) !== BigInt(premium)) {
    return false;
  }
  return (
    sameBytes(actual.slice(0, 16), template.slice(0, 16)) &&
    sameBytes(actual.slice(24), template.slice(24))
  );
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return (
    left.length === right.length &&
    Array.from(left).every((value, index) => value === right[index])
  );
}

function validateCreateSeries(
  data: ReadonlyBytes,
  accounts: readonly string[],
  terms: RfqTerms,
  market: MarketConfig
): string {
  if (data.length !== 25 || accounts.length < 5) {
    throw new Error("Invalid create-series instruction.");
  }
  if (
    accounts[1] !== market.marketAddress ||
    accounts[2] !== market.baseCoinMint ||
    accounts[3] !== market.quoteCoinMint ||
    data[8] !== (terms.isPut ? 1 : 0) ||
    readU64(data, 9) !== BigInt(terms.strike) ||
    readU64(data, 17) !== BigInt(terms.expiry) * 1_000n
  ) {
    throw new Error("Create-series instruction does not match RFQ terms.");
  }
  return accounts[4];
}

function validateUnderwrite(
  data: ReadonlyBytes,
  accounts: readonly string[],
  isPut: boolean,
  terms: RfqTerms,
  premium: string,
  market: MarketConfig,
  ixIndex: number
): ValidatedUnderwrite {
  if (data.length !== 26 || accounts.length < 12) {
    throw new Error("Invalid underwrite instruction.");
  }
  if (
    isPut !== terms.isPut ||
    accounts[2] !== market.marketAddress ||
    accounts[3] !== market.baseCoinMint ||
    accounts[4] !== market.quoteCoinMint ||
    accounts[11] !== market.feeRecipient ||
    readU64(data, 8) !== BigInt(terms.quantity) ||
    readU64(data, 16) !== BigInt(premium) ||
    readU16(data, 24) !== market.operationalFeeBps
  ) {
    throw new Error("Underwrite instruction does not match RFQ terms.");
  }
  return {
    buyerAddress: accounts[0],
    sellerAddress: accounts[1],
    seriesAddress: accounts[5],
    ixIndex,
    premium,
  };
}

async function validateSignatures(
  signatures: Readonly<Record<string, Uint8Array | null>>,
  messageBytes: ReadonlyBytes,
  requireSellerSignature: boolean
): Promise<void> {
  const entries = Object.entries(signatures);
  if (entries.length === 0)
    throw new Error("Transaction has no required signatures.");
  const [feePayer, feePayerSignature] = entries[0];
  if (requireSellerSignature && feePayerSignature === null) {
    throw new Error("Seller fee-payer signature is missing.");
  }
  for (const [signerAddress, signature] of entries) {
    if (signature === null) {
      if (signerAddress === feePayer && !requireSellerSignature) continue;
      throw new Error("Required transaction signature is missing.");
    }
    const publicKey = await crypto.subtle.importKey(
      "raw",
      arrayBuffer(getAddressEncoder().encode(address(signerAddress))),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    if (
      !(await crypto.subtle.verify(
        { name: "Ed25519" },
        publicKey,
        arrayBuffer(signature),
        arrayBuffer(messageBytes)
      ))
    ) {
      throw new Error("Transaction signature is invalid.");
    }
  }
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Transaction must be base64 encoded.");
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function signatureSectionOffset(bytes: Uint8Array): number {
  let count = 0;
  let shift = 0;
  let offset = 0;
  while (offset < bytes.length && offset < 3) {
    const value = bytes[offset];
    count |= (value & 0x7f) << shift;
    offset += 1;
    if ((value & 0x80) === 0) break;
    shift += 7;
  }
  if (count < 1 || offset + count * 64 > bytes.length) {
    throw new Error("Invalid Solana transaction signature section.");
  }
  return offset;
}

function readU64(bytes: ReadonlyBytes, offset: number): bigint {
  return new DataView(arrayBuffer(bytes)).getBigUint64(offset, true);
}

function readU16(bytes: ReadonlyBytes, offset: number): number {
  return new DataView(arrayBuffer(bytes)).getUint16(offset, true);
}

function hex(bytes: ReadonlyBytes): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    ""
  );
}

function arrayBuffer(bytes: ArrayLike<number>): ArrayBuffer {
  const copy = Uint8Array.from(bytes);
  return copy.buffer;
}
