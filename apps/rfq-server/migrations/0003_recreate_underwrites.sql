DROP TABLE underwrites;

CREATE TABLE underwrites (
  tx_signature TEXT NOT NULL,
  ix_index INTEGER NOT NULL,
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
  created_at_ms INTEGER NOT NULL,
  submitted_at_ms INTEGER,
  confirmed_at_ms INTEGER,
  confirmed_receipt TEXT,
  last_error TEXT,
  PRIMARY KEY (tx_signature, ix_index)
);

CREATE INDEX underwrites_seller_status_expiry_idx
  ON underwrites (seller_address, status, expiry_ms);
