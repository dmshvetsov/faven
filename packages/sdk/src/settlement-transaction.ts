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
const ASSOCIATED_TOKEN_PROGRAM = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const COMPUTE_BUDGET_PROGRAM = address(
  "ComputeBudget111111111111111111111111111111"
);
const SETTLE_SELLERS_BATCH_DISCRIMINATOR = new Uint8Array([
  244, 160, 246, 223, 209, 180, 219, 102,
]);

export const SETTLEMENT_COMPUTE_UNIT_LIMIT = 1_000_000;

export interface SettlementSellerAccounts {
  readonly sellerVault: Address;
  readonly seller: Address;
  readonly basePayoutAccount: Address | null;
  readonly quotePayoutAccount: Address | null;
  readonly requiresSellerAccount: boolean;
}

export interface SettlementTransactionInput {
  readonly feePayer: Address;
  readonly settler: Address;
  readonly market: Address;
  readonly baseTokenProgram: Address;
  readonly quoteTokenProgram: Address;
  readonly baseMint: Address;
  readonly quoteMint: Address;
  readonly series: Address;
  readonly baseCollateralVault: Address;
  readonly quoteCollateralVault: Address;
  readonly sellers: readonly SettlementSellerAccounts[];
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
}

export function createSettlementTransaction(input: SettlementTransactionInput) {
  if (input.sellers.length === 0) {
    throw new Error("Settlement must contain at least one SellerVault.");
  }
  const sellerVaults = new Set<string>();
  for (const seller of input.sellers) {
    if (sellerVaults.has(seller.sellerVault)) {
      throw new Error(
        "Settlement cannot contain a SellerVault more than once."
      );
    }
    sellerVaults.add(seller.sellerVault);
  }
  return compileTransaction(
    appendTransactionMessageInstructions(
      [computeBudgetInstruction(), settlementInstruction(input)],
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(input.blockhash),
          lastValidBlockHeight: input.lastValidBlockHeight,
        },
        setTransactionMessageFeePayer(
          input.feePayer,
          createTransactionMessage({ version: 0 })
        )
      )
    )
  );
}

function computeBudgetInstruction() {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, SETTLEMENT_COMPUTE_UNIT_LIMIT, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data, accounts: [] };
}

function settlementInstruction(input: SettlementTransactionInput) {
  return {
    programAddress: OPTIONS_PROGRAM,
    data: SETTLE_SELLERS_BATCH_DISCRIMINATOR,
    accounts: [
      writableSigner(input.settler),
      readonly(input.market),
      readonly(input.baseTokenProgram),
      readonly(input.quoteTokenProgram),
      readonly(input.baseMint),
      readonly(input.quoteMint),
      writable(input.series),
      writable(input.baseCollateralVault),
      writable(input.quoteCollateralVault),
      readonly(ASSOCIATED_TOKEN_PROGRAM),
      readonly(SYSTEM_PROGRAM),
      ...input.sellers.flatMap((seller) => [
        writable(seller.sellerVault),
        ...(seller.basePayoutAccount === null
          ? []
          : [writable(seller.basePayoutAccount)]),
        ...(seller.quotePayoutAccount === null
          ? []
          : [writable(seller.quotePayoutAccount)]),
        ...(seller.requiresSellerAccount ? [readonly(seller.seller)] : []),
      ]),
    ],
  };
}

function readonly(account: Address) {
  return { address: account, role: AccountRole.READONLY };
}

function writable(account: Address) {
  return { address: account, role: AccountRole.WRITABLE };
}

function writableSigner(account: Address) {
  return { address: account, role: AccountRole.WRITABLE_SIGNER };
}
