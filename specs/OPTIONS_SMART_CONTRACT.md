# Options Smart Contract Specification

## Scope

This document specifies MVP version of the on-chain smart contract design for European, physically settled options on Sui.

The contract design uses:
- transferable semi-fungible long option objects with quantity,
- non-transferable seller vault records,
- one internal `CollateralPool` per option series,
- oracle expiry price finalization,
- manual holder exercise within a fixed exercise window,
- PTB-composable flash-loan exercise,
- post-window net auto-settlement for unexercised ITM longs.

This document does not specify RFQ servers, market-maker APIs, web UI, indexing, or off-chain quote routing.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and `OPTIONAL` in this document are to be interpreted as described in RFC 2119.

## Core Terms and Product Language

This document uses `./DOMAIN-LANGUAGE.md` as way to describe option trading specific parts of the product used by business and technical members.

## Market Object Model

`Market` MUST be stored as a separate shared object.

Each market MUST support exactly one `OracleBase / QuoteCoin / BaseCoin` combination.

Market creation MUST reject a duplicate market with the same `OracleBase / QuoteCoin / BaseCoin` combination.

Examples:
- `SUI / USDC / SUI`
- `DEEP / USDC / DEEP`
- `BTC / USDC / WBTC`
- `BTC / USDC / HBTC`

Different wrapped versions of the same oracle asset MUST be different markets. A `BTC / USDC / WBTC` long token MUST NOT merge with a `BTC / USDC / HBTC` long token because they are different option class tokens. Tokens of the same option class and different option series MUST NOT be merged together, if either expiry and/or strike and/or call/put type is different, for example two tokens `BTC / USDC / WBTC` one with expiry June 12 2026 and another with June 26 2026, but with the same strike 62000 and same call type.

The market MUST store:
- oracle `oracle` name
- oracle `oracle_feed_id` for `OracleBase / QuoteCoin` pair,
- base coin decimals,
- quote coin decimals,
- strike scale,
- admin address or admin capability,
- pause flag,
- `QuoteCoin` asset address
- `BaseCoin` asset address

The contract MUST reject operations for unsupported coin types.

The contract MUST emit `MarketCreated` with:
- market id,
- oracle base symbol or id,
- quote coin type,
- base coin type,
- oracle name,
- oracle feed id.

## Series Object Model

`Series` MUST be stored as a separate shared object.

The minimum underwriting time to expiry is 8 hours.

A series object MUST contain:
- unique `series_id`,
- `market_id`
- `call_put_market` (option type): 1 for CALL, 2 for PUT
- `strike_price`,
- `expiry_ms`,
- `exercise_window_end_ms = expiry_ms + 1 hour`,
- `exception_window_end_ms = exercise_window_end_ms + 1 hour`,
- total short quantity,
- total manual exercised quantity,
- total exercise-by-exception quantity,
- stored oracle `expiry_price`,
- expiry price publish time,
- internal `CollateralPool` field,
- state,
- cumulative exercise proceeds accounting,
- seller vault records

Each option series MUST have exactly one internal `CollateralPool`. The `CollateralPool` MUST be stored as nested object inside `Series`.

Series states:
- `Open`: series exists and expiration price has not been finalized.
- `ExpirationPriceFinalized`: expiration price is stored and immutable.
- `Closed`: seller payouts are complete and old series storage may be closed.

Post-expiry phases MUST be derived from `state`, finalized price, `expiry_ms`, `exercise_window_end_ms`, and `exception_window_end_ms`. They MUST NOT require separate stored states.

Derived phases:
- price pending: `state == Open` and current time is greater than or equal to `expiry_ms`,
- no-exercise expiry, options expired worthless: `state == ExpirationPriceFinalized` and the series is ATM or OTM,
- manual exercise: `state == ExpirationPriceFinalized`, the series is ITM, and current time is <= to `exercise_window_end_ms`,
- exercise-by-exception window: `state == ExpirationPriceFinalized`, the series is ITM, current time is > than `exercise_window_end_ms`, and current time is <= to `exception_window_end_ms`,
- partial settlement: `state == ExpirationPriceFinalized`, the series is ITM, exercise-by-exception did not complete, and current time > than `exception_window_end_ms`,
- full settlement: `state == ExpirationPriceFinalized` the series is ITM and `total_manual_exercised_quantity + total_exercise_by_exception_quantity` == `total_short_quantity`.

Manual exercise MUST be allowed only when:
- series price is finalized state = `ExpirationPriceFinalized`,
- current time is `>= expiry_ms`,
- current time is `<= exercise_window_end_ms`,
- the series is ITM.

Exercise-by-exception MUST be allowed only when:
- series price is finalized state = `ExpirationPriceFinalized`,
- current time is `>= expiry_ms`,
- current time is `> exercise_window_end_ms` and `<= exception_window_end_ms`,
- the series is ITM.

An ITM call is `expiry_price > strike_price`.

An ITM put is `expiry_price < strike_price`.

ATM and OTM options MUST NOT be exercisable, `Long` tokens expire worthless when the expiration price is finalized.

For ITM series, after `exercise_window_end_ms`, unexercised long tokens MUST NOT be used for direct physical exercise.

Unexercised ITM long tokens MAY be used only to claim from the claim pool after exercise + exercise-by-exception windows ends. If exercise-by-exception has not completed before `exception_window_end_ms`, remaining unexercised `Long` tokens MUST be considered expired worthless.

### Series Creation

Series creation MUST be permissionless.

The contract MUST enforce:
- expiry is more than the minimum underwriting time to expiry after the current time,
- strike is greater than zero,
- option type is valid,
- market coin types are supported,
- no duplicate series exists for the same market, option type, strike, and expiry.

The contract MUST emit `SeriesCreated` with:
- series id,
- market id,
- option type,
- strike,
- expiry.

## Long Token Model

Each `Long` token MUST contain:
- object id,
- market id,
- series id,
- option marker type,
- strike,
- expiry,
- quantity as `u64`.

`Long` quantity represents a claim amount only. Actual `BaseCoin` and `QuoteCoin` collateral MUST remain in the internal `CollateralPool` balances of the corresponding `Series`.

Long tokens MUST be freely transferable by their owner.

Long tokens MUST support:
- `split(token, quantity) -> Long`,
- `join(target, source)`,
- partial exercise by splitting before exercise,
- exercise by consuming the whole provided token object.

`join` MUST require identical:
- market id,
- series id,
- option type,
- strike,
- expiry.

`Long` tokens MUST be sent to holder, the protocol MUST NOT hold `Long` tokens for holders. Holder action is REQUIRED to exercise.

After the exercise window, an unexercised ITM `Long` token is no longer a physical exercise right. It becomes a claim ticket against the isolated claim pool only if exercise-by-exception has completed for the series. After exercise-by-exception window ends `Long` token is expired worthless.

## Seller Vault Object Model

Stored under `Series` as dynamic fields keyed by seller address. Additionally `Series` must store `seller_vault_index: vector<address>` to allow batch processing over `SellerVault`s.

`SellerVault` acts as store of short option tokens. It records how much the seller wrote and determines what the seller receives after expiry. Sellers MUST NOT have a withdrawal or self-settlement path.

The contract MUST use one non-transferable `SellerVault` record per seller address and option `Series`. The `SellerVault` SHOULD be stored under the shared `Series` object. It MUST NOT be an owned object that requires seller signature for settlement, because seller settlement MUST be permissionless for best overall (avoid waiting for both seller and buyer to sign to settle an option serries) and seller particularly UX.

Each `SellerVault` MUST store:
- seller address,
- series id,
- short quantity,
- collateral quantity,
- settlement state,

## Buyer Vault Object Model

`BuyerVault` MUST be stored as a separate shared object. A buyer address MAY create and own one or more `BuyerVault<QuoteCoin>` objects for the same `QuoteCoin`. Each `BuyerVault` is independent, and its funds will be used to pay premiums across `Market`s that use the same `QuoteCoin`.

```move
struct BuyerVault<phantom QuoteCoin> has key {
    id: UID,
    owner: address,
    balance: Balance<QuoteCoin>,
}
```

Only the maker’s owner wallet MUST be able to deposit and withdraw `QuoteCoin` from `BuyerVault<QuoteCoin>`. Maker deposits and withdraws `QuoteCoin`, withdrawals require transaction sender to be `BuyerVault` owner. Withdrawal and underwriting mutate the same `BuyerVault`, preventing either operation from spending an outdated balance.

`BuyerVault<QuoteCoin>` `QuoteCoin` balance fund premiums to buy `Long` options for a `Market` that uses that exaxt `QuoteCoin`.

Withdrawals may use only the unspent balance.

Buyer authorizes a `Long` purchase by signing canonical BCS `OrderV1` bytes using Sui personal-message Ed25519 signing.

Vault operations:
- create_vault: records ctx.sender() as owner.
- deposit: accepts Coin<QuoteCoin> and requires ctx.sender() == vault.owner.
- withdraw: requires ctx.sender() == vault.owner.
- close: withdraw and drop BuyerVault object

The contract MUST emit `BuyerVaultCreated` with:
- buyer vault id,
- owner,
- quote coin type.

The contract MUST emit `BuyerVaultDeposited` with:
- buyer vault id,
- owner,
- quote coin type,
- amount.

The contract MUST emit `BuyerVaultWithdrawn` with:
- buyer vault id,
- owner,
- quote coin type,
- amount.

The contract MUST emit `BuyerVaultClosed` with:
- buyer vault id,
- owner,
- quote coin type,
- last withdrawal amount.

`OrderV1` with signature and public_key that signed the order must be passed as `vector<u8>` to the smart contract as a buyer order to buy an option specified in `OrderV1` and can be used by seller to underwrite an option contract.

### BCS of Signed OrderV1

```
struct SignedOrderV1 has drop {
  order: vector<u8>,      // BCS(OrderV1)
  signature: vector<u8>,  // serialized Sui signature
  public_key: vector<u8>, // signer public key bytes
}
```

```
struct OrderV1 has copy, drop {
    domain: vector<u8>, // exactly "otp:order:v1"
    seller: address,
    market_id: address,
    call_put_marker: u8 // 1: call option 2: put option
    side_marker: u8 // 1: long (buy option) 2: short (sell option)
    strike_price: u64, // in QuoteCoin
    expiry_ms: u64,
    contracts_quantity: u64,
    premium_per_contract: u64,
    operational_fee: u64,
    fee_recipient: address,
    good_till_ms: u64,
    buyer_vault_id: address,
    signer: address, // also address of the buyer must match address derived from SignedOrderV1 public_key
}
```

- Fields MUST be BCS-serialized in exactly the declared order.
- Integers MUST use fixed-width little-endian BCS encoding.
- address MUST be 32 canonical Sui address bytes.
- vector<u8> MUST use a ULEB128 length prefix followed by raw bytes.
- Human-readable numeric strings MUST be converted to base-unit integers before serialization.
- Implementations MUST reject missing, additional, reordered, wrongly typed, or out-of-range fields.
- The signature payload MUST be the canonical BCS bytes wrapped according to Sui personal-message signing.
- fields with address bytes of `OrderV1` should be checked for equality against corresponding objects using `object::id(object).to_address()`
- on-chain order domain verification relies on `market_id`, `buyer_vault_id`, and natural series terms (`call_put_marker`, `strike_price`, `expiry_ms`) matching live objects
- `operational_fee` and `fee_recipient` are signed order terms; the smart contract underwriting logic MUST use these values from `OrderV1` and MUST NOT accept them as caller-controlled transaction arguments.

OrderV1 signature MUST be standard Sui serialized Ed25519 signature blob. Verify the signature against `SignedOrderV1.public_key` using Sui's personal-message flow and check the `SignedOrderV1.public_key` derived address equals `OrderV1.signer`, `OrderV1` `signer` MUST be address of a public key that produced the `OrderV1` signature.

## Collateral Pool

`CollateralPool` MUST be an internal wrapped/nested object inside `Series`.

`CollateralPool` MUST hold `BaseCoin` and `QuoteCoin` balances for one option series only.

Seller collateral coin balance in the pool MUST NOT be treated as per-seller separate balances. `Series` and `SellerVault` accounting determines seller payout shares.

The `CollateralPool` MUST track accounted balances for its `Series` so admin and operator can only recover excess or dust that is not reserved for active or unsettled positions.

After the `Series` is `Closed`, its internal `CollateralPool` SHOULD be destroyable with `Series` after all required payouts, transfers to `ClaimPool`, and allowed dust recovery are complete.

## Underwriting

Underwriting creates `Long` tokens for a buyer and records a seller short obligation.

Underwriting MUST be rejected when the series expiry is less than or equal to the minimum underwriting time to expiry after the current time.

- The contract verifies the signature, signer-vault ownership, deadline, direction, exact argument/order match, sufficient vault balance, and unused `order_hash`.
- The contract computes `order_hash = blake2b256(bcs(OrderV1))` and stores it in `Series`, caller-provided hashes MUST BE forbidden. The hash includes `operational_fee` and `fee_recipient`.
- A successful fill atomically marks the order consumed, deducts premium from the vault, deposits seller collateral, mints the long to the maker, pays premium minus fee to the seller, and pays the fee recipient.

For a covered call atomic underwrite transaction:
- seller provides signed by a buyer `OrderV1`
- provided `OrderV1` matches seller options parameters in full:
  - `seller`
  - `market_id`
  - `call_put_marker`
  - `strike_price`
  - `expiry_ms`
  - quantity of contracts to underwrite
  - must be long side, 
  - "good till" must not expire
- verifies that `buyer_vault_id` matches passed `BuyerVault<QuoteCoin>`, owned by `OrderV1` `signer` and have sufficient amount to pay premium
- verifies the `OrderV1` hash was not used before to prevent replay attack
- seller deposits `BaseCoin` collateral equal to the option quantity into the internal `CollateralPool` of the `Series`,
- buyer pays premium in `QuoteCoin` from passed `BuyerVault` owned by `OrderV1` `signer`
- contract mints and transfers `Long` token to buyer using his signer address
- seller vault short quantity increases in `SellerVault`.

For a cash-secured put atomic underwrite transaction:
- seller provides signed by a buyer `OrderV1`
- provided `OrderV1` matches seller options parameters in full:
  - `seller`
  - `market_id`
  - `call_put_marker`
  - `strike_price`
  - `expiry_ms`
  - quantity of contracts to underwrite
  - must be long side, 
  - "good till" must not expire
- verifies that `buyer_vault_id` matches passed `BuyerVault<QuoteCoin>`, owned by `OrderV1` `signer` and have sufficient amount to pay premium
- verifies the `OrderV1` hash was not used before to prevent replay attack
- seller deposits `QuoteCoin` collateral equal to `strike_payment(quantity)` into the internal `CollateralPool` of the `Series`,
- buyer pays premium in `QuoteCoin` from passed `BuyerVault` owned by `OrderV1` `signer`
- contract mints and transfers `Long` token to buyer using his signer address
- seller vault short quantity increases in `SellerVault`.

Seller collateral MUST be deposited in full 1:1, in other words fully collateralized.

Premium and fee handling:
- total premium calculation `premium_total = premium_per_contract * contracts_quantity` where `contracts_quantity = (contracts_in_base_units / contract_decimal_scale)` with checked `u64` overflow and abort on overflow.
- buyer pays `premium_total` in `QuoteCoin`,
- `operational_fee` is deducted from `premium_total`,
- seller receives `premium_total - operational_fee`,
- protocol fee is transferred to `fee_recipient`,
- `fee_recipient` and `operational_fee` MUST come from signed `OrderV1` fields.

`operational_fee` MUST NOT exceed `premium_total`.

The market MAY admin-configured maximum fee basis points. If present, the smart contract MUST reject underwriting if fees above that maximum fee.

The contract MUST emit `Underwritten` with:
- series id,
- seller,
- buyer,
- quantity,
- collateral deposited,
- premium total,
- protocol fee,
- long token id.

## Strike Payment Calculation

The contract MUST provide deterministic conversion between `BaseCoin` quantity and `QuoteCoin` strike payment.

For calls, holder quote payment MUST be:

`quote_required = ceil(base_quantity * strike_price * quote_scale / base_scale / strike_scale)`

Example: call option for 1 SUI, strike $3.50, quote is USDC:
- 1 Sui base_quantity = 1_000_000_000 because SUI has 9 decimals
- $3.5 strike_price = 350_000_000 if strike scale is 1e8
- quote_scale = 1_000_000 because USDC has 6 decimals
- base_scale = 1_000_000_000
- strike_scale = 100_000_000
- 1_000_000_000 * 350_000_000 * 1_000_000 / 1_000_000_000 / 100_000_000 = 3_500_000
- holder pays 3_500_000 USDC base units which is 3.5 USDC.

For puts, seller quote collateral and holder quote payout MUST use the same formula.

Rounding MUST favor solvency:
- holder payment for calls MUST round up,
- put collateral requirement MUST round up,
- holder payout for puts MUST NOT exceed locked quote collateral.

## Pyth Unverified Expiry Price Finalization

The oracle is used only once per `Series` to finalize and store the expiry price; after that, all ITM/OTM checks read the stored `Series` expiry price.

The contract MUST receive `expiry_price` finalization from off-chain with a transaction that sets expiry price for one or more `Series`.

Expiry price finalization MUST be permissioned. Only the market admin or configured market operator SHOULD be able to finalize expiry prices.

Only Pyth oracle finalization is supported. Pyth Oracle adapter MUST be named as an unverifiable Pyth oracle adapter, for example `pyth_oracle_unverifiable`, because Pyth Sui does not expose a public contract API that verifies historical benchmark `binary.data[]` payloads for arbitrary timestamps.

The Pyth unverifiable adapter MUST NOT treat `binary.data[]` as on-chain proof. It MUST accept and emit the Pyth benchmark payload or payload hash as audit metadata in the event for so this proof binary data MAY be verified in the future. The adapter SHOULD NOT implement any verification utilities and methods.

Finalization legitimacy comes from admin/operator authority.

The adapter MUST create an `ExpiryPrice` "hot-potato" value. `ExpiryPrice` MUST be defined by the series/finalization module, MUST have no abilities, and MUST be consumed in the same PTB by the series finalization function. The adapter MUST be the only non-test module allowed to construct `ExpiryPrice`.

`ExpiryPrice` MUST contain at least:
- `market_id`,
- oracle name,
- `oracle_feed_id`,
- `expiry_ms`,
- settlement `expiry_price`,
- publish time,
- benchmark `binary.data[]` hash as `price_payload_hash`.

One `ExpiryPrice` MAY finalize multiple `Series` in the same transaction when all finalized series have the same `market_id` and `expiry_ms`.

The series finalization module MUST expose fixed-arity helpers for batching:
- `finalize`
- `finalize_two`
- `finalize_four`
- `finalize_eight`

Each fixed-arity helper MUST consume exactly one `ExpiryPrice` and finalize the provided series arguments atomically.

The accepted price MUST satisfy:
- publish time is after or equal to `expiry_ms`,
- price is positive,
- `oracle` name and `oracle_feed_id` matches the `Market` `oracle_feed_id`,
- every finalized `Series` has the same `market_id` and `expiry_ms` as `ExpiryPrice`.

Once stored, the expiry price MUST be immutable.

Finalizing a valid expiration price MUST move the series from `Open` to `ExpirationPriceFinalized`.

If no valid bounded price is finalized, exercise MUST remain blocked.

The contract MUST emit `ExpiryPriceFinalized` with:
- series id,
- oracle name,
- oracle feed id,
- settlement price,
- publish time,
- price payload hash.

When an ATM or OTM series is resolved without exercise, the contract MUST emit `SeriesNoExerciseResolved` with:
- series id,
- option type,
- settlement price,
- strike.

## Manual Physical Exercise

Exercise is holder-initiated.

The holder MUST provide:
- a `Long` token,
- required payment asset that acts as payout to sellers,
- `Clock` object,
- finalized `Series` object.

Exercise MUST consume the whole provided `Long` token. The exercised quantity MUST be the provided `Long` token quantity. Holders who want to exercise only part of their position MUST split their `Long` token before exercise. Holder can split or join `Long` tokens to produce the exact token quantity they want to exercise.

### Covered Call Exercise

For an ITM call:
- holder burns the whole provided call `Long` token,
- holder pays `QuoteCoin` strike cash,
- the internal `CollateralPool` of the corresponding `Series` transfers `BaseCoin` to holder,
- `Series` records exercised quantity,
- `Series` records quote proceeds received.

### Cash-Secured Put Exercise

For an ITM put:
- holder burns the whole provided put `Long` token,
- holder delivers `BaseCoin`,
- the internal `CollateralPool` of the corresponding `Series` transfers `QuoteCoin` strike cash to holder,
- `Series` records exercised quantity,
- `Series` records base proceeds received.

Exercise MUST abort if:
- `Series` expiry price is not finalized,
- current `Clock` object time is outside exercise window,
- option is not ITM,
- payment asset is insufficient for the full provided `Long` token quantity,
- `Long` token option does not match `Series`,
- `Long` token quantity is zero,
- the internal `CollateralPool` of the given `Series` does not have enough collateral for the full provided `Long` token quantity.

The contract MUST emit `Exercised` with:
- series id,
- holder,
- option type,
- quantity,
- input asset amount,
- output asset amount.

## OPTIONAL Flash-Loan Exercise

This is OPTIONAL feature.

Flash-loan exercise MUST be supported through PTB composition. The core exercise functions MUST be designed so returned proceeds can be used in the same PTB to repay a flash loan or swap route.

For calls, a PTB MUST:
- borrow `QuoteCoin`,
- call `exercise`,
- receive `BaseCoin`,
- swap exact part of `BaseCoin` to `QuoteCoin` required to repay borrowed `QuoteCoin`,
- repay borrowed `QuoteCoin`,
- transfer remainder of `BaseCoin` to holder.

For puts, a PTB MAY:
- borrow `BaseCoin`,
- call `exercise`,
- receive `QuoteCoin`,
- swap part of `QuoteCoin` to `BaseCoin` required to repay borrowed `BaseCoin`,
- repay borrowed `BaseCoin`,
- transfer remainder of `QuoteCoin` to holder.

The core options contract SHOULD NOT hard-code one lending protocol or DEX. Provider-specific helpers MAY be separate adapter modules.

Flash exercise MUST be atomic: if borrow, exercise, swap, or repay fails, the whole flash-loan exercise PTB MUST fail.

## OPTIONAL Exercise-by-Exception

This is OPTIONAL feature.

Exercise-by-exception is a permissionless settlement for remaining unexercised ITM options during an explicit post-manual-exercise exception window. It is settlement that utilise flash-loan type of exercise for holders of ITM `Long` tokens who haven't exercise during manual exercise window.

Exercise-by-exception is best effort only, when flash-loan rates, liquidity and price conditions allows. Exercise by exception MUST be atomic: if required seller payment, collateral release, external repayment, claim-pool deposit fails, liquidity cannot produce enough output to cover seller payment or flash-loan the whole PTB MUST fail.

Exercise-by-exception PTB has no rewards for its caller.

Anyone MAY trigger exercise-by-exception during the exception window if:
- the series price is finalized,
- the series is ITM,
- current `Clock` time is greater than `exercise_window_end_ms`,
- current `Clock` time is less than or equal to `exception_window_end_ms`,
- the series has unexercised short quantity,
- `total_manual_exercised_quantity + total_exercise_by_exception_quantity` < `total_short_quantity`.

The exercise-by-exception quantity MUST equal: `total_short_quantity - total_manual_exercised_quantity`.

The operation MUST settle sellers as if all remaining ITM `Long`s were exercised, but it MUST NOT exercise `Long`s instead assets after flash-loan exercise-by-exception must be deposited to `ClaimPool` for future exchange for `Long` token.

The protocol MUST NOT guarantee that late holders receive the full theoretical intrinsic value of `Long` positions. Holders receive only the net asset amount deposited into the claim pool after required seller payment, flash-loan repayment, swap costs, and routing slippage.

If exercise-by-exception does not complete before `exception_window_end_ms`, the remaining unexercised ITM long tokens MUST expire worthless and MUST NOT be claimable from `ClaimPool`.

For calls:
- the operation provides `QuoteCoin` strike cash for the remaining quantity,
- seller accounting records the remaining quantity as paid in `QuoteCoin`,
- the corresponding `BaseCoin` collateral is released into the same PTB,
- the PTB MAY use part of the released `BaseCoin` to repay flash-loan or swap obligations,
- the remaining net `BaseCoin` MUST be deposited into an `ClaimPool` for holders withdrawal in exchange for `Long` tokens.

For puts:
- the operation provides `BaseCoin` for the remaining quantity,
- seller accounting records the remaining quantity as paid in `BaseCoin`,
- the corresponding `QuoteCoin` collateral is released into the same PTB,
- the PTB MAY use part of the released `QuoteCoin` to repay flash-loan or swap obligations,
- the remaining net `QuoteCoin` MUST be deposited into an `ClaimPool` for holders withdrawal in exchange for `Long` tokens.

The contract MUST NOT hard-code a DEX, lending protocol, swap route, or flash-loan provider for exercise-by-exception. External routing MUST be composed around the core settlement operation in a PTB.

The operation SHOULD support caller-provided minimum net claim amounts so exercise-by-exception caller can enforce slippage limits.

The contract MUST emit `ExerciseByException` with:
- series id,
- option type,
- quantity,
- seller payment asset amount,
- released collateral asset amount,
- net claim asset amount,
- claim pool id, if created.

When the exception window ends with unexercised quantity, the contract MUST emit `ExceptionWindowExpired` with:
- series id,
- option type,
- remaining unexercised quantity.

## Claim Pool Object Model

The `ClaimPool` MUST be a separate object from the `Series` and `SellerVaults`. It SHOULD be created only after exercise-by-exception results in non-zero assets for remaining `Long` holders.

The claim pool MUST store only the minimum data required for `Long` holder claims:
- market id,
- series id,
- option type,
- strike,
- expiry,
- claim asset type,
- total claimable long quantity,
- remaining claimable long quantity,
- total net claim asset amount,
- remaining net claim asset amount.

Claiming from the claim pool MUST:
- require a matching `Long` token,
- burn the whole provided `Long` token,
- pay the holder a pro-rata share of the remaining net claim asset,
- reduce remaining claimable quantity and amount.

Claim rounding MUST favor pool solvency. The final valid claim MAY receive remaining rounding dust.

Claiming from the claim pool MUST NOT require loading the old `Series` object, seller vault records, or old collateral accounting.

After exercise-by-exception completes and seller payout settlement for the series is complete, the old series and seller-vault storage SHOULD be closable so storage rebates can be claimed. The claim pool MAY remain on-chain independently until late holders claim or the pool is fully depleted and closed.

The contract MUST emit `ClaimPoolClaimed` with:
- claim pool id,
- series id,
- holder,
- long token id,
- quantity,
- claim asset amount.

## Seller Settlement

Seller settlement MUST be permissionless and MUST NOT require seller action.

Seller payout MUST be performed by series-level or batched permissionless settlement. Sellers MUST NOT claim, withdraw, or settle their own vaults. SellerVault records are accounting inputs only; they are closed by protocol settlement and proceeds are transferred directly to seller addresses.

Series-level or batched settlement MUST be allowed when the series is settle-ready:
- immediately after price finalization for ATM or OTM series,
- after `exercise_window_end_ms` if the ITM series has been manually exercised for its full short quantity,
- after successful exercise-by-exception,
- after `exception_window_end_ms` if exercise-by-exception did not complete.

Seller settlement MUST close seller vault records and transfer proceeds directly to the seller addresses stored in those records.

When all seller vault records for the series are closed, the series MUST move to `Closed`.

Because `Long` tokens are fungible by series and are not matched to seller vaults, manual exercises and exercise-by-exception quantities MUST be allocated across seller vaults pro-rata by each vault's short quantity.

For ATM or OTM series, sellers receive original collateral back.

For ITM calls where all short quantity was manually exercised or exercise-by-exception completed, sellers receive `QuoteCoin` proceeds for the seller's full short quantity.

For ITM puts where all short quantity was manually exercised or exercise-by-exception completed, sellers receive `BaseCoin` proceeds for the seller's full short quantity.

For ITM series where remaining unexercised quantity exists and exercise-by-exception did not complete before `exception_window_end_ms`, sellers receive mixed settlement:
- exercised portion as exercise proceeds,
- unexercised portion as original collateral.

Seller settlement MUST abort if:
- series is not settle-ready,
- seller vault record in the requested batch is already closed,
- series does not exist,
- settlement arithmetic would overdraw the internal `CollateralPool` of the `Series`.

Rounding dust MUST remain in the internal `CollateralPool` of the `Series` and MUST be recoverable only through admin recovery after `series.state == Closed` and `now >= series.exception_window_end_ms` and `now >= series.exercise_window_end_ms` and all seller payouts, manual exercises for given `Series` are fully accounted and settled, only the remaining unreserved balance may be recovered.

Each seller payout MUST emit `SellerPayoutSettled` with:
- series id,
- seller,
- short contracts quantity,
- collateral quantity,
- exercised contracts quantity,
- base paid,
- quote paid.

Each completed settlement batch MUST emit `SeriesSettlementBatchCompleted` with:
- series id,
- settled seller count,
- base paid total,
- quote paid total.

## Accounting Invariant

Rules that must always stay true so the contract cannot lose track of who is owed what.

At all times, each `Series` internal `CollateralPool` accounted balances MUST be greater than or equal to the active obligations required by that option series.

For each series:
- `total_manual_exercised_quantity + total_exercise_by_exception_quantity <= total_short_quantity`,
- manually exercised MUST burn `Long` token.
- exercise-by-exception MUST NOT require burning wallet-held `Long` tokens, instead must move holders payout assets to `ClaimPool` for future claims with `Long` tokens.
- `ClaimPool` claims MUST burn the provided matching `Long` token.
- `SellerVault` short quantities MUST sum to series total short quantity, excluding settled vaults only after their obligations are paid,
- pool transfers MUST use only the internal `CollateralPool` of that `Series`,
- pool transfers MUST never exceed accounted balances.

The contract MUST use checked arithmetic.

Quantity and payment calculations SHOULD use `u128` or wider intermediate arithmetic where needed.

## Transferability and Composability

`Long` tokens MUST be transferable outside the protocol.

The contract MUST emit enough events for wallets, indexers, and keepers to discover:
- created series,
- underwritten positions,
- long token mint/exercise,
- price finalization,
- exercise by exception and claim pool creation,
- claim pool claims,
- series-level or batched seller settlement.

## Pause

The admin pause MUST be applied per market.

The protocol MAY provide a function that pauses all markets in a single transaction.

When a market is paused:
- series creation MUST be disabled,
- underwriting MUST be disabled,
- admin recovery MAY be enabled,
- long token split and join SHOULD remain enabled,
- price finalization SHOULD remain enabled,
- exercise and seller settlement SHOULD remain enabled unless the implementation has a known critical bug in those paths.

Pause authority MUST be held by an admin capability.

Pausing a market MUST emit `Paused` with:
- admin.

Unpausing a market MUST emit `Unpaused` with:
- admin.

## Admin Recovery

Admin recovery MUST be limited to:
- excess balances not reserved by accounting,
- series collateral pool rounding dust after collateral pool is fully settlement and series is closed,
- unsupported objects or coins accidentally sent to auxiliary admin-controlled objects, if technically possible.

Admin recovery MUST NOT withdraw collateral required for open, exercisable, or unsettled series.

Admin recovery MUST NOT withdraw claim-pool balances owed to unclaimed `Long` tokens.

Admin recovery MUST emit `AdminRecovered`.

`AdminRecovered` MUST contain:
- admin,
- asset type,
- amount,
- recipient,
- reason code.

## Public Function Surface

The contract SHOULD expose at least:

- `create_market`
- `create_series`
- `underwrite_call`
- `underwrite_put`
- `long::split`
- `long::merge`
- `pyth_oracle_unverifiable::create_expiry_price`
- `series::finalize_one`
- `series::finalize_two`
- `series::finalize_four`
- `series::finalize_eight`
- `exercise`
- `exercise_by_exception`
- `claim_pool::redeem`
- `seller_vault::batch_settle`
- `pause`
- `unpause`
- `admin_recover_excess`
- `buyer::create_vault`
- `buyer::depoit`
- `buyer::withdraw`
- `buyer::close_vault`

## Non-Goals For MVP

MVP MUST NOT implement:
- American exercise,
- pure cash-settlement
- automatic clawback exercise,
- PAS assets,
- naked options,
- cross collateral,
- seller writer tokens,
- seller collateral withdrawal before expiry,
- seller close by burning longs before expiry,
- automatic holder discovery,
- built-in DEX routing,
- built-in lending protocol dependency.
- seller collateral top-up after underwriting,
- seller short reduction before expiry,
- seller excess collateral withdrawal before expiry.
- underwite module chain id and package id verification during underwriting, following field may be added to orderv2:
  - protocol_package_id: address,
  - chain_id: vector<u8>, // exactly "sui:mainnet" or "sui:testnet" or "sui:devnet" must match the current contract execution environemnt, e.g. testent orders MUST be aborted in mainnet

## Main Design Tradeoffs

The design chooses seller vault records over transferable writer tokens to keep seller accounting simple and settlement permissionless.

The design chooses transferable long SFT objects so options remain composable and mergeable by series.

The cost of this design is per-series dust and a larger `Series` object. Physically exercised quantity still must be allocated to seller vaults pro-rata by short quantity because long tokens are fungible by series and are not matched to seller vaults.

Sui transactions use a distinct serialization format that intrinsically incorporates chain-specific identifiers. Thus there is no need explicit chain id specification.
