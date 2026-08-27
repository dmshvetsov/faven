export interface BroadcastTask {
  readonly txSignature: string;
  readonly ixIndex: number;
  readonly signedTransaction: string;
}

export interface BroadcastRepository {
  markSubmitted(
    txSignature: string,
    ixIndex: number,
    atMs: number
  ): Promise<void>;
  markConfirmed(
    txSignature: string,
    ixIndex: number,
    atMs: number
  ): Promise<void>;
  markFailed(
    txSignature: string,
    ixIndex: number,
    atMs: number,
    error: string
  ): Promise<void>;
}

export interface SolanaBroadcastRpc {
  simulate(transaction: string): Promise<{ readonly error: string | null }>;
  send(transaction: string): Promise<void>;
  confirm(signature: string): Promise<{ readonly error: string | null }>;
}

export class RetryableBroadcastError extends Error {}

export class BroadcastProcessor {
  constructor(
    private readonly repository: BroadcastRepository,
    private readonly rpc: SolanaBroadcastRpc
  ) {}

  async process(task: BroadcastTask, nowMs: number): Promise<void> {
    let simulation: { readonly error: string | null };
    try {
      simulation = await this.rpc.simulate(task.signedTransaction);
    } catch (error) {
      const message = errorMessage(error);
      if (isTransient(message)) throw new RetryableBroadcastError(message);
      await this.repository.markFailed(
        task.txSignature,
        task.ixIndex,
        nowMs,
        message
      );
      return;
    }
    if (simulation.error !== null) {
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
      if (isTransient(message)) throw new RetryableBroadcastError(message);
      await this.repository.markFailed(
        task.txSignature,
        task.ixIndex,
        nowMs,
        message
      );
      return;
    }
    await this.repository.markSubmitted(task.txSignature, task.ixIndex, nowMs);
    let confirmation: { readonly error: string | null };
    try {
      confirmation = await this.rpc.confirm(task.txSignature);
    } catch (error) {
      const message = errorMessage(error);
      if (isTransient(message)) throw new RetryableBroadcastError(message);
      await this.repository.markFailed(
        task.txSignature,
        task.ixIndex,
        nowMs,
        message
      );
      return;
    }
    if (confirmation.error !== null) {
      await this.repository.markFailed(
        task.txSignature,
        task.ixIndex,
        nowMs,
        confirmation.error
      );
      return;
    }
    await this.repository.markConfirmed(task.txSignature, task.ixIndex, nowMs);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Solana RPC failed.";
}

function isTransient(message: string): boolean {
  return /network|timeout|temporar|429|50[0-9]/i.test(message);
}
