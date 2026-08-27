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
};

describe("broadcast queue processing", () => {
  it("records a simulation error as a terminal failed underwrite", async () => {
    const repository = repositoryMock();
    const processor = new BroadcastProcessor(repository, {
      simulate: vi.fn().mockResolvedValue({ error: "insufficient funds" }),
      send: vi.fn(),
      confirm: vi.fn(),
    });

    await processor.process(task, 1_735_600_000_000);

    expect(repository.markFailed).toHaveBeenCalledWith(
      task.txSignature,
      0,
      1_735_600_000_000,
      "insufficient funds"
    );
  });

  it("persists submission and confirmed receipt before completing", async () => {
    const repository = repositoryMock();
    const processor = new BroadcastProcessor(repository, {
      simulate: vi.fn().mockResolvedValue({ error: null }),
      send: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue({ error: null }),
    });

    await processor.process(task, 1_735_600_000_000);

    expect(repository.markSubmitted).toHaveBeenCalledBefore(
      repository.markConfirmed
    );
    expect(repository.markConfirmed).toHaveBeenCalledWith(
      task.txSignature,
      0,
      1_735_600_000_000
    );
  });

  it("asks the queue to retry a transient submission failure", async () => {
    const processor = new BroadcastProcessor(repositoryMock(), {
      simulate: vi.fn().mockResolvedValue({ error: null }),
      send: vi.fn().mockRejectedValue(new Error("network timeout")),
      confirm: vi.fn(),
    });

    await expect(
      processor.process(task, 1_735_600_000_000)
    ).rejects.toBeInstanceOf(RetryableBroadcastError);
  });

  it("asks the queue to retry while confirmation is still pending", async () => {
    const processor = new BroadcastProcessor(repositoryMock(), {
      simulate: vi.fn().mockResolvedValue({ error: null }),
      send: vi.fn().mockResolvedValue(undefined),
      confirm: vi
        .fn()
        .mockRejectedValue(new Error("network confirmation pending")),
    });

    await expect(
      processor.process(task, 1_735_600_000_000)
    ).rejects.toBeInstanceOf(RetryableBroadcastError);
  });
});

function repositoryMock() {
  return {
    markSubmitted: vi.fn().mockResolvedValue(undefined),
    markConfirmed: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
}
