import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";

export interface FinalTransactionValidationInput {
  readonly underwriteTx: string;
  readonly canonicalTransaction: string;
}

export class FinalTransactionValidationError extends Error {}

export function validateFinalUnderwriteTransaction(
  input: FinalTransactionValidationInput
): void {
  const submitted = decodeMessage(input.underwriteTx);
  const canonical = decodeMessage(input.canonicalTransaction);

  validateInlineV0(submitted);
  validateInlineV0(canonical);
  validateFeePayer(submitted, canonical);
  validateLifetime(submitted, canonical);
  validateAccountFlags(submitted, canonical);
  validateAccountOrder(submitted, canonical);
  validateInstructions(submitted, canonical);
}

function decodeMessage(encodedTransaction: string) {
  try {
    const transaction = getTransactionDecoder().decode(
      base64Bytes(encodedTransaction)
    );
    return getCompiledTransactionMessageDecoder().decode(
      new Uint8Array(transaction.messageBytes)
    );
  } catch {
    throw new FinalTransactionValidationError("transaction-is-malformed");
  }
}

function validateInlineV0(message: ReturnType<typeof decodeMessage>): void {
  if (message.version !== 0 || message.addressTableLookups !== undefined) {
    throw new FinalTransactionValidationError("transaction-must-be-inline-v0");
  }
}

function validateFeePayer(
  submitted: ReturnType<typeof decodeMessage>,
  canonical: ReturnType<typeof decodeMessage>
): void {
  if (submitted.staticAccounts[0] !== canonical.staticAccounts[0]) {
    throw new FinalTransactionValidationError(
      "fee-payer-does-not-match-canonical-terms"
    );
  }
}

function validateLifetime(
  submitted: ReturnType<typeof decodeMessage>,
  canonical: ReturnType<typeof decodeMessage>
): void {
  if (submitted.lifetimeToken !== canonical.lifetimeToken) {
    throw new FinalTransactionValidationError(
      "blockhash-does-not-match-canonical-terms"
    );
  }
}

function validateAccountFlags(
  submitted: ReturnType<typeof decodeMessage>,
  canonical: ReturnType<typeof decodeMessage>
): void {
  const submittedHeader = submitted.header;
  const canonicalHeader = canonical.header;
  if (
    submittedHeader.numSignerAccounts !== canonicalHeader.numSignerAccounts ||
    submittedHeader.numReadonlySignerAccounts !==
      canonicalHeader.numReadonlySignerAccounts ||
    submittedHeader.numReadonlyNonSignerAccounts !==
      canonicalHeader.numReadonlyNonSignerAccounts
  ) {
    throw new FinalTransactionValidationError(
      "account-flags-do-not-match-canonical-terms"
    );
  }
}

function validateAccountOrder(
  submitted: ReturnType<typeof decodeMessage>,
  canonical: ReturnType<typeof decodeMessage>
): void {
  if (!sameValues(submitted.staticAccounts, canonical.staticAccounts)) {
    throw new FinalTransactionValidationError(
      "account-order-does-not-match-canonical-terms"
    );
  }
}

function validateInstructions(
  submitted: ReturnType<typeof decodeMessage>,
  canonical: ReturnType<typeof decodeMessage>
): void {
  if (submitted.instructions.length !== canonical.instructions.length) {
    throw new FinalTransactionValidationError(
      "instruction-count-does-not-match-canonical-terms"
    );
  }
  for (let index = 0; index < canonical.instructions.length; index += 1) {
    const submittedInstruction = submitted.instructions[index];
    const canonicalInstruction = canonical.instructions[index];
    if (
      submittedInstruction === undefined ||
      canonicalInstruction === undefined
    ) {
      throw new FinalTransactionValidationError(
        "instruction-count-does-not-match-canonical-terms"
      );
    }
    if (
      submitted.staticAccounts[submittedInstruction.programAddressIndex] !==
      canonical.staticAccounts[canonicalInstruction.programAddressIndex]
    ) {
      throw new FinalTransactionValidationError(
        "instruction-program-does-not-match-canonical-terms"
      );
    }
    if (
      !sameValues(
        submittedInstruction.accountIndices ?? [],
        canonicalInstruction.accountIndices ?? []
      )
    ) {
      throw new FinalTransactionValidationError(
        "instruction-accounts-do-not-match-canonical-terms"
      );
    }
    if (
      !sameBytes(
        submittedInstruction.data ?? [],
        canonicalInstruction.data ?? []
      )
    ) {
      throw new FinalTransactionValidationError(
        "instruction-data-does-not-match-canonical-terms"
      );
    }
  }
}

function sameValues<T>(left: readonly T[], right: readonly T[]): boolean {
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

function base64Bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new FinalTransactionValidationError("transaction-must-be-base64");
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
