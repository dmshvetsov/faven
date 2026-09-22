# RFQ server

The configured Wrangler targets are `localdevelopment`, `development`,
`staging`, and `production`. They map respectively to `development:testnet`,
`development:devnet`, `staging:devnet`, and `production:mainnet`.

Before deploying a remote target, replace its placeholder D1 database ID in
`wrangler.jsonc`, create the matching Cloudflare Queue, and set both Worker
secrets:

```sh
pnpm --dir apps/rfq-server exec wrangler secret put SOLANA_RPC_URL --env <cf env>
pnpm --dir apps/rfq-server exec wrangler secret put FAUCET_PRIVATE_KEY --env <cf env>
pnpm --dir apps/rfq-server exec wrangler secret put ADMIN_AUTH_TOKEN --env <cf env>
```

Repeat for staging and production.

## Canonical term units

The API and D1 database store fixed-point integers as decimal strings:

- `quantity`: whole-option quantity with 18 decimals (e18)
- `premium`: QuoteCoin premium per whole option with 18 decimals (e18)
- `strike`: USD strike with 8 decimals (e8)

The RFQ server and its clients operates strictly these scales.
The options program expose instructions for e18 quantity and premium scales.
The same e8 strike scale used both in the RFQ server and the option program.

On devnet, `POST /wallet-fundings` funds an on-curve wallet once every 24
hours. Set `FAUCET_PRIVATE_KEY` to the JSON byte array from a dedicated
Solana CLI keypair that holds the configured mint authority and enough SOL.
If an interrupted request leaves a `pending` row, first check the transaction
signature on Solana; if none was submitted, an operator can change that row to
`failed` in D1, set a completion time and the sanitized reason
`funding-unavailable`, then the wallet can request funding again. Never change
a pending row if its recorded transaction may still settle.
