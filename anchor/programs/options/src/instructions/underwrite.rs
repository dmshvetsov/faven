use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount, TransferChecked},
};

use crate::{
    errors::OptionsError,
    events::{SeriesCreated, Underwritten},
    math,
    options_rules::ensure_min_expiry,
    state::{
        Market, OptionType, SellerVault, Series, SeriesState, EXERCISE_WINDOW_MS, LONG_MINT_SEED,
        SELLER_VAULT_SEED, SERIES_SEED,
    },
};

pub fn underwrite_call_e18(
    ctx: Context<UnderwriteCall>,
    expiry_ms: u64,
    strike_price_e8: u64,
    quantity_e18: u128,
    premium_e18: u128,
    operational_fee_bps: u16,
) -> Result<()> {
    ensure_series(
        ctx.accounts.series.as_mut(),
        ctx.accounts.market.key(),
        OptionType::Call,
        expiry_ms,
        strike_price_e8,
    )?;
    underwrite_e18(
        UnderwriteExecutionContext {
            buyer: &ctx.accounts.buyer,
            seller: &ctx.accounts.seller,
            market: ctx.accounts.market.as_ref(),
            series: ctx.accounts.series.as_mut(),
            long_mint: ctx.accounts.long_mint.to_account_info(),
            buyer_long_ata: ctx.accounts.buyer_long_ata.to_account_info(),
            buyer_quote_source: ctx.accounts.buyer_quote_source.to_account_info(),
            seller_collateral_source: ctx.accounts.seller_base_source.to_account_info(),
            seller_quote_destination: ctx.accounts.seller_quote_destination.to_account_info(),
            quote_mint: ctx.accounts.quote_mint.to_account_info(),
            quote_mint_decimals: ctx.accounts.quote_mint.decimals,
            fee_recipient: ctx.accounts.fee_recipient.to_account_info(),
            fee_recipient_quote_ata: ctx.accounts.fee_recipient_quote_ata.to_account_info(),
            seller_vault: ctx.accounts.seller_vault.as_mut(),
            collateral_mint: ctx.accounts.base_mint.to_account_info(),
            collateral_vault: ctx.accounts.base_collateral_vault.to_account_info(),
            collateral_decimals: ctx.accounts.base_mint.decimals,
            series_bump: ctx.bumps.series,
        },
        quantity_e18,
        premium_e18,
        operational_fee_bps,
        OptionType::Call,
    )
}

pub fn underwrite_put_e18(
    ctx: Context<UnderwritePut>,
    expiry_ms: u64,
    strike_price_e8: u64,
    quantity_e18: u128,
    premium_e18: u128,
    operational_fee_bps: u16,
) -> Result<()> {
    ensure_series(
        ctx.accounts.series.as_mut(),
        ctx.accounts.market.key(),
        OptionType::Put,
        expiry_ms,
        strike_price_e8,
    )?;
    underwrite_e18(
        UnderwriteExecutionContext {
            buyer: &ctx.accounts.buyer,
            seller: &ctx.accounts.seller,
            market: ctx.accounts.market.as_ref(),
            series: ctx.accounts.series.as_mut(),
            long_mint: ctx.accounts.long_mint.to_account_info(),
            buyer_long_ata: ctx.accounts.buyer_long_ata.to_account_info(),
            buyer_quote_source: ctx.accounts.buyer_quote_source.to_account_info(),
            seller_collateral_source: ctx.accounts.seller_quote_account.to_account_info(),
            seller_quote_destination: ctx.accounts.seller_quote_account.to_account_info(),
            quote_mint: ctx.accounts.quote_mint.to_account_info(),
            quote_mint_decimals: ctx.accounts.quote_mint.decimals,
            fee_recipient: ctx.accounts.fee_recipient.to_account_info(),
            fee_recipient_quote_ata: ctx.accounts.fee_recipient_quote_ata.to_account_info(),
            seller_vault: ctx.accounts.seller_vault.as_mut(),
            collateral_mint: ctx.accounts.quote_mint.to_account_info(),
            collateral_vault: ctx.accounts.quote_collateral_vault.to_account_info(),
            collateral_decimals: ctx.accounts.quote_mint.decimals,
            series_bump: ctx.bumps.series,
        },
        quantity_e18,
        premium_e18,
        operational_fee_bps,
        OptionType::Put,
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SeriesInitialization {
    Created,
    Existing,
}

fn ensure_series(
    series: &mut Account<'_, Series>,
    market: Pubkey,
    option_type: OptionType,
    expiry_ms: u64,
    strike_price_e8: u64,
) -> Result<SeriesInitialization> {
    require!(strike_price_e8 > 0, OptionsError::InvalidStrikePrice);
    ensure_min_expiry(expiry_ms)?;
    let exercise_window_end_ms = expiry_ms
        .checked_add(EXERCISE_WINDOW_MS)
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;

    let is_fresh = {
        let account_info = series.to_account_info();
        let data = account_info.try_borrow_data()?;
        !data.starts_with(Series::DISCRIMINATOR)
    };
    if is_fresh {
        series.state = SeriesState::Open;
        series.market = market;
        series.option_type = option_type;
        series.strike_price = strike_price_e8;
        series.expiry_ms = expiry_ms;
        series.exercise_window_end_ms = exercise_window_end_ms;
        series.expiry_price = None;
        series.total_contracts_quantity = 0;
        series.total_manual_exercised_quantity = 0;
        series.total_settled_quantity = 0;
        series.total_quote_amount = 0;
        emit!(SeriesCreated {
            series: series.key(),
            market,
            option_type,
            strike_price: strike_price_e8,
            expiry_ms,
        });
        return Ok(SeriesInitialization::Created);
    }

    require!(series.market == market, OptionsError::SeriesMarketMismatch);
    require!(
        series.option_type == option_type,
        OptionsError::SeriesOptionTypeMismatch
    );
    require!(
        series.strike_price == strike_price_e8,
        OptionsError::SeriesStrikePriceMismatch
    );
    require!(
        series.expiry_ms == expiry_ms,
        OptionsError::SeriesExpiryMismatch
    );
    require!(
        series.exercise_window_end_ms == exercise_window_end_ms,
        OptionsError::SeriesExerciseWindowMismatch
    );
    require!(
        series.state == SeriesState::Open,
        OptionsError::SeriesNotOpen
    );
    require!(
        series.expiry_price.is_none()
            && series.total_manual_exercised_quantity == 0
            && series.total_settled_quantity == 0
            && series.total_quote_amount == 0,
        OptionsError::InvalidOpenSeriesAccounting
    );
    Ok(SeriesInitialization::Existing)
}

struct UnderwriteExecutionContext<'a, 'info> {
    buyer: &'a Signer<'info>,
    seller: &'a Signer<'info>,
    market: &'a Account<'info, Market>,
    series: &'a mut Account<'info, Series>,
    long_mint: AccountInfo<'info>,
    buyer_long_ata: AccountInfo<'info>,
    buyer_quote_source: AccountInfo<'info>,
    seller_collateral_source: AccountInfo<'info>,
    seller_quote_destination: AccountInfo<'info>,
    quote_mint: AccountInfo<'info>,
    quote_mint_decimals: u8,
    fee_recipient: AccountInfo<'info>,
    fee_recipient_quote_ata: AccountInfo<'info>,
    seller_vault: &'a mut Account<'info, SellerVault>,
    collateral_mint: AccountInfo<'info>,
    collateral_vault: AccountInfo<'info>,
    collateral_decimals: u8,
    series_bump: u8,
}

fn underwrite_e18(
    accounts: UnderwriteExecutionContext<'_, '_>,
    quantity_e18: u128,
    premium_e18: u128,
    operational_fee_bps: u16,
    expected_option_type: OptionType,
) -> Result<()> {
    let market = accounts.market;
    let series = &accounts.series;
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
        accounts.buyer.key() != accounts.seller.key(),
        OptionsError::BuyerAndSellerMustDiffer
    );
    require!(
        operational_fee_bps >= market.min_operational_fee_bps
            && operational_fee_bps <= market.max_operational_fee_bps,
        OptionsError::OperationalFeeBpsOutOfRange
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

    let seller_vault = accounts.seller_vault;
    if seller_vault.owner == Pubkey::default() && seller_vault.series == Pubkey::default() {
        seller_vault.owner = accounts.seller.key();
        seller_vault.series = series.key();
    }
    require!(
        seller_vault.owner == accounts.seller.key() && seller_vault.series == series.key(),
        OptionsError::InvalidSellerVault
    );

    transfer_tokens(
        accounts.seller_collateral_source,
        accounts.collateral_mint,
        accounts.collateral_vault,
        accounts.seller.to_account_info(),
        collateral,
        accounts.collateral_decimals,
    )?;
    if seller_premium > 0 {
        transfer_tokens(
            accounts.buyer_quote_source.clone(),
            accounts.quote_mint.clone(),
            accounts.seller_quote_destination,
            accounts.buyer.to_account_info(),
            seller_premium,
            accounts.quote_mint_decimals,
        )?;
    }
    if fee > 0 {
        transfer_tokens(
            accounts.buyer_quote_source,
            accounts.quote_mint.clone(),
            accounts.fee_recipient_quote_ata,
            accounts.buyer.to_account_info(),
            fee,
            accounts.quote_mint_decimals,
        )?;
    }

    let option_marker = [series.option_type.marker()];
    let expiry_bytes = series.expiry_ms.to_le_bytes();
    let strike_bytes = series.strike_price.to_le_bytes();
    let series_bump = [accounts.series_bump];
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
    let long_mint = accounts.long_mint.key();
    token::mint_to(
        CpiContext::new_with_signer(
            token::ID,
            MintTo {
                mint: accounts.long_mint,
                to: accounts.buyer_long_ata,
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
    let series = accounts.series;
    series.total_contracts_quantity = series
        .total_contracts_quantity
        .checked_add(quantity)
        .ok_or(error!(OptionsError::ArithmeticOverflow))?;

    emit!(Underwritten {
        series: series.key(),
        seller: accounts.seller.key(),
        buyer: accounts.buyer.key(),
        quantity,
        long_mint,
        collateral_deposited: collateral,
        premium_total: premium,
        operational_fee: fee,
        fee_recipient: accounts.fee_recipient.key(),
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
#[instruction(expiry_ms: u64, strike_price_e8: u64)]
pub struct UnderwriteCall<'info> {
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    #[account(address = market.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = market.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = seller,
        space = Series::SPACE,
        seeds = [
            SERIES_SEED,
            market.key().as_ref(),
            &[OptionType::Call.marker()],
            &expiry_ms.to_le_bytes(),
            &strike_price_e8.to_le_bytes(),
        ],
        bump,
    )]
    pub series: Box<Account<'info, Series>>,
    #[account(
        init_if_needed,
        payer = seller,
        seeds = [
            LONG_MINT_SEED,
            market.key().as_ref(),
            &[OptionType::Call.marker()],
            &expiry_ms.to_le_bytes(),
            &strike_price_e8.to_le_bytes(),
        ],
        bump,
        mint::decimals = base_mint.decimals,
        mint::authority = series,
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
    #[account(
        mut,
        constraint = seller_base_source.owner == seller.key() @ OptionsError::InvalidFundingAccount,
        constraint = seller_base_source.mint == market.base_mint @ OptionsError::InvalidFundingAccount,
    )]
    pub seller_base_source: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = seller_quote_destination.owner == seller.key() @ OptionsError::InvalidFundingAccount,
        constraint = seller_quote_destination.mint == market.quote_mint @ OptionsError::InvalidFundingAccount,
    )]
    pub seller_quote_destination: Box<Account<'info, TokenAccount>>,
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
            &[OptionType::Call.marker()],
            &expiry_ms.to_le_bytes(),
            &strike_price_e8.to_le_bytes(),
            seller.key().as_ref(),
        ],
        bump,
    )]
    pub seller_vault: Box<Account<'info, SellerVault>>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = base_mint,
        associated_token::authority = series,
    )]
    pub base_collateral_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(expiry_ms: u64, strike_price_e8: u64)]
pub struct UnderwritePut<'info> {
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    #[account(address = market.base_mint)]
    pub base_mint: Box<Account<'info, Mint>>,
    #[account(address = market.quote_mint)]
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = seller,
        space = Series::SPACE,
        seeds = [
            SERIES_SEED,
            market.key().as_ref(),
            &[OptionType::Put.marker()],
            &expiry_ms.to_le_bytes(),
            &strike_price_e8.to_le_bytes(),
        ],
        bump,
    )]
    pub series: Box<Account<'info, Series>>,
    #[account(
        init_if_needed,
        payer = seller,
        seeds = [
            LONG_MINT_SEED,
            market.key().as_ref(),
            &[OptionType::Put.marker()],
            &expiry_ms.to_le_bytes(),
            &strike_price_e8.to_le_bytes(),
        ],
        bump,
        mint::decimals = base_mint.decimals,
        mint::authority = series,
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
    #[account(
        mut,
        constraint = seller_quote_account.owner == seller.key() @ OptionsError::InvalidFundingAccount,
        constraint = seller_quote_account.mint == market.quote_mint @ OptionsError::InvalidFundingAccount,
    )]
    pub seller_quote_account: Box<Account<'info, TokenAccount>>,
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
            &[OptionType::Put.marker()],
            &expiry_ms.to_le_bytes(),
            &strike_price_e8.to_le_bytes(),
            seller.key().as_ref(),
        ],
        bump,
    )]
    pub seller_vault: Box<Account<'info, SellerVault>>,
    #[account(
        init_if_needed,
        payer = seller,
        associated_token::mint = quote_mint,
        associated_token::authority = series,
    )]
    pub quote_collateral_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
