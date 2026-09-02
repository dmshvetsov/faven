import { describe, expect, it, vi } from "vitest";

import { BroadcastProcessor, type BroadcastTask } from "../src/broadcast";

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

  it("persists the confirmed Solana receipt before completing", async () => {
    const repository = repositoryMock();
    const processor = new BroadcastProcessor(repository, {
      simulate: vi.fn().mockResolvedValue({ error: null }),
      send: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue({
        error: null,
        receipt: '{"confirmationStatus":"confirmed","slot":123}',
      }),
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

  it("records a transient submission failure without retrying the signed transaction", async () => {
    const rpc = {
      simulate: vi.fn().mockResolvedValue({ error: null }),
      send: vi.fn().mockRejectedValue(new Error("network timeout")),
      confirm: vi.fn(),
    };
    const repository = repositoryMock();
    const processor = new BroadcastProcessor(repository, rpc);

    await processor.process(task, 1_735_600_000_000);

    expect(repository.markFailed).toHaveBeenCalledWith(
      task.txSignature,
      task.ixIndex,
      1_735_600_000_000,
      "network timeout"
    );
  });

  it("records a confirmation transport error without retrying", async () => {
    const repository = repositoryMock();
    const processor = new BroadcastProcessor(repository, {
      simulate: vi.fn().mockResolvedValue({ error: null }),
      send: vi.fn().mockResolvedValue(undefined),
      confirm: vi
        .fn()
        .mockRejectedValue(new Error("network confirmation pending")),
    });

    await processor.process(task, 1_735_600_000_000);

    expect(repository.markFailed).toHaveBeenCalledWith(
      task.txSignature,
      task.ixIndex,
      1_735_600_000_000,
      "network confirmation pending"
    );
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
