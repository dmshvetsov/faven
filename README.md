## Devent Tokens

- custom USDC `usdcHvyN6fvECJ1poPYkt1vztze1pQ6psC8i4cji2Ly`
- custom wrapped SOL `wSoLCzXHe214cjx7CFjP1axzXyqLkEwq5Xf873hy1JP`

Mint authority for all above tokens `GcSzHLa3gFdvhnLCbUXq8CDeLftrkhQezYNsc224WzfR` (Faven Devent faucet key-pair)

## Development Setup

### Requirements

    $ brew install hivemind

### Setup

Start Solana program development environment

    $ just anchor-dev

Initialized markets, fund faucets, only needed once on a fresh start

    $ just anchor-dev-setup

### Start Development Env

    $ hivemind

## Rysk RFQ

RFQ request

```json
{
    "jsonrpc": "2.0",
    "method": "request",
    "id": "request",
    "params": {
        "asset": "0x9fdbda0a5e284c32744d2f17ee5c74b284993463",
        "assetName": "UBTC",
        "chainId": 999,
        "expiry": 1793347200,
        "isPut": false,
        "quantity": "100000000000000000",
        "strike": "8800000000000",
        "taker": "0x0000000000000000000000000000000000000000",
        "usd": "0xb88339cb7199b77e23db6e890353e22632ba630f",
        "collateralAsset": "0x9fdbda0a5e284c32744d2f17ee5c74b284993463",
        "isEIP1271": false
    }
}
```

RFQ response

```json
{
    "jsonrpc": "2.0",
    "id": "request",
    "result": {
        "assetAddress": "0x9fdbda0a5e284c32744d2f17ee5c74b284993463",
        "chainId": 999,
        "isPut": false,
        "strike": "8800000000000",
        "expiry": 1793347200,
        "maker": "0x418E14e4D34aDd3C23D2be1C11e6b02e628Ae6Dd",
        "nonce": "1788680416688807",
        "price": "1735232890990000000000",
        "quantity": "150000000000000000",
        "isTakerBuy": false,
        "signature": "0x29a6a9d05cf006c20b0b18bbb3126377f4be64cb6e211f58480c17eb27728e9a00d519892df08e863e41d5e44c9f25fc02bbceab3d5f77a95232ced82b9c6aea1c",
        "usd": "0xb88339cb7199b77e23db6e890353e22632ba630f",
        "collateralAsset": "0x9fdbda0a5e284c32744d2f17ee5c74b284993463",
        "validUntil": 1788680476,
        "premiumAsset": "",
        "apy": 14.69731237449622
    }
}
```

Explanation:

Quantity has 1e18 scale. Price has 1e18 scale.

`quantity = 100000000000000000 = 0.1 × 1e18`, so it represents **0.1 oToken**, or **0.1 BTC** exposure.

`price = 1735267844970000000000 = 1,735.26784497 × 1e18`, so the quoted premium is **$1,735.26784497 per whole oToken/BTC**.

Therefore:

`0.1 × $1,735.26784497 = $173.526784497`

The contract applies the same calculation in token units: `quantity × price × 10^usdDecimals / 1e36`. 
