import { describe, expect, it, vi } from "vitest";

import {
  BroadcastProcessor,
  PendingConfirmationError,
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
    const simulationResult = {
      value: { err: "insufficient funds", logs: ["full simulation log"] },
    };
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const processor = new BroadcastProcessor(repository, {
      simulate: vi.fn().mockResolvedValue({
        error: "insufficient funds",
        result: simulationResult,
      }),
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
    expect(logError).toHaveBeenCalledWith("Underwrite broadcast failed.", {
      stage: "simulation",
      txSignature: task.txSignature,
      ixIndex: task.ixIndex,
      simulationResult,
    });
    logError.mockRestore();
  });

  it("persists the confirmed Solana receipt before completing", async () => {
    const repository = repositoryMock();
    const processor = new BroadcastProcessor(repository, {
      simulate: vi.fn().mockResolvedValue({ error: null, result: {} }),
      send: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue({
        status: "confirmed",
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
      simulate: vi.fn().mockResolvedValue({ error: null, result: {} }),
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
      simulate: vi.fn().mockResolvedValue({ error: null, result: {} }),
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

  it("logs an on-chain confirmation failure with its receipt", async () => {
    const repository = repositoryMock();
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const processor = new BroadcastProcessor(repository, {
      simulate: vi.fn().mockResolvedValue({ error: null, result: {} }),
      send: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue({
        status: "failed",
        error: '{"InstructionError":[0,{"Custom":1}]}',
        receipt: '{"slot":123,"err":{"InstructionError":[0,{"Custom":1}]}}',
      }),
    });

    await processor.process(task, 1_735_600_000_000);

    expect(logError).toHaveBeenCalledWith("Underwrite broadcast failed.", {
      stage: "confirmation",
      txSignature: task.txSignature,
      ixIndex: task.ixIndex,
      error: '{"InstructionError":[0,{"Custom":1}]}',
      receipt: '{"slot":123,"err":{"InstructionError":[0,{"Custom":1}]}}',
    });
    logError.mockRestore();
  });

  it("retries a pending confirmation without recording a terminal failure", async () => {
    const repository = repositoryMock("submitted");
    const rpc = {
      simulate: vi.fn(),
      send: vi.fn(),
      confirm: vi.fn().mockResolvedValue({ status: "pending" }),
    };

    await expect(
      new BroadcastProcessor(repository, rpc).process(task, 1_735_600_000_000)
    ).rejects.toBeInstanceOf(PendingConfirmationError);

    expect(rpc.simulate).not.toHaveBeenCalled();
    expect(rpc.send).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("only polls for confirmation when an earlier queue attempt submitted the transaction", async () => {
    const repository = repositoryMock("submitted");
    const rpc = {
      simulate: vi.fn(),
      send: vi.fn(),
      confirm: vi.fn().mockResolvedValue({
        status: "confirmed",
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
