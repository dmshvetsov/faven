# Product Specification

Purpose: define specification of off-chain system that connects to option trading on-chain protocol, where assets management and settlement logic implemented in the on-chain protocol and seller/buyer matching logic implemented in the off-chain users facing web application and server infrastructure (further just infra).

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and `OPTIONAL` in this document are to be interpreted as described in RFC 2119.

## Product Language

This document uses `./DOMAIN-LANGUAGE.md` as way to describe option trading specific parts of the product used by business and technical members.

## What the protocol does

The protocol facilitates trades between two parties, "DeFi participants" as option sellers that uses web application UI and option buyers connected with web-sockets to request-for-quote server (rfq-server), these are two types of application users.

Process in high-level flow for option seller:
- seller visits the web application (UI)
- seller picks contract type "covered call" or "cash secured put", contract expiration date, strike price
- seller receive best quote from integrated to the protocol buyers for given contract type call/put, oracle/base/quote pair, cash token and expiration date
- seller agrees to a quote and signs a blockchain transaction
- the server infra broadcasts underwrite transaction to the blockchain

Process in high-level flow for buyers:
- Connect to `/rfqs/<asset>` to receive RFQ notifications and `/maker` to generate underwrite transactions and submit quotes.
- When an RFQ notification arrives, choose a premium, request a server-generated underwrite transaction, sign its unchanged bytes, and submit one blind quote with its expiry time.
- After aggregation, the seller receives the best buyer-signed transaction, adds its signature, and sends it to the server for broadcast. The buyer pays the quoted premium and receives the long option token.
- the server infra broadcasts underwrite transaction to the blockchain

## RFQ-server Technical Stack

RFQ-server MUST be implemented with:
- Cloudflare (workers, durable object, cache API, cron, queues) written in TypeScript
- Hono JavaScript/TypeScript Web application framework
- Cloudflare D1 database
- Drizzle ORM for all application reads and writes to D1

## On-chain settlement, expiration, asset management, and Long option token

The smart contract design, underwriting, long token design, options price finalization, exercise, settlement, and event requirements are specified in `spec/OPTIONS_SMART_CONTRACT.md`.

Solana v0 transactions MUST be used for all transactions.

## Ticker schema

`<oracle base coin symbol 3-5 chars>-<oracle quote coin symbol also used as "cash" token 3-5 chars>-<base coin symbol 3-5 chars>-<DDMMMYY format expiration date>-<strike price either flaoting point number 0. or whole 150 but not both>-<call/put marker C or P char>`

Ticker schema examples:
- `BTC-USDT-WBTC-5JUN26-75000-C` options uses $BTC price, $USDT quote "cash" for premium, $WBTC base coin as collateral in Call option with expiration date 5 June 2026 and strike price 75000 in $USDT
- `BTC-USDT-WBTC-28AUG26-68000-P` options uses $BTC price, $USDT quote "cash" for premium and deposit, $WBTC as base coin in Put option with expiration date 28 August 2026 and with strike price 68000 in $USDT
- `BTC-USDC-HBTC-5JUN26-68000-P` options uses $BTC price, $USDC quote "cash" for premium and deposit, $HBTC (hashi BTC) as base coin in Put option with expiration date 5 June 2026 and with a strike price 68000 in $USDC
- `BTC-USDC-TBTC-5JUN26-1002000-C`
- `SUI-USDC-SUI-5JUN26-0.97-C` options uses $SUI price, $USDC quote for base $SUI and "cash" for premium, $SUI base coin as collateral
- `SUI-USDC-HASUI-5JUN26-0.72-P`
- `DEEP-USDC-DEEP-5JUN26-0.035-C`

## 1 Server (Off-chain infrastructure)

### 1.1 Database

#### underwrites table

Stores every underwrite transaction records submitted by sellers.

The primary key MUST be `(tx_signature, ix_index)`:

- `tx_signature` is the seller fee-payer signature and Solana transaction identifier.
- `ix_index` is the zero-based index of the underwrite instruction in that transaction.

Must be use together with `underwrite_audit`

#### underwrite_audit table

Stores every underwrite status changes

- `id`: auto-increment row id for ordered history entries
- `created_at`: when this history event was written by the server
- `tx_signature` and `ix_index`: link the history event to one underwrite table row
- `status`: lifecycle state written at that step like `pending`, `queued`, `submitted`, `confirmed`, or `failed`

#### option_series table

Stores created series data.

Stores one row per option series with the latest settlement progress. Used by the server to know if a series is only price-finalized, partly settled, or fully closed. Also gives the dashboard a simple source for "pending settlement" vs "settled".

Table schema TODO

### seller_payouts

Stores the final seller settlement result per `(series, seller)`.

- TODO find out PK
- `seller_address` identifies which seller got this payout
- `settled_at` shows when this seller payout was recorded
- `settlement_tx_hash` links the payout to the this seller on-chain settlement tx
- `short_quantity` stores how many seller contracts this payout covers in base units
- `base_paid_decimals` stores how much base asset was paid back to seller
- `quote_paid_decimals` stores how much quote asset was paid to seller
- `payout_kind` explains the result shape like `expired_worthless`, `itm_full`, or `itm_mixed`
- `seller_settlement_batch` PK series_settlement_batches

Table writes MUST be idempotent. Replaying the same payout is allowed only when all stored values match.

### series_settlement_batches

Stores each seller settlement batch execution. Used for dedupe, audit, settlement history, cron/debugging, admin fallback, and aggregate stats.

- TODO find out PK
- `created_at` shows when the batch was first recorded
- `updated_at` shows when the batch last changed
- `submitted_at` shows when the batch transaction was submitted
- `confirmed_at` shows when the batch was confirmed and persisted
- TODO find how to link to series table
- `status` lifecycle state: `pending`, `submitted`, `confirmed`, or `failed`
- `triggered_by` last executor that touched this row, for example `cron` or `admin-cli`
- `tx_hash` links the batch to the exact chain tx. Must be unique when not null.
- `settled_seller_count` shows how many sellers were processed in this batch
- `base_paid_total_decimals` stores total base asset paid in the batch
- `quote_paid_total_decimals` stores total quote asset paid in the batch
- `error_message` last failure message, for operator/debug use

### series_finalizations

Stores one expiry finalization attempt/result per option series. 

- TODO find out PK
- `created_at` when the row was first created
- `updated_at` when the row last changed
- `submitted_at` when the transaction was submitted
- `confirmed_at` when the finalization was confirmed and persisted
- series uniq identifier
- `status` lifecycle state: `pending`, `submitted`, `confirmed`, or `failed`
- `triggered_by` last executor that touched this row, for example `admin-cli`, or `cron`
- `expiry_price_decimals` final expiry price submitted on-chain
- `tx_hash` finalization transaction hash.
- `error_message` last failure message, for operator/debug use

### OPTIONAL underwrite_payout_allocations

OPTIONAL table. Only needed if we want exact settled amount per individual underwrite row, not just per seller per series. Without this table, payout can be shown per seller position group and allocated pro-rata in reads.

- `settled_at` shows when allocation was written
- `underwrite_id` links allocation to one underwrite row
- `series_id` helps validate allocation belongs to the same series
- `seller_address` helps validate allocation belongs to the same seller
- `settlement_tx_hash` links allocation to the settlement event
- `base_paid_decimals` stores this underwrite's base payout share
- `quote_paid_decimals` stores this underwrite's quote payout share

### 1.2 RFQ and CRUD API Server

MUST implement API for:
- RFQ WebSocket
- sellers dashboard of sold option contracts open, settled
- Server-operated seller settlement triggered by Cloudflare Scheduled job (Cron) for finalization and settlement; no seller-facing or admin HTTP settlement API in MVP
- queueing and broadcasting transactions, used to update

MUST use Cloudflare Durable Object as a way to store provided quotes and their expiration.

#### Indexing

Out of the scope. The server stores data in the database using broadcasting queue. Admin CLI commands to backfill missed data to database for underwrites events, series events, exercies, settlement and payouts.

#### How Integration with buyers works

Buyers connects to public WebSocket API. No authentication is needed.

#### RFQ and buyer quotes

See [BUYER-API.md](./BUYER-API.md) and [SELLER-API.md](./SELLER-API.md).

#### RFQ flow

Request, response, notification refers to WebSocket JSON-RPC 2.0 request, response and notification.

RFQ is short-lived. The server uses one fixed 2.5-second aggregation window.
It begins when the server fans out the RFQ notification. The server MUST reject
`underwriteTx.generate` and `quote.submit` after the deadline with error `1005`.

1. Seller sends `rfq.create` to `/taker`. `params` contains a seller-generated
   UUIDv7 `rfqId`, market address, call/put marker, expiry, strike, quantity,
   seller, and seller collateral source. The JSON-RPC `id` is only request and
   response correlation.
2. The server routes creation to the RFQ Durable Object keyed by `rfqId`. It
   validates and stores canonical seller terms, fetches and stores
   `recentBlockhash` and `lastValidBlockHeight`, and rejects a reused `rfqId`.
3. The RFQ Durable Object fans out `rfq.request` as a JSON-RPC notification to
   all buyers connected to `/rfqs/<asset>`. Its params follow BUYER-API.md and
   include `rfqId` plus priceable terms, but not seller or seller collateral
   source.
4. A buyer may call `underwriteTx.generate` before the deadline with `rfqId`,
   premium, maker, and buyer quote source. The server generates a Solana v0
   transaction with inline accounts only. It adds `create_series` when the
   series does not exist and records the generated message for later matching.
   A buyer may generate multiple transactions.
5. The buyer validates and signs an unchanged generated transaction, then sends
   `quote.submit`. A maker may have only one accepted blind quote per RFQ across
   all connections. The quote must reference a previously generated message,
   use a `validUntil` no more than 40 seconds ahead and later than the
   aggregation deadline, and include the buyer signature.
6. The server responds with the current quote status. It selects the highest
   premium; the earliest accepted quote wins a tie. When a different buyer
   displaces the current best quote, the server sends that buyer a best-effort
   `quote.outbid` notification.
7. At the deadline, the RFQ Durable Object sends the seller one private
   `quote.best` notification containing the selected signed transaction. When
   no quote was accepted, it sends `quote.best` with
   `noQuoteReason: "no_buyers"`.
8. The seller verifies the transaction, signs the unchanged bytes as fee payer,
   and sends `underwrite.submit`. The selected quote must still be valid. An
   expired selected quote makes the RFQ unsuccessful; the seller must start a
   fresh RFQ.
9. The server validates the exact v0 message against canonical seller terms and
   the recorded buyer quote, validates required signatures and account metas,
   simulates the final transaction, then broadcasts it unchanged.

The RFQ Durable Object MUST retain its canonical state, generated transaction
messages, accepted quotes, and terminal tombstone for two weeks. A seller
connection closing cancels every non-terminal RFQ from that connection; a
reconnected seller MUST create a new RFQ. A buyer disconnect does not remove an
already accepted quote, while outbid delivery remains best effort.

Known issues:
- Embedding `create_series` in a generated transaction remains subject to a
  deterministic-series race. `ensure_series` is out of scope for this rewrite.
- `buyer_quote_source` and `seller_collateral_source` may have insufficient
  funds when the transaction reaches the blockchain. This is expected; final
  simulation detects it, but the server does not reserve balances.

#### Seller Settlement Cron Job

Cron settlement must settle series with `option_series.expiry_price_decimals` is set.

Cron MUST create pending `series_settlement_batches` only for price finalized series where `exercise_window_end_ms` has passed and at least one seller is not settled for this series. Sellers are queried from confirmed `underwrites` table rows, excluding sellers already present in `seller_payouts`, and split into batches, batch size must be calculated from blockchain limits.

Cron MUST only enqueue pending batches. Failed batches require explicit admin retry.

#### Environment variables

TBD

#### Broadcasting transactions on-chain

MUST implement Cloudflare queues for transaction submission on-chain. All transactions that require sequential broadcasting MUST use the broadcast queue to submit transaction on-chain. Transaction that do not require strict sequential order MAY NOT use broadcast queue but free to use it anyway if it simplifies the application design and maintainability.

RFQ underwrite broadcasts use one queue with one in-flight transaction. The
worker simulates and submits each accepted signed transaction once, then waits
for `confirmed` commitment before acknowledging the message. A simulation,
send, or confirmation failure MUST be persisted as `failed` and acknowledged;
the worker MUST NOT retry the signed RFQ transaction. Before acknowledgement it
MUST persist the resulting on-chain state in database tables from the receipt
or emitted events.

## 2 Web App (Off-chain decentralized application with UI)

Implements user interface for takers and buyers.

MUST be mobile fist application.

MUST implement following pages:
- Home page (seller UI)
  - with supported assets and call to action to earn instant payout (premium) for creating (underwriting) "Sell higher" (covered call, aka CC) and "Buy lower" (cash secured put aka CSP) contracts; 
  - home page must has RFQ builder interface for a selected asset, contract type CC/CSP, including strike selection, expiry selection, position size input (contracts quantity), summary with collateral requirements, quoted premium, expected expiry outcome if price stay above and below-or-equal to strike. Must have a CTA that triggers an underwrite on-chain transaction.
- seller dashboard page showing open and settled contracts

Home page and seller UI MUST use simple language. MUST NOT mention of options or derivatives.

MUST use RFQ server broadcast queue to submit transaction on-chain that requires sequential order. MUST use RFQ server to broadcast other transactions on-chain to simplify the design.

## 3 Oracles

MUST use Pyth Hermess off-chain client to fetch prices for assets.

### Supported Markets

All possible permutations of `QuoteCoin` + `BaseCoin` listed below.

List of supported `QuoteCoin`:
- USDC
  - mainnet mint TBD
  - devenet mint TBD (must deploy custom tesnet coin that mimics UDSC)

List of supported BaseCoin and their corresponding oracles:
- wBTC
  - mainnet mint `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh`
  - devenet mint TBD (must deploy custom tesnet coin that mimics wBTC)
  - Pyth oracle: `Crypto.BTC/USD` symbol and price feed id `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43`
  - 1 option contract = 1 BTC
  - min position size purchase is 0.005 BTC option contract, step 0.005 BTC, means that next higher min purchase will be 0.01 BTC, then 0.015 BTC, purchases must be multiplies of 0.05
  - max position size 1 BTC

## Premium

Always paid in `QuoteCoin` "cash" token of option contract.

## Protocol Fees

Protocol fees MUST not be disclosed in seller UI. Fees are paid from the premium paid from buyer to seller. RFQ server MUST include configured `operational_fee_bps` and `fee_recipient` in underwrite transactions.

## Admin access

Administrators must authorize changes in server database with `wrangler d1 execute` commands that are wrapped in CLI utility that expose available administrative actions. Authentication and authorization is delegated to Cloudflare/wrangler login, thus administrators must have Cloudflare access to run D1 queries.

`wrangler d1 execute` `--env` flag must be used to run commands against

## Application environments

Cloudflare server workers must work in following environments

- `development:testnet` environment for development that does not contain real users data, with local database
- `development:devnet` environment for development that may contains real users data that is not guaranteed to be preserved over product iterations and the blockchain devnet network iterations, this data has low value in comparison to real production users data (connected to staging DB)
- `staging:devnet` testing and demo environment that may contains real users data that is not guaranteed to be preserved over product iterations and the blockchain devnet network iterations, this data has low value in comparison to real production users data
- `production:mainnet` production environment with real users data in database and the blockchain mainnet network

Wrangler configuration JSONC file must be configured so: 
- top-level configuration is `development:testnet` with remove staging d1 database
- `localdevelopment` cloudflare/wrangler env is for `development:devent` and local d1 database
- `staging` cloudflare/wrangler env is for `staging:testnet`
- `production`

## Unspecified Requirements and out off scope

If requirement is not specified it MUST NOT be built.

Out of scope off-chain infrastructure implementation:
- indexing on-chain events of the protocol
- database freshness updates for table records that represent on-chain objects and state, manual re-indexing and backfills MAY be used instead
