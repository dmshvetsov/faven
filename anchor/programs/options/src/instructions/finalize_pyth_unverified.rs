use anchor_lang::prelude::*;

use crate::{
    errors::OptionsError,
    events::PythUnverifiedPrice,
    finalization::finalize_series,
    math::normalize_pyth_price_to_strike_scale,
    state::{FinalizationMethod, Market, Series},
};

pub fn finalize_pyth_unverified_one_series(
    ctx: Context<FinalizePythUnverifiedOneSeries>,
    id: [u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) -> Result<()> {
    let normalized_price = normalize_pyth_price_to_strike_scale(price, expo)?;
    emit_unverified_price(
        ctx.accounts.market.key(),
        ctx.accounts.operator.key(),
        id,
        price,
        conf,
        expo,
        publish_time,
        normalized_price,
    );
    finalize_series(
        ctx.accounts.market.key(),
        &ctx.accounts.market,
        &mut [&mut ctx.accounts.series_one],
        normalized_price,
        FinalizationMethod::PythUnverified,
    )
}

pub fn finalize_pyth_unverified_two_series(
    ctx: Context<FinalizePythUnverifiedTwoSeries>,
    id: [u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) -> Result<()> {
    finalize_unverified_batch(
        ctx.accounts.market.key(),
        ctx.accounts.operator.key(),
        &ctx.accounts.market,
        &mut [&mut ctx.accounts.series_one, &mut ctx.accounts.series_two],
        id,
        price,
        conf,
        expo,
        publish_time,
    )
}

pub fn finalize_pyth_unverified_four_series(
    ctx: Context<FinalizePythUnverifiedFourSeries>,
    id: [u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) -> Result<()> {
    finalize_unverified_batch(
        ctx.accounts.market.key(),
        ctx.accounts.operator.key(),
        &ctx.accounts.market,
        &mut [
            &mut ctx.accounts.series_one,
            &mut ctx.accounts.series_two,
            &mut ctx.accounts.series_three,
            &mut ctx.accounts.series_four,
        ],
        id,
        price,
        conf,
        expo,
        publish_time,
    )
}

pub fn finalize_pyth_unverified_eight_series(
    ctx: Context<FinalizePythUnverifiedEightSeries>,
    id: [u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) -> Result<()> {
    finalize_unverified_batch(
        ctx.accounts.market.key(),
        ctx.accounts.operator.key(),
        &ctx.accounts.market,
        &mut [
            &mut ctx.accounts.series_one,
            &mut ctx.accounts.series_two,
            &mut ctx.accounts.series_three,
            &mut ctx.accounts.series_four,
            &mut ctx.accounts.series_five,
            &mut ctx.accounts.series_six,
            &mut ctx.accounts.series_seven,
            &mut ctx.accounts.series_eight,
        ],
        id,
        price,
        conf,
        expo,
        publish_time,
    )
}

fn finalize_unverified_batch(
    market_key: Pubkey,
    operator: Pubkey,
    market: &Account<Market>,
    series_accounts: &mut [&mut Account<Series>],
    id: [u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) -> Result<()> {
    let normalized_price = normalize_pyth_price_to_strike_scale(price, expo)?;
    emit_unverified_price(
        market_key,
        operator,
        id,
        price,
        conf,
        expo,
        publish_time,
        normalized_price,
    );
    finalize_series(
        market_key,
        market,
        series_accounts,
        normalized_price,
        FinalizationMethod::PythUnverified,
    )
}

fn emit_unverified_price(
    market: Pubkey,
    operator: Pubkey,
    id: [u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
    normalized_price: u64,
) {
    emit!(PythUnverifiedPrice {
        market,
        operator,
        id,
        price,
        conf,
        expo,
        publish_time,
        normalized_price,
    });
}

#[derive(Accounts)]
pub struct FinalizePythUnverifiedOneSeries<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(constraint = operator.key() == market.operator @ OptionsError::UnauthorizedFinalizer)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub series_one: Account<'info, Series>,
}

#[derive(Accounts)]
pub struct FinalizePythUnverifiedTwoSeries<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(constraint = operator.key() == market.operator @ OptionsError::UnauthorizedFinalizer)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub series_one: Account<'info, Series>,
    #[account(mut)]
    pub series_two: Account<'info, Series>,
}

#[derive(Accounts)]
pub struct FinalizePythUnverifiedFourSeries<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(constraint = operator.key() == market.operator @ OptionsError::UnauthorizedFinalizer)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub series_one: Account<'info, Series>,
    #[account(mut)]
    pub series_two: Account<'info, Series>,
    #[account(mut)]
    pub series_three: Account<'info, Series>,
    #[account(mut)]
    pub series_four: Account<'info, Series>,
}

#[derive(Accounts)]
pub struct FinalizePythUnverifiedEightSeries<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(constraint = operator.key() == market.operator @ OptionsError::UnauthorizedFinalizer)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub series_one: Account<'info, Series>,
    #[account(mut)]
    pub series_two: Account<'info, Series>,
    #[account(mut)]
    pub series_three: Account<'info, Series>,
    #[account(mut)]
    pub series_four: Account<'info, Series>,
    #[account(mut)]
    pub series_five: Account<'info, Series>,
    #[account(mut)]
    pub series_six: Account<'info, Series>,
    #[account(mut)]
    pub series_seven: Account<'info, Series>,
    #[account(mut)]
    pub series_eight: Account<'info, Series>,
}
