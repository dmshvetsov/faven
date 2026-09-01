# RFQ server rewrite handoff

## Goal

Replace the current RFQ implementation in `apps/rfq-server` with the flow in
[RFQ-SERVER.md](./RFQ-SERVER.md). There is no compatibility layer and no active
buyer or seller client to migrate.

The canonical wire contracts are [SELLER-API.md](./SELLER-API.md) and
[BUYER-API.md](./BUYER-API.md).

## Fixed decisions

- Sellers create UUIDv7 `rfqId` values. JSON-RPC `id` only correlates requests.
- The seller method is `rfq.create`; buyer methods are
  `underwriteTx.generate` and `quote.submit`.
- RFQ fan-out is a `rfq.request` notification. It includes the existing
  priceable RFQ fields and `rfqId`, not seller account details.
- Aggregation is a server-owned, fixed 2.5-second window starting at fan-out.
  Generation and quote submission after it return `1005`.
- The server records the RFQ blockhash and last valid block height, but keeping
  the selected transaction blockhash fresh is out of scope.
- Generated transactions are Solana v0 with inline accounts only. Reject legacy
  transactions and address lookup tables.
- The server retains `create_series` when a series does not exist.
  `ensure_series` is out of scope.
- Buyers may generate multiple candidate transactions, but each maker can have
  one accepted blind quote per RFQ across all connections.
- A quote must be one previously generated message, must outlast aggregation,
  and may be at most 40 seconds in the future. It remains eligible after buyer
  disconnect, but must be unexpired at seller submission.
- The highest premium wins; first accepted quote wins a tie. Notify only a
  different displaced best buyer with best-effort `quote.outbid`.
- The seller receives `quote.best` at close, or the same method with
  `noQuoteReason: "no_buyers"` when no quote was accepted.
- Seller disconnect cancels all that connection's non-terminal RFQs. A
  reconnect always creates fresh RFQs.
- The RFQ Durable Object keeps terminal tombstones for two weeks.
- The server validates the canonical v0 message and signatures, then simulates
  the seller-signed transaction. It does not separately query source token
  accounts; the on-chain program and simulation enforce them.
- Underwrites use one serial queue and must reach `confirmed` before queue
  acknowledgement. Failures are recorded once and acknowledged without retry.
- Repeating exactly queued `underwrite.submit` returns the original `queued`
  response. It is not an underwrite status query.
- Buyer `positions` is out of scope and must not be implemented.

## Target architecture

Use these Durable Object responsibilities:

| Component | Key | Responsibility |
|---|---|---|
| RFQ Durable Object | `rfqId` | Canonical terms, blockhash, generated messages, quote ranking, lifecycle, alarm, and two-week tombstone. |
| Asset Hub | BaseCoin mint | Holds `/rfqs/<asset>` sockets and fans out `rfq.request`. |
| Maker/Taker hubs | Implementation choice | Hold `/maker` and `/taker` sockets, correlate connections, forward requests to RFQ objects, and deliver private notifications. They may be one class or separate classes. |

Only the RFQ Durable Object may mutate an RFQ. Hubs never own RFQ state. They
use a connection identifier to let an RFQ object deliver to the seller or a
displaced buyer. Failed notification delivery is best effort.

## RFQ lifecycle

```text
rfq.create
  -> validating
  -> aggregating (fan-out starts 2.5 s timer)
  -> selected | no_quote | cancelled
  -> queued | failed
  -> terminal tombstone (two weeks)
```

1. `/taker` forwards `rfq.create` to the RFQ object named by `params.rfqId`.
   Reject any existing object state for that ID. Validate market and seller
   terms, derive the series, fetch latest blockhash, and write durable state.
2. Resolve the configured BaseCoin from market and ask its Asset Hub to fan out
   `rfq.request`. Set and persist `requestDeadline` at that fan-out boundary;
   schedule a Durable Object alarm for it.
3. `/maker` forwards generation and quote calls by `params.rfqId`. The RFQ
   object owns every deadline, terminal-state, and one-quote-per-maker check.
4. The alarm selects the best accepted quote. It notifies the seller gateway
   with `quote.best`, or the no-quote form. It never sends a quote after seller
   disconnect or cancellation.
5. `underwrite.submit` is accepted only for the selected transaction, after
   aggregation and before `validUntil`. It moves the RFQ to queued only after
   durable underwrite recording and queue admission. Exact duplicate submissions
   return the stored queued result; changed bytes fail.
6. On seller-socket close, the taker hub cancels each active RFQ owned by that
   connection. On buyer-socket close, retain its accepted quote and clear only
   delivery routing.

## Transaction construction and validation

Add a transaction-builder module rather than reusing the seller-provided,
premium-free template flow.

1. Derive the series from stored market, expiry, strike, and call/put terms.
   Read only the series account to decide whether to add `create_series`.
2. Build a v0 message using the RFQ's stored blockhash, seller as fee payer,
   configured operational fee and recipient, seller collateral source, maker,
   buyer quote source, and buyer premium.
3. Store a hash of each generated unsigned message with `maker`, premium,
   buyer quote source, and message bytes. This is the only message a submitted
   quote may sign.
4. At `quote.submit`, verify the maker signature and exact generated message.
   Rank only valid quotes; enforce `validUntil` and one accepted quote per
   maker atomically.
5. At `underwrite.submit`, compare the exact message with the selected quote
   and canonical terms; validate v0, no lookups, program IDs, instruction data,
   account order, account flags, fee payer, and expected buyer/seller
   signatures. Do not alter signed bytes.
6. Simulate the final bytes. Simulation, rather than pre-generation token
   account reads, is the final check of account ownership, mint, and available
   balance. Balance changes between simulation and execution remain expected.

## Queue and database work

Keep `underwrites` and `underwrite_audit` as the durable underwrite lifecycle
record. Update queue handling so one RFQ broadcast is processed at a time:

1. Persist the queued underwrite and audit row before exposing `queued`.
2. Simulate once, send once, mark `submitted`, then wait for `confirmed`.
3. Persist `confirmed` and receipt before queue acknowledgement.
4. On simulation, send, or confirmation failure, persist `failed` and its
   audit entry, then acknowledge. Remove automatic transient retry and
   blockhash-validity retry from RFQ underwrite processing.
5. Return `txSignature`, the Solana fee-payer signature, instead of a SHA-256
   transaction digest.

## Code-change sequence

1. Split `rfq-broker.ts` responsibilities into RFQ state, asset subscription,
   and connection hub modules. Add Durable Object bindings and configuration.
2. Implement durable RFQ state, alarm recovery, cancellation, two-week cleanup,
   generated-message records, quote ranking, and idempotent submit result.
3. Add v0 transaction construction and strict final-message validation. Replace
   legacy-template comparison in `transaction-validation.ts`.
4. Change worker routes and queue consumer concurrency to one. Update broadcast
   confirmation to `confirmed` and terminal-on-first-failure behavior.
5. Preserve dashboard and underwrite persistence behavior. Do not add buyer
   position RPC work.
6. Apply any necessary D1 migration only for durable underwrite fields that the
   existing schema cannot store. RFQ quote state remains in Durable Objects.

## Validation after implementation

Run `just format`, `just lint`, and the focused RFQ-server tests during the
rewrite. Run `just test` when the complete replacement is finished.
