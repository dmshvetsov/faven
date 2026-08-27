# RFQ-Server API documentation

## WebSocket endpoints

| Endpoint | Purpose |
|---|---|
| `wss://v12.rysk.finance/rfqs/<asset>` | Receive RFQs for `<asset>` - underlying-token address |
| `wss://v12.rysk.finance/maker` | Submit quotes, balance requests, and position requests |

## Common JSON-RPC envelopes

This API MUST follow [JSON-RPC 2.0 standard](https://www.jsonrpc.org/specification).

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
  result: Rfq
}

type Rfq = {
  asset: string             // underlying token address
  assetName: string         // oracle price "wBTC", "wETH", "wSOL", "JUP" etc
  chainId: string           // solana:mainnet, solana:devnet, solana:testnet
  expiry: number            // Unix seconds
  isPut: boolean
  quantity: string          // 1e18 option amount
  strike: string            // 1e8 USD strike
  collateralAsset: string   // asset used as collateral by option seller
  premiumAsset: string      // premium-payment token mint address
  requestDeadline: number   // Unix milliseconds
  underwriteTx: string      // base64 encoded, prepared and unsigned transaction that must be updated, signed and send with Quote response
}
```

`RfqRequest.id` (rfqId in UUID format) represents a distinct RFQ request, even if the option terms repeat.

To sign `underwriteTx` base64 encoded string:
1. decoded `underwriteTx` to solana transaction
2. set transaction `premium` and `recentBlockhash` (from current Solana blockchain `blockhash` state), transaction premium must equal to `Quote.premium`
3. sign the transaction
4. encode updated `underwriteTx` to base64 (with `premium` and `recentBlockhash` set)
5. include updated `underwriteTx` and the signature in `QuoteResponse`

## 2. Submit a quote for RFQ — `/maker`

Use incoming RFQ JSON-RPC request id that is `rfqId` as quote JSON-RPC request id.

```ts
type QuoteRequest = {
  jsonrpc: "2.0"
  id: string // rfqId from RfqRequest must be used here
  method: "quote",
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
  usd: string                // must equal RFQ usd
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
  providedStatus: string           // best | notbest
}
```

- `best` — your quote is currently best.
- `notbest` — another quote is currently better.

## 3. Get positions — `/maker`

```json
{
  "jsonrpc": "2.0",
  "id": "<generated UUIDv7>",
  "method": "positions",
  "params": {
    "account": "<public key (address) used to sign underwrite transactions (buy options)>"
  }
}
```

## Notes

Maker(s) and buyer is used interchangeably in this document.
