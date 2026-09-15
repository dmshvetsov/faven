use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::{
    errors::OptionsError,
    events::MarketCreated,
    state::{Market, OracleConfig},
    token_compat::validate_market_mint,
};

pub fn create_market(
    ctx: Context<CreateMarket>,
    oracle_config: OracleConfig,
    min_fee: u64,
    min_operational_fee_bps: u16,
    max_operational_fee_bps: u16,
) -> Result<()> {
    validate_market_mint(&ctx.accounts.quote_mint, &ctx.accounts.quote_token_program)?;
    validate_market_mint(&ctx.accounts.base_mint, &ctx.accounts.base_token_program)?;
    require!(
        ctx.accounts.quote_mint.key() != ctx.accounts.base_mint.key(),
        OptionsError::CoinMintsMustDiffer
    );
    require!(
        ctx.accounts.quote_mint.decimals <= 19,
        OptionsError::MintDecimalsTooLarge
    );
    require!(
        ctx.accounts.base_mint.decimals <= 19,
        OptionsError::MintDecimalsTooLarge
    );
    require!(
        min_operational_fee_bps <= max_operational_fee_bps,
        OptionsError::InvalidOperationalFeeRange
    );
    require!(
        max_operational_fee_bps <= 10_000,
        OptionsError::OperationalFeeBpsTooLarge
    );

    let market = &mut ctx.accounts.market;
    market.oracle_config = oracle_config;
    market.base_mint_decimals = ctx.accounts.base_mint.decimals;
    market.quote_mint_decimals = ctx.accounts.quote_mint.decimals;
    market.operator = ctx.accounts.operator.key();
    market.paused = false;
    market.quote_mint = ctx.accounts.quote_mint.key();
    market.base_mint = ctx.accounts.base_mint.key();
    market.min_fee = min_fee;
    market.min_operational_fee_bps = min_operational_fee_bps;
    market.max_operational_fee_bps = max_operational_fee_bps;

    emit!(MarketCreated {
        market: market.key(),
        operator: market.operator,
        oracle_kind: oracle_config.kind(),
        oracle_feed_id: oracle_config.feed_id(),
        quote_mint: market.quote_mint,
        base_mint: market.base_mint,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(oracle_config: OracleConfig)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub operator: Signer<'info>,
    pub quote_mint: InterfaceAccount<'info, Mint>,
    pub base_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = Market::SPACE,
        seeds = [b"market", oracle_config.kind_seed(), oracle_config.feed_id().as_ref(), quote_mint.key().as_ref(), base_mint.key().as_ref(), operator.key().as_ref()],
        bump,
    )]
    pub market: Account<'info, Market>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
