use anchor_lang::prelude::*;
use anchor_spl::{associated_token::get_associated_token_address, token::TokenAccount};

use crate::{
    errors::OptionsError,
    events::ExpiryPriceFinalized,
    state::{current_time_ms, FinalizationMethod, Market, Series, SeriesState},
};

pub const MAX_FINALIZATION_SERIES: usize = 16;

pub(crate) struct FinalizationSeries<'info> {
    pub series: Account<'info, Series>,
    pub quote_collateral_vault: Account<'info, TokenAccount>,
}

pub(crate) fn load_finalization_series<'info>(
    account_infos: &'info [AccountInfo<'info>],
) -> Result<Vec<FinalizationSeries<'info>>> {
    require!(
        !account_infos.is_empty(),
        OptionsError::EmptyFinalizationBatch
    );
    require!(
        account_infos.len().is_multiple_of(2),
        OptionsError::FinalizationSeriesVaultPairRequired
    );
    let series_count = account_infos.len() / 2;
    require!(
        series_count <= MAX_FINALIZATION_SERIES,
        OptionsError::FinalizationBatchTooLarge
    );

    let series_infos: Vec<&AccountInfo> =
        account_infos.chunks_exact(2).map(|pair| &pair[0]).collect();
    for (index, account_info) in series_infos.iter().enumerate() {
        require!(
            account_info.is_writable,
            OptionsError::FinalizationSeriesNotWritable
        );
        for other_account_info in series_infos.iter().skip(index + 1) {
            require_keys_neq!(
                account_info.key(),
                other_account_info.key(),
                OptionsError::DuplicateFinalizationSeries
            );
        }
    }

    account_infos
        .chunks_exact(2)
        .map(|pair| {
            Ok(FinalizationSeries {
                series: Account::try_from(&pair[0])?,
                quote_collateral_vault: Account::try_from(&pair[1])?,
            })
        })
        .collect()
}

pub(crate) fn persist_finalized_series(series_accounts: &[FinalizationSeries]) -> Result<()> {
    for series in series_accounts {
        series.series.exit(&crate::ID)?;
    }
    Ok(())
}

pub(crate) fn finalize_series(
    market_key: Pubkey,
    market: &Market,
    series_accounts: &mut [FinalizationSeries],
    normalized_price: u64,
    method: FinalizationMethod,
) -> Result<()> {
    require!(!market.paused, OptionsError::MarketPaused);

    let expiry_ms = series_accounts
        .first()
        .ok_or(error!(OptionsError::SeriesExpiryMismatch))?
        .series
        .expiry_ms;
    require!(
        current_time_ms()? >= expiry_ms,
        OptionsError::FinalizationTooEarly
    );

    for series in series_accounts.iter() {
        require!(
            series.series.state == SeriesState::Open,
            OptionsError::SeriesNotOpen
        );
        require!(
            series.series.market == market_key,
            OptionsError::SeriesMarketMismatch
        );
        require!(
            series.series.expiry_ms == expiry_ms,
            OptionsError::SeriesExpiryMismatch
        );
    }

    for finalization in series_accounts.iter_mut() {
        let series = &mut finalization.series;
        let quote_collateral_vault = &finalization.quote_collateral_vault;
        require_keys_eq!(
            quote_collateral_vault.key(),
            get_associated_token_address(&series.key(), &market.quote_mint),
            OptionsError::InvalidSettlementPhase
        );
        require!(
            quote_collateral_vault.owner == series.key()
                && quote_collateral_vault.mint == market.quote_mint,
            OptionsError::InvalidSettlementPhase
        );
        series.total_quote_amount = quote_collateral_vault.amount;
        series.expiry_price = Some(normalized_price);
        series.state = if series.total_contracts_quantity == 0 {
            SeriesState::Closed
        } else {
            SeriesState::ExpirationPriceFinalized
        };
        emit!(ExpiryPriceFinalized {
            series: series.key(),
            normalized_price,
            oracle_config: market.oracle_config,
            method,
        });
    }

    Ok(())
}
