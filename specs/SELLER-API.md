# RFQ Server Seller WebSocket API

## Common JSON-RPC envelopes

This API MUST follow [JSON-RPC 2.0 standard](https://www.jsonrpc.org/specification).

Always encode raw bytes with base64 before sending them in request payload.

## Endpoint `/taker?asset=<BaseCoin-mint>`

This WebSocket is for a seller to submit underwrite terms, privately receive
buyer quotes, and submit the selected fully signed transaction. It uses JSON-RPC
2.0. All client-generated request IDs MUST be UUIDv7 strings.

The server is non-custodial. It does not hold wallet keys and must not modify a
transaction after the buyer or seller has signed it.

`asset` MUST be the BaseCoin mint for every RFQ on this socket. It selects the
market-specific broker before the WebSocket is upgraded.

## 1. Request quotes with underwrite terms

```ts
type RfqCreateRequest = {
  jsonrpc: "2.0"
  id: string // generated UUIDv7; becomes rfqId
  method: "rfq.create"
  params: UnderwriteTerms 
}

type UnderwriteTerms {
    market: string                   // configured options market address
    expiry: number                   // Unix seconds
    isPut: boolean
    quantity: string                 // option contracts to underwrite
    strike: string                   // e8 USD strike
    seller: string                   // seller EOA / signing address
    sellerCollateralSource: string   // collateral token account owned by seller
  }
}
```
The server rejects an already-active rfqId, an unknown market, or invalid
underwrite terms. A disconnected seller must create a new RFQ after
reconnecting.

```ts
type RfqCreateResponse = {
  jsonrpc: "2.0"
  id: string // RfqCreateRequest.id, aka rfqId
  result: {
    requestDeadline: number // Unix milliseconds
  }
}
```

## 2. Receive a private offer

The server sends JSON-RPC notification with valid quote with the highest premium
only to the seller socket that created the RFQ. Other sellers do not receive the quote.

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

`quote.underwriteTx` was generated from the underwrite terms and buyer quote
parameters. It contains the buyer signature and can be used only before
`quote.validUntil`.

## 3. Underwrite with selected quote

The seller reviews the exact transaction from a `quote.best` notification,
signs those unchanged bytes as the fee payer, then submits it to
`underwrite.submit`.
The seller MUST not alter the underwriteTx and its instructions, including
the premium, recent blockhash, accounts, or buyer signature.

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
  result?: {
    rfqId: string
    txHash: string // SHA-256 of signed transaction bytes
    status: "queued" 
  }
  error?: {
    code: number
    message?: string
    data?: {
      rfqId: string
    }
  }
}
```

The server accepts a submission only if it exactly matches the selected,
unexpired quote for that RFQ, has valid buyer and seller signatures, and passes
the transaction validation rules. The first accepted submission consumes the
RFQ. Later submissions for that RFQ are rejected.

`queued` means the server has durably recorded and queued the transaction. It
does not mean that Solana has accepted or confirmed it.

## Errors

Errors use the JSON-RPC error envelope. The server SHOULD use these codes:

### RFQ errors `1xxx` codes

| Code | Meaning |
|---|---|
| `1001` | Unknown, expired, disconnected, or already-consumed RFQ. |
| `1002` | RFQ or transaction terms do not match configured market rules. |
| `1003` | Invalid, missing, altered, or expired transaction signatures. |
| `1004` | Submitted transaction does not exactly match a stored buyer offer. |

The error `data` SHOULD include `rfqId` when available and a stable,
machine-readable reason string.
