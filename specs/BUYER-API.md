# Buyer API documentation

Faven API for buyers. Faven implements European options, physical settlement, fully collateralised, with Pyth oracle.

Only legacy SPL tokens are supported, in all cases, by Faven and options program at this moment.

Maker and buyer is used interchangeably in this document.

Underlying and base token (base token mint) is used interchangeably in this document.

Raw bytes, such as transaction bytes, are encoded using base64. Unless otherwise noted, encoded strings are encoded using base64. Solana public keys are always encoded using base58.

## WebSocket endpoints

- `wss://devnet-api.faven.markets/rfqs/<asset>` Receive RFQs for `<asset>` - base token mint address, each asset separate connection
- `wss://devnet-api.faven.markets/maker` One global socket for every market: generate underwrite transactions, submit quotes, list positions, exercise Long options tokens.

Open one `/maker` socket per buyer application. This version
has no WebSocket authentication, API key, or wallet-binding handshake.
The `maker` public key and its signature are checked for each transaction; 

No application-level heartbeat, ping/pong message, or heartbeat timeout is implemented. The server only relies on WebSocket close/error events.

Clients must reconnect themselves; the server does not provide a resume token or subscription state.

RFQs are broadcast only to sockets currently connected to `/rfqs/<asset>`. No replay or catch-up endpoint exists. Any RFQ sent while disconnected is permanently missed.

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
wss://devnet-api.faven.markets/rfqs/5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ
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
  chainId: string           // solana:mainnet-beta, solana:devnet, solana:testnet
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

Faven takes a fee from total premium `faven fee = premium * Rfq.quantity whole tokens * faven fee bps` and shows sellers `seller premium = premium - faven fee`. The fee is transferred within underwrite instruction, no separate instruction for a fee in `underwriteTx`. The fee MAY vary but remains inside on-chain configures min, min_bps, max_bps values that all options series share.

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

### Underwrite instruction verification

[Example of an underwriteTx](https://explorer.solana.com/tx/4j1hMzodU1MxpdaPaQT5WuNAtUnBktNAz2GLUmzYXi4sdeDHfUkj8grDgwTPGUh3ijvFK5B1gG75vaeptxMgfw2F?cluster=devnet) with decoded arguments and accounts.

The program ID is `FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT`.

IDL provided separately.

## 3. Submit a quote for RFQ — `/maker` endpoint

Each buyer quote blindly without knowing quotes of other buyers.
Buyer allowed to provide quote only once per RFQ. Provided quote is final,
duplicates or updates are not allowed. Invalid quotes,
including quotes sent after deadline, do not consume one quote per RFQ slot.

Best-quote rule: highest premium wins, time priority on ties.

Seller see only the best quote and may choose not to use it to underwrite.

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
comparing. For example, with `requestDeadline = 1770000000123` ms, the allowed
integer range is `1770000001` through `1770000040` sec inclusive. The server
also rejects a quote whose transaction blockhash has expired.


```ts
type QuoteResponse = {
  jsonrpc: "2.0"
  id: string // will match QuoteRequest.id
  result: {
    rfqId: string              // will match Quote.rfqId (QuoteRequest.params.rfqId)
    bestQuote: string          // 1e18 currently best quote premium
    providedQuote: string      // quote provided in QuoteRequest
    providedStatus: "best" | "not_best" | "best_received_later"
  }
}
```

All providedStatus values:
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

## 4. Get list of options — `/maker` endpoint


```ts
type PositionsRequest = {
  jsonrpc: "2.0",
  id: string, // generated UUIDv7
  method: "underwrites.list",
  params: {
    buyerAccount: string // address used to sign underwrite transactions as a buyer (bought Long)
    expired?: boolean; // false - open position, true - cannot be exercised, exercise window ended
    priceFinalized?: boolean; // false - open option series and expiration price is not know, true - either in the exercise window or already expired
  }
}
```

Use `priceFinalized` and `expired` together for getting open positions, positions that can be exercised now, 

| expired | priceFinalized| result |
|---|---|---|
| false | true | options with known expiration price, exercisable (if position ITM) until the exercise window ends
| false | false | options that have time to expiry, hence expiry price is unknown, not exercisable
| true | true | expired options, with known expiraiton price, no longer exercisable
| true | false | not possible, no results

```ts
type PositionsResult = {
  jsonrpc: "2.0"
  id: string // will match PositionsRequest.id
  result: {
    account: string                         // will match PositionsRequest.params.account
    underwrites: AccountSeriesUnderwrites[] // total options underwritten by series where provided account is buyer
  }
}

type AccountSeriesUnderwrites = {
  seriesAddress: string
  longMint: string                 // SPL mint address for the Long option token
  marketAddress: string
  isPut: boolean
  expiryMs: number
  expiryPrice: string | null       // USD final price, 1e8 fixed-point; present when priceFinalized is true
  exerciseWindowEndMs: number
  strike: string                   // USD strike, 1e8 fixed-point
  baseMint: string                 // physical-delivery token mint address
  quoteMint: string                // strike, premium, and call-exercise payment token mint address
  quantity: string                 // current Long token balance, 1e18 fixed-point
}
```

`underwrite` contains one item for each series where `PositionsRequest.params.account`
was buyer. 

Note `PositionsRequest` API does not track Long token transfers
and must be treated as a snapshot of all underwrite transactions
when they happened.

No pagination at this point the whole list of filtered/unfiltered positions is returned.


## 5. Exercise - `/maker` endpoint

`exercise_e18` instruction takes one argument:
- `quantity_e18: u128` — Long tokens to burn, expressed as an e18 Base Token quantity.

`quantity_e18` must be greater than zero and scalable down to the Base Token
mint's decimals without rounding. For example, a 9-decimal Base Token requires
`quantity_e18` to be divisible by `1_000_000_000` which is `1e9 = e18 - e9`:
`1_000_000_000_123_000_000` is invalid `quantity_e18` for 9-decimal mint token,
`1_000_000_321_000_000_000` is valid `quantity_e18` for 9-decimal mint token,
Converted amount to Base mint decimals that exceeds `u64` are rejected.

The holder sends these accounts in order:
- `holder` — Long tokens holder, signer and transaction fee payer
- `market`
- `baseMint`
- `quoteMint`
- `series`
- `longMint`
- `holderLongSource` — holder-owned token account for `longMint`
- `holderPaymentSource` — holder-owned `quoteMint` account for calls, `baseMint` account for puts
- `holderReceiptAta` — holder’s ATA for `baseMint` on calls, `quoteMint` on puts; created by the instruction if absent
- `baseCollateralVault` — Series PDA’s ATA for `baseMint`
- `quoteCollateralVault` — Series PDA’s ATA for `quoteMint`
- `tokenProgram`
- `associatedTokenProgram`
- `systemProgram`

Exercise is permitted only after expiry-price finalization, while an ITM
option series' one-hour exercise window remains open. `Long` option series
token holders MUST submit exercise transaction.

Seller settlement remains server-operated after exercise window; Settlement
is not a `/maker` action.

## 6. Quote Fill Notifications - `/maker` endpoint

The server sends `underwrite.fill` only to the connected to `/maker` WebSocket
buyer that produced the selected quote and signed `underwriteTx`.

It fires when the underwrite transaction is confirmed on-chain. It also fires
with `status: "failed"` when the transaction cannot complete because of the
buyer input, such as an expired blockhash, an invalid buyer payment token
account, or insufficient buyer SPL tokens.

The server sends no notification when no quote fills, or when the failure is
caused by the seller or a technical issue such as network or compute failure.

```ts
type UnderwriteFillNotification = {
  jsonrpc: "2.0"
  method: "underwrite.fill"
  params: {
    rfqId: string              // RFQ that selected this quote
    txSig: string              // fee-payer transaction signature
    status: "confirmed" | "failed"
    marketId: string           // market public key
    seriesId: string           // option series public key
    strike: string             // USD strike, 1e8
    isPut: boolean             // false for calls, true for puts
    expiry: number             // Unix seconds
    quantity: string           // 1e18 option contracts
    premium: string            // 1e18 premium per whole option contract
    error?: string             // present only when status is "failed"
  }
}
```

## Error codes

RFQ errors use `1xxx` codes. The error `data` SHOULD include `rfqId` when available,
`rfqId` not guarantied to be present in `data`. None of the below errors consume
an RFQ quote slot.

| Code | Meaning |
|---|---|
| `1001` | Unknown, expired, disconnected, or already-consumed RFQ. |
| `1002` | RFQ or transaction terms do not match configured market rules. |
| `1003` | Invalid, missing, altered, or expired transaction signatures. |
| `1004` | Submitted transaction does not exactly match a stored buyer offer. |
| `1005` | RFQ aggregation window has closed. |

Exercise errors use `2xxx` codes

| Code | Meaning |
| -- | -- |
