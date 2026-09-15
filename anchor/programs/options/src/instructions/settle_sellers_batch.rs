use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    errors::OptionsError,
    events::{SellerPayoutSettled, SeriesSettlementBatchCompleted},
    state::{
        current_time_ms, Market, OptionType, SellerVault, Series, SeriesState, SELLER_VAULT_SEED,
        SERIES_SEED,
    },
    token_compat,
};

pub fn settle_sellers_batch<'info>(ctx: Context<'info, SettleSellersBatch<'info>>) -> Result<()> {
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
        ctx.accounts.series.state == SeriesState::ExpirationPriceFinalized,
        OptionsError::InvalidSettlementPhase
    );
    require!(
        !ctx.remaining_accounts.is_empty(),
        OptionsError::EmptySettlementBatch
    );

    let series = &ctx.accounts.series;
    let expiry_price = series
        .expiry_price
        .ok_or(error!(OptionsError::InvalidSettlementPhase))?;
    let is_itm = match series.option_type {
        OptionType::Call => expiry_price > series.strike_price,
        OptionType::Put => expiry_price < series.strike_price,
    };
    if is_itm {
        require!(
            current_time_ms()? >= series.exercise_window_end_ms,
            OptionsError::InvalidSettlementPhase
        );
    }
    require!(
        series.total_contracts_quantity > 0,
        OptionsError::SettlementQuantityExceedsIssuedContracts
    );
    let series_key = series.key();
    let option_type = series.option_type;
    let expiry_ms = series.expiry_ms;
    let strike_price = series.strike_price;
    let total_contracts = series.total_contracts_quantity;
    let total_manual_exercised = series.total_manual_exercised_quantity;
    let total_quote_amount = series.total_quote_amount;
    let mut total_settled = series.total_settled_quantity;
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
    let mut remaining = ctx.remaining_accounts.iter();
    let mut settled_vaults = Vec::new();
    let mut settled_seller_count = 0_u16;
    let mut remaining_base = ctx.accounts.base_collateral_vault.amount;
    let mut remaining_quote = ctx.accounts.quote_collateral_vault.amount;
    while let Some(seller_vault_info) = remaining.next() {
        require!(
            seller_vault_info.is_writable,
            OptionsError::InvalidSellerVault
        );
        let seller_vault = Account::<SellerVault>::try_from(seller_vault_info)?;
        require!(
            !settled_vaults.contains(&seller_vault.key()),
            OptionsError::DuplicateSettlementSellerVault
        );
        let seller = seller_vault.owner;
        require_keys_eq!(
            seller_vault.series,
            series_key,
            OptionsError::InvalidSellerVault
        );
        let expected_seller_vault = Pubkey::find_program_address(
            &[
                SELLER_VAULT_SEED,
                market_key.as_ref(),
                &[option_type.marker()],
                &expiry_ms.to_le_bytes(),
                &strike_price.to_le_bytes(),
                seller.as_ref(),
            ],
            &crate::ID,
        )
        .0;
        require_keys_eq!(
            seller_vault.key(),
            expected_seller_vault,
            OptionsError::SellerVaultPdaMismatch
        );
        total_settled = total_settled
            .checked_add(seller_vault.short_quantity)
            .ok_or(error!(OptionsError::ArithmeticOverflow))?;
        require!(
            total_settled <= total_contracts,
            OptionsError::SettlementQuantityExceedsIssuedContracts
        );
        let (base_paid, quote_paid) = seller_payout(
            option_type,
            is_itm,
            total_manual_exercised,
            total_contracts,
            total_quote_amount,
            seller_vault.short_quantity,
            seller_vault.collateral_quantity,
        )?;
        let base_ata = if base_paid > 0 {
            Some(
                remaining
                    .next()
                    .ok_or(error!(OptionsError::MalformedSettlementAccounts))?,
            )
        } else {
            None
        };
        let quote_ata = if quote_paid > 0 {
            Some(
                remaining
                    .next()
                    .ok_or(error!(OptionsError::MalformedSettlementAccounts))?,
            )
        } else {
            None
        };
        let requires_seller = base_ata.is_some_and(|account| account.data_is_empty())
            || quote_ata.is_some_and(|account| account.data_is_empty());
        let seller_account = if requires_seller {
            let seller_account = remaining
                .next()
                .ok_or(error!(OptionsError::MalformedSettlementAccounts))?;
            require_keys_eq!(
                seller_account.key(),
                seller,
                OptionsError::MalformedSettlementAccounts
            );
            Some(seller_account)
        } else {
            None
        };
        if let Some(base_ata) = base_ata {
            ensure_seller_ata(
                &ctx,
                base_ata,
                seller,
                seller_account,
                ctx.accounts.base_mint.to_account_info(),
                &ctx.accounts.base_token_program,
            )?;
            remaining_base = remaining_base
                .checked_sub(base_paid)
                .ok_or(error!(OptionsError::InsufficientSeriesCollateral))?;
            transfer_from_series(
                &ctx,
                SeriesTransfer {
                    source: ctx.accounts.base_collateral_vault.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    destination: base_ata.clone(),
                    decimals: ctx.accounts.base_mint.decimals,
                    token_program: ctx.accounts.base_token_program.to_account_info(),
                },
                base_paid,
                signer_seeds,
            )?;
        }
        if let Some(quote_ata) = quote_ata {
            ensure_seller_ata(
                &ctx,
                quote_ata,
                seller,
                seller_account,
                ctx.accounts.quote_mint.to_account_info(),
                &ctx.accounts.quote_token_program,
            )?;
            remaining_quote = remaining_quote
                .checked_sub(quote_paid)
                .ok_or(error!(OptionsError::InsufficientSeriesCollateral))?;
            transfer_from_series(
                &ctx,
                SeriesTransfer {
                    source: ctx.accounts.quote_collateral_vault.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    destination: quote_ata.clone(),
                    decimals: ctx.accounts.quote_mint.decimals,
                    token_program: ctx.accounts.quote_token_program.to_account_info(),
                },
                quote_paid,
                signer_seeds,
            )?;
        }
        seller_vault.close(ctx.accounts.settler.to_account_info())?;
        settled_vaults.push(seller_vault.key());
        settled_seller_count = settled_seller_count
            .checked_add(1)
            .ok_or(error!(OptionsError::ArithmeticOverflow))?;
        emit!(SellerPayoutSettled {
            series: series_key,
            seller,
            base_coin_amount: base_paid,
            quote_coin_amount: quote_paid,
        });
    }
    let series = &mut ctx.accounts.series;
    series.total_settled_quantity = total_settled;
    if total_settled == total_contracts {
        series.state = SeriesState::Closed;
    }
    if settled_seller_count > 1 {
        emit!(SeriesSettlementBatchCompleted {
            series: series.key(),
            settled_seller_count,
        });
    }
    Ok(())
}

fn seller_payout(
    option_type: OptionType,
    is_itm: bool,
    total_manual_exercised: u64,
    total_contracts: u64,
    total_quote_amount: u64,
    short_quantity: u64,
    collateral_quantity: u64,
) -> Result<(u64, u64)> {
    if !is_itm || total_manual_exercised == 0 {
        return Ok(match option_type {
            OptionType::Call => (collateral_quantity, 0),
            OptionType::Put => (0, collateral_quantity),
        });
    }
    if total_manual_exercised == total_contracts {
        return Ok(match option_type {
            OptionType::Call => (
                0,
                floor_pro_rata(total_quote_amount, short_quantity, total_contracts)?,
            ),
            OptionType::Put => (short_quantity, 0),
        });
    }
    let base_pool = match option_type {
        OptionType::Call => total_contracts
            .checked_sub(total_manual_exercised)
            .ok_or(error!(OptionsError::ArithmeticOverflow))?,
        OptionType::Put => total_manual_exercised,
    };
    Ok((
        floor_pro_rata(base_pool, short_quantity, total_contracts)?,
        floor_pro_rata(total_quote_amount, short_quantity, total_contracts)?,
    ))
}

fn floor_pro_rata(pool: u64, short_quantity: u64, total_contracts: u64) -> Result<u64> {
    require!(total_contracts > 0, OptionsError::ZeroDivision);
    u64::try_from(
        u128::from(pool)
            .checked_mul(u128::from(short_quantity))
            .ok_or(error!(OptionsError::ArithmeticOverflow))?
            / u128::from(total_contracts),
    )
    .map_err(|_| error!(OptionsError::ArithmeticOverflow))
}

fn ensure_seller_ata<'info>(
    ctx: &Context<'info, SettleSellersBatch<'info>>,
    ata: &AccountInfo<'info>,
    seller: Pubkey,
    seller_account: Option<&AccountInfo<'info>>,
    mint: AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    if ata.data_is_empty() {
        let seller_account =
            seller_account.ok_or(error!(OptionsError::MalformedSettlementAccounts))?;
        associated_token::create(CpiContext::new(
            associated_token::ID,
            associated_token::Create {
                payer: ctx.accounts.settler.to_account_info(),
                associated_token: ata.clone(),
                authority: seller_account.clone(),
                mint: mint.clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: token_program.to_account_info(),
            },
        ))?;
    }
    validate_seller_ata(ata, seller, mint.key(), token_program)
}

struct SeriesTransfer<'info> {
    source: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    decimals: u8,
    token_program: AccountInfo<'info>,
}

fn transfer_from_series<'info>(
    ctx: &Context<'info, SettleSellersBatch<'info>>,
    transfer: SeriesTransfer<'info>,
    amount: u64,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            transfer.token_program.key(),
            TransferChecked {
                from: transfer.source,
                mint: transfer.mint,
                to: transfer.destination,
                authority: ctx.accounts.series.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        transfer.decimals,
    )
}

fn validate_seller_ata(
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
        OptionsError::InvalidSellerPayoutAccount,
    )
}

#[derive(Accounts)]
pub struct SettleSellersBatch<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
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
