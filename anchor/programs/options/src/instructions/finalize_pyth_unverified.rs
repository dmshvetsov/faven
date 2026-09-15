use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::{
    errors::OptionsError,
    events::PythUnverifiedPrice,
    finalization::{finalize_series, load_finalization_series, persist_finalized_series},
    options_rules::price_to_strike_scale,
    state::{FinalizationMethod, Market},
    token_compat,
};

pub fn finalize_pyth_unverified_series(
    ctx: Context<FinalizePythUnverifiedSeries>,
    id: [u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) -> Result<()> {
    token_compat::validate_mint_token_program(
        &ctx.accounts.base_mint,
        &ctx.accounts.base_token_program,
    )?;
    token_compat::validate_mint_token_program(
        &ctx.accounts.quote_mint,
        &ctx.accounts.quote_token_program,
    )?;
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
        &ctx.accounts.quote_mint,
        &ctx.accounts.quote_token_program,
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
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    #[account(
        address = market.base_mint,
        constraint = *base_mint.to_account_info().owner == base_token_program.key()
            @ OptionsError::InvalidMintTokenProgram,
    )]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        address = market.quote_mint,
        constraint = *quote_mint.to_account_info().owner == quote_token_program.key()
            @ OptionsError::InvalidMintTokenProgram,
    )]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
}
