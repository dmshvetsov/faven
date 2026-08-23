# Option Settlement Implementation Plan

## Goal

Implement permissionless seller settlement and Series closure for physically settled options. This plan covers `settle_sellers_batch` through `close_series`; it does not change market creation, underwriting, or oracle logic beyond the accounting hooks described below.

## Final Decisions

- settle_sellers_batch is permissionless.
- A seller may settle any SellerVault, including their own. `settler` is an explicit signer identity.
- `settle_sellers_batch` has no protocol seller-count cap. Clients and indexers choose a batch size (how many sellers to settle in a single transaction) that fits their account and compute budget.
- Seller settlement is allowed immediately for ATM/OTM Series and only after `exercise_window_end_ms` for ITM Series, including fully exercised Series.
- Seller payout ATAs are canonical ATAs. Create them only when their payout is non-zero, funded by `settler`.
- after close of SellerVault rent rebates go to `settler`.
- `close_series` uses an explicit `series_closer` signer. It is permissionless after a Series is Closed, but is disabled while the Market is paused.
- Remaining BaseCoin and QuoteCoin dust goes to `series_closer` ATA. Rent rebates from closing the Series and its collateral vault accounts go to the Market operator ATA.

## Series Accounting

add to Series

```rust
total_quote_amount: u64
```

`total_quote_amount` is the snapshot of QuoteCoin after option expiration.

1. `create_series` initializes it to zero.
2. Price finalization snapshots `quote_collateral_vault.amount` into it for every finalized Series. Finalization must therefore receive each Series QuoteCoin vault.
3. During a call exercise, add the actual holder QuoteCoin input amount.
4. During a put exercise, subtract the actual holder QuoteCoin output amount.
5. Seller settlement and Series closure never modify it.

Once the exercise window ends, `total_quote_amount` is the exact QuoteCoin amount available to seller settlement, including all exercise and underwriting rounding effects.

No BaseCoin snapshot field is required:

- call BaseCoin pool: `total_contracts_quantity - total_manual_exercised_quantity`;
- put BaseCoin pool: `total_manual_exercised_quantity`.

All calculations use checked `u128` intermediates and convert back to `u64` only after range checks.

## Seller Settlement

Create `instructions/settle_sellers_batch.rs` and expose `settle_sellers_batch` from the program entrypoint.

### Accounts

Fixed accounts are `settler`, Market, Series, BaseCoin and QuoteCoin mints, BaseCoin and QuoteCoin Series collateral vaults, SPL Token, Associated Token program, and System Program.

Seller entries are parsed from remaining accounts. Each entry supplies:

1. writable SellerVault;
2. a canonical BaseCoin ATA when its calculated BaseCoin payout is non-zero;
3. a canonical QuoteCoin ATA when its calculated QuoteCoin payout is non-zero;
4. the seller wallet account only when an included payout ATA must be created.

Validate every supplied ATA against the SellerVault owner and expected mint. Reject malformed entries, trailing accounts, duplicate SellerVaults, closed/uninitialized vaults, wrong Series/PDA relations, and an empty batch.

### Preconditions

- Market is unpaused.
- Series is `ExpirationPriceFinalized` and settle-ready.
- Every SellerVault belongs to the Series.
- Adding each short quantity cannot exceed `total_contracts_quantity`.
- The Series token vault balances cover every calculated transfer.

### Payout rules

For a SellerVault with short quantity `s`, total issued quantity `q`, and total manual exercise `e`:

```text
seller_exercised_quantity = floor(e * s / q)
```

Do not redistribute the residual from this floor operation.

- ATM/OTM, and ITM where `e == 0`: pay the exact `SellerVault.collateral_quantity` in its collateral asset.
- Partially exercised ITM (`0 < e < q`): pay floor-pro-rata shares of the base coin and quote coin pools:
  - `base_paid = floor(base_pool * s / q)`;
  - `quote_paid = floor(total_quote_amount * s / q)`.
- Fully exercised ITM call: pay its floor-pro-rata QuoteCoin share; BaseCoin paid is zero.
- Fully exercised ITM put: pay BaseCoin equal to `s`; QuoteCoin paid is zero. Any QuoteCoin rounding dust remains in the Series vault.

Transfer proceeds to the seller address recorded in SellerVault, close the seller vault with rent rebate goes to `settler`, increment `total_settled_quantity` exactly once, and emit `SellerPayoutSettled`. Emit `SeriesSettlementBatchCompleted` only for batches with more than one seller. Set `Series.state = Closed` when total settled quantity equals total issued quantity.

## Series Closure

Create `instructions/close_series.rs` and expose `close_series`.

Require:

- `series_closer: Signer`;
- Market is unpaused;
- Series is Closed and `total_settled_quantity == total_contracts_quantity`;
- current time is at or after `exercise_window_end_ms`.

For each non-zero collateral vault balance (dust), create `series_closer`'s canonical ATA if missing, then transfer the whole remaining balance to those ATAs. Close the Series BaseCoin and QuoteCoin vaults and the Series account, directing their rent rebates to the Market operator. Long mint and Long-holder token accounts remain open.

## Related Instruction Changes

- `create_series`: initialize `total_quote_amount` and update account space.
- Both finalization instructions: accept and validate the QuoteCoin vault for every Series; snapshot its balance when finalizing.
- `exercise`: update `total_quote_amount` with the exact already-calculated input/output amount.
- `state.rs`, `events.rs`, `errors.rs`, `instructions/mod.rs`, and `lib.rs`: add the new state, instructions, events, errors, and exports.

## Required Tests

- ATM/OTM call and put exact-collateral settlement.
- ITM call and put: zero, partial, and full manual exercise.
- Multiple differently sized exercises proving `total_quote_amount` preserves rounding.
- Multiple settlement batches with unchanged pro-rata payout pools.
- Seller self-settlement, third-party settlement, conditional ATA creation, and rent routing.
- Empty, duplicate, wrong-Series, malformed, already-closed, and over-settling SellerVault inputs.
- Pause rejection for settlement and closure.
- Closure dust to `series_closer`, Series/vault rent to Market operator, and attempted premature closure.
- Checked-arithmetic and insufficient-vault-balance failures.

## Specification Updates Needed

- Add `total_quote_amount` to the permitted Series fields and define its lifecycle above.
- Replace obsolete seller-payout-counter and operator-recovery text.
- Define actual settlement pools, all payout branches, explicit `settler` and `series_closer` identities, no seller-count cap, and closure/rent/dust routing.
- Replace `OperatorRecovered` with a closure event whose recipient is `series_closer` and whose rent recipient is the Market operator.
