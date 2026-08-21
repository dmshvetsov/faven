use crate::{
    errors::MarketError,
    state::{current_time_ms, MIN_UNDERWRITING_LEAD_TIME_MS},
};
use anchor_lang::prelude::*;

pub fn ensure_min_expiry(expiry_ms: u64) -> Result<u64> {
    let minimum_expiry_ms = current_time_ms()?
        .checked_add(MIN_UNDERWRITING_LEAD_TIME_MS)
        .ok_or(error!(MarketError::ArithmeticOverflow))?;

    require!(expiry_ms > minimum_expiry_ms, MarketError::ExpiryTooSoon);
    Ok(expiry_ms)
}
