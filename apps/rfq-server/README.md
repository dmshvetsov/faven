# RFQ server

The configured Wrangler targets are `localdevelopment`, `development`,
`staging`, and `production`. They map respectively to `development:testnet`,
`development:devnet`, `staging:devnet`, and `production:mainnet`.

Before deploying a remote target, replace its placeholder D1 database ID in
`wrangler.jsonc`, create the matching Cloudflare Queue, and set both Worker
secrets:

```sh
corepack pnpm --dir apps/rfq-server exec wrangler secret put SOLANA_RPC_URL --env development
corepack pnpm --dir apps/rfq-server exec wrangler secret put SOLANA_WEBSOCKET_URL --env development
corepack pnpm --dir apps/rfq-server exec wrangler secret put TREASURY_PRIVATE_KEY --env development
```

Repeat for staging and production. Local development includes a testnet SOL
test market for WebSocket integration checks. Browser origins are closed
outside local development, and unsupported markets fail closed.

On devnet, `POST /wallet-fundings` funds an on-curve wallet once every 24
hours. Set `TREASURY_PRIVATE_KEY` to the JSON byte array from a dedicated
Solana CLI keypair that holds the configured mint authority and enough SOL.
If an interrupted request leaves a `pending` row, first check the transaction
signature on Solana; if none was submitted, an operator can change that row to
`failed` in D1, set a completion time and the sanitized reason
`funding-unavailable`, then the wallet can request funding again. Never change
a pending row if its recorded transaction may still settle.
