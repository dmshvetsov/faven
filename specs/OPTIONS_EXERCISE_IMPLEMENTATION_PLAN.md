# ITM Long Exercise Implementation Handoff

## Goal

Implement manual physical exercise for in-the-money (ITM) Long tokens in the Anchor `options` program, plus unit and integration tests.

The updated specification defines `exercise(quantity)`: it burns exactly `quantity` Long tokens from the supplied holder-owned SPL token account.

## Scope

Included:

- Anchor `exercise` instruction and account validation.
- Call and put physical-settlement transfers.
- Exercise math, errors, event, and accounting updates.
- Rust unit and LiteSVM integration tests.

Excluded:

- Seller settlement, Series closure, and operator recovery.
- Client/SDK, IDL/Codama generation, UI, and indexer work.
- Closing the holder's Long token account after burning; its lifecycle remains holder-controlled.

## Required account model

`exercise(ctx, quantity: u64)` uses:

- `holder`: mutable signer and payer of a missing receipt ATA.
- `market`, `series`, BaseCoin mint, QuoteCoin mint, and deterministic Long mint.
- `holder_long_source`: mutable arbitrary SPL account owned by `holder`, minting the supplied Long.
- `holder_payment_source`: mutable arbitrary SPL account owned by `holder`:
  - QuoteCoin for a call.
  - BaseCoin for a put.
- `holder_receipt_ata`: holder's canonical ATA, `init_if_needed` and paid by `holder`:
  - BaseCoin for a call.
  - QuoteCoin for a put.
- Existing Series PDA BaseCoin and QuoteCoin vault ATAs.
- SPL Token, Associated Token, and System programs.

The Series PDA vaults already exist because `create_series` creates both. Exercise must not create them. Sellers are not accounts in this instruction: holder payments enter the Series vaults and seller proceeds are handled later by seller settlement.

## Instruction behavior

1. Reject a paused market.
2. Require `series.state == ExpirationPriceFinalized`, a stored expiry price, and current time in `[expiry_ms, exercise_window_end_ms)`.
3. Require strict ITM moneyness:
   - call: `expiry_price > strike_price`;
   - put: `expiry_price < strike_price`.
4. Require `quantity > 0`, `quantity <= holder_long_source.amount`, and checked addition of `quantity` without exceeding `series.total_contracts_quantity`.
5. Validate all mints, holder ownership, Series/Market relation, deterministic PDAs, and Series vault ATA ownership/mints.
6. Calculate settlement amounts with checked `u128` intermediate arithmetic:
   - call input: `ceil(quantity * strike * quote_scale / (base_scale * 1_000_000))` QuoteCoin; output: `quantity` BaseCoin;
   - put input: `quantity` BaseCoin; output: `floor(quantity * strike * quote_scale / (base_scale * 1_000_000))` QuoteCoin.
7. Ensure the holder payment account and the relevant Series collateral vault contain sufficient amounts before transfers.
8. Burn exactly `quantity` from `holder_long_source` using the holder signature.
9. Transfer exercise payment from holder to the matching Series vault, then transfer physical output from the Series vault to `holder_receipt_ata` with the Series PDA signer seeds.
10. Increment `series.total_manual_exercised_quantity` by `quantity` using checked arithmetic and emit `Exercised`.

All logical validation and arithmetic must occur before token CPIs. Transaction atomicity rolls back any CPI if a later condition fails.

## Source changes

| File | Change |
| --- | --- |
| `anchor/programs/options/src/lib.rs` | Export `Exercise` and add public `exercise(ctx, quantity)` entrypoint. |
| `anchor/programs/options/src/instructions/exercise.rs` | New instruction handler, account context, CPIs, and Series PDA signing. |
| `anchor/programs/options/src/instructions/mod.rs` | Register and re-export the exercise module. |
| `anchor/programs/options/src/math.rs` | Add reusable checked call-payment (ceil) and put-payout (floor) helpers; unit-test rounding and overflow. |
| `anchor/programs/options/src/errors.rs` | Add clear errors for invalid exercise phase, non-ITM series, excess Long quantity, and insufficient Series collateral as needed. |
| `anchor/programs/options/src/events.rs` | Add `Exercised { series, holder, option_type, quantity, input_asset_amount, output_asset_amount }`. |
| `anchor/programs/options/tests/exercise.rs` | New real-flow LiteSVM integration coverage. |

## Test plan

Unit tests:

- Call payment rounds up.
- Put payout rounds down and cannot exceed matching put collateral.
- Arithmetic overflow is rejected.

Integration tests:

- ITM call: burn a partial Long quantity; QuoteCoin enters Series vault; BaseCoin reaches a newly created holder ATA; Series exercise total changes only by that quantity.
- ITM put: burn a partial Long quantity; BaseCoin enters Series vault; QuoteCoin reaches holder ATA; floor rounding is correct.
- Arbitrary non-ATA holder Long and payment sources work.
- Remaining Long balance proves partial exercise did not burn the whole source account; the source account is not closed.
- Reject zero or over-balance quantities, wrong Long mint, wrong holder owner, wrong payment mint, and invalid Series vault.
- Reject Open, ATM, OTM, pre-expiry, at/after exercise-window-end, and paused-market exercise attempts.
- Reject insufficient holder payment and insufficient Series collateral without changing balances or Series totals.
- Reject exercise quantities that would overflow or exceed total issued contracts.
- Verify emitted `Exercised` fields for both calls and puts.

## Verification

Run the existing Rust tests for the options program using the project-required `corepack pnpm` workflow where applicable, plus the program's Cargo/LiteSVM test command already used by this package. Do not modify unrelated existing worktree changes.

