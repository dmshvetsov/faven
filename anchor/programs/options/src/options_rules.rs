use crate::{
    errors::OptionsError,
    state::{current_time_ms, MIN_UNDERWRITING_LEAD_TIME_MS},
};
use anchor_lang::prelude::*;

pub fn ensure_min_expiry(expiry_ms: u64) -> Result<u64> {
    require!(expiry_ms % 1_000 == 0, OptionsError::ExpiryNotWholeSecond);

    let minimum_expiry_ms = current_time_ms()?
        .checked_add(MIN_UNDERWRITING_LEAD_TIME_MS)
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;

    require!(expiry_ms > minimum_expiry_ms, OptionsError::ExpiryTooSoon);
    Ok(expiry_ms)
}
