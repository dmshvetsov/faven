# Product Specification

Purpose: define specification of all parts of option trading on-chain protocol with off-chain application user interface and off-chain server infrastructure, where assets settlement logic implemented in the on-chain protocol and taker/maker logic in the off-chain users facing web application (aka client) and server infrastructure.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and `OPTIONAL` in this document are to be interpreted as described in RFC 2119.

## Product Language

This document uses `./DOMAIN-LANGUAGE.md` as way to describe option trading specific parts of the product used by business and technical members.

## What the protocol does

The protocol facilitates trades between two parties, "DeFi participants" as takers or option sellers and makers "Market Makers" as option buyers, these are two types of application users

Takers are selling options, thus they are protocol option sellers. Makers buying options, thus they are protocol option buyers.

Process in high-level flow for takers:
- taker visits the protocol web application (UI)
- taker picks contract type "covered call" or "cash secured put" and contract expiration date weekly or monthly
- taker use the protocol web application to receive best quote from integrated to the protocol makers for given contract type call/put, asset collateral, cash token and expiration date
- taker agrees to a quote and signs a blockchain transaction with maker's buy order and 
- protocol server broadcasts it to Sui Blockchain

Process in high-level flow for makers:
- maker integrates their API to the protocol server by implementing an endpoint(s) that returns quotes for takers
- maker meets protocol eligibility requirements to participate in RFQ flow by depositing minimal `QuoteCoin` amount of to their on-chain buyer vault
- maker provides signed quotes for taker
- maker signs orders for quotes terms that takers chosen to underwrite (sell) an option, taker underwrite transaction with maker's order executed on-chain according to `spec/OPTIONS_SMART_CONTRACT.md`

## Technical Stack

- Sui blockchain, and Move Language for smart contracts,
- Cloudflare (workers, durable object, cache API, cron, queues) written in TypeScript
- Hono JavaScript/TypeScript Web application framework
- Cloudflare D1 database

### Token

The on-chain token model is specified in `spec/OPTIONS_SMART_CONTRACT.md`.

### Ticker schema

`<oracle base coin symbol 3-5 chars>-<oracle quote coin symbol also used as "cash" token 3-5 chars>-<base coin symbol 3-5 chars>-<DDMMMYY format expiration date>-<strike price either flaoting point number 0. or whole 150 but not both>-<call/put marker C or P char>`

Ticker schema examples:
- `BTC-USDT-WBTC-5JUN26-75000-C` options uses $BTC price, $USDT quote "cash" for premium, $WBTC base coin as collateral in Call option with expiration date 5 June 2026 and strike price 75000 in $USDT
- `BTC-USDT-WBTC-28AUG26-68000-P` options uses $BTC price, $USDT quote "cash" for premium and deposit, $WBTC as base coin in Put option with expiration date 28 August 2026 and with strike price 68000 in $USDT
- `BTC-USDC-HBTC-5JUN26-68000-P` options uses $BTC price, $USDC quote "cash" for premium and deposit, $HBTC (hashi BTC) as base coin in Put option with expiration date 5 June 2026 and with a strike price 68000 in $USDC
- `BTC-USDC-TBTC-5JUN26-1002000-C`
- `SUI-USDC-SUI-5JUN26-0.97-C` options uses $SUI price, $USDC quote for base $SUI and "cash" for premium, $SUI base coin as collateral
- `SUI-USDC-HASUI-5JUN26-0.72-P`
- `DEEP-USDC-DEEP-5JUN26-0.035-C`

## 1. Smart Contracts (on-chain protocol)

The smart contract design, object model, underwriting, exercise, settlement, and event requirements are specified in `spec/OPTIONS_SMART_CONTRACT.md`.

## 2. Server (Off-chain infrastructure)

### 2.1 Database

#### makers_vaults table

Cache for on-chain BuyerVault

- vault_id: primary key, links one row to one on-chain maker vault
- created_at: timestamp
- updated_at: timestamp
- deleted_at: soft-delete timestamp marker
- owner_address
- quote_coin_type: exact Sui coin type for the vault
- quote_coin_symbol: display/admin convenience
- enabled: admin ON/OFF flag for RFQ participation, marks this vault as ready for market maker participation in the protocol
- quote_endpoint_url: where RFQ asks this maker for quotes
- order_endpoint_url: where RFQ asks this maker for orders

#### underwrites table

Stores every underwrite transaction records submitted by sellers.

- `underwrite_id`: primary key UUID
- `created_at`: when the underwrite row was first created
- `updated_at`: last server-side change time for status or payload updates
- `quote_id`: links the accepted underwrite to makers provided quote_id
- `taker_address`: seller wallet address used in `OrderV1` and UI filtering
- `market_id`: on-chain market object id used to build and validate the underwrite transaction
- `series_id`: on-chain series object id used to build and validate the underwrite transaction
- `buyer_vault_id`: on-chain buyer vault that pays premium
- `buyer_owner_address`: expected signer address that must match the env-key-derived address
- `call_put_marker`: tells server whether to build covered call or cash-secured put underwrite path
- `contracts_qty_decimals`: accepted option size in base units
- `strike_price_decimals`: strike carried into order build and validation
- `expiry_unix_ms`: expiry copied into order and checked for staleness
- `cash_premium_per_contract`: premium used to build `OrderV1` and show UI summary
- `quote_payload_json`: snapshot of accepted quote for audit and rebuild safety
- `quote_signature`: stored quote signature if present so server can verify/audit later
- `order_payload_json`: canonical order fields the server built before signing
- `order_signature`: signed `OrderV1` signature sent on-chain
- `order_public_key`: public key paired with the env private key, sent on-chain and used for checks
- `order_hash`: optional cached hash for app-side tracking/debugging, though on-chain recomputes it
- `status`: lifecycle state like `pending`, `queued`, `submitted`, `confirmed`, or `failed`
- `failure_internal_code`: short machine-readable internal RFQ server reason when processing fails
- `failure_msg`: human-readable error details for logs only (can be external error message or internal RFQ error message)
- `broadcast_queue_message_id`: lets server correlate the row with the queued broadcast job
- `tx_digest`: final submitted Sui transaction digest once broadcast succeeds

Must be use together with `underwrite_audit`

#### underwrite_audit table

Stores every underwrite status changes

- `id`: auto-increment row id for ordered history entries
- `created_at`: when this history event was written by the server
- `underwrite_id`: links the history event to one underwrite row
- `status`: lifecycle state written at that step like `pending`, `queued`, `submitted`, `confirmed`, or `failed`

#### option_series table

Stores created series data.

Stores one row per option series with the latest settlement progress. Used by the server to know if a series is only price-finalized, partly settled, or fully closed. Also gives the dashboard a simple source for "pending settlement" vs "settled".


- `series_id` On-chain object id of the series. Main primary key.
- `created_at` When this row was first saved in D1. Used for audit and debugging.
- `updated_at` Last time this row changed in D1. Used to know if cached data is stale.
- `oracle` Name of the oracle
- `oracle_feed_id` ID of the oracle price feed
- `market_id` On-chain market object id this series belongs to. Used to list series under one market.
- `create_tx_digest` Transaction digest that created the series. Useful for audit, support, and linking back to chain activity.
- `option_type` `1` for call, `2` for put.
- `strike_price_decimals` Strike price in integer decimal form. Used for display, filtering, sorting, and duplicate checks.
- `strike_scale` Precision scale for strike price. Helps convert stored integer strike into a user-facing number correctly.
- `expiry_unix_ms` Expiry time in milliseconds. Used to filter expired vs open series and to validate underwriting is still allowed.
- `exercise_window_end_ms` End of manual exercise window. Used later for settlement/exercise UX and automation.
- `exception_window_end_ms` End of exercise-by-exception window. Used to know when final settlement can happen.
- `quote_coin_type` Full Sui coin type for quote coin. Used by app/server to match supported assets and display market terms.
- `quote_decimals` Decimal precision of quote coin. Used to format premiums, strike, and payouts.
- `base_coin_type` Full Sui coin type for base coin. Used to show collateral asset and validate series/market compatibility.
- `base_decimals` Decimal precision of base coin. Used to format contract size and collateral amounts.
- `max_operational_fee_bps` Max allowed fee in basis points from the series config. Used by server checks before building orders or underwrites.
- `expiry_price_decimals` Final expiry price once series is finalized. Used for settlement views and PnL display.
- `expiry_price_publish_time_ms` Oracle publish time for final expiry price. Used for audit and stale price checks.
- `settled_at` shows when all known D1 sellers for this series have final payout rows in `seller_payouts`
- `total_short_qty_decimals` needed to compare total written size vs exercised/settled size
- `total_exercised_qty_decimals` needed to know how much was manually exercised
- `total_exercised_exception_qty_decimals` needed to know how much was settled by exception flow
- `settled_seller_count` useful for progress and audit
- `closed_at` tells when the on-chain series close action happened. This is separate from D1 seller settlement completion.
- `close_tx_digest` transaction digest for the series close action

### seller_payouts

Stores the final seller settlement result per `(series, seller)`. Used by the dashboard to show a seller position as truly settled and what assets the seller received.

- `series_id` links payout to the settled option series
- `seller_address` identifies which seller got this payout
- `settled_at` shows when this seller payout was recorded
- `settlement_tx_digest` links the payout to the on-chain settlement tx
- `short_contracts_quantity` stores how much seller size this payout covers in base units
- `base_paid_decimals` stores how much base asset was paid back to seller
- `quote_paid_decimals` stores how much quote asset was paid to seller
- `payout_kind` explains the result shape like `expired_otm_or_atm`, `itm_full`, or `itm_mixed`
- PK `(series_id, seller_address)`
- writes MUST be idempotent. Replaying the same payout is allowed only when all stored values match.

### series_settlement_batches

Stores each seller settlement batch execution. Used for dedupe, audit, settlement history, cron/debugging, admin fallback, and aggregate stats.

- `batch_hash` primary key. Deterministic hash of `series_id` and the sorted seller address list `settle:${series_id}:${hash(sorted sellers)}`
- `created_at` shows when the batch was first recorded
- `updated_at` shows when the batch last changed
- `submitted_at` shows when the batch transaction was submitted
- `confirmed_at` shows when the batch was confirmed and persisted
- `series_id` links the batch to the affected series
- `status` lifecycle state: `pending`, `submitted`, `confirmed`, or `failed`
- `last_source` last executor that touched this row, for example `cron` or `admin-cli`
- `seller_addresses_json` JSON array of seller addresses included in this batch
- `tx_digest` links the batch to the exact chain tx. Must be unique when not null.
- `settled_seller_count` shows how many sellers were processed in this batch
- `base_paid_total_decimals` stores total base asset paid in the batch
- `quote_paid_total_decimals` stores total quote asset paid in the batch
- `error` last failure message, for operator/debug use

### OPTIONAL series_finalizations

OPTIONAL table. Stores one expiry finalization attempt/result per option series. 

- `series_id` primary key and link to `option_series`
- `created_at` when the row was first created
- `updated_at` when the row last changed
- `submitted_at` when the transaction was submitted
- `confirmed_at` when the finalization was confirmed and persisted
- `status` lifecycle state: `pending`, `submitted`, `confirmed`, or `failed`
- `last_source` last executor that touched this row, for example `admin-cli`
- `expiry_price_decimals` final expiry price submitted on-chain
- `expiry_price_publish_time_ms` publish time used for the final price
- `tx_digest` finalization transaction digest.
- `error` last failure message, for operator/debug use

### OPTIONAL underwrite_payout_allocations

OPTIONAL table. Only needed if we want exact settled amount per individual underwrite row, not just per seller per series. Without this table, payout can be shown per seller position group and allocated pro-rata in reads.

- `settled_at` shows when allocation was written
- `underwrite_id` links allocation to one underwrite row
- `series_id` helps validate allocation belongs to the same series
- `seller_address` helps validate allocation belongs to the same seller
- `settlement_tx_digest` links allocation to the settlement event
- `base_paid_decimals` stores this underwrite's base payout share
- `quote_paid_decimals` stores this underwrite's quote payout share

### 2.2 RFQ and CRUD API Server

Responsible to handle create, read, update, delete actions on the server database that required to facilitate main activity of the protocol explained in `## What the protocol does`

Implemented using Cloudflare Workers infrastructure.

MUST implement API for:
- request for quote using active makers quote URL stored in marker vaults table
- ask maker to sign a buy order based on previously provided quote
- user dashboard of sold option contracts open, expired, exercised
- makers API to create, read, update, delete vaults data
  - create a vault using a Sui on-chain transaction id (digest) of create_vault call, must store makers vault data in the server database makers vaults table
  - read must be from the database, except balance read must be from chain
  - update must only support editing URLs for quote endpoint and order endpoint
  - mark vault record as soft-delete and `enabled: false` when owner submits an on-chain transaction id (digest) of close_vault call, closed/soft-deleted vaults cannot be edited or used by makers
- request for required parameters to build a Sui PTB for takers to underwrite an option contract for a given quote
- Server-operated seller settlement triggered by Cloudflare Scheduled job (Cron), with admin-cli fallback for finalization and manual settlement; no seller-facing or admin HTTP settlement API in MVP
- submitting transaction on-chain by web app

MUST use Cloudflare Durable Object as a way to store provided quotes and their expiration.

#### How Integration with Market Makers works

Makers API MUST implement endpoint to receive quote API calls to be able to provide time bound contracts quantity bound quotes

Makers API MUST implement endpoint to receive order API calls to be able to provide buy orders

Makers MUST use a wallet associated with their protocol account to sign quotes and orders.

Makers MUST sign quotes with the wallet used to create `BuyerVault`.

Makers as a buyer MUST sign off-chain non transaction buy order messages with takers size and taker address. Order signature and public key used to sign it MUST be submitted on-chain and logged in underwrite event. Public key must be owner of the Maker vault that will be used to pay for buy order.

Maker `QuoteV1` signed messages MUST be treated as reusable, short-lived off-chain offers to buy options and MUST NOT authorize premium payment and/or token purchase. A maker MUST authorize `Long` buy and authorizes payment of the specified premium only by signing `OrderV1`.

`OrderV1` MUST include the exact `operational_fee` and `fee_recipient` authorized by the maker. Clients MUST NOT be able to change fee amount or fee receiver when building the underwriting transaction.

The same signed quote MAY be used by multiple takers while `offerValidUntilUnixMs` has not passed or `offerValidUntilTotalContractsQty` is not exceeded and on-chain underwriting requirements can be satisfied. When RFQ server sends a transaction to Broadcaster it MUST deduct order quantity from current quote `offerValidUntilTotalContractsQty`, RFQ MUST not track if transaction was actually broadcasted on-chain thus the server does not guarantees to maker that his quote will be filled right up to `offerValidUntilTotalContractsQty`. RFQ server MUST NOT send more contracts quantity than `offerValidUntilTotalContractsQty` of current quote.

#### Signed quote and order messages

Quotes and orders MUST be signed as versioned BCS structs: `QuoteV1` and `OrderV1`. Field order MUST be exactly the order shown in `MakerQuoteV1` and `MakerOrderV1`. String amounts MUST be parsed as base-unit unsigned integers before BCS serialization. Addresses MUST use canonical Sui address bytes. Missing, null, extra, floating-point, or wrongly scaled fields MUST be rejected.

Each signed struct MUST include a `domain` field. Quote domain MUST be `otp:quote:v1`. Order domain MUST be `otp:order:v1`.

Signature scheme for v1 MUST be Sui personal-message signing over the BCS bytes with Ed25519 keys. RFQ server MUST verify `MakerQuoteV1` and `MakerOrderV1` signatures.

RFQ server MUST send quote to the Makers order endpoint only for maker that created this quote.

For the MVP BTC/USDC market, RFQ server MUST accept only option expiries that happen at 08:00 UTC on Fridays, up to and including the last Friday of the next calendar month.


```
type QuoteRequest = {
  request: {
    oracle_base_symbol: string      // for example eBTC
    oracle_quote_symbol: string     // for example USD
    oracle_feed_id: string          // Pyth BTC/USD feed
    collateral_token_address: string
    collateral_token_decimals: number
    cash_token_address: string // also will be used to pay premium
    cash_token_decimals: number
    call_put_marker: 1 | 2 // u8 1: call 2: put
    long_short_marker: 1 | 2 // u8 1: long (buy option) 2: short (sell option)
    strike_price_decimals: string // uses configured Pyth oracle exponent
    expiry_unix_ms: number
    contracts_qty_decimals: string // uses collateralTokenDecimals, always measured in BaseCoin size
  }
}
```

```
type MakerQuoteV1 = {
  domain: 'otp:quote:v1'
  quote_id: string; // 36 chars long max
  oracle_base_symbol: string      // for example eBTC
  oracle_quote_symbol: string     // for example USD
  oracle_feed_id: string          // Pyth BTC/USD feed
  collateral_token_address: string // must match quote request
  collateral_token_decimals: number
  cash_token_address: string // must match quote request, also will be used to pay premium
  cash_token_decimals: number
  call_put_marker: 1 | 2 // u8 1: call 2: put, must match quote request
  long_short_marker: 1 | 2 // u8 1: long (buy option) 2: short (sell option), must match quote request
  strike_price_decimals: string // uses configured Pyth oracle exponent, must match quote request
  expiry_unix_ms: number
  signer: string // EOA wallet that manages maker protocol account
  cash_premium_per_contract: string // premium per 1 option contract in premium token decimals, cashTokenAddress is used for premium
  offer_valid_until_total_contracts_qty_decimals: string // must be >= contractsQtyDecimals of the request, uses collateralTokenDecimals
  offer_valid_until_unix_ms: number
  maker_id: string // uniq maker id created in the protocol database
}
```

```
type QuoteResponse = {
  quote: MakerQuoteV1
	quote_signature: string // signature of canonical QuoteV1 BCS bytes
}
```

```
type ExecutionRequest = {
  quote: QuoteResponse['quote']
	signature: string // signature of canonical QuoteV1 BCS bytes
  contracts_qty_decimals: string // uses collateralTokenDecimals, always measured in BaseCoin size
  taker_address: string
}
```

```
type MakerOrderV1 = {
  domain: 'otp:order:v1'
  taker_address: string // must match ExecutionRequest.taker_address, on-chain seller address
  market_id: string,
  call_put_marker: 1 | 2 // u8 1: call 2: put, must match quote request
  side_marker: 1 | 2 // u8 1: long (buy option) 2: short (sell option), must match quote request
  strike_price_decimals: string // uses configured Pyth oracle exponent, must match quote request and derived vault
  expiry_unix_ms: number // unix milliseconds
  contracts_qty_decimals: string // uses collateralTokenDecimals, always measured in BaseCoin size
  cash_premium_per_contract: string // premium per 1 option contract in premium token decimals
  operational_fee: string // absolute fee amount in premium token base units
  fee_recipient: string // protocol fee receiver address
  good_till_unix_ms: number // unix milliseconds
  maker_vault_id: string // uniq maker vault id created in the protocol
  signer: string // EOA wallet address that manages maker protocol account
}
```

```
type SignedMakerOrderV1Response = {
  order: MakerOrderV1
  signature: string // signature of canonical MakerOrderV1 BCS bytes
  public_key: string // public_key that signed the MakerOrderV1 and owns maker vault specified in MakerOrderV1
}
```

`MakerQuoteV1` is used only off-chain.

`MakerOrderV1` type is used to produce corresponding on-chain `OrderV1` object using Sui BCS, exact match of fields names between the two objects MAY NOT required because of nature of BCS, order of fields MUST match between the two objects. Names for `MakerOrderV1` are taken to better represent the off-chain domain of the application.

`offerValidUntilTotalContractsQty` MUST be tracked by RFQ server and is not validated on-chain.

`orderHash` MUST be `blake2b256(bcs(OrderV1))`, including signed fee fields. Smart contracts MUST compute `orderHash` from canonical `OrderV1` BCS bytes and MUST NOT trust a caller-provided hash.

#### Seller Settlement Cron Job

Cron settlement only starts after `option_series.expiry_price_decimals` is set.

Cron MUST create pending settlement batches only for finalized series where `exception_window_end_ms` has passed and at least one confirmed seller is missing from `seller_payouts`. Sellers are queried from confirmed `underwrites`, excluding sellers already present in `seller_payouts`, and split into batches of up to 20 sellers.

Cron MUST only enqueue pending batches. Failed batches require explicit admin retry.

#### Environment variables

- `OTP_PACKAGE_ID` protocol package id, MUST be used to derive addresses to read and write (send transactions) on-chain data
- `SUI_RPC_URL` fullnode JSON-RPC URL used by the RFQ server queue consumer to execute transactions
- `MAKER_STUB_PRIVATE_KEY` private key used by the development maker stub to sign orders; configure it as a Worker secret and never commit its value

#### Broadcasting transactions on-chain

MUST implement Cloudflare queues for transaction submission where sequential processing is required by shared on-chain object access. All transactions that require sequential broadcasting MUST use broadcast queue to submit transaction on-chain. Transaction that do not require strict sequential order MAY NOT use broadcast queue but free to use it anyway if it simplifies the application design and maintainability.

RFQ server runs one in-flight transaction per configured queue partition, waits for finality, and persists receipt-driven state before acknowledging the message.

## 2.4 Web App (Off-chain decentralized application with UI)

User interface for takers and makers.

MUST be mobile fist application.

MUST implement following pages:
- Home page with supported assets and call to action to earn instant payout (premium) for selling cash secured put and covered calls
- Taker option request for quotes builder page for a selected asset and contract type, including strike selection, expiry selection, position size input, collateral requirements, quoted premium, oracle spot price, expected expiry outcome of the contracts if price stay above and below-or-equal to strike. Must request another quote if current expires. Must have a CTA that triggers an underwrite on-chain transaction.
- Taker dashboard page showing open positions with indication what will happen if expiration and settlement will be now, settled positions, expired positions, pending settlement, with data for position: spot/current oracle price (if open position) otherwise price at expiration, strike, premium
- Maker dashboard page consist off
  - positions tab/sub-page: showing open positions, ITM/OTM status, required settlement funds, settlement readiness, and settlement history
  - vaults tab/sub-page: showing list of makers vaults and their state, balances, UI to edit and close vaults

Home page and Taker UI MUST use simple language. MUST NOT mention of options or derivatives.

Maker UI MUST use professional option trader language.

MUST use RFQ server broadcast queue to submit transaction on-chain that requires sequential order. MUST use RFQ server to broadcast other transactions on-chain to simplify the design.

## Oracles

MUST use Pyth Sui API oracle to submit prices at time of expiration on-chain.

MUST use Pyth Hermess off-chain client to fetch prices for assets.

### Supported Markets

List of supported QuoteCoin:
- USDC
  - mainnet `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`
  - testnet `0x7751ad73b7801f4bab9a18541e03cfed2199caccc8ffe36c368126833f2974e3::test_usdc::TEST_USDC` a custom testUSDC coin

#### testnet

List of supported OracleBase / BaseCoin / QuoteCoin pairs and their oracles:
- OracleBase: BTC / QuoteCoin: tUSDC / BaseCoin tBTC
  - base coin  `0xced54dfe52c5b65a36379260763116faf14bbb0f1c7e0be0a4650d023b0c579e::test_btc::TEST_BTC`
  - quote coin `0x7751ad73b7801f4bab9a18541e03cfed2199caccc8ffe36c368126833f2974e3::test_usdc::TEST_USDC`
  - Pyth oracle: `Crypto.BTC/USD` symbol and price feed id `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43`
  - 1 option contract = 1 BTC
  - min position size purchase is 0.005 BTC option contract, step 0.005 BTC means that next higher min purchase will be 0.01 BTC, then 0.015 BTC, purchases must be multiplies of 0.05
  - max position size 1 BTC

#### mainnet

TBD

## Premium

Always paid in `QuoteCoin` "cash" token of option contract.

## Protocol Fees

Protocol fees MUST not be disclosed in seller/taker UI. Fees are paid from the premium token. RFQ server MUST calculate the absolute `operational_fee` from configured fee basis points and put both `operational_fee` and `fee_recipient` into signed `OrderV1`.

## Vault minimal required amount to be eligible

Handled case by case by in business agreement between admins/operators of the application with market makers

## Admin access

Administrators must authorize changes in server database with `wrangler d1 execute` commands that are wrapped in CLI utility that expose available administrative actions. Authentication and authorization is delegated to Cloudflare/wrangler login, thus administrators must have Cloudflare access to run D1 queries.

`wrangler d1 execute` `--env` flag must be used to run commands against

## Application environments

Cloudflare server workers must work in following environments

- `development:devnet` environment for development that does not contain real users data, with local database
- `development:testnet` environment for development that may contains real users data that is not guaranteed to be preserved over product iterations and Sui tetnet network iterations, this data has lower value in comparison to real production users data
- `staging:testnet` testing and demo environment that may contains real users data that is not guaranteed to be preserved over product iterations and Sui tetnet network iterations, this data has lower value in comparison to real production users data
- `production:mainnet` production environment with real users data in database and Sui mainnet network

Wrangler configuration JSONC file must be configured so: 
- top-level configuration is `development:testnet` with remove staging d1 database
- `localdevelopment` cloudflare/wrangler env is for `development:devent` and local d1 database
- `staging` cloudflare/wrangler env is for `staging:testnet`
- `production`

## Features and User Stories

### Maker on boarding and Maker quote and buy order issuing readiness 

- as a maker i want to visit special for market makers hidden page "Maker Dashboard" on web UI to see my status: my open vaults for the currently connected wallet and their balances, these vaults statuses approved/not for issuing quotes and orders against these vaults, current URL for quote endpoint, current URL for order endpoint
- as a maker on my web app dashboard i want to sign create_vault transaction and submit it to RFQ server so i can create a new vault with a specific QuoteCoin (from the list of available to trade QuoteCoin), with quote endpoint URL for RFQ server, with order endpoint URL for RFQ server 
- as a maker on my web app dashboard i want to sign deposit transaction and submit it to RFQ server, to deposit or withdraw correspond QuoteCoin from a vault that I own to vault owner wallet
- as a maker on my web app dashboard I want to submit a HTTP form to update RFQs server quote and order endpoints URLs for a specific vault
- as a maker on my web app dashboard i want to sign close_vault transaction and submit it to RFQ server to close a specific vault

- as server admin I want to issue a wrangler CLI command with specific maker vault id to switch its ability on/off to receive RFQs, thus issue quotes and buy orders for a specific maker's vault

## Unspecified Requirements and out off scope

If requirement is not specified it MUST NOT be built.

Out of scope of off-chain infrastructure implementation:
- indexing on-chain events of the protocol
- database freshness updates for table records that represent on-chain objects and state, manual re-indexing and backfills MAY be used instead
