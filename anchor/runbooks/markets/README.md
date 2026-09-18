# Local Markets

This runbook creates the SOL / USDC / wSOL Market once, using:

- minimum fee: 2 USDC (`2_000_000` raw USDC units)
- operational fee range: 200–1,500 bps (2%–15%)
- Pyth feed: SOL/USD

It uses `~/.config/solana/id.json` as the immutable Market operator. The
serialized instruction is intentionally bound to its current public key:
`devzwDpAW2Y4LUki4JxzxaJeRA8YnQVwth1LZ8riudA`.

For a fresh environment, from `anchor/` run:

```sh
surfpool start --db .surfpool/faven.sqlite --runbook deployment --runbook markets --yes
```

For normal resumes, start the same database without running the bootstrap:

```sh
surfpool start --db .surfpool/faven.sqlite --no-deploy
```

Then run the RFQ server normally; its local D1 database resumes by default.

PUMP and SPCX configurations are documented and commented out in `main.tx`.
They cannot be created until Options supports Token-2022 Transfer Hook mints.
SPCX uses the `Crypto.SPCXX/USD` Pyth feed.
