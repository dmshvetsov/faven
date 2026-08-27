const underwriteSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS underwrites (
    signed_transaction_hash TEXT NOT NULL,
    instruction_index INTEGER NOT NULL,
    rfq_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'submitted', 'confirmed', 'failed')),
    seller_address TEXT NOT NULL,
    buyer_address TEXT NOT NULL,
    market_address TEXT NOT NULL,
    series_address TEXT NOT NULL,
    ticker TEXT NOT NULL,
    is_put INTEGER NOT NULL CHECK (is_put IN (0, 1)),
    expiry_ms INTEGER NOT NULL,
    strike TEXT NOT NULL,
    quantity TEXT NOT NULL,
    premium TEXT NOT NULL,
    base_coin_mint TEXT NOT NULL,
    quote_coin_mint TEXT NOT NULL,
    fee_recipient TEXT NOT NULL,
    operational_fee_bps INTEGER NOT NULL,
    transaction_signature TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    submitted_at_ms INTEGER,
    confirmed_at_ms INTEGER,
    last_error TEXT,
    PRIMARY KEY (signed_transaction_hash, instruction_index)
  )`,

  `CREATE INDEX IF NOT EXISTS underwrites_seller_status_expiry_idx
    ON underwrites (seller_address, status, expiry_ms)`,
  'CREATE INDEX IF NOT EXISTS underwrites_transaction_hash_idx ON underwrites (signed_transaction_hash)',

  `CREATE TABLE IF NOT EXISTS underwrite_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signed_transaction_hash TEXT NOT NULL,
    instruction_index INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'submitted', 'confirmed', 'failed'))
  )`,

  `CREATE TABLE IF NOT EXISTS option_series (
    series_address TEXT PRIMARY KEY,
    market_address TEXT NOT NULL,
    ticker TEXT NOT NULL,
    is_put INTEGER NOT NULL CHECK (is_put IN (0, 1)),
    expiry_ms INTEGER NOT NULL,
    strike TEXT NOT NULL,
    base_coin_mint TEXT NOT NULL,
    quote_coin_mint TEXT NOT NULL,
    confirmed_at_ms INTEGER NOT NULL
  )`,
] as const;

export function createUnderwriteTables(database: D1Database): Promise<void> {
  return database
    .batch(underwriteSchemaStatements.map((statement) => database.prepare(statement)))
    .then(() => undefined);
}
