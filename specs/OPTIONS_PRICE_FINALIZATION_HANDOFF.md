# Options Price Finalization Handoff

## Approved design

- Every market uses `OracleConfig::PythTwap { feed_id }` and the `PythTwap` market-identity seed.
- `PythTwap` is permissionless. It consumes a pre-posted Pyth Receiver `TwapUpdate` from the hardcoded receiver program `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`.
- Series expiry is whole-second aligned. The accepted TWAP window is exactly `[expiry - 60s, expiry]` with `down_slots_ratio <= 500_000`.
- Both paths require `now >= expiry`, an open series, matching market and expiry for every batch member, and an unpaused market.
- Raw Pyth price is positive and normalized to 1e6 with checked round-half-up arithmetic. The result is the immutable `Series.expiry_price`.
- `PythUnverified` is always deployed as the market-operator fallback. It accepts unchecked `id`, `price`, `conf`, `expo`, and `publish_time`; it does not inspect payload bytes, validate the id or timestamp, or use a payload hash.
- One source event is emitted per batch: `PythTwapPrice` or `PythUnverifiedPrice`. `ExpiryPriceFinalized` remains one event per series and records the market config, normalized price, and actual method.
- There is no protocol reward. The caller pays Pyth/Wormhole posting, transaction, and temporary-account costs. Any signer may reuse a valid TWAP account; its write authority only controls account closure and rent recovery.

## Implementation sequence

1. Prove the dependency boundary first.
   - Add a compatible `pyth-solana-receiver-sdk` version to `anchor/programs/options/Cargo.toml` and confirm it resolves with Anchor 1.1.2.
   - Add a small fixture or integration spike that deserializes `TwapUpdate` owned by the hardcoded receiver. Do not make Options CPI into Pyth or Wormhole.
   - Preserve the current unrelated working-tree changes.

2. Change market and series rules.
   - In `src/state.rs`, replace `PythUnverified` market configuration and seed helpers with `PythTwap`; add a `FinalizationMethod` enum for events.
   - Update `create_market.rs`, its tests, and PDA fixtures to use `PythTwap`.
   - In `options_rules.rs` and `create_series.rs`, reject expiry values not divisible by 1,000.

3. Add shared price math and events.
   - In `math.rs`, add `normalize_pyth_price_to_strike_scale(price: i64, expo: i32) -> Result<u64>`.
   - Use `u128` intermediates, reject zero/negative input and unrepresentable powers or outputs, and use round-half-up when reducing precision.
   - In `events.rs`, add `PythTwapPrice`, `PythUnverifiedPrice`, `ExpiryPriceFinalized`, and the finalization-method type. Keep raw source fields in only the batch event.

4. Implement the shared state transition and the two adapters.
   - Add a private helper that validates the market, series state, current time, and fixed batch shape; stores the normalized price; changes state; and emits per-series events.
   - Add `finalize_pyth_twap.rs`. Its account context reads `Account<TwapUpdate>` and checks receiver ownership, feed id, exact start/end timestamps, coverage, and the shared rules. It has no operator constraint and no relationship to `TwapUpdate.write_authority`.
   - Add `finalize_pyth_unverified.rs`. Its context requires `market.operator` to sign, accepts the five approved arguments, performs no id or timestamp check, normalizes the positive price, and uses the shared transition.
   - Expose one, two, four, and eight-series entrypoints for each adapter in `lib.rs` and `instructions/mod.rs`. Keep fixed account layouts rather than accepting arbitrary remaining accounts.

5. Add tests before release.
   - Unit-test normalization: exact scaling, below/above/tie half values, zero/negative prices, large positive/negative exponents, and overflow.
   - Extend series tests for whole-second expiry rejection.
   - Add LiteSVM tests for each arity and rejection condition: paused market, pre-expiry finalization, finalized series, mixed market/expiry, wrong feed, wrong TWAP window, insufficient coverage, invalid receiver owner, and no signer relationship to the TWAP write authority.
   - Test unverified authorization, accepted mismatched id and arbitrary publish time, raw event fields, and immutability after either method succeeds.
   - Add a separate Pyth/Wormhole integration test on Surfpool or a local Pyth fixture for the full external VAA-to-`TwapUpdate` path. LiteSVM validation fixtures do not prove Pyth/Wormhole verification.

## Client and operations handoff

1. The relayer queries Pyth historical data for the exact expiry window, performs Pyth/Wormhole full verification, posts the `TwapUpdate`, and submits the matching Options finalization instruction.
2. The relayer may close its temporary Pyth accounts after Options consumes the update and reclaim its rent.
3. If primary finalization is unavailable, the market operator may submit the unverified fallback after expiry. This is an explicit trust fallback, not Pyth verification.
4. Indexers should join the single batch source event with its per-series `ExpiryPriceFinalized` events by transaction and market/expiry context.

## Release gates

- `NO_DNA=1 cargo test -p options` from `anchor/` for pure and LiteSVM tests.
- `NO_DNA=1 anchor build` and `NO_DNA=1 anchor test` from `anchor/` when the local Pyth fixture is available.
- Run the repository's `corepack pnpm test` and `corepack pnpm check` if those root commands cover this package.
- Before deploying, confirm the Pyth Receiver program ID and SDK compatibility for the target cluster; changing the hardcoded receiver requires a reviewed program upgrade.
