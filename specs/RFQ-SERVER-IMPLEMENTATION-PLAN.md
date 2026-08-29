# RFQ Server Implementation Handoff

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and `OPTIONAL` in this document are to be interpreted as described in RFC 2119.

## Product Language

This document uses `./DOMAIN-LANGUAGE.md` as way to describe option trading specific parts of the product used by business and technical members.

## Goal and scope

Implement `apps/rfq-server` as a TypeScript Cloudflare Worker using Hono,
Durable Objects, D1, and Cloudflare Queues. It coordinates non-custodial
Solana option underwrites.

This handoff covers RFQs, buyer offers, underwrite broadcasting, the
underwrite database, and seller dashboard reads.

Do **not** implement these items in this task:

- seller settlement, price finalization, Cron, or an admin CLI;
- Pyth Hermes or any other oracle client;
- Cache API;
- on-chain indexing or backfills;
- buyer allowlists, rate limiting, or WebSocket reconnect/resume support;
- the seller web application.

## Fixed product decisions

- Solana is the only target chain.
- The server never has authority to spend a seller's or buyer's tokens.
- The seller is the transaction fee payer. The buyer signs first in time;
  the seller signs the unchanged transaction afterwards.
- Buyers are unauthenticated. Their transaction signature identifies them.
- One RFQ must result in exactly one `underwrite_call` or `underwrite_put` instruction matching RFQ terms.
- A transaction may also contain exactly one matching RFQ terms `create_series` instructions, if series does not exists during RFQ.
- RFQs and offers are in-memory only. Do not write them to D1 or Durable
  Object storage. A disconnected seller sends a new RFQ after reconnecting.
- Buyer offers may not be used after `validUntil`; `validUntil` must be no
  more than 60 seconds in the future when the server receives quote request.
- Broadcast queue concurrency is one per deployed Worker environment. Do not
  partition by market or cluster.
- An underwrite is `confirmed` after Solana returns `confirmed` commitment;
  do not wait for `finalized` and do not require event indexing.

## RFQ flow

Request, response, notification refers to WebSocket JSON-RPC 2.0 request, response and notification.

RFQ is short-lived: aggregate, seller-review, signing, simulation, and broadcast must fit comfortably inside the solana blockhash validity time.

1. Seller sends underwriteTerms request (not RFQ yet) to → server with:
  - market address
  - call_put_marker / expiry / strike (used to derive option series address)
  - quantity of contracts to underwrite
  - seller account / seller_collateral_source account
3. Server creates RFQ request from seller underwriteTerms and fan-out this RFQ to → all buyer connected to Rfq.asset  `/rfqs/<asset>` WS connection, server stores recentBlockhash and lastValidBlockHeight that will be used for this RFQ.
3. Buyers produces Quote for this RFQ:
    3.1 Buyer send underwriteTx.generate request to build an underwriteTx and provides:
      - premium
      - buyer address, must match `Quote.maker`
      - buyer_quote_source address
    3.2 Server generates underwriteTx from RFQ params and provided by buyer params sends them back to buyer, if series does not exists server includes create_series instruction into the generated transaction
    3.3 Buyer validates underwriteTx, sings it, build Quote with signed underwriteTx and sends quote.submit request
4. Server responds if a quote was accepted and if a quote is currently best, if previously best quote was out-bided by a new quote then server sends notification to previous quote buyer that the quote for current RFQ no longer best
5. Server aggregates buyer Quotes until aggregation window deadline and right after deadline sends the best quote and corresponding signed by buyer underwriteTx to seller
    - the best quote is the quote with highest premium
    - quote that came first better than a quote with the same premium that came later
7. Seller verifies the transaction matches his underwriteTerms, adds seller signature, sends it to the server broadcast queue
8. Server validates instructions against RFQ seller underwriteTerms and buyer Quote, verifies accounts their flags and expected signatures, simulates underwriteTx and broadcasts it to the blockchain

Known issues:
- Embedding create_series in competing buyer transactions is unsafe: another transaction can create the deterministic PDA first, making the selected transaction fail. Solution: introduce later `ensure_series` that create series if not exists.
- buyer_quote_source and seller_collateral_source might have less amount at the point underwriteTx broadcasted to the blockacin. No solution to this, it is expected issue.

## Configuration

Create a typed hardcoded TypeScript configuration module. It must fail closed
when a requested market or browser origin is absent.

Each configured market needs at least:

- Solana options program ID and market address;
- `OracleBase` symbol, `BaseCoin` mint, and `QuoteCoin` mint;
- configured fee recipient and operational fee BPS;
- allowed quantity minimum, step, and maximum;
- symbols required to derive the canonical ticker.

Keep Solana RPC and WebSocket URLs in Worker secrets, not source code. Keep
allowed browser origins in the hardcoded configuration: allow only
`http://localhost:5173` locally; deployed environments are closed until their
frontend origin is explicitly added.

Use these Wrangler targets:

| Wrangler target | Product environment | Solana cluster | D1 |
|---|---|---|---|
| local `localdevelopment` | `development:testnet` | testnet | local |
| `development` | `development:devnet` | devnet | remote development D1 |
| `staging` | `staging:devnet` | devnet | remote staging D1 |
| `production` | `production:mainnet` | mainnet-beta | remote production D1 |

## Wire protocol and API

Implement wire protocol and WebSocket API according `./RFQ-SERVER-API.md` and `./SELLER-API.md` specification,
the rest in this section is additional implementation details to this specification.

`/rfqs/<asset>` uses the configured `BaseCoin` mint as `<asset>`. The
`assetName` in a request is the configured `OracleBase` symbol. The full
market configuration, not the route alone, decides whether a request is
valid.

`/maker?asset=<BaseCoin-mint>` and `/taker?asset=<BaseCoin-mint>` select the
same market-specific broker before the WebSocket is upgraded. A seller may
create RFQs only for that BaseCoin on the selected socket.

### RFQ incoming requests: `/rfqs/<asset>` implementation comments to RFQ-SERVER-API spec

JSON-RPC ID acts as `rfqId`.

The server validates that the JSON-RPC ID is not already active for the broker,
uses it as `rfqId`, and stores the terms in the Durable Object's in-memory map.
Do not send a duplicate `/rfqs/<asset>` requests.

`underwriteTx` from the rfq-server intentionally excludes premium.
The buyer chooses a premium in its offer; the seller chooses whether to sign that offered transaction.

The server must use fixed-point conversion, never JavaScript floating point,
when checking the transaction against the Solana program's required values.

The buyer decodes base64 provided by the rfq-server the complete transaction.
It must replace 0 premium and zeroed recentBlockhash of the transactions.
The buyer signs it first. The seller receives the partial transaction
via rfq-server routing, reviews it in their wallet, signs the exact bytes as fee payer,
and sends `underwrite.submit` over the same seller WebSocket connection.

### Quote submission

Made by buyers using `/maker` WebSocket JSON-RPC API.

## Durable Object broker

Create one Durable Object broker per BaseCoin mint. It keeps only an in-memory
map keyed by `rfqId` to the best in terms of offered premium (highest wins),
that DO containing the terms, initiating seller socket, and the best received so far
offer. Do not call Durable Object storage for RFQs or offers.
If more than one offer has the best premium then the first (existing in DO) received buyers offer wins.

An offer is accepted only when the seller submits the exact fully signed
transaction matching one unexpired stored offer. The first accepted submission
consumes that RFQ; later submissions for it are rejected.

Offer routing is private: only the seller socket that created the RFQ receives
the best quote offer. The request itself remains available to subscribed buyers.

## Transaction validation

Validate before routing a buyer offer and repeat the relevant checks before
enqueueing the seller-signed transaction.

1. Decode base64 and require the configured Solana cluster.
2. Require the buyer signature on the partial transaction. Require both buyer
   and seller signatures before queueing, with the seller as fee payer.
3. Require that every instruction is a configured options-program
   `create_series`, `underwrite_call`, or `underwrite_put` instruction, except
   for optional standard compute-budget instructions.
4. Require exactly one underwrite instruction. Its immutable fields must
   match the stored single `underwriteTx` exactly and its premium must
   match the selected stored offer.
5. Require every `create_series` instruction to match those same terms.
6. Validate the configured market, base and quote mints, fee recipient,
   operational fee BPS, quantity minimum/step/maximum, and all immutable RFQ
   values. Reject unknown markets and any other instruction.
7. Require the submitted bytes to hash to the stored offer transaction hash
   and reject it once `validUntil` has passed.

The server must not modify a transaction after either wallet has signed it.

## Queue and underwrite lifecycle

When the seller submits a valid fully signed transaction:

1. Calculate its SHA-256 signed-byte hash.
2. Insert one `underwrites` row for the one underwrite instruction and append
   a `queued` audit entry.
3. Enqueue the raw transaction. Use tx signature (first signature of fee payer) as idempotency key. Do not enqueue the same transaction more than once.
4. The single-concurrency consumer simulates the transaction. A simulation
   error is terminal and becomes `failed`.
5. Broadcast it, then change the row to `submitted` when the RPC accepts it.
6. Retry transient RPC submission failures only while the signed transaction
   remains valid. Blockhash expiry or deterministic chain errors become
   `failed` and require a new RFQ and buyer signature.
7. On Solana `confirmed` commitment, persist the receipt and change the row
   to `confirmed` before acknowledging the queue message.

Every status transition appends a timestamped `underwrite_audit` entry. The
queue must persist the receipt and D1 state before it acknowledges a message.

## D1 data model

Implement only these tables in this task.

Use Drizzle ORM for all application reads and writes to D1. Keep D1 migrations
under Drizzle migration control; do not use hand-written repository SQL.

### `underwrites`

Use `(tx_signature, ix_index)` as the primary key so the schema supports
multi-underwrite transactions even though RFQ validation only accepts one.
`tx_signature` is the seller fee-payer signature and Solana transaction
identifier. Do not store `signed_transaction_hash` in this table.

Store the RFQ ID, lifecycle status, seller and buyer addresses, configured
market ID, series address, ticker, call/put marker, expiry, strike, quantity,
premium, base and quote mints, fee recipient, fee BPS, transaction signature,
created/submitted/confirmed timestamps, and last error.

### `underwrite_audit`

Store an auto-increment ID, the composite underwrite key, UTC Unix-millisecond
creation time, and the lifecycle status. It is append-only.

### `option_series`

Use the Solana series address as the primary key. Store the configured market,
canonical ticker, and immutable series definition required for dashboard reads.
Create or update this row only after a confirmed underwrite.

Use UTC Unix-millisecond integer columns for server-created times. Add indexes
for seller dashboard reads by seller, status, and expiry, plus `tx_signature`
lookup for idempotency.

Do not create settlement, payout, finalization, allocation, or batch tables.

## Maker/Buyer dashboard API

Buyer must use positions WebSocket request described in `./RFQ-SERVER-API.md`.

## Seller dashboard HTTP API

Implement this unauthenticated, read-only endpoint:

`GET /sellers/:sellerAddress/underwrites`

It reads only `underwrites` created by this RFQ server. Default to confirmed
rows and support an explicit lifecycle status filter. Return all matching rows
without pagination, ordered by nearest expiry first. Derive tickers in UTC as
`<OracleBase>-<QuoteCoin>-<BaseCoin>-<DDMMMYY>-<strike>-<C|P>`; normalize the
strike without redundant trailing decimal zeroes.

## Implementation sequence

1. Scaffold the Worker package, Wrangler bindings, Hono app, typed config, and
   environment configuration.
2. Add Drizzle D1 schema and migrations, typed repositories, and ticker/fixed-point helpers.
3. Implement the BaseCoin Durable Object broker and WebSocket message schemas.
4. Implement strict Solana transaction decoding and validation.
5. Add the single-concurrency broadcast queue consumer and lifecycle updates.
6. Add the seller dashboard HTTP endpoint.
7. Add tests and run formatting, linting, and relevant package checks.

## Required tests

- fixed-point parsing and conversion; ticker generation in UTC;
- market, fee, quantity, signature, instruction, and `validUntil` validation;
- private offer routing and consumed-RFQ rejection in the Durable Object;
- D1 idempotency, audit history, lifecycle updates, and expiry-ordered seller
  reads;
- queue simulation failure, transient retry, confirmed receipt persistence, and
  deterministic/expired transaction failure using mocked Solana RPC responses.
