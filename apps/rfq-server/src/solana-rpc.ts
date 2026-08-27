import type { SolanaBroadcastRpc } from "./broadcast";

export class JsonSolanaRpc implements SolanaBroadcastRpc {
  constructor(private readonly endpoint: string) {}

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

  async confirm(signature: string): Promise<{ readonly error: string | null }> {
    const result = await this.call("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    if (!isRecord(result) || !Array.isArray(result.value))
      throw new Error("Solana RPC returned an invalid status.");
    const status = result.value[0];
    if (status === null) throw new Error("network confirmation pending");
    if (!isRecord(status))
      throw new Error("Solana RPC returned an invalid status.");
    if (status.err !== null) return { error: JSON.stringify(status.err) };
    if (
      status.confirmationStatus !== "confirmed" &&
      status.confirmationStatus !== "finalized"
    ) {
      throw new Error("network confirmation pending");
    }
    return { error: null };
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

function resultValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.value)) {
    throw new Error("Solana RPC returned an invalid response.");
  }
  return value.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
