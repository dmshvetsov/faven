export interface BroadcastTask {
  readonly txSignature: string;
  readonly ixIndex: number;
  readonly signedTransaction: string;
  readonly recentBlockhash: string;
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
  simulate(transaction: string): Promise<{ readonly error: string | null }>;
  send(transaction: string): Promise<void>;
  confirm(signature: string): Promise<{
    readonly error: string | null;
    readonly receipt: string;
  }>;
  isBlockhashValid(blockhash: string): Promise<boolean>;
}

export class RetryableBroadcastError extends Error {}

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
    let simulation: { readonly error: string | null };
    try {
      simulation = await this.rpc.simulate(task.signedTransaction);
    } catch (error) {
      const message = errorMessage(error);
      if (isTransient(message)) {
        await this.retryWhileBlockhashValid(task, nowMs, message);
        return;
      }
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
      if (isTransient(message)) {
        await this.retryWhileBlockhashValid(task, nowMs, message);
        return;
      }
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
    let confirmation: {
      readonly error: string | null;
      readonly receipt: string;
    };
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
    await this.repository.markConfirmed(
      task.txSignature,
      task.ixIndex,
      nowMs,
      confirmation.receipt
    );
  }

  private async retryWhileBlockhashValid(
    task: BroadcastTask,
    nowMs: number,
    retryError: string
  ): Promise<void> {
    let isValid: boolean;
    try {
      isValid = await this.rpc.isBlockhashValid(task.recentBlockhash);
    } catch (error) {
      await this.repository.markFailed(
        task.txSignature,
        task.ixIndex,
        nowMs,
        `Unable to verify signed transaction blockhash: ${errorMessage(error)}`
      );
      return;
    }
    if (!isValid) {
      await this.repository.markFailed(
        task.txSignature,
        task.ixIndex,
        nowMs,
        "Signed transaction blockhash has expired."
      );
      return;
    }
    throw new RetryableBroadcastError(retryError);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Solana RPC failed.";
}

function isTransient(message: string): boolean {
  return /network|timeout|temporar|429|50[0-9]/i.test(message);
}
