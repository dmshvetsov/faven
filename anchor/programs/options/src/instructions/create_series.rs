use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token},
};

use crate::{
    errors::MarketError,
    events::SeriesCreated,
    state::{
        Market, OptionType, Series, SeriesState, EXERCISE_WINDOW_MS, LONG_MINT_SEED,
        MIN_UNDERWRITING_LEAD_TIME_MS, SERIES_SEED,
    },
};

pub fn create_series(
    ctx: Context<CreateSeries>,
    option_type_marker: u8,
    strike_price: u64,
    expiry_ms: i64,
) -> Result<()> {
    let option_type = OptionType::from_marker(option_type_marker)?;
    require!(strike_price > 0, MarketError::InvalidStrikePrice);

    let now_ms = Clock::get()?
        .unix_timestamp
        .checked_mul(1_000)
        .ok_or(error!(MarketError::ArithmeticOverflow))?;
    let minimum_expiry = now_ms
        .checked_add(MIN_UNDERWRITING_LEAD_TIME_MS)
        .ok_or(error!(MarketError::ArithmeticOverflow))?;
    require!(expiry_ms > minimum_expiry, MarketError::ExpiryTooSoon);

    let exercise_window_end_ms = expiry_ms
        .checked_add(EXERCISE_WINDOW_MS)
        .ok_or(error!(MarketError::ArithmeticOverflow))?;
    let series = &mut ctx.accounts.series;
    series.state = SeriesState::Open;
    series.market = ctx.accounts.market.key();
    series.option_type = option_type;
    series.strike_price = strike_price;
    series.expiry_ms = expiry_ms;
    series.exercise_window_end_ms = exercise_window_end_ms;
    series.expiry_price = None;
    series.total_short_quantity = 0;
    series.total_contracts_quantity = 0;
    series.total_manual_exercised_quantity = 0;
    series.total_settled_quantity = 0;

    emit!(SeriesCreated {
        series: series.key(),
        market: series.market,
        option_type,
        strike_price,
        expiry_ms,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(option_type_marker: u8, strike_price: u64, expiry_ms: i64)]
pub struct CreateSeries<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(address = market.base_coin_mint)]
    pub base_coin_mint: Account<'info, Mint>,
    #[account(address = market.quote_coin_mint)]
    pub quote_coin_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = Series::SPACE,
        seeds = [
            SERIES_SEED,
            market.key().as_ref(),
            &[option_type_marker],
            &expiry_ms.to_le_bytes(),
            &strike_price.to_le_bytes(),
        ],
        bump,
    )]
    pub series: Account<'info, Series>,
    #[account(
        init,
        payer = payer,
        seeds = [
            LONG_MINT_SEED,
            market.key().as_ref(),
            &[option_type_marker],
            &expiry_ms.to_le_bytes(),
            &strike_price.to_le_bytes(),
        ],
        bump,
        mint::decimals = base_coin_mint.decimals,
        mint::authority = series,
    )]
    pub long_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = base_coin_mint,
        associated_token::authority = series,
    )]
    pub base_collateral_vault: Account<'info, anchor_spl::token::TokenAccount>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = quote_coin_mint,
        associated_token::authority = series,
    )]
    pub quote_collateral_vault: Account<'info, anchor_spl::token::TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
