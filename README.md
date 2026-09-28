# Faven

On-chain option protocol handles collateralization, settlement, and exercise logic.

Off-chain server matches sellers and buyers via fast request for quote system (RFQ).

Web app serves as a easy to understand wrapper for 2 options selling/income strategies cash-secured puts (buy lower) and covered-calls (sell higher).

## Mainnet

Solana mainnet program [FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT](https://explorer.solana.com/address/FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT)

Mainnet web app https://beta.faven.markets

## Product demo

- Video [Sell 1 SPCX tokenized stock at higher price in the future and receive a premium for this commitment (2 mins long)](https://youtu.be/Lp1-KoChD1w?si=wsb2c_f7WGcqhyj2)


Mainnet Transactions:
- [Call (Sell higher)](https://explorer.solana.com/tx/eLWGzJodVBhTdRogZ38ge3rHUR8P8dMk2M2VJR2Frg5qhza4J71B9vHfqGXXus2AKRWgaeMxXSPuqG5Yi7Hzqq8) Backpack Security SPCX <> USDC option with expiry OCT 9, 2026
- [Call (Sell higher)](https://explorer.solana.com/tx/2k75fDUGseAQu8MftRXmumXmn5arA5sFfzDRSWTyLxAGoJeV53Q8iz3iiZFEDsY9Fohj2UfNyLrMma2TxF3gD6tz) Backpack Security SPCX <> USDC option with expiry OCT 2, 2026
- [Call (Sell higher)](https://explorer.solana.com/tx/WDELfWMT4XRfb48dWGEd5LkXm2PF2dt1T5ehUebDNTBRM42usK1wB7VHKnZQhmcfe52ZGZzdyJKuZpfcuRbemBi) wSOL <> USDC option with expiry OCT 2, 2026
- [Put (Sell higher)](https://explorer.solana.com/tx/37R7xCkBj4g5xMbuJpsSLKTMgEoRAKnVdBUa1yMeUTb78vQeeH26zLA3EaJ7xdKuNc4VVSTyYA94WVgfMuA3ocdB) wSOL <> USDC option with expiry OCT 2, 2026

## On-chain Settlement and Exercise

Each option call or put is fully collateralized on-chain, physically settled, 

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
