use anchor_lang::prelude::*;

use crate::{errors::OptionsError, options_rules::STRIKE_SCALE};

pub fn token_scale(decimals: u8) -> Result<u64> {
    10_u64
        .checked_pow(u32::from(decimals))
        .ok_or(error!(OptionsError::MintDecimalsTooLarge))
}

pub fn rescale_fixed_point_round_half_up(
    value: u128,
    exponent: i32,
    target_decimals: i32,
) -> Result<u64> {
    let scale_exponent = exponent
        .checked_add(target_decimals)
        .ok_or(error!(OptionsError::PythPriceOutOfRange))?;

    let normalized = if scale_exponent >= 0 {
        let factor = 10_u128
            .checked_pow(
                u32::try_from(scale_exponent)
                    .map_err(|_| error!(OptionsError::PythPriceOutOfRange))?,
            )
            .ok_or(error!(OptionsError::PythPriceOutOfRange))?;
        value
            .checked_mul(factor)
            .ok_or(error!(OptionsError::PythPriceOutOfRange))?
    } else {
        let precision = scale_exponent
            .checked_abs()
            .ok_or(error!(OptionsError::PythPriceOutOfRange))?;
        let divisor = 10_u128
            .checked_pow(
                u32::try_from(precision).map_err(|_| error!(OptionsError::PythPriceOutOfRange))?,
            )
            .ok_or(error!(OptionsError::PythPriceOutOfRange))?;
        let quotient = value / divisor;
        let remainder = value % divisor;

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
    call_payment(quantity, strike_price, quote_scale, base_scale)
}

pub fn call_payment(
    quantity: u64,
    strike_price: u64,
    quote_scale: u64,
    base_scale: u64,
) -> Result<u64> {
    let (numerator, denominator) =
        strike_payment_fraction(quantity, strike_price, quote_scale, base_scale)?;
    ceil_div(numerator, denominator)
}

pub fn put_payout(
    quantity: u64,
    strike_price: u64,
    quote_scale: u64,
    base_scale: u64,
) -> Result<u64> {
    let (numerator, denominator) =
        strike_payment_fraction(quantity, strike_price, quote_scale, base_scale)?;
    u64::try_from(numerator / denominator).map_err(|_| error!(OptionsError::ArithmeticOverflow))
}

fn strike_payment_fraction(
    quantity: u64,
    strike_price: u64,
    quote_scale: u64,
    base_scale: u64,
) -> Result<(u128, u128)> {
    let numerator = u128::from(quantity)
        .checked_mul(u128::from(strike_price))
        .and_then(|value| value.checked_mul(u128::from(quote_scale)))
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;
    let denominator = u128::from(base_scale)
        .checked_mul(u128::from(STRIKE_SCALE))
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;
    require!(denominator != 0, OptionsError::ZeroDivision);
    Ok((numerator, denominator))
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
        call_payment, operational_fee, premium_total, put_collateral, put_payout,
        rescale_fixed_point_round_half_up,
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
    fn call_payment_rounds_up_for_fractional_quote_base_units() {
        assert_eq!(call_payment(1, 1, 1, 3).unwrap(), 1);
    }

    #[test]
    fn put_payout_rounds_down_and_cannot_exceed_put_collateral() {
        let collateral = put_collateral(1, 1, 1, 3).unwrap();
        let payout = put_payout(1, 1, 1, 3).unwrap();

        assert_eq!(payout, 0);
        assert!(payout <= collateral);
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
        assert!(call_payment(u64::MAX, u64::MAX, u64::MAX, 1).is_err());
        assert!(put_payout(u64::MAX, u64::MAX, u64::MAX, 1).is_err());
    }

    #[test]
    fn fixed_point_values_rescale_to_the_target_precision() {
        assert_eq!(
            rescale_fixed_point_round_half_up(5, 0, 6).unwrap(),
            5_000_000
        );
        assert_eq!(
            rescale_fixed_point_round_half_up(12_345_678, -6, 6).unwrap(),
            12_345_678
        );
    }

    #[test]
    fn fixed_point_values_round_half_up_when_reducing_precision() {
        assert_eq!(
            rescale_fixed_point_round_half_up(12_345_678, -7, 6).unwrap(),
            1_234_568
        );
        assert_eq!(rescale_fixed_point_round_half_up(15, -7, 6).unwrap(), 2);
        assert_eq!(rescale_fixed_point_round_half_up(14, -7, 6).unwrap(), 1);
    }

    #[test]
    fn fixed_point_rescaling_rejects_unrepresentable_values() {
        for (value, exponent) in [(1, 14), (1, i32::MIN)] {
            assert!(rescale_fixed_point_round_half_up(value, exponent, 6).is_err());
        }
    }
}
