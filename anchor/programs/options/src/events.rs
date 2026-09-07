use anchor_lang::prelude::*;

use crate::state::{FinalizationMethod, OptionType, OracleConfig, OracleKind};

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub operator: Pubkey,
    pub oracle_kind: OracleKind,
    pub oracle_feed_id: [u8; 32],
    pub quote_mint: Pubkey,
    pub base_mint: Pubkey,
}

#[event]
pub struct SeriesCreated {
    pub series: Pubkey,
    pub market: Pubkey,
    pub option_type: OptionType,
    pub strike_price: u64,
    pub expiry_ms: u64,
}

#[event]
pub struct Underwritten {
    pub series: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub quantity: u64,
    pub long_mint: Pubkey,
    pub collateral_deposited: u64,
    pub premium_total: u64,
    pub operational_fee: u64,
    pub fee_recipient: Pubkey,
}

#[event]
pub struct Exercised {
    pub series: Pubkey,
    pub holder: Pubkey,
    pub option_type: OptionType,
    pub quantity: u64,
    pub input_asset_amount: u64,
    pub output_asset_amount: u64,
}

#[event]
pub struct PythTwapPrice {
    pub market: Pubkey,
    pub twap_update: Pubkey,
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub start_time: i64,
    pub end_time: i64,
    pub down_slots_ratio: u32,
    pub normalized_price: u64,
}

#[event]
pub struct PythUnverifiedPrice {
    pub market: Pubkey,
    pub operator: Pubkey,
    pub id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    pub normalized_price: u64,
}

#[event]
pub struct ExpiryPriceFinalized {
    pub series: Pubkey,
    pub normalized_price: u64,
    pub oracle_config: OracleConfig,
    pub method: FinalizationMethod,
}

#[event]
pub struct SellerPayoutSettled {
    pub series: Pubkey,
    pub seller: Pubkey,
    pub base_coin_amount: u64,
    pub quote_coin_amount: u64,
}

#[event]
pub struct SeriesSettlementBatchCompleted {
    pub series: Pubkey,
    pub settled_seller_count: u16,
}

#[event]
pub struct SeriesClosed {
    pub series: Pubkey,
    pub series_closer: Pubkey,
    pub rent_recipient: Pubkey,
    pub base_coin_dust_amount: u64,
    pub quote_coin_dust_amount: u64,
}
