use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, get_associated_token_address, AssociatedToken},
    token::{self, Burn, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{
    errors::OptionsError,
    events::Exercised,
    math::{call_payment, put_payout},
    state::{
        current_time_ms, Market, OptionType, Series, SeriesState, LONG_MINT_SEED, SERIES_SEED,
    },
};

pub fn exercise(ctx: Context<Exercise>, quantity: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    let series = &ctx.accounts.series;
    require!(!market.paused, OptionsError::MarketPaused);
    require!(quantity > 0, OptionsError::ZeroQuantity);
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
                market.quote_coin_mint,
                market.base_coin_mint,
                call_payment(
                    quantity,
                    series.strike_price,
                    market.quote_coin_scale,
                    market.base_coin_scale,
                )?,
                quantity,
                &ctx.accounts.quote_collateral_vault,
                &ctx.accounts.base_collateral_vault,
            ),
            OptionType::Put => (
                market.base_coin_mint,
                market.quote_coin_mint,
                quantity,
                put_payout(
                    quantity,
                    series.strike_price,
                    market.quote_coin_scale,
                    market.base_coin_scale,
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
    require!(
        ctx.accounts.holder_payment_source.amount >= input_amount,
        OptionsError::InsufficientHolderPayment
    );
    require!(
        output_vault.amount >= output_amount,
        OptionsError::InsufficientSeriesCollateral
    );

    let expected_receipt = get_associated_token_address(&ctx.accounts.holder.key(), &receipt_mint);
    require_keys_eq!(
        ctx.accounts.holder_receipt_ata.key(),
        expected_receipt,
        OptionsError::InvalidExerciseTokenAccount
    );
    if ctx.accounts.holder_receipt_ata.data_is_empty() {
        associated_token::create(CpiContext::new(
            associated_token::ID,
            associated_token::Create {
                payer: ctx.accounts.holder.to_account_info(),
                associated_token: ctx.accounts.holder_receipt_ata.to_account_info(),
                authority: ctx.accounts.holder.to_account_info(),
                mint: if receipt_mint == market.base_coin_mint {
                    ctx.accounts.base_coin_mint.to_account_info()
                } else {
                    ctx.accounts.quote_coin_mint.to_account_info()
                },
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;
    }
    validate_token_account(
        &ctx.accounts.holder_receipt_ata.to_account_info(),
        ctx.accounts.holder.key(),
        receipt_mint,
    )?;

    token::burn(
        CpiContext::new(
            token::ID,
            Burn {
                mint: ctx.accounts.long_mint.to_account_info(),
                from: ctx.accounts.holder_long_source.to_account_info(),
                authority: ctx.accounts.holder.to_account_info(),
            },
        ),
        quantity,
    )?;
    let payment_mint_account = if payment_mint == market.base_coin_mint {
        ctx.accounts.base_coin_mint.to_account_info()
    } else {
        ctx.accounts.quote_coin_mint.to_account_info()
    };
    transfer_checked(
        ctx.accounts.holder_payment_source.to_account_info(),
        payment_mint_account,
        payment_vault.to_account_info(),
        ctx.accounts.holder.to_account_info(),
        input_amount,
        if payment_mint == market.base_coin_mint {
            ctx.accounts.base_coin_mint.decimals
        } else {
            ctx.accounts.quote_coin_mint.decimals
        },
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
    let receipt_mint_account = if receipt_mint == market.base_coin_mint {
        ctx.accounts.base_coin_mint.to_account_info()
    } else {
        ctx.accounts.quote_coin_mint.to_account_info()
    };
    token::transfer_checked(
        CpiContext::new_with_signer(
            token::ID,
            TransferChecked {
                from: output_vault.to_account_info(),
                mint: receipt_mint_account,
                to: ctx.accounts.holder_receipt_ata.to_account_info(),
                authority: series.to_account_info(),
            },
            &[signer_seeds],
        ),
        output_amount,
        if receipt_mint == market.base_coin_mint {
            ctx.accounts.base_coin_mint.decimals
        } else {
            ctx.accounts.quote_coin_mint.decimals
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

fn validate_token_account(
    account_info: &AccountInfo,
    expected_owner: Pubkey,
    expected_mint: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *account_info.owner,
        token::ID,
        OptionsError::InvalidExerciseTokenAccount
    );
    let data = account_info.try_borrow_data()?;
    let mut data_slice: &[u8] = data.as_ref();
    let account = TokenAccount::try_deserialize(&mut data_slice)?;
    require!(
        account.owner == expected_owner && account.mint == expected_mint,
        OptionsError::InvalidExerciseTokenAccount
    );
    Ok(())
}

fn transfer_checked<'info>(
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new(
            token::ID,
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
    #[account(address = market.base_coin_mint)]
    pub base_coin_mint: Box<Account<'info, Mint>>,
    #[account(address = market.quote_coin_mint)]
    pub quote_coin_mint: Box<Account<'info, Mint>>,
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
    pub long_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        constraint = holder_long_source.owner == holder.key() @ OptionsError::InvalidExerciseTokenAccount,
        constraint = holder_long_source.mint == long_mint.key() @ OptionsError::InvalidExerciseTokenAccount,
    )]
    pub holder_long_source: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub holder_payment_source: Box<Account<'info, TokenAccount>>,
    /// CHECK: The handler derives, creates when needed, and validates the holder's ATA.
    #[account(mut)]
    pub holder_receipt_ata: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = base_coin_mint,
        associated_token::authority = series,
    )]
    pub base_collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = quote_coin_mint,
        associated_token::authority = series,
    )]
    pub quote_collateral_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
