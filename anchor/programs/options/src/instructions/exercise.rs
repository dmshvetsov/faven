use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token::{self, Burn, Mint as LongMint, Token, TokenAccount as LongTokenAccount},
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    errors::OptionsError,
    events::Exercised,
    math::{call_payment, put_payout},
    state::{
        current_time_ms, Market, OptionType, Series, SeriesState, LONG_MINT_SEED, SERIES_SEED,
    },
    token_compat,
};

pub fn exercise_e18(ctx: Context<Exercise>, quantity_e18: u128) -> Result<()> {
    let market = &ctx.accounts.market;
    let series = &ctx.accounts.series;
    require!(!market.paused, OptionsError::MarketPaused);
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
    require!(quantity_e18 > 0, OptionsError::ZeroQuantity);
    let base_mint_scale = crate::math::token_scale(market.base_mint_decimals)?;
    let quantity = crate::math::e18_to_token_decimals(quantity_e18, base_mint_scale)?;
    require!(
        quantity <= ctx.accounts.holder_long_source.amount,
        OptionsError::ExerciseQuantityExceedsLongBalance
    );
    require!(
        series.state == SeriesState::ExpirationPriceFinalized,
        OptionsError::InvalidExercisePhase
    );
    let expiry_price = series
        .expiry_price
        .ok_or(error!(OptionsError::InvalidExercisePhase))?;
    let now_ms = current_time_ms()?;
    require!(
        now_ms >= series.expiry_ms && now_ms < series.exercise_window_end_ms,
        OptionsError::InvalidExercisePhase
    );
    let is_itm = match series.option_type {
        OptionType::Call => expiry_price > series.strike_price,
        OptionType::Put => expiry_price < series.strike_price,
    };
    require!(is_itm, OptionsError::SeriesNotInTheMoney);
    let quote_mint_scale = crate::math::token_scale(market.quote_mint_decimals)?;
    let updated_exercised = series
        .total_manual_exercised_quantity
        .checked_add(quantity)
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;
    require!(
        updated_exercised <= series.total_contracts_quantity,
        OptionsError::ExerciseQuantityExceedsIssuedContracts
    );

    let (payment_mint, receipt_mint, input_amount, output_amount, payment_vault, output_vault) =
        match series.option_type {
            OptionType::Call => (
                market.quote_mint,
                market.base_mint,
                call_payment(
                    quantity,
                    series.strike_price,
                    quote_mint_scale,
                    base_mint_scale,
                )?,
                quantity,
                &ctx.accounts.quote_collateral_vault,
                &ctx.accounts.base_collateral_vault,
            ),
            OptionType::Put => (
                market.base_mint,
                market.quote_mint,
                quantity,
                put_payout(
                    quantity,
                    series.strike_price,
                    quote_mint_scale,
                    base_mint_scale,
                )?,
                &ctx.accounts.base_collateral_vault,
                &ctx.accounts.quote_collateral_vault,
            ),
        };
    require!(
        ctx.accounts.holder_payment_source.owner == ctx.accounts.holder.key()
            && ctx.accounts.holder_payment_source.mint == payment_mint,
        OptionsError::InvalidExerciseTokenAccount
    );
    let payment_token_program = if payment_mint == market.base_mint {
        &ctx.accounts.base_token_program
    } else {
        &ctx.accounts.quote_token_program
    };
    token_compat::validate_token_account(
        &ctx.accounts.holder_payment_source,
        payment_token_program,
    )?;
    require!(
        ctx.accounts.holder_payment_source.amount >= input_amount,
        OptionsError::InsufficientHolderPayment
    );
    require!(
        output_vault.amount >= output_amount,
        OptionsError::InsufficientSeriesCollateral
    );

    let receipt_token_program = if receipt_mint == market.base_mint {
        &ctx.accounts.base_token_program
    } else {
        &ctx.accounts.quote_token_program
    };
    token_compat::validate_associated_token_account_address(
        &ctx.accounts.holder_receipt_ata.key(),
        &ctx.accounts.holder.key(),
        &receipt_mint,
        &receipt_token_program.key(),
    )?;
    if ctx.accounts.holder_receipt_ata.data_is_empty() {
        associated_token::create(CpiContext::new(
            associated_token::ID,
            associated_token::Create {
                payer: ctx.accounts.holder.to_account_info(),
                associated_token: ctx.accounts.holder_receipt_ata.to_account_info(),
                authority: ctx.accounts.holder.to_account_info(),
                mint: if receipt_mint == market.base_mint {
                    ctx.accounts.base_mint.to_account_info()
                } else {
                    ctx.accounts.quote_mint.to_account_info()
                },
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: receipt_token_program.to_account_info(),
            },
        ))?;
    }
    token_compat::validate_token_account_with_owner_and_mint(
        &ctx.accounts.holder_receipt_ata.to_account_info(),
        ctx.accounts.holder.key(),
        receipt_mint,
        receipt_token_program,
    )?;

    token::burn(
        CpiContext::new(
            ctx.accounts.long_token_program.key(),
            Burn {
                mint: ctx.accounts.long_mint.to_account_info(),
                from: ctx.accounts.holder_long_source.to_account_info(),
                authority: ctx.accounts.holder.to_account_info(),
            },
        ),
        quantity,
    )?;
    let payment_mint_account = if payment_mint == market.base_mint {
        ctx.accounts.base_mint.to_account_info()
    } else {
        ctx.accounts.quote_mint.to_account_info()
    };
    transfer_tokens(
        ctx.accounts.holder_payment_source.to_account_info(),
        payment_mint_account,
        payment_vault.to_account_info(),
        ctx.accounts.holder.to_account_info(),
        input_amount,
        if payment_mint == market.base_mint {
            ctx.accounts.base_mint.decimals
        } else {
            ctx.accounts.quote_mint.decimals
        },
        payment_token_program,
    )?;

    let option_marker = [series.option_type.marker()];
    let expiry_bytes = series.expiry_ms.to_le_bytes();
    let strike_bytes = series.strike_price.to_le_bytes();
    let series_bump = [ctx.bumps.series];
    let market_key = market.key();
    let signer_seeds: &[&[u8]] = &[
        SERIES_SEED,
        market_key.as_ref(),
        &option_marker,
        &expiry_bytes,
        &strike_bytes,
        &series_bump,
    ];
    let receipt_mint_account = if receipt_mint == market.base_mint {
        ctx.accounts.base_mint.to_account_info()
    } else {
        ctx.accounts.quote_mint.to_account_info()
    };
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            receipt_token_program.key(),
            TransferChecked {
                from: output_vault.to_account_info(),
                mint: receipt_mint_account,
                to: ctx.accounts.holder_receipt_ata.to_account_info(),
                authority: series.to_account_info(),
            },
            &[signer_seeds],
        ),
        output_amount,
        if receipt_mint == market.base_mint {
            ctx.accounts.base_mint.decimals
        } else {
            ctx.accounts.quote_mint.decimals
        },
    )?;

    let series = &mut ctx.accounts.series;
    series.total_manual_exercised_quantity = updated_exercised;
    series.total_quote_amount = match series.option_type {
        OptionType::Call => series
            .total_quote_amount
            .checked_add(input_amount)
            .ok_or(error!(OptionsError::ArithmeticOverflow))?,
        OptionType::Put => series
            .total_quote_amount
            .checked_sub(output_amount)
            .ok_or(error!(OptionsError::ArithmeticOverflow))?,
    };
    emit!(Exercised {
        series: series.key(),
        holder: ctx.accounts.holder.key(),
        option_type: series.option_type,
        quantity,
        input_asset_amount: input_amount,
        output_asset_amount: output_amount,
    });
    Ok(())
}

fn transfer_tokens<'info>(
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from,
                mint,
                to,
                authority,
            },
        ),
        amount,
        decimals,
    )
}

#[derive(Accounts)]
pub struct Exercise<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    pub long_token_program: Program<'info, Token>,
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
        seeds = [
            LONG_MINT_SEED,
            market.key().as_ref(),
            &[series.option_type.marker()],
            &series.expiry_ms.to_le_bytes(),
            &series.strike_price.to_le_bytes(),
        ],
        bump,
    )]
    pub long_mint: Box<Account<'info, LongMint>>,
    #[account(
        mut,
        constraint = holder_long_source.owner == holder.key() @ OptionsError::InvalidExerciseTokenAccount,
        constraint = holder_long_source.mint == long_mint.key() @ OptionsError::InvalidExerciseTokenAccount,
    )]
    pub holder_long_source: Box<Account<'info, LongTokenAccount>>,
    #[account(mut)]
    pub holder_payment_source: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: The handler derives, creates when needed, and validates the holder's ATA.
    #[account(mut)]
    pub holder_receipt_ata: UncheckedAccount<'info>,
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
