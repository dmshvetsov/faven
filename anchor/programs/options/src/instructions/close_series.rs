use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, get_associated_token_address, AssociatedToken},
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{
    errors::OptionsError,
    events::SeriesClosed,
    state::{current_time_ms, Market, Series, SeriesState, SERIES_SEED},
};

pub fn close_series<'info>(ctx: Context<'info, CloseSeries<'info>>) -> Result<()> {
    require!(!ctx.accounts.market.paused, OptionsError::MarketPaused);
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
        )?;
        transfer_dust(
            &ctx,
            ctx.accounts.base_collateral_vault.to_account_info(),
            ctx.accounts.base_mint.to_account_info(),
            base_destination.clone(),
            base_dust_amount,
            ctx.accounts.base_mint.decimals,
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
        )?;
        transfer_dust(
            &ctx,
            ctx.accounts.quote_collateral_vault.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            quote_destination.clone(),
            quote_dust_amount,
            ctx.accounts.quote_mint.decimals,
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
        signer_seeds,
    )?;
    close_vault(
        &ctx,
        ctx.accounts.quote_collateral_vault.to_account_info(),
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
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
    }
    validate_closer_ata(ata, ctx.accounts.series_closer.key(), mint.key())
}

fn transfer_dust<'info>(
    ctx: &Context<'info, CloseSeries<'info>>,
    source: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new_with_signer(
            token::ID,
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
    signer_seeds: &[&[u8]],
) -> Result<()> {
    token::close_account(CpiContext::new_with_signer(
        token::ID,
        CloseAccount {
            account: vault,
            destination: ctx.accounts.market_operator.to_account_info(),
            authority: ctx.accounts.series.to_account_info(),
        },
        &[signer_seeds],
    ))
}

fn validate_closer_ata(account_info: &AccountInfo, owner: Pubkey, mint: Pubkey) -> Result<()> {
    require_keys_eq!(
        account_info.key(),
        get_associated_token_address(&owner, &mint),
        OptionsError::InvalidSeriesCloserPayoutAccount
    );
    require_keys_eq!(
        *account_info.owner,
        token::ID,
        OptionsError::InvalidSeriesCloserPayoutAccount
    );
    let data = account_info.try_borrow_data()?;
    let mut data_slice: &[u8] = data.as_ref();
    let account = TokenAccount::try_deserialize(&mut data_slice)?;
    require!(
        account.owner == owner && account.mint == mint,
        OptionsError::InvalidSeriesCloserPayoutAccount
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CloseSeries<'info> {
    #[account(mut)]
    pub series_closer: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    /// CHECK: receives SOL rent only after its key is checked against the Market.
    #[account(mut, address = market.operator)]
    pub market_operator: UncheckedAccount<'info>,
    #[account(address = market.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = market.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
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
    )]
    pub base_collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = series,
    )]
    pub quote_collateral_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
