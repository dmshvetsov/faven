# Buyer API documentation

Faven API for buyers. Faven implements European options, physical settlement, fully collateralised, with Pyth oracle.

Maker and buyer is used interchangeably in this document.

Token and coin is used interchangeably in this document.

Underlying and base token (base token mint) is used interchangeably in this document.

Raw bytes, such as transaction bytes, are encoded using base64. Unless otherwise noted, encoded strings are encoded using base64. Solana public keys are always encoded using base58.

## WebSocket endpoints

- `wss://<faven base api url>/rfqs/<asset>` Receive RFQs for `<asset>` - base token mint address
- `wss://<faven base api url>/maker` One global socket for every market: generate underwrite transactions, submit quotes, list positions, exercise Long options tokens.

Open one `/maker` socket per buyer application. This version
has no WebSocket authentication, API key, or wallet-binding handshake.
The `maker` public key and its signature are checked for each transaction; 

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
  assetAddress: string      // underlying (base) token mint address, this token mint will be physically delivered
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
    buyerQuoteSource: string  // Quote token account owned by maker to pay premium from, recommended to use associated token account (ATA)
    premium: string           // 1e18 offered Rfq.premiumAsset token premium per one whole Rfq.assetAddress option token
  }
}
```

`premium` field is a amount of premiumAsset base units paid for one whole underlying token unit option contract. For example an `underwriteTx` for 0.05 wBTC will have `Rfq.quantity` = 0.05 * 10 ** 18 (despite the fact that BTC has 8 decimals) with a maker's premium $764 whole USDC `UnderwriteTxGenerateRequest.params.premium` must be = 764 * 10 ** 18 (despite that USDC premiumAsset has 6 decimals). Maker with given `underwriteTx` will pay on-chain $764 * 0.05 quantity * (10 ** 6 USDC decimals) = 38_200_000 USDC base units or $38.2 whole units. The protocol handles decimal scaling from RFQ scales to corresponding underlying token mint decimal scales, RFQ always use 1e18 scale for premium and quantity and 1e8 for strike price, on-chain settlement always happens in underlying token mint decimals. 

Faven takes a fee from total premium `faven fee = premium * Rfq.quantity whole tokens * faven fee bps` and shows sellers `seller premium = premium - faven fee`.

One whole option contract token represents one whole underlying token.

`maker` must be the buyer that signs the generated transaction. `premium` and other option terms are written into the generated underwrite instruction.

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

The buyer needs a funded `buyerQuoteSource` SPL token account owned by `maker`.
It may be the buyer's Quote Token ATA, but any owned Quote Token token account is
valid. Its balance must cover the total premium.

The buyer signs the transaction and includes the resulting base64
encoded transaction in `Quote.underwriteTx`.

The buyer does not pay transaction fees, or account rents. The buyer signs first,
seller second and RFQ server submits transactions after both signatures are collected.
The buyer does not spend SOL in underwrite transactions. Missing ATA are created if
needed inside underwriteTx, the buyer does not need to create any accounts in advance.

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
  validUntil: number         // Unix seconds; see the exact bounds below
  underwriteTx: string       // signed by maker underwriteTx, from UnderwriteTxGenerateResponse.result.underwriteTx, generated underwriteTx must not be changed or modified
}
```

`validUntil` is in Unix seconds. It must be strictly after the RFQ deadline and
no more than 40 seconds after it. Convert the millisecond deadline before
comparing. For example, with `requestDeadline = 1770000000123`, the allowed
integer range is `1770000001` through `1770000040` inclusive. Use the earliest
value that still gives the seller enough time to sign and submit. The server
also rejects a quote whose transaction blockhash has expired.


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

> Not available yet. Do not rely on this API for position tracking.

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

> Not available yet. Do not rely on this API for exercise or settlement.

### Fill notification and failed fills

There is currently no buyer `fill` WebSocket notification, no buyer fill
status endpoint, and therefore no notification method name, `txSig`, or series
ID to integrate with yet. `quote.submit` only says whether a quote is best; it
does not mean the trade filled. A selected transaction can still fail before it
lands, including from blockhash expiry, missing/invalid token accounts,
insufficient token balance, rent, or compute failure. The protocol simulates
before sending and broadcasts once; it does not refresh or retry the signed
transaction. Treat the quote as unfilled unless on-chain state confirms it.

When a fill notification is added, its premium amounts will need to state both
the RFQ 1e18 premium-per-contract and the actual Quote Token base-unit total.

### Exercise and settlement status

The on-chain program supports physical settlement after expiry, but the buyer
API for it is not released. It finalizes an expiry price from the configured
Pyth TWAP, permits manual exercise only while the one-hour exercise window is
open, then settles sellers. Calls require the holder to pay Quote Token at the
strike and receive BaseCoin; puts require BaseCoin payment and deliver
Quote Token. Until the positions and exercise APIs are released with their
operational flow, buyers should not run production size.

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
