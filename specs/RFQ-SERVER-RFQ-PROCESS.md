# RFQ server RFQ process

This document defines durable RFQ processing. 

## Architecture

| Component | Key | Responsibility |
|---|---|---|
| RFQ Durable Object | `rfqId` | Canonical terms, blockhash, generated messages, quote ranking, lifecycle, alarm, and two-week tombstone. |
| Asset Hub | BaseCoin mint | Holds `/rfqs/<asset>` sockets and fans out `rfq.request`. |
| Maker/Taker hubs | Implementation choice | Hold `/maker` and `/taker` sockets, forward requests, and deliver private notifications. |

Only the RFQ Durable Object MAY mutate an RFQ. Hubs MUST NOT own RFQ state.
They use connection identifiers for private delivery. Failed delivery of
`quote.best` and `quote.outbid` is best effort.

## Lifecycle

```text
rfq.create
  -> validating
  -> aggregating
  -> selected | no_quote | cancelled
  -> queued | failed
  -> terminal tombstone (two weeks)
```

1. `/taker` forwards `rfq.create` to the RFQ object named by `rfqId`. It MUST
   reject an existing RFQ ID, validate market and seller terms, derive the Series,
   obtain the latest blockhash and last valid block height, and store these
   values durably.
2. The object resolves the configured BaseCoin and asks its Asset Hub to fan
   out `rfq.request`. At that boundary it MUST persist `requestDeadline` and
   schedule a Durable Object alarm. The aggregation period is fixed at 2.5
   seconds. Tx generation and quote submission after the deadline MUST fail with
   `1005`.
3. `/maker` forwards `underwriteTx.generate` and `quote.submit` by `rfqId`.
   The RFQ object owns deadline, terminal-state, and one-accepted-quote-per-
   maker checks atomically across all connections.
4. At the alarm, the object selects the highest premium; the earliest accepted
   quote wins a tie. It sends `quote.best` to the seller, or the no-quote form
   with `noQuoteReason: "no_buyers"`. It MUST NOT send a result after seller
   cancellation.
5. Seller socket closure MUST cancel every non-terminal RFQ from that
   connection. A reconnect MUST create new RFQs. Buyer socket closure MUST
   retain an accepted quote but remove its notification route.
6. The object MUST retain its canonical state, generated-message records,
   accepted quotes, and terminal tombstone for two weeks.

## Generated transactions and quotes

- A buyer MAY generate multiple candidate transactions before the deadline.
- The server MUST build a Solana v0 transaction with inline accounts only and
  MUST reject legacy transactions and address lookup tables.
- The builder derives the Series from stored market, expiry, strike, and
  call/put values. It reads only the Series account to decide whether to add
  `create_series`;
- The message uses the stored blockhash, seller as fee payer, configured
  operational fee and recipient, seller collateral source, maker, buyer quote
  source, and buyer premium.
- For every generated message, the server MUST store its hash, bytes, maker,
  premium, and buyer quote source. A submitted quote MAY sign only one of
  those messages.
- A maker MAY have only one accepted blind quote per RFQ. A quote MUST outlast
  the aggregation deadline, be no more than 40 seconds in the future, and be
  unexpired when the seller submits it. A displaced best buyer SHOULD receive
  best-effort `quote.outbid`.

## Seller submission

`underwrite.submit` is valid only after aggregation, before the selected
quote's `validUntil`, and only for the exact selected transaction. The server
MUST durably record the underwrite and admit it to the broadcast queue before
returning `queued`.

An exact duplicate of a queued submission MUST return the stored `queued`
result. Changed bytes MUST fail; this endpoint is not an underwrite-status
query.

Before queue admission the server MUST validate the exact v0 message against
canonical RFQ terms and the selected quote: message bytes, program IDs,
instruction data, account order and flags, fee payer, and required buyer and
seller signatures. It MUST NOT modify signed bytes.

The server MUST simulate the final signed transaction. Simulation is the final
check of token-account ownership, mint, and funds; balances MAY still change
before execution. The server MUST NOT separately reserve balances or refresh a
selected transaction's blockhash.

Buyer `positions` is out of scope and MUST NOT be implemented.
