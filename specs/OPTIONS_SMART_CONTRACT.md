# Options Smart-Contract Specification

## Scope

This document specifies MVP version of the on-chain smart-contract design for European, physically settled options on Solana.

This document does not specify RFQ servers, market-maker APIs, web UI, indexing, or off-chain quote routing.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and `OPTIONAL` in this document are to be interpreted as described in RFC 2119.

## Core Terms and Product Language

This document uses `./DOMAIN-LANGUAGE.md` as the language for product and implementation, the document must be read.

## Market

The market program manages markets available for option series. Each market supports exactly one `OracleBase / QuoteCoin / BaseCoin` option class, one configured operator, and oracle configuration. Different operators MAY create independent markets for the same option class. Market creation MUST reject a duplicate with the same operator, oracle configuration, `QuoteCoin` mint address, and `BaseCoin` mint address.

Market must be PDA `["market", oracle_constant_id, price_source_id, quote_coin_mint, base_coin_mint, operator_address]`. `oracle_constant_id` is the enum variant name `"PythTwap"`string.

`Market` and hence the protocol supports only SPL tokens. Other types of tokens like native SOL and Token-2022 is out of support. `QuoteCoin` and `BaseCoin` MUST be SPL tokens, native SOL is out of support, wrapped SOL tokens can be used instead.

Examples:
- `SOL / USDC / SOL`
- `SOL / USDT / SOL`
- `PUMP / USDC / PUMP`
- `HYPE / USDC / HYPE`
- `BTC / USDC / WBTC`
- `BTC / USDT / WBTC`
- `BTC / USDC / xBTC`
- `BTC / USDC / cbBTC`

Different wrapped versions of the same oracle asset MUST be different markets. A `BTC / USDC / WBTC` long token has different mint from `BTC / USDC / xBTC` token and `BTC / USDT / WBTC` token because they are different option class tokens. Same way tokens of the same option class but different option series must have different token mint, for example two different tokens are `BTC / USDC / WBTC` with expiry June 12 2026 and expiry June 26 2026, even if they have the same strike 62000 and both are call options.

`Market` MUST use a tagged `OracleConfig` so common market accounting is independent from oracle-specific finalization logic. MVP supports exactly:

```rust
OracleConfig::PythTwap { feed_id: [u8; 32] }
```

`feed_id` is the 32-byte Pyth price-feed ID for the `OracleBase / QuoteCoin` pair.

`PythUnverified` is not a market configuration; it is an always-deployed, operator-only fallback finalization method for a `PythTwap` market. Future oracle integrations MAY add configuration variants.

The market MUST only store:
- `oracle_config`,
- base coin scale,
- quote coin scale,
- operator address,
- pause flag,
- `QuoteCoin` mint address,
- `BaseCoin` mint address,
- `min_fee`,
- `min_operational_fee_bps`,
- `max_operational_fee_bps`.

`QuoteCoin` and `BaseCoin` MUST be distinct mints owned by the canonical SPL Token Program. Native SOL and Token-2022 are unsupported; wrapped SOL MAY be used. The program MUST derive on-chain each stored coin scale as `10 ^ mint.decimals`, and MUST reject a mint with more than 19 decimals because its scale cannot fit in `u64`.

Market creation is permissionless. The transaction payer and supplied operator MUST both sign. The payer funds account creation; the supplied operator is stored immutably as the market operator. A newly created market MUST be unpaused and usable immediately.

`min_fee` is a `QuoteCoin` amount in base units and MAY be zero, `min_fee` is required. `min_operational_fee_bps` and `max_operational_fee_bps` are required values in `0..=10_000`; the program MUST enforce `min_operational_fee_bps <= max_operational_fee_bps`. Zero values support a zero-fee market.

### Market Creation

`create_market` MUST accept:
- the operator signer,
- the BaseCoin and QuoteCoin SPL mint accounts,
- `OracleConfig::PythTwap { feed_id }`,
- `min_fee: u64`,
- `min_operational_fee_bps: u16`, and
- `max_operational_fee_bps: u16`.

The payer signer creates and funds the market PDA. The instruction MUST reject:
- a missing payer signature,
- a missing operator signature if operator different from payer,
- a BaseCoin or QuoteCoin mint not owned by the canonical SPL Token Program,
- if BaseCoin mint is the same QuoteCoin mint,
- a mint with more than 19 decimals,
- an invalid fee-bps range, and
- an existing market PDA.

On success, it MUST persist the passed oracle configuration, mints, operator, and fee configuration; derived token scales; and `paused = false`. The operator address and market identity fields are immutable because this MVP exposes no market-update instruction.

The smart-contract MUST emit `MarketCreated` with:
- market address,
- operator address,
- oracle kind,
- oracle feed id,
- quote coin mint address,
- base coin mint address.

## Option Series

PDA mint address `["option_series", market_address, call_put_marker, expiry, strike_price]`.

The minimum underwriting time to expiry is 8 hours.

A series MUST only store:
- series state flag,
- `market_address`
- `call_put_marker` (option type): 1 for CALL, 2 for PUT
- `strike_price`,
- `expiry_ms`,
- `exercise_window_end_ms = expiry_ms + 1 hour`,
- finalized oracle `expiry_price`,
- `total_contracts_quantity`,
- `total_manual_exercised_quantity`,
- `total_seller_quote_payout_amount` to store accumulated quote coin seller payouts accumulated during exercise
- `total_settled_quantity`

Series states:
- `Open`: series exists and expiration price has not been finalized.
- `ExpirationPriceFinalized`: expiration price is stored and immutable.
- `Closed`: seller payouts are complete and old series storage may be closed.

Post-expiry phases MUST be derived from `state`, finalized price, `expiry_ms` and `exercise_window_end_ms`. They MUST NOT require separate stored states.

Derived phases:
- price pending: `state == Open` and current time is greater than or equal to `expiry_ms`,
- no-exercise expiry, options expired worthless: `state == ExpirationPriceFinalized` and the series is ATM or OTM,
- manual exercise: `state == ExpirationPriceFinalized`, the series is ITM, and current time is < to `exercise_window_end_ms`,
- fully exercised: `state == ExpirationPriceFinalized` the series is ITM and `total_manual_exercised_quantity` == `total_contracts_quantity`.
- partial settlement: `state == ExpirationPriceFinalized`, the series is ITM and current time >= than `exercise_window_end_ms`,

Manual exercise MUST be allowed only when:
- series price is finalized state = `ExpirationPriceFinalized`,
- current time is `>= expiry_ms`,
- current time is `< exercise_window_end_ms`,
- the series is ITM.

ATM and OTM options MUST NOT be exercisable, `Long` tokens expire worthless when the expiration price is finalized.

For ITM series, after `exercise_window_end_ms`, unexercised long tokens MUST NOT be used for exercise, all unexercised tokens MUST be considered worthless.

`Series` PDA is the authority for `BaseCoin` and `QuoteCoin` collateral vault token accounts.

BaseCoin Series token account:
- mint = Series.base_coin_mint
- token authority = Series PDA
- token program = SPL Token Program

QuoteCoin Series token account:
- mint = Series.quote_coin_mint
- token authority = Series PDA
- token program = SPL Token Program

After the `Series` is `Closed`, all related PDAs that can be closed (this excludes mint account, and `Long` token holders accounts) to rebate storage MUST be destroyed to release used on-chain memory and rent cost. `Series` can be closed only when `total_settled_quantity == total_contracts_quantity`. Dust and excess collateral goes settlement transaction signer that closes the `Series`.

The protocol MUST NOT maintain an on-chain seller index. Off-chain indexers discover seller vaults from `Underwritten` events.

### Option Series Creation

Series creation MUST be permissionless.

The contract MUST enforce:
- expiry is more than the minimum underwriting time to expiry after the current time,
- expiry is aligned to a whole second: `expiry_ms % 1_000 == 0`,
- strike is greater than zero,
- option type is valid,
- no duplicate series exists for the same market, option type, strike, and expiry.

On success option series creation, the contract MUST create the deterministic `Long` mint with `BaseCoin` decimals, Series PDA mint authority, and no freeze authority. It MUST also create the Series PDA's `BaseCoin` and `QuoteCoin` associated token accounts.

The contract MUST emit `SeriesCreated` with:
- series id,
- market id,
- option type,
- strike,
- expiry.

### Option Series Seller Vault

PDA `["option_series_seller_vault", market_address, call_put_marker, expiry, strike_price, seller_pubkey]`

`Series` and `SellerVault` accounting determines seller payout shares.

`SellerVault` acts as store of short option positions, how many contracts of base coin sellers sold. Short amount MUST have same decimal scale as base coin. It records how much the seller wrote and determines what the seller receives after expiry.

Seller vault MUST NOT support a withdrawal or self-settlement path. Vault settlement MUST be permissionless for best user experience (avoid waiting for both seller and buyer to sign to settle an option serries).

Each `SellerVault` MUST store:
- `owner` seller public key address,
- series address,
- short contracts quantity,
- collateral quantity,

## Long Token for Option Series

Each `Long` token MUST be SPL fungible token with deterministic PDA mint address `["option_series_mint", market_address, call_put_marker, expiry, strike_price]`. This PDA is mint authority for `Long` SPL token. `Long` freeze authority is none.

`Long` quantity represents a claim amount. `Long` (option contract) quantity  Contract quantities use the same decimal precision as the underlying `BaseCoin`; therefore, one whole contract represents 1.0 `BaseCoin`. Actual `BaseCoin` and `QuoteCoin` collateral MUST remain in the `Series` PDA token accounts

`Long` tokens MUST have the same decimal scale as Base Coin.

## Underwriting

Underwriting creates `Long` tokens for a buyer and records a seller short obligation.

Underwriting MUST be rejected when the series expiry is less than or equal to the minimum underwriting time to expiry after the current time.

The contract MUST verify buyer and seller signatures and MUST reject an underwrite where buyer and seller are the same wallet. Contracts `quantity` MUST be greater than zero.

Buyer and seller funding accounts MAY be any SPL Token accounts owned by the respective signer with the required mint. The contract MUST create a missing buyer `Long` ATA, seller `QuoteCoin` ATA, or fee-recipient `QuoteCoin` ATA. The seller MUST fund all such ATA creation in the underwriting transaction.

For a covered call underwrite transaction:
- seller deposits from his account `BaseCoin` collateral equal to the option quantity into `Series` PDA token account,
- buyer pays premium in `QuoteCoin` from his account,
- contract mints and transfers `Long` token to buyer's account,
- if the seller's vault PDA does not exist, the contract creates it,
- seller vault short accounting increases in `SellerVault` PDA.

For a cash-secured put underwrite transaction:
- seller deposits from his account `QuoteCoin` collateral equal to `strike_payment(quantity)` into `Series` PDA token account,
- buyer pays premium from his account in `QuoteCoin`,
- contract mints and transfers `Long` token to buyer's account,
- if the seller's vault PDA does not exist, the contract creates it,
- seller vault short accounting increases in `SellerVault` PDA.

Seller collateral MUST be deposited in full 1:1, all underwrites are fully collateralize.

Premium and fee handling:
- total premium calculation `premium_total = ceil_div(quantity * premium_per_contract, base_coin_scale)` with checked arithmetic, this rounding favors the seller, where `contracts_quantity = (contracts_in_base_units / contract_decimal_scale)` with checked `u64` overflow and abort on overflow, and `premium_per_contract` how much buyer pays in `QuoteCoin` to buy one `Long` whole option token (one token in integer units).
- buyer pays `premium_total` in `QuoteCoin`,
- `operational_fee` is deducted from `premium_total` and calculated on-chain, resulted fee MUST NOT be less than minimal fee set in the market `operational_fee = MAX((premium_total * operational_fee_bps) / 10_000, min_fee)`,
- `operational_fee` is transferred to `fee_recipient`,
- seller receives `premium_total - operational_fee`,
- `fee_recipient` and `operational_fee_bps` MUST be part of underwriting transaction signed by Buyer and Seller.

`operational_fee` MUST NOT exceed `premium_total`.

The smart contract MUST reject underwriting when `operational_fee_bps` is outside the market's inclusive minimum and maximum operational-fee-bps range. `fee_recipient` MAY be any wallet, including buyer, seller, or the market operator.

Zero-premium underwrites are allowed only when the calculated `operational_fee` is also zero.

The contract MUST emit `Underwritten` with:
- series id,
- seller,
- buyer,
- quantity of long tokens,
- long token mint address,
- collateral deposited,
- premium total,
- operational fee,
- fee recipient.

## Strike Payment Calculation

All strike prices have 6 decimal scale `strike_scale = 1_000_000`.

The contract MUST provide deterministic conversion between `BaseCoin` quantity and `QuoteCoin` strike payment.

For a BaseCoin quantity `q` (where q is number of contracts which is the same as number of BaseCoins):
- `call_collateral(q) = q`
- `call_payment(q) = ceil_div(q * strike_price * quote_scale, base_scale * strike_scale)`
- `put_collateral(q) = ceil_div(q * strike_price * quote_scale, base_scale * strike_scale)`
- `put_payout(q) = floor_div(q * strike_price * quote_scale, base_scale * strike_scale)`

Use round down for put payouts and round up for put collateral, leaving any difference as dust.

Example: call option for 1 SUI, strike $3.50, quote is USDC:
- 1 Sui base_quantity = 1_000_000_000 because SUI has 9 decimals
- $3.5 strike_price = 3_500_000 if strike scale is 1e6
- quote_scale = 1_000_000 because USDC has 6 decimals
- base_scale = 1_000_000_000
- strike_scale = 1_000_000
- `ceil_div(1_000_000_000 * 3_500_000 * 1_000_000, 1_000_000_000 * 1_000_000) = 3_500_000`
- holder pays 3_500_000 USDC base units which is 3.5 USDC.

For puts, seller quote collateral and holder quote payout MUST use the same formula.

Rounding MUST favor solvency:
- holder payment for calls MUST round up,
- put collateral requirement MUST round up,
- holder payout for puts MUST NOT exceed locked quote collateral.

## Price Finalization

The oracle is used only once per `Series` to finalize and store the expiry price; after that, all ITM/OTM checks read the stored `Series` expiry price. Contracts MUST NOT support a dispute window or a finalization reward.

Every finalization method MUST require:
- the market is not paused,
- current time is `>= expiry_ms`,
- every supplied series is `Open` 
- every supplied series has the same market and expiry.

One finalization transaction MAY finalize one or more series. The stored 1e6-scale expiry price is immutable; successful finalization moves every supplied series from `Open` to `ExpirationPriceFinalized`.

### Price Representation

Pyth raw prices are `raw_price * 10^expo`. Every finalization MUST require a positive raw price and convert it to the protocol's 1e6 strike scale using checked arithmetic and round-half-up. The conversion MUST reject values that cannot be represented as a positive `u64` at the 1e6 scale.

### Permissionless Pyth TWAP Finalization

For `PythTwap` markets signer MUST finalize a series from any suitable, already-posted Pyth Receiver `TwapUpdate` on-chain account; the update account's write authority MUST NOT restrict Options finalization. 

The Options program MUST hardcode the canonical Pyth Receiver program identity (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`). The passed `TwapUpdate` MUST be owned by that program and have been produced through Pyth's full VAA-verification path. `TwapUpdate` has no `VerificationLevel` field.

For every Pyth TWAP finalization, the program MUST require:
- `twap.feed_id == market.oracle_config.feed_id`,
- `twap.start_time == expiry_ms / 1_000 - 60`,
- `twap.end_time == expiry_ms / 1_000`,
- `twap.down_slots_ratio <= 500_000`, meaning at least 50% data coverage over the 60-second window,
- a positive raw price, and
- all batch series have the specified market and expiry.

The program MUST emit exactly one `PythTwapPrice` per finalized batch with:
- market id,
- Pyth Receiver `TwapUpdate` address,
- Pyth feed id,
- raw price, 
- confidence,
- exponent,
- TWAP start time and end time,
- down-slots ratio,
- normalized 1e6 settlement price.

### Permissioned Pyth Unverified Fallback

`PythUnverified` an operator-only fallback. It MAY be used after expiry only while the series remains `Open`. Its authority is the market's configured operator, not any Pyth account.

The fallback MUST accept exactly the reported Pyth Hermes API payload as instruction arguments:
- `id: [u8; 32]`,
- `price: i64`,
- `conf: u64`,
- `expo: i32`, and
- `publish_time: i64`.

The fallback price finalization logic MUST NOT implement any checks.

The program MUST emit exactly one `PythUnverifiedPrice` per finalized batch with:
- market id,
- market operator,
- reported id, raw price, confidence, exponent, and publish time, and
- normalized 1e6 settlement price.

### Shared Finalization Events and API

Both methods MUST emit one `ExpiryPriceFinalized` per series with:
- series id,
- normalized 1e6 settlement price,
- market oracle configuration, and
- actual finalization method (`PythTwap` or `PythUnverified`).

The series finalization module MUST expose one batch instruction for each method:
- `finalize_pyth_twap_series`, and
- `finalize_pyth_unverified_series`.

Each batch instruction MUST accept from one through sixteen writable Series accounts. It MUST reject an empty batch, a batch larger than sixteen Series accounts, and duplicate Series accounts.

## Manual Physical Exercise

Exercise is `Long` token holder-initiated.

The holder MUST provide:
- a `Long` token,
- required payment asset that acts as payout to sellers,

Exercise MUST accept an explicit `quantity` and burn exactly that quantity of `Long` tokens from holder. The exercised quantity MUST be greater than zero and no greater than holder's `Long` token balance.

### Covered Call Exercise

For an ITM call:
- holder transfers `Long` tokens to burn inside the contract,
- holder transfers `QuoteCoin` strike cash to `Series` PDA token account,
- the `Series` PDA  transfers `BaseCoin` to the holder,
- `Series` records exercised quantity,

### Cash-Secured Put Exercise

For an ITM put:
- holder transfers `Long` tokens to burn inside the contract,
- holder transfers `BaseCoin` equal to `Long` token amount to `Series` PDA token account,
- the `Series` PDA  transfers `QuoteCoin` amount to the holder,
- `Series` records exercised quantity,

Exercise MUST abort if:
- `Series` expiry price is not finalized,
- option is not ITM,
- payment asset to exercise is insufficient for amount of `Long` token quantity,
- `Long` token option does not match `Series`,
- `Long` token quantity is zero,
- `Series` PDA does not have enough collateral for amount of `Long` token quantity.

The contract MUST emit `Exercised` with:
- series id,
- holder,
- option type,
- quantity,
- input asset amount,
- output asset amount.

## Seller Settlement

Seller settlement MUST be permissionless.

Because `Long` tokens are fungible by series and are not matched to seller vaults, exercises quantities MUST be allocated across seller pro-rata by each vault's short quantity during seller settlement. Seller settlement amounts MUST be rounded down, any resulting dust MUST remain in the `Series` PDA token account.

Seller payout MUST be performed from `SellerVault` accounts supplied to the settlement transaction. Off-chain indexers discover those accounts from `Underwritten` events; the contract MUST validate every supplied vault and its relation to the Series on-chain. A settlement invocation MAY process one or more seller vaults.

Seller settlement MUST be allowed when the series is settle-ready:
- immediately after price finalization for ATM or OTM series,
- after `exercise_window_end_ms`

Seller settlement MUST close seller vault account and transfer proceeds directly to the seller addresses stored in those records. Rent rebate for closed seelr vault account goes to transaction signer of a settlement transactions. If ATA account for non-zero payout of `BaseCoin` or/and `QuoteCoin` token does not exists it MUST be created, signer of a settlement transaction must fund ATA creation.

When `total_settled_quantity == total_contracts_quantity`, the series MUST move to `Closed`. Each settled seller vault MUST increase `total_settled_quantity` by its short contracts quantity exactly once.

For ATM or OTM series, sellers receive original collateral back.

For ITM calls where all short quantity was manually exercised completed, sellers receive `QuoteCoin` proceeds for the seller's full short quantity.

For ITM puts where all short quantity was manually exercised completed, sellers receive `BaseCoin` proceeds for the seller's full short quantity.

For ITM settled series where remaining unexercised quantity exists sellers receive mixed settlement:
- exercised portion as exercise proceeds,
- unexercised portion as original collateral.

Seller settlement MUST abort if:
- series is not settle-ready,
- a requested seller vault is already closed,
- `total_settled_quantity` would exceed `total_contracts_quantity`,
- series does not exist,
- settlement arithmetic would overdraw the internal `Series` balance of base or quote tokens.

Rounding dust MUST remain in the `Series` PDA and MUST be recoverable only through operator recovery after `series.state == Closed` and `now >= series.exercise_window_end_ms` and all seller payouts, manual exercises for given `Series` are fully accounted and settled, only the remaining unreserved balance may be recovered. Rounding dust only recovered when `Series` PDAs and other accounts are closed, dust goes to the `Series` close transaction signer; rent rebate goes to current `Series` `Market` operator.

Each seller payout MUST emit `SellerPayoutSettled` with:
- series id,
- seller,
- short contracts quantity,
- collateral quantity,
- exercised contracts quantity,
- base paid,
- quote paid.

Each settlement invocation that processes more than one seller vault MUST emit `SeriesSettlementBatchCompleted` with:
- series id,
- settled seller count,
- base paid total,
- quote paid total.

## Accounting Invariant

Rules that must always stay true so the contract cannot lose track of who is owed what.

At all times, each `Series` PDA accounted balances MUST be greater than or equal to the active obligations required by that option series.

For each series:
- `total_manual_exercised_quantity <= total_contracts_quantity`,
- `total_settled_quantity <= total_contracts_quantity`,
- manually exercised MUST burn `Long` token.
- active `SellerVault` short quantities plus `total_settled_quantity` MUST equal `total_contracts_quantity`,
- pool transfers MUST use only the balance that `Series` PDA,
- pool transfers MUST never exceed accounted balances.

The contract MUST use checked arithmetic.

Quantity and payment calculations SHOULD use `u128` or wider intermediate arithmetic where needed.

## Pause

The operator pause MUST be applied per market.

When a market is paused all instructions/actions with `Market`, `Series`, `Long` are paused and must be rejected, except:
- operator recovery MAY be enabled,
- market un-pausing MUST be enabled.

Pause authority MUST be held by the configured operator address, which MUST sign the instruction.

Pausing a market MUST emit `MarketPaused` with:
- operator address.

Un-pausing a market MUST emit `MarketUnpaused` with:
- operator address.

## Operator Funds Recovery

Operator recovery MUST be limited to series token accounts after series is fully settlement. Recovery must be part of the Series closure. Operator recovery MUST NOT withdraw collateral required for open, exercisable, or unsettled series.

Operator recovery MUST emit `OperatorRecovered` that MUST contain:
- operator address,
- asset type,
- amount,
- recipient,
- reason code.

## Public Function Surface

The contract MUST expose exactly API:

- `create_market`
- `pause_market`
- `unpause_market`
- `create_series`
- `close_series`
- `underwrite_call`
- `underwrite_put`
- `finalize_pyth_twap_series`
- `finalize_pyth_unverified_series`
- `exercise`
- `settle_sellers_batch`

## Non-Goals For MVP

MVP MUST NOT implement:
- American exercise
- pure cash-settlement
- naked options
- cross collateral

## Main Design Trade-offs

The design chooses seller vault records over transferable writer tokens to keep seller accounting simple and settlement permissionless.

The design chooses transferable long SPL so options remain composable and tradeble outside the options contract.
