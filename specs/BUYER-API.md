# Buyer API documentation

## WebSocket endpoints

| Endpoint | Purpose |
|---|---|
| `wss:/<faven api root>/rfqs/<asset>` | Receive RFQs for `<asset>` - base coin mint address |
| `wss://<faven api root>/maker` | Generate underwrite transactions, submit quotes, and request positions for one BaseCoin market |

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
  id: string // UUIDv7, will be equal to sent JsonRpcResponse.id
  result?: unknown
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
}
```

## 1. Incoming RFQ — `/rfqs/<asset>`

`<asset>` is the underlying solana token mint address

```text
wss://v12.rysk.finance/rfqs/5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ
```

An RFQ is a JSON-RPC request message. `RfqRequest.id` is the RFQ ID you must use when submitting the quote.

```ts
type RfqRequest = {
  jsonrpc: "2.0"
  id: string // this is rfqId, must be generated UUIDv7
  method: "rfq.request",
  params: Rfq
}

type Rfq = {
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

`RfqRequest.id` (rfqId in UUID format) represents a distinct RFQ request, even if the option terms repeat.

## 2. Generate an underwrite transaction — `/maker?asset=<BaseCoin-mint>`

```ts
type UnderwriteTxGenerateRequest = {
  jsonrpc: "2.0"
  id: string, // generated UUIDv7
  method: "underwriteTx.generate"
  params: {
    rfqId: string             // RfqRequest.id value must be used for rfqId
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
  id: string // UnderwriteTxGenerateRequest.id
  result: {
    rfqId: string              // RfqRequest.id and UnderwriteTxGenerateRequest.params.rfqId
    underwriteTx: string       // base64 encoded unsigned transaction
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

Use incoming RFQ JSON-RPC request id that is `rfqId` as quote JSON-RPC request id.

```ts
type QuoteRequest = {
  jsonrpc: "2.0"
  id: string // rfqId from RfqRequest must be used here
  method: "quote.submit",
  params: Quote
}

type Quote = {
  assetAddress: string       // must equal RFQ asset
  chainId: string            // must equal RFQ chainId
  expiry: number             // must equal RFQ expiry
  isPut: boolean             // must equal RFQ isPut
  maker: string              // maker EOA / signing address
  quantity: string           // e18; must equal RFQ quantity
  strike: string             // e8; must equal RFQ strike
  premiumAsset: string       // must equal RFQ premiumAsset
  collateralAsset: string    // must equal RFQ collateralAsset

  validUntil: number         // Unix seconds, no more than 40 seconds in the future (max time for solana blockhash TTL) until this quote is valid
  premium: string            // e18 USD premium per one option unit
  underwriteTx: string       // maker signed underwriteTx with premium and recentBlockhash set
}
```

`underwriteTx` is used to validate correctness of Quote.signature and whole QuoteRequest.params (Quote) against sent RfqRequest.result


```ts
type QuoteResponse = {
  jsonrpc: "2.0"
  id: string // rfqId in UUID format
  result: RfqResult
}
```

```ts
/** Result of comparing of all quotes from all buyers */
type RfqResult = {
  assetAddress: string
  chainId: string
  bestQuote: string                // best quote tat was sent to seller
  providedQuote: string            // quote provided connected maker (you)
  providedStatus: string           // best | not_best
}
```

- `best` — your quote is currently best.
- `not_best` — another quote is currently better.
- `best_received_later` — same as the best quote but received later than another quote with the same best terms
- `deadline` - your quote submitted after the RFQ deadline

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

## Notes

Maker(s) and buyer is used interchangeably in this document.
