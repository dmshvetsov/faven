use anchor_lang::prelude::*;

use crate::errors::MarketError;

pub fn token_scale(decimals: u8) -> Result<u64> {
    10_u64
        .checked_pow(u32::from(decimals))
        .ok_or(error!(MarketError::MintDecimalsTooLarge))
}
