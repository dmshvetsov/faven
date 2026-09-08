export interface BroadcastTask {
  readonly txSignature: string;
  readonly ixIndex: number;
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

export class BroadcastProcessor {
  constructor(
    private readonly repository: BroadcastRepository,
    private readonly rpc: SolanaBroadcastRpc
  ) {}

  async process(task: BroadcastTask, nowMs: number): Promise<void> {
    const status = await this.repository.getStatus(
      task.txSignature,
      task.ixIndex
    );
    if (status === null || status === "confirmed" || status === "failed")
      return;
    if (status === "submitted") {
      await this.confirm(task, nowMs);
      return;
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
      return;
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
      return;
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
      return;
    }
    await this.repository.markSubmitted(task.txSignature, task.ixIndex, nowMs);
    await this.confirm(task, nowMs);
  }

  private async confirm(task: BroadcastTask, nowMs: number): Promise<void> {
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
      return;
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
      return;
    }
    await this.repository.markConfirmed(
      task.txSignature,
      task.ixIndex,
      nowMs,
      confirmation.receipt
    );
  }
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
