use anchor_lang::prelude::*;

use crate::state::OptionType;
use crate::state::OracleKind;

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub operator: Pubkey,
    pub oracle_kind: OracleKind,
    pub oracle_feed_id: [u8; 32],
    pub quote_coin_mint: Pubkey,
    pub base_coin_mint: Pubkey,
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
