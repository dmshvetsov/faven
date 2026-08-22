use anchor_lang::prelude::*;

use crate::errors::OptionsError;

pub fn token_scale(decimals: u8) -> Result<u64> {
    10_u64
        .checked_pow(u32::from(decimals))
        .ok_or(error!(OptionsError::MintDecimalsTooLarge))
}

pub const STRIKE_SCALE: u64 = 1_000_000;

pub fn normalize_pyth_price_to_strike_scale(price: i64, expo: i32) -> Result<u64> {
    require!(price > 0, OptionsError::InvalidPythPrice);

    let strike_expo = expo
        .checked_add(6)
        .ok_or(error!(OptionsError::PythPriceOutOfRange))?;
    let raw_price = u128::try_from(price).map_err(|_| error!(OptionsError::InvalidPythPrice))?;

    let normalized = if strike_expo >= 0 {
        let factor = 10_u128
            .checked_pow(
                u32::try_from(strike_expo)
                    .map_err(|_| error!(OptionsError::PythPriceOutOfRange))?,
            )
            .ok_or(error!(OptionsError::PythPriceOutOfRange))?;
        raw_price
            .checked_mul(factor)
            .ok_or(error!(OptionsError::PythPriceOutOfRange))?
    } else {
        let precision = strike_expo
            .checked_abs()
            .ok_or(error!(OptionsError::PythPriceOutOfRange))?;
        let divisor = 10_u128
            .checked_pow(
                u32::try_from(precision).map_err(|_| error!(OptionsError::PythPriceOutOfRange))?,
            )
            .ok_or(error!(OptionsError::PythPriceOutOfRange))?;
        let quotient = raw_price / divisor;
        let remainder = raw_price % divisor;

        if remainder >= divisor / 2 {
            quotient
                .checked_add(1)
                .ok_or(error!(OptionsError::PythPriceOutOfRange))?
        } else {
            quotient
        }
    };

    let normalized =
        u64::try_from(normalized).map_err(|_| error!(OptionsError::PythPriceOutOfRange))?;
    require!(normalized > 0, OptionsError::PythPriceOutOfRange);
    Ok(normalized)
}

pub fn premium_total(quantity: u64, premium_per_contract: u64, base_scale: u64) -> Result<u64> {
    ceil_div(
        u128::from(quantity)
            .checked_mul(u128::from(premium_per_contract))
            .ok_or(error!(OptionsError::ArithmeticOverflow))?,
        u128::from(base_scale),
    )
}

pub fn put_collateral(
    quantity: u64,
    strike_price: u64,
    quote_scale: u64,
    base_scale: u64,
) -> Result<u64> {
    let numerator = u128::from(quantity)
        .checked_mul(u128::from(strike_price))
        .and_then(|value| value.checked_mul(u128::from(quote_scale)))
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;
    let denominator = u128::from(base_scale)
        .checked_mul(u128::from(STRIKE_SCALE))
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;
    ceil_div(numerator, denominator)
}

pub fn operational_fee(premium: u64, fee_bps: u16, min_fee: u64) -> Result<u64> {
    let proportional_fee = u128::from(premium)
        .checked_mul(u128::from(fee_bps))
        .ok_or(error!(OptionsError::ArithmeticOverflow))?
        / 10_000;
    let fee = proportional_fee.max(u128::from(min_fee));
    u64::try_from(fee).map_err(|_| error!(OptionsError::ArithmeticOverflow))
}

fn ceil_div(numerator: u128, denominator: u128) -> Result<u64> {
    require!(denominator != 0, OptionsError::ZeroDivision);

    let value = numerator
        .checked_add(
            denominator
                .checked_sub(1)
                .ok_or(error!(OptionsError::ArithmeticOverflow))?,
        )
        .ok_or(error!(OptionsError::ArithmeticOverflow))?
        / denominator;
    u64::try_from(value).map_err(|_| error!(OptionsError::ArithmeticOverflow))
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_pyth_price_to_strike_scale, operational_fee, premium_total, put_collateral,
    };

    #[test]
    fn premium_rounds_up_in_sellers_favor() {
        assert_eq!(premium_total(3, 5, 2).unwrap(), 8);
    }

    #[test]
    fn put_collateral_rounds_up_to_preserve_solvency() {
        assert_eq!(
            put_collateral(1_000_000_000, 3_500_000, 1_000_000, 1_000_000_000).unwrap(),
            3_500_000
        );
    }

    #[test]
    fn fee_uses_the_greater_of_the_minimum_and_proportional_amount() {
        assert_eq!(operational_fee(100, 500, 10).unwrap(), 10);
        assert_eq!(operational_fee(10_000, 500, 10).unwrap(), 500);
    }

    #[test]
    fn wide_arithmetic_rejects_unrepresentable_values() {
        assert!(premium_total(u64::MAX, u64::MAX, 1).is_err());
        assert!(put_collateral(u64::MAX, u64::MAX, u64::MAX, 1).is_err());
    }

    #[test]
    fn pyth_prices_normalize_to_the_strike_scale() {
        assert_eq!(
            normalize_pyth_price_to_strike_scale(5, 0).unwrap(),
            5_000_000
        );
        assert_eq!(
            normalize_pyth_price_to_strike_scale(12_345_678, -6).unwrap(),
            12_345_678
        );
    }

    #[test]
    fn pyth_prices_round_half_up_when_reducing_precision() {
        assert_eq!(
            normalize_pyth_price_to_strike_scale(12_345_678, -7).unwrap(),
            1_234_568
        );
        assert_eq!(normalize_pyth_price_to_strike_scale(15, -7).unwrap(), 2);
        assert_eq!(normalize_pyth_price_to_strike_scale(14, -7).unwrap(), 1);
    }

    #[test]
    fn pyth_price_normalization_rejects_invalid_or_unrepresentable_values() {
        for (price, expo) in [(0, 0), (-1, 0), (1, 14), (1, i32::MIN)] {
            assert!(normalize_pyth_price_to_strike_scale(price, expo).is_err());
        }
    }
}
