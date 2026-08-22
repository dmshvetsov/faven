use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::TwapUpdate;

use crate::{
    errors::OptionsError,
    events::PythTwapPrice,
    finalization::{finalize_series, load_finalization_series, persist_finalized_series},
    options_rules::price_to_strike_scale,
    state::{FinalizationMethod, Market, PYTH_RECEIVER_PROGRAM_ID},
};

pub fn finalize_pyth_twap_series(ctx: Context<FinalizePythTwapSeries>) -> Result<()> {
    let mut series_accounts = load_finalization_series(ctx.remaining_accounts)?;
    let expiry_ms = series_accounts
        .first()
        .ok_or(error!(OptionsError::SeriesExpiryMismatch))?
        .expiry_ms;
    let expiry_seconds = i64::try_from(expiry_ms / 1_000)
        .map_err(|_| error!(OptionsError::PythTwapWindowMismatch))?;
    let expected_start_time = expiry_seconds
        .checked_sub(60)
        .ok_or(error!(OptionsError::PythTwapWindowMismatch))?;
    let twap = ctx.accounts.twap_update.twap;

    require!(
        twap.feed_id == ctx.accounts.market.oracle_config.feed_id(),
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

    let normalized_price = price_to_strike_scale(twap.price, twap.exponent)?;
    emit!(PythTwapPrice {
        market: ctx.accounts.market.key(),
        twap_update: ctx.accounts.twap_update.key(),
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
        ctx.accounts.market.key(),
        &ctx.accounts.market,
        &mut series_accounts,
        normalized_price,
        FinalizationMethod::PythTwap,
    )?;
    persist_finalized_series(&series_accounts)
}

#[derive(Accounts)]
pub struct FinalizePythTwapSeries<'info> {
    pub caller: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(owner = PYTH_RECEIVER_PROGRAM_ID)]
    pub twap_update: Account<'info, TwapUpdate>,
}
