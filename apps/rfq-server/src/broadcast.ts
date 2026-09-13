import { isBuyerFaultUnderwriteFailure } from "./underwrite-fill";

export interface BroadcastTask {
  readonly txSignature: string;
  readonly ixIndex: number;
  /** Present for fill notifications; absent on queue messages created before this feature. */
  readonly rfqId?: string;
  readonly signedTransaction: string;
}

export interface BroadcastRepository {
  getStatus(
    txSignature: string,
    ixIndex: number
  ): Promise<"queued" | "submitted" | "confirmed" | "failed" | null>;
  markSubmitted(
    txSignature: string,
    ixIndex: number,
    atMs: number
  ): Promise<void>;
  markConfirmed(
    txSignature: string,
    ixIndex: number,
    atMs: number,
    confirmedReceipt: string
  ): Promise<void>;
  markFailed(
    txSignature: string,
    ixIndex: number,
    atMs: number,
    error: string
  ): Promise<void>;
}

export interface SolanaBroadcastRpc {
  simulate(transaction: string): Promise<SimulationResult>;
  send(transaction: string): Promise<void>;
  confirm(signature: string): Promise<SolanaConfirmation>;
}

export interface SimulationResult {
  readonly error: string | null;
  /** Full `simulateTransaction` RPC response for diagnostics. */
  readonly result: unknown;
}

export type SolanaConfirmation =
  | { readonly status: "pending" }
  | { readonly status: "confirmed"; readonly receipt: string }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly receipt: string;
    };

export class PendingConfirmationError extends Error {}

export type BroadcastResult =
  | { readonly status: "confirmed" }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly buyerFault: boolean;
    }
  | null;

export class BroadcastProcessor {
  constructor(
    private readonly repository: BroadcastRepository,
    private readonly rpc: SolanaBroadcastRpc
  ) {}

  async process(task: BroadcastTask, nowMs: number): Promise<BroadcastResult> {
    const status = await this.repository.getStatus(
      task.txSignature,
      task.ixIndex
    );
    if (status === null || status === "confirmed" || status === "failed")
      return null;
    if (status === "submitted") {
      return this.confirm(task, nowMs);
    }
    let simulation: SimulationResult;
    try {
      simulation = await this.rpc.simulate(task.signedTransaction);
    } catch (error) {
      const message = errorMessage(error);
      logBroadcastFailure("simulation-rpc", task, { error: message });
      await this.repository.markFailed(
        task.txSignature,
        task.ixIndex,
        nowMs,
        message
      );
      return failedResult(message);
    }
    if (simulation.error !== null) {
      logBroadcastFailure("simulation", task, {
        simulationResult: simulation.result,
      });
      await this.repository.markFailed(
        task.txSignature,
        task.ixIndex,
        nowMs,
        simulation.error
      );
      return failedResult(
        simulation.error,
        isBuyerFaultUnderwriteFailure(simulation.error, simulation.result)
      );
    }
    try {
      await this.rpc.send(task.signedTransaction);
    } catch (error) {
      const message = errorMessage(error);
      logBroadcastFailure("submission", task, { error: message });
      await this.repository.markFailed(
        task.txSignature,
        task.ixIndex,
        nowMs,
        message
      );
      return failedResult(message);
    }
    await this.repository.markSubmitted(task.txSignature, task.ixIndex, nowMs);
    return this.confirm(task, nowMs);
  }

  private async confirm(
    task: BroadcastTask,
    nowMs: number
  ): Promise<BroadcastResult> {
    let confirmation: SolanaConfirmation;
    try {
      confirmation = await this.rpc.confirm(task.txSignature);
    } catch (error) {
      const message = errorMessage(error);
      logBroadcastFailure("confirmation-rpc", task, { error: message });
      await this.repository.markFailed(
        task.txSignature,
        task.ixIndex,
        nowMs,
        message
      );
      return failedResult(message);
    }
    if (confirmation.status === "pending") {
      throw new PendingConfirmationError("Solana confirmation is pending.");
    }
    if (confirmation.status === "failed") {
      logBroadcastFailure("confirmation", task, {
        error: confirmation.error,
        receipt: confirmation.receipt,
      });
      await this.repository.markFailed(
        task.txSignature,
        task.ixIndex,
        nowMs,
        confirmation.error
      );
      return failedResult(confirmation.error);
    }
    await this.repository.markConfirmed(
      task.txSignature,
      task.ixIndex,
      nowMs,
      confirmation.receipt
    );
    return { status: "confirmed" };
  }
}

function failedResult(error: string, buyerFault = false): BroadcastResult {
  return { status: "failed", error, buyerFault };
}

function logBroadcastFailure(
  stage:
    | "simulation-rpc"
    | "simulation"
    | "submission"
    | "confirmation-rpc"
    | "confirmation",
  task: BroadcastTask,
  details: Record<string, unknown>
): void {
  console.error("Underwrite broadcast failed.", {
    stage,
    txSignature: task.txSignature,
    ixIndex: task.ixIndex,
    ...details,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Solana RPC failed.";
}
