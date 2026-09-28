## Mainnet

Solana mainnet program [FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT](https://explorer.solana.com/address/FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT)

## Development Setup

### Requirements

- hivemind
- pnpm
- rust
- surfpool
- anchor CLI
- solana CLI

### Setup

Install rfq/web/admin-cli dependencies

    $ pnpm install

Start Solana program development environment

    $ just anchor-dev

Initialized markets, fund faucets, only needed once on a fresh start

    $ just anchor-dev-setup

### Start Development Env

    $ hivemind
