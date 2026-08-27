import { describe, expect, it, vi } from "vitest";

import {
  BroadcastProcessor,
  RetryableBroadcastError,
  type BroadcastTask,
} from "../src/broadcast";

const task: BroadcastTask = {
  txSignature: "transaction-signature",
  ixIndex: 0,
  signedTransaction: "base64-transaction",
  recentBlockhash: "11111111111111111111111111111111",
};

describe("broadcast queue processing", () => {
  it("records a simulation error as a terminal failed underwrite", async () => {
    const repository = repositoryMock();
    const processor = new BroadcastProcessor(repository, {
      simulate: vi.fn().mockResolvedValue({ error: "insufficient funds" }),
      send: vi.fn(),
      confirm: vi.fn(),
      isBlockhashValid: vi.fn(),
    });

    await processor.process(task, 1_735_600_000_000);

    expect(repository.markFailed).toHaveBeenCalledWith(
      task.txSignature,
      0,
      1_735_600_000_000,
      "insufficient funds"
    );
  });

  it("persists the confirmed Solana receipt before completing", async () => {
    const repository = repositoryMock();
    const processor = new BroadcastProcessor(repository, {
      simulate: vi.fn().mockResolvedValue({ error: null }),
      send: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue({
        error: null,
        receipt: '{"confirmationStatus":"confirmed","slot":123}',
      }),
      isBlockhashValid: vi.fn(),
    });

    await processor.process(task, 1_735_600_000_000);

    expect(repository.markSubmitted).toHaveBeenCalledBefore(
      repository.markConfirmed
    );
    expect(repository.markConfirmed).toHaveBeenCalledWith(
      task.txSignature,
      0,
      1_735_600_000_000,
      '{"confirmationStatus":"confirmed","slot":123}'
    );
  });

  it("retries a transient submission failure while the blockhash is valid", async () => {
    const rpc = {
      simulate: vi.fn().mockResolvedValue({ error: null }),
      send: vi.fn().mockRejectedValue(new Error("network timeout")),
      confirm: vi.fn(),
      isBlockhashValid: vi.fn().mockResolvedValue(true),
    };
    const processor = new BroadcastProcessor(repositoryMock(), rpc);

    await expect(
      processor.process(task, 1_735_600_000_000)
    ).rejects.toBeInstanceOf(RetryableBroadcastError);
    expect(rpc.isBlockhashValid).toHaveBeenCalledWith(task.recentBlockhash);
  });

  it("fails instead of retrying once the signed transaction blockhash expires", async () => {
    const repository = repositoryMock();
    const processor = new BroadcastProcessor(repository, {
      simulate: vi.fn().mockResolvedValue({ error: null }),
      send: vi.fn().mockRejectedValue(new Error("network timeout")),
      confirm: vi.fn(),
      isBlockhashValid: vi.fn().mockResolvedValue(false),
    });

    await processor.process(task, 1_735_600_000_000);

    expect(repository.markFailed).toHaveBeenCalledWith(
      task.txSignature,
      task.ixIndex,
      1_735_600_000_000,
      "Signed transaction blockhash has expired."
    );
  });

  it("asks the queue to retry while confirmation is still pending", async () => {
    const processor = new BroadcastProcessor(repositoryMock(), {
      simulate: vi.fn().mockResolvedValue({ error: null }),
      send: vi.fn().mockResolvedValue(undefined),
      confirm: vi
        .fn()
        .mockRejectedValue(new Error("network confirmation pending")),
      isBlockhashValid: vi.fn().mockResolvedValue(true),
    });

    await expect(
      processor.process(task, 1_735_600_000_000)
    ).rejects.toBeInstanceOf(RetryableBroadcastError);
  });

  it("only polls for confirmation when an earlier queue attempt submitted the transaction", async () => {
    const repository = repositoryMock("submitted");
    const rpc = {
      simulate: vi.fn(),
      send: vi.fn(),
      confirm: vi.fn().mockResolvedValue({
        error: null,
        receipt: '{"confirmationStatus":"confirmed"}',
      }),
      isBlockhashValid: vi.fn(),
    };

    await new BroadcastProcessor(repository, rpc).process(
      task,
      1_735_600_000_000
    );

    expect(rpc.simulate).not.toHaveBeenCalled();
    expect(rpc.send).not.toHaveBeenCalled();
    expect(repository.markConfirmed).toHaveBeenCalledWith(
      task.txSignature,
      task.ixIndex,
      1_735_600_000_000,
      '{"confirmationStatus":"confirmed"}'
    );
  });
});

function repositoryMock(status = "queued") {
  return {
    getStatus: vi.fn().mockResolvedValue(status),
    markSubmitted: vi.fn().mockResolvedValue(undefined),
    markConfirmed: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
}
