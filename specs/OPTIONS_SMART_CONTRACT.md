# Options Smart Contract Specification

## Scope

This document specifies MVP version of the on-chain smart contract design for European, physically settled options on Solana.

This document does not specify RFQ servers, market-maker APIs, web UI, indexing, or off-chain quote routing.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and `OPTIONAL` in this document are to be interpreted as described in RFC 2119.

## Core Terms and Product Language

This document uses `./DOMAIN-LANGUAGE.md` as the language for product and implementation, the document must be read.

## Market

The market program manages markets available for option series. Each market supports exactly one `OracleBase / QuoteCoin / BaseCoin` option class, one configured operator, and oracle configuration. Different operators MAY create independent markets for the same option class. Market creation MUST reject a duplicate with the same operator, oracle configuration, `QuoteCoin` mint address, and `BaseCoin` mint address.

Market must be PDA `["market", oracle_constant_id, price_source_id, quote_coin_mint, base_coin_mint, operator_address]`. Where oracle_constant_id is enum variant name, like "PythUnverified".

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
OracleConfig::PythUnverified { feed_id: [u8; 32] }
```

`feed_id` is the 32-byte Pyth price-feed ID for the `OracleBase / QuoteCoin` pair. Future oracle integrations MAY add configuration variants.

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
- `OracleConfig::PythUnverified { feed_id }`,
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

The contract MUST emit `MarketCreated` with:
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
- `market_address`
- `call_put_marker` (option type): 1 for CALL, 2 for PUT
- `strike_price`,
- `expiry_ms`,
- `exercise_window_end_ms = expiry_ms + 1 hour`,
- total short quantity,
- total manual exercised quantity,
- finalized oracle `expiry_price`,
- series state flag,
- `total_contracts_quantity`
- `total_exercised_quantity`
- `seller_index_batch_num` number of existed seller index batches

Series states:
- `Open`: series exists and expiration price has not been finalized.
- `ExpirationPriceFinalized`: expiration price is stored and immutable.
- `Closed`: seller payouts are complete and old series storage may be closed.

Post-expiry phases MUST be derived from `state`, finalized price, `expiry_ms` and `exercise_window_end_ms`. They MUST NOT require separate stored states.

Derived phases:
- price pending: `state == Open` and current time is greater than or equal to `expiry_ms`,
- no-exercise expiry, options expired worthless: `state == ExpirationPriceFinalized` and the series is ATM or OTM,
- manual exercise: `state == ExpirationPriceFinalized`, the series is ITM, and current time is < to `exercise_window_end_ms`,
- full settlement: `state == ExpirationPriceFinalized` the series is ITM and `total_manual_exercised_quantity` == `total_short_quantity`.
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

After the `Series` is `Closed`, all related PDAs that can be closed (this excludes mint account, and `Long` token holders accounts) to rebate storage MUST be destroyed to release used on-chain memory and rent cost. `Series` can be closed only when all holders of short side of the pool are settled. Dust and excess of collateral goes to operator that closes the `Swries`.

`Series` stores all public addresses of sellers (underwriters) in sellers index PDA `["option_series_seller_index", market_address, call_put_marker, expiry, strike_price, batch_num]` that acts as a batch of 16 public key addresses. When one batch is full `Series` must allocate a new batch. Each underwrite appends a wallet to current seller index batch. These batches are used to iterate over during sellers settlement. Memory for these batches must be released during settlement, storage rebate goes to operator that triggers settlement for a seller index batch.

### Option Series Creation

Series creation MUST be permissionless.

The contract MUST enforce:
- expiry is more than the minimum underwriting time to expiry after the current time,
- strike is greater than zero,
- option type is valid,
- no duplicate series exists for the same market, option type, strike, and expiry.

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

`Long` quantity represents a claim amount only. Actual `BaseCoin` and `QuoteCoin` collateral MUST remain in the `Series` PDA token accounts

`Long` tokens MUST have the same decimal scale as Base Coin.

## Underwriting

Underwriting creates `Long` tokens for a buyer and records a seller short obligation.

Underwriting MUST be rejected when the series expiry is less than or equal to the minimum underwriting time to expiry after the current time.

The contract verifies buyers, sellers signatures.

For a covered call underwrite transaction:
- seller deposits from his account `BaseCoin` collateral equal to the option quantity into `Series` PDA token account,
- buyer pays premium in `QuoteCoin` from his account,
- contract mints and transfers `Long` token to buyer's account,
- if seller's vault PDA does not exists sellers account public address appended to `Series` sellers index and seller's vault must be created,
- seller vault short accounting increases in `SellerVault` PDA.

For a cash-secured put underwrite transaction:
- seller deposits from his account `QuoteCoin` collateral equal to `strike_payment(quantity)` into `Series` PDA token account,
- buyer pays premium from his account in `QuoteCoin`,
- contract mints and transfers `Long` token to buyer's account,
- if seller's vault PDA does not exists sellers account public address appended to `Series` sellers index and seller's vault must be created,
- seller vault short accounting increases in `SellerVault` PDA.

Seller collateral MUST be deposited in full 1:1, all underwrites are fully collateralize.

Premium and fee handling:
- 
- total premium calculation `premium_total = premium_per_contract * contracts_quantity` where `contracts_quantity = (contracts_in_base_units / contract_decimal_scale)` with checked `u64` overflow and abort on overflow, and `premium_per_contract` how much buyer pays in `QuoteCoin` to buy one `Long` whole option token (one token in integer units).
- buyer pays `premium_total` in `QuoteCoin`,
- `operational_fee` is deducted from `premium_total`,
- seller receives `premium_total - operational_fee`, resulted fee MUST NOT be less than minimal fee set in the market `operational_fee = MAX((amount * fee_bps) / 10_000, min_fee)`.
- protocol fee is transferred to `fee_recipient`,
- `fee_recipient` and `operational_fee_bps` MUST be part of underwriting transaction signed by Buyer and Seller.

`operational_fee` MUST NOT exceed `premium_total`.

The market MAY operator-configured maximum fee basis points. If present, the smart contract MUST reject underwriting if fees above that maximum fee basis points, if fees below minimal fees basis points. 

The contract MUST emit `Underwritten` with:
- series id,
- seller,
- buyer,
- quantity of long tokens,
- long token mint address,
- collateral deposited,
- premium total,
- protocol fee,
- free recipient.

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

### Pyth Unverified Expiry Price Finalization

Protocol participants trust operator for price settlement and able to audit it on-chain and with `ExpiryPriceFinalized` event and open dispute with the operator directly off-chain. Contracts MUST NOT support dispute window.

The oracle is used only once per `Series` to finalize and store the expiry price; after that, all ITM/OTM checks read the stored `Series` expiry price.

The contract MUST receive `expiry_price` finalization from off-chain with a transaction that sets expiry price for one or more `Series`.

Expiry price finalization MUST be permissioned. Only the configured market operator MUST be able to finalize expiry prices.

Only `OracleConfig::PythUnverified` finalization is supported. Its adapter MUST be named as an unverifiable Pyth oracle adapter, for example `pyth_oracle_unverifiable`, because no checks are performed on-chain.

The Pyth unverifiable adapter MUST NOT treat `binary.data[]` as on-chain proof. It MUST accept it as it is and emit the Pyth benchmark payload or payload hash as audit metadata in the event for so this proof binary data MAY be verified in the future. The adapter SHOULD NOT implement any verification utilities and methods.

Finalization legitimacy comes from operator authority.

One finalization transaction MAY finalize multiple `Series` when all finalized series have the same `market_id` and `expiry_ms`.

The series finalization module MUST expose fixed-arity helpers for batching:
- `finalize_one_series`
- `finalize_two_series`
- `finalize_four_series`
- `finalize_eight_series`

The accepted price MUST satisfy:
- publish time is after or equal to `expiry_ms`,
- price is positive,
- price has default strike scale used in the protocol 1e6,
- the market `oracle_config` is `PythUnverified` and its `feed_id` matches the finalized Pyth feed ID,
- every finalized `Series` in a single transaction has the same `market_id` and `expiry_ms` as `ExpiryPrice`.

Once stored, the expiry price MUST be immutable.

Finalizing a valid expiration price MUST move the series from `Open` to `ExpirationPriceFinalized`.

The contract MUST emit `ExpiryPriceFinalized` with:
- series id,
- oracle kind,
- oracle feed id,
- settlement price,
- publish time,
- price payload hash.

## Manual Physical Exercise

Exercise is `Long` token holder-initiated.

The holder MUST provide:
- a `Long` token,
- required payment asset that acts as payout to sellers,

Exercise MUST consume the whole provided `Long` token. The exercised quantity MUST be the provided `Long` token quantity. Holders who want to exercise only part of their position MUST send partial amount of their `Long`.

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

Seller settlement MUST be permissionless and MUST NOT require seller action.

Seller payout MUST be performed in permissionless settlement using `Series` seller index batches. Each settlement must consume one seller index batch.

Sellers MUST NOT claim, withdraw, or settle their own vaults. Seller vault records are accounting inputs only; they are closed by protocol settlement and proceeds are transferred directly to seller addresses.

Series batched settlement MUST be allowed when the series is settle-ready:
- immediately after price finalization for ATM or OTM series,
- after `exercise_window_end_ms`

Seller settlement MUST close seller vault records and transfer proceeds directly to the seller addresses stored in those records. Rent rebate for closed account goes to the fee payer of a settlement transactions. If ATA account for payout token does not exists it MUST be created, fee payer of a settlement transaction must fund ATA creation.

When all seller vault records for the series are closed, the series MUST move to `Closed`.

Because `Long` tokens are fungible by series and are not matched to seller vaults, manual exercises quantities MUST be allocated across seller pro-rata by each vault's short quantity during seller settlement. Seller settlement amounts MUST be rounded down, any resulting dust MUST remain in the `Series` PDA token account.

For ATM or OTM series, sellers receive original collateral back.

For ITM calls where all short quantity was manually exercised completed, sellers receive `QuoteCoin` proceeds for the seller's full short quantity.

For ITM puts where all short quantity was manually exercised completed, sellers receive `BaseCoin` proceeds for the seller's full short quantity.

For ITM settled series where remaining unexercised quantity exists sellers receive mixed settlement:
- exercised portion as exercise proceeds,
- unexercised portion as original collateral.

Seller settlement MUST abort if:
- series is not settle-ready,
- seller vault record in the requested batch is already closed,
- series does not exist,
- settlement arithmetic would overdraw the internal `Series` balance of base or quote tokens.

Rounding dust MUST remain in the `Series` PDA  and MUST be recoverable only through operator recovery after `series.state == Closed` and `now >= series.exercise_window_end_ms` and all seller payouts, manual exercises for given `Series` are fully accounted and settled, only the remaining unreserved balance may be recovered.

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

At all times, each `Series` PDA accounted balances MUST be greater than or equal to the active obligations required by that option series.

For each series:
- `total_manual_exercised_quantity <= total_short_quantity`,
- manually exercised MUST burn `Long` token.
- `SellerVault` short quantities MUST sum to series total short quantity, excluding settled vaults only after their obligations are paid,
- pool transfers MUST use only the balance that `Series` PDA,
- pool transfers MUST never exceed accounted balances.

The contract MUST use checked arithmetic.

Quantity and payment calculations SHOULD use `u128` or wider intermediate arithmetic where needed.

## Pause

The operator pause MUST be applied per market.

When a market is paused:
- series creation MUST be disabled,
- underwriting MUST be disabled,
- operator recovery MAY be enabled,
- price finalization MUST be disabled
- exercise MUST be disabled
- settlement MUST be disabled

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
- `finalize_one_series`
- `finalize_two_series`
- `finalize_four_series`
- `finalize_eight_series`
- `exercise`
- `settle_sellers_batch`
- `pyth_oracle_unverifiable::create_expiry_price`

## Non-Goals For MVP

MVP MUST NOT implement:
- American exercise
- pure cash-settlement
- naked options
- cross collateral

## Main Design Trade-offs

The design chooses seller vault records over transferable writer tokens to keep seller accounting simple and settlement permissionless.

The design chooses transferable long SPL so options remain composable and tradeble outside the options contract.
