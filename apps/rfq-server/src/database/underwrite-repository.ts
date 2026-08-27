export type UnderwriteStatus = 'queued' | 'submitted' | 'confirmed' | 'failed';

export interface QueuedUnderwrite {
  readonly signedTransactionHash: string;
  readonly instructionIndex: number;
  readonly rfqId: string;
  readonly sellerAddress: string;
  readonly buyerAddress: string;
  readonly marketAddress: string;
  readonly seriesAddress: string;
  readonly ticker: string;
  readonly isPut: boolean;
  readonly expiryMs: number;
  readonly strike: string;
  readonly quantity: string;
  readonly premium: string;
  readonly baseCoinMint: string;
  readonly quoteCoinMint: string;
  readonly feeRecipient: string;
  readonly operationalFeeBps: number;
  readonly transactionSignature: string;
  readonly createdAtMs: number;
}

export interface StoredUnderwrite extends QueuedUnderwrite {
  readonly status: UnderwriteStatus;
  readonly submittedAtMs: number | null;
  readonly confirmedAtMs: number | null;
  readonly lastError: string | null;
}

interface UnderwriteRow {
  readonly signed_transaction_hash: string;
  readonly instruction_index: number;
  readonly rfq_id: string;
  readonly status: UnderwriteStatus;
  readonly seller_address: string;
  readonly buyer_address: string;
  readonly market_address: string;
  readonly series_address: string;
  readonly ticker: string;
  readonly is_put: number;
  readonly expiry_ms: number;
  readonly strike: string;
  readonly quantity: string;
  readonly premium: string;
  readonly base_coin_mint: string;
  readonly quote_coin_mint: string;
  readonly fee_recipient: string;
  readonly operational_fee_bps: number;
  readonly transaction_signature: string;
  readonly created_at_ms: number;
  readonly submitted_at_ms: number | null;
  readonly confirmed_at_ms: number | null;
  readonly last_error: string | null;
}

interface AuditRow {
  readonly created_at_ms: number;
  readonly status: UnderwriteStatus;
}

interface OptionSeriesRow {
  readonly series_address: string;
  readonly market_address: string;
  readonly ticker: string;
  readonly is_put: number;
  readonly expiry_ms: number;
  readonly strike: string;
  readonly base_coin_mint: string;
  readonly quote_coin_mint: string;
  readonly confirmed_at_ms: number;
}

export interface StoredOptionSeries {
  readonly seriesAddress: string;
  readonly marketAddress: string;
  readonly ticker: string;
  readonly isPut: boolean;
  readonly expiryMs: number;
  readonly strike: string;
  readonly baseCoinMint: string;
  readonly quoteCoinMint: string;
  readonly confirmedAtMs: number;
}

export class UnderwriteRepository {
  constructor(private readonly database: D1Database) {}

  async createQueued(underwrite: QueuedUnderwrite): Promise<{ created: boolean }> {
    const insert = this.database
      .prepare(
        `INSERT OR IGNORE INTO underwrites (
          signed_transaction_hash, instruction_index, rfq_id, status,
          seller_address, buyer_address, market_address, series_address, ticker,
          is_put, expiry_ms, strike, quantity, premium, base_coin_mint,
          quote_coin_mint, fee_recipient, operational_fee_bps, transaction_signature,
          created_at_ms
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        underwrite.signedTransactionHash,
        underwrite.instructionIndex,
        underwrite.rfqId,
        underwrite.sellerAddress,
        underwrite.buyerAddress,
        underwrite.marketAddress,
        underwrite.seriesAddress,
        underwrite.ticker,
        Number(underwrite.isPut),
        underwrite.expiryMs,
        underwrite.strike,
        underwrite.quantity,
        underwrite.premium,
        underwrite.baseCoinMint,
        underwrite.quoteCoinMint,
        underwrite.feeRecipient,
        underwrite.operationalFeeBps,
        underwrite.transactionSignature,
        underwrite.createdAtMs,
      );
    const audit = this.database
      .prepare(
        `INSERT INTO underwrite_audit (
          signed_transaction_hash, instruction_index, created_at_ms, status
        ) SELECT ?, ?, ?, 'queued' WHERE changes() = 1`,
      )
      .bind(
        underwrite.signedTransactionHash,
        underwrite.instructionIndex,
        underwrite.createdAtMs,
      );

    const [result] = await this.database.batch([insert, audit]);
    return { created: result.meta.changes === 1 };
  }

  async get(hash: string, instructionIndex: number): Promise<StoredUnderwrite | null> {
    const row = await this.database
      .prepare(
        'SELECT * FROM underwrites WHERE signed_transaction_hash = ? AND instruction_index = ?',
      )
      .bind(hash, instructionIndex)
      .first<UnderwriteRow>();
    return row === null ? null : toStoredUnderwrite(row);
  }

  async auditFor(
    hash: string,
    instructionIndex: number,
  ): Promise<readonly { readonly createdAtMs: number; readonly status: UnderwriteStatus }[]> {
    const result = await this.database
      .prepare(
        `SELECT created_at_ms, status FROM underwrite_audit
         WHERE signed_transaction_hash = ? AND instruction_index = ?
         ORDER BY id ASC`,
      )
      .bind(hash, instructionIndex)
      .all<AuditRow>();
    return result.results.map((row) => ({ createdAtMs: row.created_at_ms, status: row.status }));
  }

  async markSubmitted(hash: string, instructionIndex: number, submittedAtMs: number): Promise<void> {
    await this.transition({
      hash,
      instructionIndex,
      from: 'queued',
      to: 'submitted',
      atMs: submittedAtMs,
      update: 'submitted_at_ms = ?',
      value: submittedAtMs,
    });
  }

  async markConfirmed(hash: string, instructionIndex: number, confirmedAtMs: number): Promise<void> {
    const update = this.database
      .prepare(
        `UPDATE underwrites
         SET status = 'confirmed', confirmed_at_ms = ?
         WHERE signed_transaction_hash = ? AND instruction_index = ? AND status = 'submitted'`,
      )
      .bind(confirmedAtMs, hash, instructionIndex);
    const audit = this.database
      .prepare(
        `INSERT INTO underwrite_audit (
          signed_transaction_hash, instruction_index, created_at_ms, status
        ) SELECT ?, ?, ?, 'confirmed' WHERE changes() = 1`,
      )
      .bind(hash, instructionIndex, confirmedAtMs);
    const series = this.database
      .prepare(
        `INSERT OR IGNORE INTO option_series (
          series_address, market_address, ticker, is_put, expiry_ms, strike,
          base_coin_mint, quote_coin_mint, confirmed_at_ms
        ) SELECT series_address, market_address, ticker, is_put, expiry_ms, strike,
          base_coin_mint, quote_coin_mint, ?
          FROM underwrites
          WHERE signed_transaction_hash = ? AND instruction_index = ? AND status = 'confirmed'`,
      )
      .bind(confirmedAtMs, hash, instructionIndex);
    await this.database.batch([update, audit, series]);
  }

  async markFailed(
    hash: string,
    instructionIndex: number,
    failedAtMs: number,
    error: string,
  ): Promise<void> {
    await this.transition({
      hash,
      instructionIndex,
      from: 'queued',
      to: 'failed',
      atMs: failedAtMs,
      update: 'last_error = ?',
      value: error,
    });
  }

  async getSeries(seriesAddress: string): Promise<StoredOptionSeries | null> {
    const row = await this.database
      .prepare('SELECT * FROM option_series WHERE series_address = ?')
      .bind(seriesAddress)
      .first<OptionSeriesRow>();
    if (row === null) {
      return null;
    }
    return {
      seriesAddress: row.series_address,
      marketAddress: row.market_address,
      ticker: row.ticker,
      isPut: row.is_put === 1,
      expiryMs: row.expiry_ms,
      strike: row.strike,
      baseCoinMint: row.base_coin_mint,
      quoteCoinMint: row.quote_coin_mint,
      confirmedAtMs: row.confirmed_at_ms,
    };
  }

  private async transition({
    hash,
    instructionIndex,
    from,
    to,
    atMs,
    update,
    value,
  }: {
    readonly hash: string;
    readonly instructionIndex: number;
    readonly from: UnderwriteStatus;
    readonly to: UnderwriteStatus;
    readonly atMs: number;
    readonly update: string;
    readonly value: string | number;
  }): Promise<void> {
    const status = this.database
      .prepare(
        `UPDATE underwrites SET status = ?, ${update}
         WHERE signed_transaction_hash = ? AND instruction_index = ? AND status = ?`,
      )
      .bind(to, value, hash, instructionIndex, from);
    const audit = this.database
      .prepare(
        `INSERT INTO underwrite_audit (
          signed_transaction_hash, instruction_index, created_at_ms, status
        ) SELECT ?, ?, ?, ? WHERE changes() = 1`,
      )
      .bind(hash, instructionIndex, atMs, to);
    await this.database.batch([status, audit]);
  }
}

function toStoredUnderwrite(row: UnderwriteRow): StoredUnderwrite {
  return {
    signedTransactionHash: row.signed_transaction_hash,
    instructionIndex: row.instruction_index,
    rfqId: row.rfq_id,
    status: row.status,
    sellerAddress: row.seller_address,
    buyerAddress: row.buyer_address,
    marketAddress: row.market_address,
    seriesAddress: row.series_address,
    ticker: row.ticker,
    isPut: row.is_put === 1,
    expiryMs: row.expiry_ms,
    strike: row.strike,
    quantity: row.quantity,
    premium: row.premium,
    baseCoinMint: row.base_coin_mint,
    quoteCoinMint: row.quote_coin_mint,
    feeRecipient: row.fee_recipient,
    operationalFeeBps: row.operational_fee_bps,
    transactionSignature: row.transaction_signature,
    createdAtMs: row.created_at_ms,
    submittedAtMs: row.submitted_at_ms,
    confirmedAtMs: row.confirmed_at_ms,
    lastError: row.last_error,
  };
}
