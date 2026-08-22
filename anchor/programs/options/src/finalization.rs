use anchor_lang::prelude::*;

use crate::{
    errors::OptionsError,
    events::ExpiryPriceFinalized,
    state::{current_time_ms, FinalizationMethod, Market, Series, SeriesState},
};

pub const MAX_FINALIZATION_SERIES: usize = 16;

pub(crate) fn load_finalization_series<'info>(
    account_infos: &'info [AccountInfo<'info>],
) -> Result<Vec<Account<'info, Series>>> {
    require!(
        !account_infos.is_empty(),
        OptionsError::EmptyFinalizationBatch
    );
    require!(
        account_infos.len() <= MAX_FINALIZATION_SERIES,
        OptionsError::FinalizationBatchTooLarge
    );

    for (index, account_info) in account_infos.iter().enumerate() {
        require!(
            account_info.is_writable,
            OptionsError::FinalizationSeriesNotWritable
        );
        for other_account_info in account_infos.iter().skip(index + 1) {
            require_keys_neq!(
                account_info.key(),
                other_account_info.key(),
                OptionsError::DuplicateFinalizationSeries
            );
        }
    }

    account_infos.iter().map(Account::try_from).collect()
}

pub(crate) fn persist_finalized_series(series_accounts: &[Account<Series>]) -> Result<()> {
    for series in series_accounts {
        series.exit(&crate::ID)?;
    }
    Ok(())
}

pub(crate) fn finalize_series(
    market_key: Pubkey,
    market: &Market,
    series_accounts: &mut [Account<Series>],
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
