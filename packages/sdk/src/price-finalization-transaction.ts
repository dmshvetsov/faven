import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from "@solana/kit";

const OPTIONS_PROGRAM = address("FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT");
const PYTH_TWAP_FINALIZATION_DISCRIMINATOR = new Uint8Array([
  43, 32, 59, 241, 94, 80, 21, 32,
]);
const PYTH_UNVERIFIED_FINALIZATION_DISCRIMINATOR = new Uint8Array([
  39, 12, 238, 117, 51, 101, 73, 33,
]);
const MAX_FINALIZATION_SERIES = 16;

export interface FinalizationSeriesAccounts {
  readonly seriesAddress: Address;
  readonly quoteCollateralVault: Address;
}

interface FinalizationTransactionInput {
  readonly feePayer: Address;
  readonly market: Address;
  readonly series: readonly FinalizationSeriesAccounts[];
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
}

export interface PythTwapFinalizationTransactionInput extends FinalizationTransactionInput {
  readonly caller: Address;
  readonly twapUpdate: Address;
}

export interface PythUnverifiedFinalizationTransactionInput extends FinalizationTransactionInput {
  readonly operator: Address;
  readonly feedId: Uint8Array;
  readonly price: bigint;
  readonly confidence: bigint;
  readonly exponent: number;
  readonly publishTime: bigint;
}

export function createPythTwapPriceFinalizationTransaction(
  input: PythTwapFinalizationTransactionInput
) {
  const series = finalizationSeriesAccounts(input.series);
  return compileTransaction(
    appendTransactionMessageInstructions(
      [
        {
          programAddress: OPTIONS_PROGRAM,
          data: PYTH_TWAP_FINALIZATION_DISCRIMINATOR,
          accounts: [
            readonlySigner(input.caller),
            readonly(input.market),
            readonly(input.twapUpdate),
            ...series,
          ],
        },
      ],
      transactionMessage(input)
    )
  );
}

export function createPythUnverifiedPriceFinalizationTransaction(
  input: PythUnverifiedFinalizationTransactionInput
) {
  const series = finalizationSeriesAccounts(input.series);
  return compileTransaction(
    appendTransactionMessageInstructions(
      [
        {
          programAddress: OPTIONS_PROGRAM,
          data: pythUnverifiedData(input),
          accounts: [
            readonlySigner(input.operator),
            readonly(input.market),
            ...series,
          ],
        },
      ],
      transactionMessage(input)
    )
  );
}

function transactionMessage(input: FinalizationTransactionInput) {
  return setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: blockhash(input.blockhash),
      lastValidBlockHeight: input.lastValidBlockHeight,
    },
    setTransactionMessageFeePayer(
      input.feePayer,
      createTransactionMessage({ version: 0 })
    )
  );
}

function finalizationSeriesAccounts(
  series: readonly FinalizationSeriesAccounts[]
) {
  if (series.length === 0 || series.length > MAX_FINALIZATION_SERIES) {
    throw new Error("Finalization must contain from 1 to 16 Series.");
  }
  const addresses = new Set<string>();
  return series.flatMap(({ seriesAddress, quoteCollateralVault }) => {
    if (addresses.has(seriesAddress)) {
      throw new Error("Finalization cannot contain a Series more than once.");
    }
    addresses.add(seriesAddress);
    return [writable(seriesAddress), readonly(quoteCollateralVault)];
  });
}

function pythUnverifiedData(
  input: PythUnverifiedFinalizationTransactionInput
): Uint8Array {
  if (input.feedId.length !== 32)
    throw new Error("Pyth feed ID must be 32 bytes.");
  const data = new Uint8Array(68);
  data.set(PYTH_UNVERIFIED_FINALIZATION_DISCRIMINATOR);
  data.set(input.feedId, 8);
  const view = new DataView(data.buffer);
  view.setBigInt64(40, input.price, true);
  view.setBigUint64(48, input.confidence, true);
  view.setInt32(56, input.exponent, true);
  view.setBigInt64(60, input.publishTime, true);
  return data;
}

function readonlySigner(address: Address) {
  return { address, role: AccountRole.READONLY_SIGNER };
}

function writable(address: Address) {
  return { address, role: AccountRole.WRITABLE };
}

function readonly(address: Address) {
  return { address, role: AccountRole.READONLY };
}
