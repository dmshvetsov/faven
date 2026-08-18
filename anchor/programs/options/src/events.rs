use anchor_lang::prelude::*;

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
