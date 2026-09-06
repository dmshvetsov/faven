# Buyer API documentation

Faven API for buyers.

Maker and buyer is used interchangeably in this document.

Token and coin is used interchangeably in this document.

Underlying and base token (base token mint) is used interchangeably in this document.

Raw bytes, such as transaction bytes, are encoded using base64. Unless otherwise noted, encoded strings are encoded using base64. Solana public keys are always encoded using base58.

## WebSocket endpoints

- `wss://<faven base api url>/rfqs/<asset>` Receive RFQs for `<asset>` - base token mint address
- `wss://<faven base api url>/maker` Generate underwrite transactions, submit quotes, and request positions for one BaseCoin market

## Common JSON-RPC envelopes

This API MUST follow [JSON-RPC 2.0 standard](https://www.jsonrpc.org/specification).

### Outgoing request

Always use UUIDv7 for JSON-RPC requests ids. Non UUIDv7 JSON-RPC envelop ids will be rejected.

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

## 1. Incoming RFQ — `/rfqs/<asset>` endpoint

`<asset>` is the underlying (base) solana token mint address

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
  rfqId: string             // will be UUIDv7
  assetAddress: string      // underlying (base) token mint address
  assetName: string         // asset name from oracle "SOL", "BTC", "ETH", "JUP" etc
  chainId: string           // solana:mainnet, solana:devnet, solana:testnet
  expiry: number            // Unix seconds
  isPut: boolean
  quantity: string          // 1e18 option amount
  strike: string            // 1e8 USD strike
  collateralAsset: string   // token mint address of an asset used as collateral by an option seller
  premiumAsset: string      // token mint address used to pay premium
  requestDeadline: number   // RFQ window deadline, Unix milliseconds
}
```

## 2. Generate an underwrite transaction — `/maker` endpoint

Can be called multiple times per RFQ until RFQ `requestDeadline`.


```ts
type UnderwriteTxGenerateRequest = {
  jsonrpc: "2.0"
  id: string, // generated UUIDv7
  method: "underwriteTx.generate"
  params: {
    rfqId: string             // must match Rfq.rfqId (RfqRequest.params.rfqId)
    maker: string             // buyer EOA / public key of a key-pair used to sign underwriteTx and pay premium
    buyerQuoteSource: string  // QuoteCoin token account owned by maker to pay premium from, recommended to use associated token account (ATA)
    premium: string           // 1e18 offered Rfq.premiumAsset token premium per one whole Rfq.assetAddress option token
  }
}
```

`premium` field is a amount of premiumAsset base units paid for one whole unit of long option contract. For example an `underwriteTx` for 0.05 wBTC will have `Rfq.quantity` = 0.05 * 10 ** 18 (despite the fact that BTC has 8 decimals) with a maker's premium 764 USDC  `UnderwriteTxGenerateRequest.params.premium` must be = 764 * 10 ** 18 (despite that USDC has 6 decimals). Maker with given `underwriteTx` will pay on-chain 764 * 0.05 * 10 ** 6 USDC. Decimal scaling from RFQ to underlying token mint decimals handled by the protocol, RFQ always use 1e18 scale for premium and quantity and 1e8 for strike price, settlement always happens in underlying token mint decimals.

`maker` must be the buyer that signs the generated transaction and must equal `Quote.maker`. `premium` is written into the generated underwrite instruction.

```ts
type UnderwriteTxGenerateResponse = {
  jsonrpc: "2.0"
  id: string // will match UnderwriteTxGenerateRequest.id
  result: {
    rfqId: string                 // will match UnderwriteTxGenerateRequest.params.rfqId
    underwriteTx: string          // v0 solana transaction without ALT, base64 encoded unsigned transaction
    lastValidBlockHeight: number
  }
}
```

Before signing, the buyer SHOULD verify the option terms: premium, quantity,
assetAddress, premiumAsset, expiry, isPut flag, strike.
The buyer MUST NOT change any transaction parameters,
including instructions or recent blockhash.

The buyer signs the transaction and includes the resulting base64
encoded transaction in `Quote.underwriteTx`.

## 3. Submit a quote for RFQ — `/maker` endpoint

Each buyer quote blindly without knowing quotes of other buyers.
Buyer allowed to provide quote only once per RFQ. Provided quote is final,
duplicates or updates are not allowed. Invalid quotes,
including quotes sent after deadline, do not consume one quote per RFQ slot.

```ts
type QuoteRequest = {
  jsonrpc: "2.0"
  id: string // generated UUIDv7
  method: "quote.submit",
  params: Quote
}

type Quote = {
  rfqId: string              // must equal to RfqRequest.params.rfqId
  chainId: string            // must equal RfqRequest.params.chainId
  validUntil: number         // Unix seconds, no more than 40 seconds in the future (max time for solana blockhash TTL) until this quote is valid
  premium: string            // 1e18 USD premium per one option unit
  underwriteTx: string       // signed by maker underwriteTx, from UnderwriteTxGenerateResponse.result.underwriteTx, generated underwriteTx must not be changed or modified
}
```

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
  bestQuote: string                                           // 1e18 best quote premium tat was sent to seller
  providedQuote: string                                       // quote provided in QuoteRequest
  providedStatus: "best" | "not_best" | "best_received_later"
}
```

QuoteRequest.providedStatus:
- `best` — your quote is currently best.
- `not_best` — another quote is currently better.
- `best_received_later` — same as the best quote but received later than another quote with the same best terms
- `outbid` - other buyer provided better quote and out-bided previous best quote

If buyer's previous best quote was out-bided by another buyer during the aggregation window,
the protocol rfq-server SHOULD send notification to the buyer who was out-bided

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

## 4. Get positions — `/maker` endpoint

> Not yet implemented WIP

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

## 5. Exercise - `/maker` endpoint

> Not yet implemented TBD

## Errors codes

- `1xxx` RFQ errors

| Code | Meaning |
|---|---|
| `1001` | Unknown, expired, disconnected, or already-consumed RFQ. |
| `1002` | RFQ or transaction terms do not match configured market rules. |
| `1003` | Invalid, missing, altered, or expired transaction signatures. |
| `1004` | Submitted transaction does not exactly match a stored buyer offer. |
| `1005` | RFQ aggregation window has closed. |

The error `data` SHOULD include `rfqId` when available.
