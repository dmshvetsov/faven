use anchor_lang::prelude::*;

use crate::{
    errors::OptionsError,
    events::ExpiryPriceFinalized,
    state::{current_time_ms, FinalizationMethod, Market, Series, SeriesState},
};

pub(crate) fn finalize_series(
    market_key: Pubkey,
    market: &Market,
    series_accounts: &mut [&mut Account<Series>],
    normalized_price: u64,
    method: FinalizationMethod,
) -> Result<()> {
    require!(!market.paused, OptionsError::MarketPaused);

    let expiry_ms = series_accounts
        .first()
        .ok_or(error!(OptionsError::SeriesExpiryMismatch))?
        .expiry_ms;
    require!(
        current_time_ms()? >= expiry_ms,
        OptionsError::FinalizationTooEarly
    );

    for series in series_accounts.iter() {
        require!(
            series.state == SeriesState::Open,
            OptionsError::SeriesNotOpen
        );
        require!(
            series.market == market_key,
            OptionsError::SeriesMarketMismatch
        );
        require!(
            series.expiry_ms == expiry_ms,
            OptionsError::SeriesExpiryMismatch
        );
    }

    for series in series_accounts.iter_mut() {
        series.expiry_price = Some(normalized_price);
        series.state = SeriesState::ExpirationPriceFinalized;
        emit!(ExpiryPriceFinalized {
            series: series.key(),
            normalized_price,
            oracle_config: market.oracle_config,
            method,
        });
    }

    Ok(())
}
