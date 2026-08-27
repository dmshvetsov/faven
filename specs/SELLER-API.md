# RFQ Server Seller WebSocket API

## Endpoint `/taker`

This WebSocket is for a seller to create an RFQ, privately receive buyer
offers, and submit the selected fully signed transaction. It uses JSON-RPC 2.0.
All client-generated request IDs MUST be UUIDv7 strings.

The server is non-custodial. It does not hold wallet keys and must not modify a
transaction after the buyer or seller has signed it.

## 1. Create an RFQ

The seller prepares the premium-free transaction and sends its terms. The
request ID is the `rfqId` and MUST be unique among active RFQs for the relevant
BaseCoin broker.

```ts
type RfqCreateRequest = {
  jsonrpc: "2.0"
  id: string // UUIDv7; becomes rfqId
  method: "rfq.create"
  params: Rfq
}
```

`Rfq` is exactly the type in `../specs/RFQ-SERVER-API.md`. In particular:

- `asset` is the configured BaseCoin mint and selects the buyer feed;
- `assetName`, `chainId`, collateral and premium assets, quantity, strike, and
  expiry must match a configured market;
- `underwriteTx` must be omitted, the rfq-server sets it
- `requestDeadline` must be omitted, the rfq-server sets it

On success, the server broadcasts the RFQ to buyers subscribed to
`/rfqs/<asset>` using the `RfqRequest` format defined in
`../specs/RFQ-SERVER-API.md`, then returns:

```ts
type RfqCreateResponse = {
  jsonrpc: "2.0"
  id: string // RfqCreateRequest.id, aka rfqId
  result: {
    requestDeadline: number // Unix milliseconds
  }
}
```

The server rejects an already-active ID, an unknown market, or invalid transaction terms.
A disconnected seller must create a new RFQ after reconnecting.

## 2. Receive a private offer

The server receives all buyers `quotes` and choose the best (with highest premium) valid buyer `quote`, the server sends this JSON-RPC Quote request only to the seller socket that created the RFQ. The server does not send them to other sellers.

```ts
type QuoteNotification = {
  jsonrpc: "2.0"
  method: "quote.best"
  params: {
    rfqId: string
    quote: Quote // exactly the type in ../specs/RFQ-SERVER-API.md with underwriteTx signed by buyer
  }
}
```

The `quote.underwriteTx` contains the buyer-selected premium, a current recent
blockhash, and the buyer signature. A quote can be selected only before its
`validUntil` time.

## 3. Underwrite with selected quote

The seller reviews the exact transaction from an `quote.best` notification,
signs those unchanged bytes as the fee payer, then submits it. The seller MUST
not alter the premium, recent blockhash, instructions, accounts, or buyer
signature.

```ts
type UnderwriteSubmitRequest = {
  jsonrpc: "2.0"
  id: string // new generated UUIDv7; not rfqId
  method: "underwrite.submit"
  params: {
    rfqId: string
    underwriteTx: string // base64, signed by both buyer and this seller
  }
}

type UnderwriteSubmitResponse = {
  jsonrpc: "2.0"
  id: string // UnderwriteSubmitRequest.id
  result: {
    rfqId: string
    txHash: string // SHA-256 of signed transaction bytes
    status: "queued"
  }
}
```

The server accepts a submission only if it exactly matches one unexpired offer
stored for that RFQ (in Durable object with given rfqId),
has valid buyer and seller signatures, and passes the
transaction validation rules. The first accepted submission consumes the RFQ.
Later submissions for that RFQ are rejected.

`queued` means the server has durably recorded and queued the transaction. It
does not mean that Solana has accepted or confirmed it.

## Errors

Errors use the JSON-RPC error envelope. The server SHOULD use these codes:

| Code | Meaning |
|---|---|
| `-32600` | Invalid JSON-RPC envelope or request fields. |
| `-32601` | Unknown method. |
| `-32001` | Unknown, expired, disconnected, or already-consumed RFQ. |
| `-32002` | RFQ or transaction terms do not match configured market rules. |
| `-32003` | Invalid, missing, altered, or expired transaction signatures. |
| `-32004` | Submitted transaction does not exactly match a stored buyer offer. |

The error `data` SHOULD include `rfqId` when available and a stable,
machine-readable reason string.
