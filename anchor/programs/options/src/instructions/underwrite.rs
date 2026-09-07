use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount, TransferChecked},
};

use crate::{
    errors::OptionsError,
    events::Underwritten,
    math,
    state::{
        current_time_ms, Market, OptionType, SellerVault, Series, SeriesState, LONG_MINT_SEED,
        MIN_UNDERWRITING_LEAD_TIME_MS, SELLER_VAULT_SEED, SERIES_SEED,
    },
};

pub fn underwrite_call_e18(
    ctx: Context<Underwrite>,
    quantity_e18: u128,
    premium_e18: u128,
    operational_fee_bps: u16,
) -> Result<()> {
    underwrite_e18(
        ctx,
        quantity_e18,
        premium_e18,
        operational_fee_bps,
        OptionType::Call,
    )
}

pub fn underwrite_put_e18(
    ctx: Context<Underwrite>,
    quantity_e18: u128,
    premium_e18: u128,
    operational_fee_bps: u16,
) -> Result<()> {
    underwrite_e18(
        ctx,
        quantity_e18,
        premium_e18,
        operational_fee_bps,
        OptionType::Put,
    )
}

fn underwrite_e18(
    ctx: Context<Underwrite>,
    quantity_e18: u128,
    premium_e18: u128,
    operational_fee_bps: u16,
    expected_option_type: OptionType,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let series = &ctx.accounts.series;
    require!(!market.paused, OptionsError::MarketPaused);
    require!(
        series.state == SeriesState::Open,
        OptionsError::SeriesNotOpen
    );
    require!(
        series.option_type == expected_option_type,
        OptionsError::InvalidOptionType
    );
    require!(quantity_e18 > 0, OptionsError::ZeroQuantity);
    require!(
        ctx.accounts.buyer.key() != ctx.accounts.seller.key(),
        OptionsError::BuyerAndSellerMustDiffer
    );
    require!(
        operational_fee_bps >= market.min_operational_fee_bps
            && operational_fee_bps <= market.max_operational_fee_bps,
        OptionsError::OperationalFeeBpsOutOfRange
    );

    let now_ms = current_time_ms()?;
    let minimum_expiry = now_ms
        .checked_add(MIN_UNDERWRITING_LEAD_TIME_MS)
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;
    require!(
        series.expiry_ms > minimum_expiry,
        OptionsError::ExpiryTooSoon
    );

    let (collateral_mint, collateral_mint_account, collateral_vault, collateral_decimals) =
        match expected_option_type {
            OptionType::Call => (
                market.base_mint,
                ctx.accounts.base_mint.to_account_info(),
                ctx.accounts.base_collateral_vault.to_account_info(),
                ctx.accounts.base_mint.decimals,
            ),
            OptionType::Put => (
                market.quote_mint,
                ctx.accounts.quote_mint.to_account_info(),
                ctx.accounts.quote_collateral_vault.to_account_info(),
                ctx.accounts.quote_mint.decimals,
            ),
        };
    require!(
        ctx.accounts.seller_collateral_source.owner == ctx.accounts.seller.key()
            && ctx.accounts.seller_collateral_source.mint == collateral_mint,
        OptionsError::InvalidFundingAccount
    );

    let base_mint_scale = math::token_scale(market.base_mint_decimals)?;
    let quote_mint_scale = math::token_scale(market.quote_mint_decimals)?;
    let quantity = math::e18_to_token_decimals(quantity_e18, base_mint_scale)?;
    let premium_per_contract = math::e18_to_token_decimals(premium_e18, quote_mint_scale)?;
    let premium = math::premium_total(quantity, premium_per_contract, base_mint_scale)?;
    let fee = math::operational_fee(premium, operational_fee_bps, market.min_fee)?;
    require!(fee <= premium, OptionsError::FeeExceedsPremium);
    let seller_premium = premium
        .checked_sub(fee)
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;
    let collateral = match expected_option_type {
        OptionType::Call => quantity,
        OptionType::Put => math::put_collateral(
            quantity,
            series.strike_price,
            quote_mint_scale,
            base_mint_scale,
        )?,
    };

    let seller_vault = &mut ctx.accounts.seller_vault;
    if seller_vault.owner == Pubkey::default() && seller_vault.series == Pubkey::default() {
        seller_vault.owner = ctx.accounts.seller.key();
        seller_vault.series = series.key();
    }
    require!(
        seller_vault.owner == ctx.accounts.seller.key() && seller_vault.series == series.key(),
        OptionsError::InvalidSellerVault
    );

    transfer_tokens(
        ctx.accounts.seller_collateral_source.to_account_info(),
        collateral_mint_account,
        collateral_vault,
        ctx.accounts.seller.to_account_info(),
        collateral,
        collateral_decimals,
    )?;
    if seller_premium > 0 {
        transfer_tokens(
            ctx.accounts.buyer_quote_source.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.seller_quote_ata.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            seller_premium,
            ctx.accounts.quote_mint.decimals,
        )?;
    }
    if fee > 0 {
        transfer_tokens(
            ctx.accounts.buyer_quote_source.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.fee_recipient_quote_ata.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            fee,
            ctx.accounts.quote_mint.decimals,
        )?;
    }

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
    let signer = &[signer_seeds];
    token::mint_to(
        CpiContext::new_with_signer(
            token::ID,
            MintTo {
                mint: ctx.accounts.long_mint.to_account_info(),
                to: ctx.accounts.buyer_long_ata.to_account_info(),
                authority: series.to_account_info(),
            },
            signer,
        ),
        quantity,
    )?;

    seller_vault.short_quantity = seller_vault
        .short_quantity
        .checked_add(quantity)
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;
    seller_vault.collateral_quantity = seller_vault
        .collateral_quantity
        .checked_add(collateral)
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;
    let series = &mut ctx.accounts.series;
    series.total_contracts_quantity = series
        .total_contracts_quantity
        .checked_add(quantity)
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;

    emit!(Underwritten {
        series: series.key(),
        seller: ctx.accounts.seller.key(),
        buyer: ctx.accounts.buyer.key(),
        quantity,
        long_mint: ctx.accounts.long_mint.key(),
        collateral_deposited: collateral,
        premium_total: premium,
        operational_fee: fee,
        fee_recipient: ctx.accounts.fee_recipient.key(),
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
pub struct Underwrite<'info> {
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    #[account(address = market.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = market.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
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
        init_if_needed,
        payer = seller,
        associated_token::mint = long_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_long_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = buyer_quote_source.owner == buyer.key() @ OptionsError::InvalidFundingAccount,
        constraint = buyer_quote_source.mint == market.quote_mint @ OptionsError::InvalidFundingAccount,
    )]
    pub buyer_quote_source: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub seller_collateral_source: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = quote_mint,
        associated_token::authority = seller,
    )]
    pub seller_quote_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: Any wallet may receive the operational fee.
    pub fee_recipient: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = quote_mint,
        associated_token::authority = fee_recipient,
    )]
    pub fee_recipient_quote_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = seller,
        space = SellerVault::SPACE,
        seeds = [
            SELLER_VAULT_SEED,
            market.key().as_ref(),
            &[series.option_type.marker()],
            &series.expiry_ms.to_le_bytes(),
            &series.strike_price.to_le_bytes(),
            seller.key().as_ref(),
        ],
        bump,
    )]
    pub seller_vault: Box<Account<'info, SellerVault>>,
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
