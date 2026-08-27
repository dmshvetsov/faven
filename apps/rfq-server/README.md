# RFQ server

Cloudflare Worker bootstrap for the non-custodial Solana RFQ server.

The configured Wrangler targets are `localdevelopment`, `development`,
`staging`, and `production`. They map respectively to `development:testnet`,
`development:devnet`, `staging:devnet`, and `production:mainnet`.

Before deploying a remote target, replace its placeholder D1 database ID in
`wrangler.jsonc`, create the matching Cloudflare Queue, and set both Worker
secrets:

```sh
corepack pnpm --dir apps/rfq-server exec wrangler secret put SOLANA_RPC_URL --env development
corepack pnpm --dir apps/rfq-server exec wrangler secret put SOLANA_WEBSOCKET_URL --env development
```

Repeat for staging and production. Market configuration deliberately starts
empty and browser origins are closed outside local development, so unsupported
markets and origins fail closed until explicitly configured.
