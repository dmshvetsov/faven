ALTER TABLE underwrites ADD COLUMN oracle_asset TEXT;
ALTER TABLE underwrites ADD COLUMN base_asset TEXT;
ALTER TABLE underwrites ADD COLUMN quote_asset TEXT;
UPDATE underwrites
SET
  oracle_asset = substr(ticker, 1, instr(ticker, '-') - 1),
  quote_asset = substr(
    substr(ticker, instr(ticker, '-') + 1),
    1,
    instr(substr(ticker, instr(ticker, '-') + 1), '-') - 1
  ),
  base_asset = substr(
    substr(
      ticker,
      instr(ticker, '-') + instr(substr(ticker, instr(ticker, '-') + 1), '-') + 1
    ),
    1,
    instr(
      substr(
        ticker,
        instr(ticker, '-') + instr(substr(ticker, instr(ticker, '-') + 1), '-') + 1
      ),
      '-'
    ) - 1
  );
ALTER TABLE underwrites DROP COLUMN ticker;

ALTER TABLE option_series ADD COLUMN oracle_asset TEXT;
ALTER TABLE option_series ADD COLUMN base_asset TEXT;
ALTER TABLE option_series ADD COLUMN quote_asset TEXT;
ALTER TABLE option_series ADD COLUMN expiry_price TEXT;
ALTER TABLE option_series ADD COLUMN finalized_at_ms INTEGER;
ALTER TABLE option_series ADD COLUMN finalized_slot INTEGER;
ALTER TABLE option_series ADD COLUMN finalization_signature TEXT;
ALTER TABLE option_series ADD COLUMN finalization_method TEXT;
UPDATE option_series
SET
  oracle_asset = substr(ticker, 1, instr(ticker, '-') - 1),
  quote_asset = substr(
    substr(ticker, instr(ticker, '-') + 1),
    1,
    instr(substr(ticker, instr(ticker, '-') + 1), '-') - 1
  ),
  base_asset = substr(
    substr(
      ticker,
      instr(ticker, '-') + instr(substr(ticker, instr(ticker, '-') + 1), '-') + 1
    ),
    1,
    instr(
      substr(
        ticker,
        instr(ticker, '-') + instr(substr(ticker, instr(ticker, '-') + 1), '-') + 1
      ),
      '-'
    ) - 1
  );
ALTER TABLE option_series DROP COLUMN ticker;
