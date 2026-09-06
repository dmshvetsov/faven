import type { SolanaBroadcastRpc, SolanaConfirmation } from "./broadcast";

export class JsonSolanaRpc implements SolanaBroadcastRpc {
  constructor(private readonly endpoint: string) {}

  async getLatestBlockhash(): Promise<{
    readonly blockhash: string;
    readonly lastValidBlockHeight: number;
  }> {
    const result = await this.call("getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    const value = resultValue(result);
    if (
      typeof value.blockhash !== "string" ||
      typeof value.lastValidBlockHeight !== "number" ||
      !Number.isSafeInteger(value.lastValidBlockHeight)
    ) {
      throw new Error("Solana RPC returned an invalid latest blockhash.");
    }
    return {
      blockhash: value.blockhash,
      lastValidBlockHeight: value.lastValidBlockHeight,
    };
  }

  async accountExists(accountAddress: string): Promise<boolean> {
    const result = await this.call("getAccountInfo", [
      accountAddress,
      { commitment: "confirmed", encoding: "base64" },
    ]);
    const value = accountInfoValue(result);
    return value !== null;
  }

  async simulate(
    transaction: string
  ): Promise<{ readonly error: string | null }> {
    const result = await this.call("simulateTransaction", [
      transaction,
      { encoding: "base64", sigVerify: true, commitment: "confirmed" },
    ]);
    const value = resultValue(result);
    return { error: value.err === null ? null : JSON.stringify(value.err) };
  }

  async send(transaction: string): Promise<void> {
    await this.call("sendTransaction", [
      transaction,
      {
        encoding: "base64",
        skipPreflight: true,
        preflightCommitment: "confirmed",
      },
    ]);
  }

  async submitFundingTransaction(transaction: string): Promise<string> {
    const result = await this.call("sendTransaction", [
      transaction,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
      },
    ]);
    if (typeof result !== "string") {
      throw new Error("Solana RPC returned an invalid transaction signature.");
    }
    return result;
  }

  async waitForConfirmedFunding(signature: string): Promise<void> {
    for (let attempt = 0; attempt < 45; attempt += 1) {
      const confirmation = await this.confirm(signature);
      if (confirmation.status === "confirmed") return;
      if (confirmation.status === "failed") {
        throw new FundingTransactionFailedError(confirmation.error);
      }
      await delay(1_000);
    }
    throw new FundingConfirmationTimeoutError();
  }

  async confirm(signature: string): Promise<SolanaConfirmation> {
    const result = await this.call("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    if (!isRecord(result) || !Array.isArray(result.value))
      throw new Error("Solana RPC returned an invalid status.");
    const status = result.value[0];
    if (status === null) return { status: "pending" };
    if (!isRecord(status))
      throw new Error("Solana RPC returned an invalid status.");
    const receipt = JSON.stringify(status);
    if (status.err !== null)
      return { status: "failed", error: JSON.stringify(status.err), receipt };
    if (
      status.confirmationStatus !== "confirmed" &&
      status.confirmationStatus !== "finalized"
    ) {
      return { status: "pending" };
    }
    return { status: "confirmed", receipt };
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body))
      throw new Error("Solana RPC returned an invalid response.");
    if (isRecord(body.error)) {
      throw new Error(
        typeof body.error.message === "string"
          ? body.error.message
          : "Solana RPC error."
      );
    }
    if (!("result" in body)) throw new Error("Solana RPC returned no result.");
    return body.result;
  }
}

export class FundingTransactionFailedError extends Error {
  constructor(readonly rpcError: string) {
    super("Solana transaction failed.");
  }
}

export class FundingConfirmationTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for Solana transaction confirmation.");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resultValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.value)) {
    throw new Error("Solana RPC returned an invalid response.");
  }
  return value.value;
}

function accountInfoValue(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !("value" in value)) {
    throw new Error("Solana RPC returned an invalid response.");
  }
  const account = value.value;
  if (account !== null && !isRecord(account)) {
    throw new Error("Solana RPC returned an invalid account.");
  }
  return account;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
