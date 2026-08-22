use anchor_lang::prelude::*;

use crate::{
    errors::OptionsError,
    events::PythUnverifiedPrice,
    finalization::{finalize_series, load_finalization_series, persist_finalized_series},
    options_rules::price_to_strike_scale,
    state::{FinalizationMethod, Market},
};

pub fn finalize_pyth_unverified_series(
    ctx: Context<FinalizePythUnverifiedSeries>,
    id: [u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) -> Result<()> {
    let mut series_accounts = load_finalization_series(ctx.remaining_accounts)?;
    let normalized_price = price_to_strike_scale(price, expo)?;

    emit!(PythUnverifiedPrice {
        market: ctx.accounts.market.key(),
        operator: ctx.accounts.operator.key(),
        id,
        price,
        conf,
        expo,
        publish_time,
        normalized_price,
    });
    finalize_series(
        ctx.accounts.market.key(),
        &ctx.accounts.market,
        &mut series_accounts,
        normalized_price,
        FinalizationMethod::PythUnverified,
    )?;
    persist_finalized_series(&series_accounts)
}

#[derive(Accounts)]
pub struct FinalizePythUnverifiedSeries<'info> {
    pub operator: Signer<'info>,
    #[account(constraint = operator.key() == market.operator @ OptionsError::UnauthorizedFinalizer)]
    pub market: Account<'info, Market>,
}
