use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    errors::OptionsError,
    events::SeriesClosed,
    state::{current_time_ms, Market, Series, SeriesState, SERIES_SEED},
    token_compat,
};

pub fn close_series<'info>(ctx: Context<'info, CloseSeries<'info>>) -> Result<()> {
    require!(!ctx.accounts.market.paused, OptionsError::MarketPaused);
    token_compat::validate_mint_transfer_allowed(
        &ctx.accounts.base_mint,
        &ctx.accounts.base_token_program,
    )?;
    token_compat::validate_mint_transfer_allowed(
        &ctx.accounts.quote_mint,
        &ctx.accounts.quote_token_program,
    )?;
    token_compat::validate_token_account(
        &ctx.accounts.base_collateral_vault,
        &ctx.accounts.base_token_program,
    )?;
    token_compat::validate_token_account(
        &ctx.accounts.quote_collateral_vault,
        &ctx.accounts.quote_token_program,
    )?;
    require!(
        ctx.accounts.series.state == SeriesState::Closed
            && ctx.accounts.series.total_settled_quantity
                == ctx.accounts.series.total_contracts_quantity,
        OptionsError::InvalidClosurePhase
    );
    require!(
        current_time_ms()? >= ctx.accounts.series.exercise_window_end_ms,
        OptionsError::InvalidClosurePhase
    );

    let series = &ctx.accounts.series;
    let option_marker = [series.option_type.marker()];
    let expiry_bytes = series.expiry_ms.to_le_bytes();
    let strike_bytes = series.strike_price.to_le_bytes();
    let series_bump = [ctx.bumps.series];
    let market_key = ctx.accounts.market.key();
    let signer_seeds: &[&[u8]] = &[
        SERIES_SEED,
        market_key.as_ref(),
        &option_marker,
        &expiry_bytes,
        &strike_bytes,
        &series_bump,
    ];
    let base_dust_amount = ctx.accounts.base_collateral_vault.amount;
    let quote_dust_amount = ctx.accounts.quote_collateral_vault.amount;
    let mut remaining = ctx.remaining_accounts.iter();

    if base_dust_amount > 0 {
        let base_destination = remaining
            .next()
            .ok_or(error!(OptionsError::MalformedClosureAccounts))?;
        ensure_closer_ata(
            &ctx,
            base_destination,
            ctx.accounts.base_mint.to_account_info(),
            &ctx.accounts.base_token_program,
        )?;
        transfer_dust(
            &ctx,
            ctx.accounts.base_collateral_vault.to_account_info(),
            ctx.accounts.base_mint.to_account_info(),
            base_destination.clone(),
            base_dust_amount,
            ctx.accounts.base_mint.decimals,
            &ctx.accounts.base_token_program,
            signer_seeds,
        )?;
    }
    if quote_dust_amount > 0 {
        let quote_destination = remaining
            .next()
            .ok_or(error!(OptionsError::MalformedClosureAccounts))?;
        ensure_closer_ata(
            &ctx,
            quote_destination,
            ctx.accounts.quote_mint.to_account_info(),
            &ctx.accounts.quote_token_program,
        )?;
        transfer_dust(
            &ctx,
            ctx.accounts.quote_collateral_vault.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            quote_destination.clone(),
            quote_dust_amount,
            ctx.accounts.quote_mint.decimals,
            &ctx.accounts.quote_token_program,
            signer_seeds,
        )?;
    }
    require!(
        remaining.next().is_none(),
        OptionsError::MalformedClosureAccounts
    );

    close_vault(
        &ctx,
        ctx.accounts.base_collateral_vault.to_account_info(),
        &ctx.accounts.base_token_program,
        signer_seeds,
    )?;
    close_vault(
        &ctx,
        ctx.accounts.quote_collateral_vault.to_account_info(),
        &ctx.accounts.quote_token_program,
        signer_seeds,
    )?;
    emit!(SeriesClosed {
        series: series.key(),
        series_closer: ctx.accounts.series_closer.key(),
        rent_recipient: ctx.accounts.market_operator.key(),
        base_coin_dust_amount: base_dust_amount,
        quote_coin_dust_amount: quote_dust_amount,
    });
    Ok(())
}

fn ensure_closer_ata<'info>(
    ctx: &Context<'info, CloseSeries<'info>>,
    ata: &AccountInfo<'info>,
    mint: AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    if ata.data_is_empty() {
        associated_token::create(CpiContext::new(
            associated_token::ID,
            associated_token::Create {
                payer: ctx.accounts.series_closer.to_account_info(),
                associated_token: ata.clone(),
                authority: ctx.accounts.series_closer.to_account_info(),
                mint: mint.clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: token_program.to_account_info(),
            },
        ))?;
    }
    validate_closer_ata(
        ata,
        ctx.accounts.series_closer.key(),
        mint.key(),
        token_program,
    )
}

#[allow(clippy::too_many_arguments)]
fn transfer_dust<'info>(
    ctx: &Context<'info, CloseSeries<'info>>,
    source: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    token_program: &Interface<'info, TokenInterface>,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: source,
                mint,
                to: destination,
                authority: ctx.accounts.series.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        decimals,
    )
}

fn close_vault<'info>(
    ctx: &Context<'info, CloseSeries<'info>>,
    vault: AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault,
            destination: ctx.accounts.market_operator.to_account_info(),
            authority: ctx.accounts.series.to_account_info(),
        },
        &[signer_seeds],
    ))
}

fn validate_closer_ata(
    account_info: &AccountInfo,
    owner: Pubkey,
    mint: Pubkey,
    token_program: &Interface<TokenInterface>,
) -> Result<()> {
    token_compat::validate_associated_token_account_address(
        &account_info.key(),
        &owner,
        &mint,
        &token_program.key(),
    )?;
    token_compat::validate_token_account_with_owner_and_mint_for_error(
        account_info,
        owner,
        mint,
        token_program,
        OptionsError::InvalidSeriesCloserPayoutAccount,
    )
}

#[derive(Accounts)]
pub struct CloseSeries<'info> {
    #[account(mut)]
    pub series_closer: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    /// CHECK: receives SOL rent only after its key is checked against the Market.
    #[account(mut, address = market.operator)]
    pub market_operator: UncheckedAccount<'info>,
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
    #[account(
        mut,
        close = market_operator,
        has_one = market @ OptionsError::SeriesMarketMismatch,
        seeds = [
            SERIES_SEED,
            market.key().as_ref(),
            &[series.option_type.marker()],
            &series.expiry_ms.to_le_bytes(),
            &series.strike_price.to_le_bytes(),
        ],
        bump,
    )]
    pub series: Box<Account<'info, Series>>,
    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = series,
        associated_token::token_program = base_token_program,
    )]
    pub base_collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = series,
        associated_token::token_program = quote_token_program,
    )]
    pub quote_collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
