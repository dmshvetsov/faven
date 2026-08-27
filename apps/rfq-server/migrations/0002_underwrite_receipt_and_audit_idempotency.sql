ALTER TABLE underwrites ADD COLUMN confirmed_receipt TEXT;

CREATE UNIQUE INDEX underwrite_audit_transition_idx
  ON underwrite_audit (tx_signature, ix_index, status);
