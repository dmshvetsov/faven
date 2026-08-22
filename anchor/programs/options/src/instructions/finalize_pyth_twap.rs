use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::TwapUpdate;

use crate::{
    errors::OptionsError,
    events::PythTwapPrice,
    finalization::finalize_series,
    math::normalize_pyth_price_to_strike_scale,
    state::{FinalizationMethod, Market, Series, PYTH_RECEIVER_PROGRAM_ID},
};

pub fn finalize_pyth_twap_one_series(ctx: Context<FinalizePythTwapOneSeries>) -> Result<()> {
    finalize_twap_batch(
        ctx.accounts.market.key(),
        &ctx.accounts.market,
        &ctx.accounts.twap_update,
        &mut [&mut ctx.accounts.series_one],
    )
}

pub fn finalize_pyth_twap_two_series(ctx: Context<FinalizePythTwapTwoSeries>) -> Result<()> {
    finalize_twap_batch(
        ctx.accounts.market.key(),
        &ctx.accounts.market,
        &ctx.accounts.twap_update,
        &mut [&mut ctx.accounts.series_one, &mut ctx.accounts.series_two],
    )
}

pub fn finalize_pyth_twap_four_series(ctx: Context<FinalizePythTwapFourSeries>) -> Result<()> {
    finalize_twap_batch(
        ctx.accounts.market.key(),
        &ctx.accounts.market,
        &ctx.accounts.twap_update,
        &mut [
            &mut ctx.accounts.series_one,
            &mut ctx.accounts.series_two,
            &mut ctx.accounts.series_three,
            &mut ctx.accounts.series_four,
        ],
    )
}

pub fn finalize_pyth_twap_eight_series(ctx: Context<FinalizePythTwapEightSeries>) -> Result<()> {
    finalize_twap_batch(
        ctx.accounts.market.key(),
        &ctx.accounts.market,
        &ctx.accounts.twap_update,
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
    )
}

fn finalize_twap_batch(
    market_key: Pubkey,
    market: &Account<Market>,
    twap_update: &Account<TwapUpdate>,
    series_accounts: &mut [&mut Account<Series>],
) -> Result<()> {
    let expiry_ms = series_accounts
        .first()
        .ok_or(error!(OptionsError::SeriesExpiryMismatch))?
        .expiry_ms;
    let expiry_seconds = i64::try_from(expiry_ms / 1_000)
        .map_err(|_| error!(OptionsError::PythTwapWindowMismatch))?;
    let expected_start_time = expiry_seconds
        .checked_sub(60)
        .ok_or(error!(OptionsError::PythTwapWindowMismatch))?;
    let twap = twap_update.twap;

    require!(
        twap.feed_id == market.oracle_config.feed_id(),
        OptionsError::PythTwapFeedMismatch
    );
    require!(
        twap.start_time == expected_start_time && twap.end_time == expiry_seconds,
        OptionsError::PythTwapWindowMismatch
    );
    require!(
        twap.down_slots_ratio <= 500_000,
        OptionsError::InsufficientPythTwapCoverage
    );

    let normalized_price = normalize_pyth_price_to_strike_scale(twap.price, twap.exponent)?;
    emit!(PythTwapPrice {
        market: market_key,
        twap_update: twap_update.key(),
        feed_id: twap.feed_id,
        price: twap.price,
        conf: twap.conf,
        expo: twap.exponent,
        start_time: twap.start_time,
        end_time: twap.end_time,
        down_slots_ratio: twap.down_slots_ratio,
        normalized_price,
    });
    finalize_series(
        market_key,
        market,
        series_accounts,
        normalized_price,
        FinalizationMethod::PythTwap,
    )
}

#[derive(Accounts)]
pub struct FinalizePythTwapOneSeries<'info> {
    pub caller: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(owner = PYTH_RECEIVER_PROGRAM_ID)]
    pub twap_update: Account<'info, TwapUpdate>,
    #[account(mut)]
    pub series_one: Account<'info, Series>,
}

#[derive(Accounts)]
pub struct FinalizePythTwapTwoSeries<'info> {
    pub caller: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(owner = PYTH_RECEIVER_PROGRAM_ID)]
    pub twap_update: Account<'info, TwapUpdate>,
    #[account(mut)]
    pub series_one: Account<'info, Series>,
    #[account(mut)]
    pub series_two: Account<'info, Series>,
}

#[derive(Accounts)]
pub struct FinalizePythTwapFourSeries<'info> {
    pub caller: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(owner = PYTH_RECEIVER_PROGRAM_ID)]
    pub twap_update: Account<'info, TwapUpdate>,
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
pub struct FinalizePythTwapEightSeries<'info> {
    pub caller: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(owner = PYTH_RECEIVER_PROGRAM_ID)]
    pub twap_update: Account<'info, TwapUpdate>,
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
