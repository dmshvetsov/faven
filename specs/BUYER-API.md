# Buyer API documentation

Maker(s) and buyer is used interchangeably in this document.

## WebSocket endpoints

- `wss://<faven base api url>/rfqs/<asset>` Receive RFQs for `<asset>` - base token mint address
- `wss://<faven base api url>/maker` Generate underwrite transactions, submit quotes, and request positions for one BaseCoin market

## Common JSON-RPC envelopes

This API MUST follow [JSON-RPC 2.0 standard](https://www.jsonrpc.org/specification).

Always encode raw bytes with base64 before sending them in request payload.

### Outgoing request

Use UUIDv7 for JSON-RPC requests ids.

```ts
type JsonRpcRequest = {
  jsonrpc: "2.0"
  id: string // must be generated UUIDv7
  method: string
  params?: unknown
}
```

### Incoming response

```ts
type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: string // UUIDv7, MUST be equal to a JsonRpcRequest.id that was sent in case of outgoing request or received for incoming request
  result: unknown
} | {
  jsonrpc: "2.0"
  id: string // UUIDv7, MUST be equal to a JsonRpcRequest.id that was sent in case of outgoing request or received for incoming request
  error: {
    code?: number
    message?: string
    data?: unknown
  }
}
```

## 1. Incoming RFQ — `/rfqs/<asset>`

`<asset>` is the underlying solana token mint address

```text
wss://<faven base API url>/rfqs/5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ
```

An RFQ is a JSON-RPC notification message. `RfqRequest.params.rfqId` is the RFQ ID you must use when submitting request and responses related to this RFQ, for example your quote.

```ts
type RfqRequest = {
  jsonrpc: "2.0"
  method: "rfq.request",
  params: Rfq
}

type Rfq = {
  rfqId: string             // UUIDv7
  assetAddress: string      // underlying token address
  assetName: string         // oracle price "wBTC", "wETH", "wSOL", "JUP" etc
  chainId: string           // solana:mainnet, solana:devnet, solana:testnet
  expiry: number            // Unix seconds
  isPut: boolean
  quantity: string          // 1e18 option amount
  strike: string            // 1e8 USD strike
  collateralAsset: string   // asset used as collateral by option seller
  premiumAsset: string      // premium-payment token mint address
  requestDeadline: number   // Unix milliseconds
}
```

## 2. Generate an underwrite transaction — `/maker`

Can be called multiple times per RFQ until RFQ deadline.

```ts
type UnderwriteTxGenerateRequest = {
  jsonrpc: "2.0"
  id: string, // generated UUIDv7
  method: "underwriteTx.generate"
  params: {
    rfqId: string             // must match Rfq.rfqId (RfqRequest.params.rfqId)
    maker: string             // buyer EOA / signing address
    buyerQuoteSource: string  // QuoteCoin token account owned by maker to pay premium from
    premium: string           // e18 offered USD premium per one option unit
  }
}
```

`maker` must be the buyer that signs the generated transaction and must equal
`Quote.maker`. `premium` is written into the generated underwrite instruction.

```ts
type UnderwriteTxGenerateResponse = {
  jsonrpc: "2.0"
  id: string // will match UnderwriteTxGenerateRequest.id
  result: {
    rfqId: string              // will match UnderwriteTxGenerateRequest.params.rfqId
    underwriteTx: string       // v0 solana transaction without ALT, base64 encoded unsigned transaction
    lastValidBlockHeight: number
  }
}
```

Before signing, the buyer SHOULD verify the option terms, premium, buyer quote
source, seller, and transaction fee payer. The buyer MUST NOT change the
any transaction parameters, including instructions or recent blockhash.
The buyer signs the transaction and includes the resulting base64
transaction in `Quote.underwriteTx`.

## 3. Submit a quote for RFQ — `/maker`

Each buyer quote blindly without knowing quotes of other buyers until buyer provides his quote. Buyer only allowed to provide quote only once per RFQ, provided quote is final and duplicates or update are not allowed. Invalid quotes, including quotes sent after deadline, do not consume one quote per RFQ slot.

```ts
type QuoteRequest = {
  jsonrpc: "2.0"
  id: string // generated UUIDv7
  method: "quote.submit",
  params: Quote
}

type Quote = {
  // values that must be reused from RfqRequest.params notification
  rfqId: string              // must equal to RfqRequest.params.rfqId
  assetAddress: string       // must equal RfqRequest.params.assetAddress
  chainId: string            // must equal RfqRequest.params.chainId
  expiry: number             // must equal RfqRequest.params.expiry
  isPut: boolean             // must equal RfqRequest.params.isPut
  maker: string              // maker EOA / signing address
  quantity: string           // 1e18; must equal RFQ quantity
  strike: string             // 1e8; must equal RFQ strike
  premiumAsset: string       // must equal RFQ premiumAsset
  collateralAsset: string    // must equal RFQ collateralAsset

  // provided quote values
  validUntil: number         // Unix seconds, no more than 40 seconds in the future (max time for solana blockhash TTL) until this quote is valid
  premium: string            // 1e18 USD premium per one option unit
  underwriteTx: string       // maker signed underwriteTx, from UnderwriteTxGenerateResponse.result.underwriteTx, generated underwriteTx must not be changed or modified
}
```

`underwriteTx` is used to validate correctness of Quote.signature and whole QuoteRequest.params (Quote) against sent RfqRequest.result

`validUntil` (counted in seconds) must be bigger than `RfqRequest.params.requestDeadline` (counted in milliseconds), but validity must not exceed Solana max block height validity thus `validUntil` max value is 40 seconds - `RfqRequest.params.requestDeadline + 40_000 milliseconds`.


```ts
type QuoteResponse = {
  jsonrpc: "2.0"
  id: string // will match QuoteRequest.id
  result: QuoteResult
}
```

```ts
type QuoteResult = {
  rfqId: string                                               // will match Quote.rfqId (QuoteRequest.params.rfqId)
  bestQuote: string                                           // best quote tat was sent to seller
  providedQuote: string                                       // quote provided connected maker (you)
  providedStatus: "best" | "not_best" | "best_received_later"
}
```

QuoteRequest.providedStatus:
- `best` — your quote is currently best.
- `not_best` — another quote is currently better.
- `best_received_later` — same as the best quote but received later than another quote with the same best terms
- `outbid` - other buyer provided better quote and out-bided previous best quote

If buyer's previous best quote was out-bided by another buyer during the aggregation window, the server MUST send notification to the buyer who was out-bided

```ts
type QuoteOutbidNotification = {
  jsonrpc: "2.0"
  method: "quote.outbid"
  params: {
    rfqId: string               // will match Quote.rfqId (QuoteRequest.params.rfqId)
    bestQuote: string           // best quote tat was sent to seller
    providedQuote: string       // quote provided connected maker (you)
    providedStatus: "outbid"
  }
}
```

## 4. Get positions — `/maker`

```ts
{
  jsonrpc: "2.0",
  id: string, // generated UUIDv7
  method: "positions",
  params: {
    account: string // public key (address) used to sign underwrite transactions (buy options)
  }
}
```

### RFQ errors `1xxx` codes

| Code | Meaning |
|---|---|
| `1001` | Unknown, expired, disconnected, or already-consumed RFQ. |
| `1002` | RFQ or transaction terms do not match configured market rules. |
| `1003` | Invalid, missing, altered, or expired transaction signatures. |
| `1004` | Submitted transaction does not exactly match a stored buyer offer. |
| `1005` | RFQ aggregation window has closed. |

The error `data` SHOULD include `rfqId` when available and a stable,
machine-readable reason string.
