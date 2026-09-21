# Local Markets

This runbook creates predefined Markets for development.

- minimum fee: 2 USDC (`2_000_000` raw USDC units)
- operational fee range: 200–1,500 bps (2%–15%)

It uses `~/.config/solana/id.json` as the immutable Market operator (must exists on the developers computer).

Start Surfpool development env:

    $ just anchor-dev

Run runbook:

    $ just anchor-dev-setup
