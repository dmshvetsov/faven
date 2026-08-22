use crate::{
    errors::OptionsError,
    math::rescale_fixed_point_round_half_up,
    state::{current_time_ms, MIN_UNDERWRITING_LEAD_TIME_MS},
};
use anchor_lang::prelude::*;

pub const STRIKE_DECIMALS: i32 = 6;
pub const STRIKE_SCALE: u64 = 1_000_000;

pub fn price_to_strike_scale(price: i64, exponent: i32) -> Result<u64> {
    require!(price > 0, OptionsError::InvalidPythPrice);

    let value = u128::try_from(price).map_err(|_| error!(OptionsError::InvalidPythPrice))?;
    rescale_fixed_point_round_half_up(value, exponent, STRIKE_DECIMALS)
}

pub fn ensure_min_expiry(expiry_ms: u64) -> Result<u64> {
    require!(expiry_ms % 1_000 == 0, OptionsError::ExpiryNotWholeSecond);

    let minimum_expiry_ms = current_time_ms()?
        .checked_add(MIN_UNDERWRITING_LEAD_TIME_MS)
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;

    require!(expiry_ms > minimum_expiry_ms, OptionsError::ExpiryTooSoon);
    Ok(expiry_ms)
}

#[cfg(test)]
mod tests {
    use super::price_to_strike_scale;

    #[test]
    fn prices_normalize_to_the_strike_scale() {
        assert_eq!(price_to_strike_scale(5, 0).unwrap(), 5_000_000);
        assert_eq!(price_to_strike_scale(12_345_678, -6).unwrap(), 12_345_678);
    }

    #[test]
    fn price_to_strike_scale_rejects_non_positive_prices() {
        assert!(price_to_strike_scale(0, 0).is_err());
        assert!(price_to_strike_scale(-1, 0).is_err());
    }
}
