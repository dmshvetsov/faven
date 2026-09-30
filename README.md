# Faven

Set a price to buy or sell crypto or Backpack Securities tokenized stocks. Choose the end date. Open trade. Get paid upfront.

On the selected date, you trade is executed only if the market reaches your price, like a limit order. If it does not, your collateral is returned. Either way, you keep the upfront payment.

Everything is known before you open a trade: payment, collateral, end date, and the only 2 possible outcomes. Nothing to monitor or rebalance. No hidden fees, no slippage, no spread traps, no leverage, no liquidation.

https://beta.faven.markets

Team:
- Dima [github](https://github.com/dmshvetsov) | [linkedin](https://www.linkedin.com/in/dmshvetsov/) | [X](https://x.com/dmshvetsov)
- Timur [website](https://timurakiev.com) | [linkedin](https://www.linkedin.com/in/timur-akiev/)

## How it Works

On-chain option protocol handles collateralization, settlement, and exercise logic.

Off-chain server matches sellers and buyers via fast request for quote system (RFQ).

Web app serves as a easy to understand wrapper for 2 options selling/income strategies cash-secured puts (buy lower) and covered-calls (sell higher).

Sellers use Faven web app. Buyer are connected to the RFQ server via web-sockets.

## Product demo

- Video [Sell 1 SPCX tokenized stock at higher price in the future and receive a premium for this commitment (2 mins long)](https://youtu.be/Lp1-KoChD1w?si=wsb2c_f7WGcqhyj2)


Mainnet Transactions:
- [Call (Sell higher)](https://explorer.solana.com/tx/eLWGzJodVBhTdRogZ38ge3rHUR8P8dMk2M2VJR2Frg5qhza4J71B9vHfqGXXus2AKRWgaeMxXSPuqG5Yi7Hzqq8) Backpack Security SPCX <> USDC option with expiry OCT 9, 2026
- [Call (Sell higher)](https://explorer.solana.com/tx/2k75fDUGseAQu8MftRXmumXmn5arA5sFfzDRSWTyLxAGoJeV53Q8iz3iiZFEDsY9Fohj2UfNyLrMma2TxF3gD6tz) Backpack Security SPCX <> USDC option with expiry OCT 2, 2026
- [Call (Sell higher)](https://explorer.solana.com/tx/WDELfWMT4XRfb48dWGEd5LkXm2PF2dt1T5ehUebDNTBRM42usK1wB7VHKnZQhmcfe52ZGZzdyJKuZpfcuRbemBi) wSOL <> USDC option with expiry OCT 2, 2026
- [Put (Sell higher)](https://explorer.solana.com/tx/37R7xCkBj4g5xMbuJpsSLKTMgEoRAKnVdBUa1yMeUTb78vQeeH26zLA3EaJ7xdKuNc4VVSTyYA94WVgfMuA3ocdB) wSOL <> USDC option with expiry OCT 2, 2026

## On-chain Settlement and Exercise

Each option call or put is fully collateralized on-chain, physically settled, European-style option. Seller position is represented as on-chain accounting, buyer gets SPL fungible Long token.

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
