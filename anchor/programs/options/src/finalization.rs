use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    errors::OptionsError,
    events::ExpiryPriceFinalized,
    state::{current_time_ms, FinalizationMethod, Market, Series, SeriesState},
    token_compat,
};

pub const MAX_FINALIZATION_SERIES: usize = 16;

pub(crate) struct FinalizationSeries<'info> {
    pub series: Account<'info, Series>,
    pub quote_collateral_vault: InterfaceAccount<'info, TokenAccount>,
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
                quote_collateral_vault: InterfaceAccount::try_from(&pair[1])?,
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
    quote_mint: &InterfaceAccount<'_, Mint>,
    quote_token_program: &Interface<'_, TokenInterface>,
    series_accounts: &mut [FinalizationSeries],
    normalized_price: u64,
    method: FinalizationMethod,
) -> Result<()> {
    require!(!market.paused, OptionsError::MarketPaused);

    let expiry_ms = series_accounts
        .first()
        .ok_or(error!(OptionsError::PriceFinalizationSeriesExpiryMismatch))?
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
            OptionsError::PriceFinalizationSeriesExpiryMismatch
        );
    }

    for finalization in series_accounts.iter_mut() {
        let series = &mut finalization.series;
        let quote_collateral_vault = &finalization.quote_collateral_vault;
        token_compat::validate_associated_token_account_address(
            &quote_collateral_vault.key(),
            &series.key(),
            &quote_mint.key(),
            &quote_token_program.key(),
        )?;
        token_compat::validate_token_account(quote_collateral_vault, quote_token_program)?;
        require!(
            quote_collateral_vault.owner == series.key()
                && quote_collateral_vault.mint == quote_mint.key(),
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
