import { afterEach, describe, expect, it, vi } from "vitest";

import { BroadcastProcessor, type BroadcastTask } from "../src/broadcast";
import { JsonSolanaRpc } from "../src/solana-rpc";

const task: BroadcastTask = {
  txSignature: "seller-transaction-signature",
  ixIndex: 0,
  signedTransaction: "signed-transaction",
};

afterEach(() => vi.unstubAllGlobals());

describe("Solana JSON-RPC broadcast adapter", () => {
  it("reads the blockhash and Series account needed to create an RFQ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as { method: string };
        if (request.method === "getLatestBlockhash") {
          return Response.json({
            jsonrpc: "2.0",
            id: request.method,
            result: {
              value: {
                blockhash: "11111111111111111111111111111111",
                lastValidBlockHeight: 42,
              },
            },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: request.method,
          result: { value: null },
        });
      })
    );
    const rpc = new JsonSolanaRpc("https://solana.example");

    await expect(rpc.getLatestBlockhash()).resolves.toEqual({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 42,
    });
    await expect(rpc.accountExists("series-address")).resolves.toBe(false);
  });

  it("persists a confirmed underwrite after successful mocked RPC responses", async () => {
    const requests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        const request = requests.at(-1) as { method: string };
        return Response.json(rpcSuccessFor(request.method));
      })
    );
    const repository = new LifecycleRepository();

    await new BroadcastProcessor(
      repository,
      new JsonSolanaRpc("https://solana.example")
    ).process(task, 1_735_600_000_000);

    expect(requests).toMatchObject([
      { method: "simulateTransaction" },
      { method: "sendTransaction" },
      { method: "getSignatureStatuses" },
    ]);
    expect(repository.statuses).toEqual(["submitted", "confirmed"]);
    expect(repository.confirmedReceipt).toBe(
      '{"err":null,"confirmationStatus":"confirmed"}'
    );
  });

  it("reports a transaction that has not reached confirmed as pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jsonrpc: "2.0",
          id: "getSignatureStatuses",
          result: { value: [null] },
        })
      )
    );

    await expect(
      new JsonSolanaRpc("https://solana.example").confirm(task.txSignature)
    ).resolves.toEqual({ status: "pending" });
  });

  it("persists a deterministic RPC rejection as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          error: { message: "blockhash not found" },
        })
      )
    );
    const repository = new LifecycleRepository();

    await new BroadcastProcessor(
      repository,
      new JsonSolanaRpc("https://solana.example")
    ).process(task, 1_735_600_000_000);

    expect(repository.failure).toBe("blockhash not found");
  });
});

function rpcSuccessFor(method: string): unknown {
  if (method === "simulateTransaction") {
    return { jsonrpc: "2.0", id: method, result: { value: { err: null } } };
  }
  if (method === "sendTransaction") {
    return { jsonrpc: "2.0", id: method, result: task.txSignature };
  }
  return {
    jsonrpc: "2.0",
    id: method,
    result: {
      value: [{ err: null, confirmationStatus: "confirmed" }],
    },
  };
}

class LifecycleRepository {
  readonly statuses: string[] = [];
  failure: string | undefined;
  confirmedReceipt: string | undefined;

  async getStatus(): Promise<"queued"> {
    return "queued";
  }

  async markSubmitted(): Promise<void> {
    this.statuses.push("submitted");
  }

  async markConfirmed(
    _txSignature: string,
    _ixIndex: number,
    _atMs: number,
    receipt: string
  ): Promise<void> {
    this.statuses.push("confirmed");
    this.confirmedReceipt = receipt;
  }

  async markFailed(
    _txSignature: string,
    _ixIndex: number,
    _atMs: number,
    error: string
  ): Promise<void> {
    this.failure = error;
  }
}
