CREATE TABLE wallet_fundings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at_ms INTEGER NOT NULL,
  transaction_signature TEXT,
  completed_at_ms INTEGER,
  failure_reason TEXT
);

CREATE UNIQUE INDEX wallet_fundings_one_pending_per_wallet_idx
  ON wallet_fundings (wallet_address)
  WHERE status = 'pending';

CREATE INDEX wallet_fundings_wallet_succeeded_idx
  ON wallet_fundings (wallet_address, status, completed_at_ms);
