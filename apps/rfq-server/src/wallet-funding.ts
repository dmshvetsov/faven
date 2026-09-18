import { address, isOffCurveAddress } from "@solana/kit";

import {
  DEVNET_FUNDING,
  LOCALHOST_FUNDING,
  WALLET_FUNDING_COOLDOWN_MS,
  type SolanaCluster,
  type WalletFunding,
} from "./config";
import { WalletFundingRepository } from "./database/wallet-funding-repository";
import {
  FundingConfirmationTimeoutError,
  FundingTransactionFailedError,
  JsonSolanaRpc,
} from "./solana-rpc";
import {
  buildWalletFundingTransaction,
  treasurySignerFromSecret,
} from "./wallet-funding-transaction";

export type WalletFundingResult =
  | { readonly status: "invalid-wallet-address" }
  | { readonly status: "funding-in-progress" }
  | { readonly status: "wallet-cooldown-active"; readonly retryAt: Date }
  | { readonly status: "funding-unavailable" }
  | {
      readonly status: "funded";
      readonly signature: string | null;
      readonly funding: readonly WalletFunding[];
    };

export async function fundWallet(input: {
  readonly database: D1Database;
  readonly cluster: SolanaCluster;
  readonly rpcUrl: string;
  readonly treasuryPrivateKey: string | undefined;
  readonly walletAddress: string;
  readonly now?: number;
}): Promise<WalletFundingResult> {
  if (!isEoaWalletAddress(input.walletAddress)) {
    return { status: "invalid-wallet-address" };
  }

  const funding = fundingForCluster(input.cluster);
  if (funding === null) {
    return { status: "funding-unavailable" };
  }

  const now = input.now ?? Date.now();
  const repository = new WalletFundingRepository(input.database);
  const retryAt = await cooldownRetryAt(repository, input.walletAddress);
  if (retryAt !== null && retryAt.getTime() > now) {
    return { status: "wallet-cooldown-active", retryAt };
  }

  const pending = await repository.createPending(input.walletAddress, now);
  if (!pending.created || pending.id === null) {
    return { status: "funding-in-progress" };
  }

  const retryAtAfterClaim = await cooldownRetryAt(
    repository,
    input.walletAddress
  );
  if (retryAtAfterClaim !== null && retryAtAfterClaim.getTime() > now) {
    await repository.markFailed(pending.id, "wallet-cooldown-active", now);
    return { status: "wallet-cooldown-active", retryAt: retryAtAfterClaim };
  }

  try {
    const rpc = new JsonSolanaRpc(input.rpcUrl);
    if (input.cluster === "localhost") {
      await fundLocalWallet(rpc, input.walletAddress, funding);
      await repository.markSucceeded(pending.id, null, Date.now());
      return { status: "funded", signature: null, funding };
    }

    let treasury;
    try {
      treasury = await treasurySignerFromSecret(input.treasuryPrivateKey);
    } catch {
      await repository.markFailed(pending.id, "funding-unavailable", now);
      return { status: "funding-unavailable" };
    }
    const latestBlockhash = await rpc.getLatestBlockhash();
    const transaction = await buildWalletFundingTransaction({
      recipient: input.walletAddress,
      treasury,
      ...latestBlockhash,
    });
    await repository.recordTransactionSignature(
      pending.id,
      transaction.signature
    );
    await rpc.submitFundingTransaction(transaction.wireTransaction);
    await rpc.waitForConfirmedFunding(transaction.signature);
    await repository.markSucceeded(
      pending.id,
      transaction.signature,
      Date.now()
    );
    return { status: "funded", signature: transaction.signature, funding };
  } catch (error) {
    if (!(error instanceof FundingTransactionFailedError)) {
      console.error(
        "Wallet funding outcome is unknown; attempt remains pending.",
        {
          walletAddress: input.walletAddress,
          error:
            error instanceof FundingConfirmationTimeoutError
              ? "confirmation timed out"
              : error instanceof Error
                ? error.message
                : "Unknown error.",
        }
      );
      return { status: "funding-unavailable" };
    }

    console.error("Wallet funding transaction failed on-chain.", {
      walletAddress: input.walletAddress,
      error: error.rpcError,
    });
    await repository.markFailed(pending.id, "transaction-failed", Date.now());
    return { status: "funding-unavailable" };
  }
}

async function fundLocalWallet(
  rpc: JsonSolanaRpc,
  walletAddress: string,
  funding: readonly WalletFunding[]
): Promise<void> {
  for (const item of funding) {
    if (item.kind === "spl-token") {
      await rpc.setSurfnetTokenAccount({
        owner: walletAddress,
        mint: item.mint,
        tokenProgram: item.tokenProgram,
        amount: item.mintAmount,
      });
    } else {
      await rpc.setSurfnetAccount(walletAddress, { lamports: item.lamports });
    }
  }
}

function fundingForCluster(
  cluster: SolanaCluster
): readonly WalletFunding[] | null {
  if (cluster === "localhost") return LOCALHOST_FUNDING;
  if (cluster === "devnet") return DEVNET_FUNDING;
  return null;
}

async function cooldownRetryAt(
  repository: WalletFundingRepository,
  walletAddress: string
): Promise<Date | null> {
  const latestSuccess = await repository.latestSucceeded(walletAddress);
  return latestSuccess?.completedAtMs === null || latestSuccess === null
    ? null
    : new Date(latestSuccess.completedAtMs + WALLET_FUNDING_COOLDOWN_MS);
}

export function isEoaWalletAddress(value: string): boolean {
  try {
    const walletAddress = address(value);
    return !isOffCurveAddress(walletAddress);
  } catch {
    return false;
  }
}

export function retryAfterSeconds(retryAt: Date, now = Date.now()): number {
  return Math.max(1, Math.ceil((retryAt.getTime() - now) / 1_000));
}

export function fundedResponse(
  signature: string | null,
  funding: readonly WalletFunding[] = DEVNET_FUNDING
) {
  return {
    signature,
    funded: {
      ...Object.fromEntries(
        funding
          .filter((funding) => funding.kind === "spl-token")
          .map((funding) => [funding.mint, funding.mintAmount.toString()])
      ),
      solLamport: funding
        .find((funding) => funding.kind === "sol")
        ?.lamports.toString(),
    },
  };
}
