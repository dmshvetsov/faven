use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
mod finalization;
pub mod instructions;
pub mod math;
pub mod options_rules;
pub mod state;

pub(crate) use instructions::__client_accounts_close_series;
pub(crate) use instructions::__client_accounts_create_market;
pub(crate) use instructions::__client_accounts_exercise;
pub(crate) use instructions::__client_accounts_finalize_pyth_unverified_series;
pub(crate) use instructions::__client_accounts_settle_sellers_batch;
pub(crate) use instructions::__client_accounts_underwrite_call;
pub(crate) use instructions::__client_accounts_underwrite_put;
pub use instructions::{
    CloseSeries, CreateMarket, Exercise, FinalizePythUnverifiedSeries, SettleSellersBatch,
    UnderwriteCall, UnderwritePut,
};
pub use state::{OptionType, OracleConfig};

declare_id!("FAVENgBXzD9K9qYHKRF5RFRJeT4Qa2EV4EoTycki5gGT");

#[program]
pub mod options {
    use super::*;

    pub fn create_market(
        ctx: Context<CreateMarket>,
        oracle_config: OracleConfig,
        min_fee: u64,
        min_operational_fee_bps: u16,
        max_operational_fee_bps: u16,
    ) -> Result<()> {
        instructions::create_market(
            ctx,
            oracle_config,
            min_fee,
            min_operational_fee_bps,
            max_operational_fee_bps,
        )
    }

    pub fn underwrite_call_e18(
        ctx: Context<UnderwriteCall>,
        expiry_ms: u64,
        strike_price_e8: u64,
        quantity_e18: u128,
        premium_e18: u128,
        operational_fee_bps: u16,
    ) -> Result<()> {
        instructions::underwrite_call_e18(
            ctx,
            expiry_ms,
            strike_price_e8,
            quantity_e18,
            premium_e18,
            operational_fee_bps,
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
        instructions::underwrite_put_e18(
            ctx,
            expiry_ms,
            strike_price_e8,
            quantity_e18,
            premium_e18,
            operational_fee_bps,
        )
    }

    pub fn exercise_e18(ctx: Context<Exercise>, quantity_e18: u128) -> Result<()> {
        instructions::exercise_e18(ctx, quantity_e18)
    }

    pub fn close_series<'info>(ctx: Context<'info, CloseSeries<'info>>) -> Result<()> {
        instructions::close_series(ctx)
    }

    pub fn settle_sellers_batch<'info>(
        ctx: Context<'info, SettleSellersBatch<'info>>,
    ) -> Result<()> {
        instructions::settle_sellers_batch(ctx)
    }

    pub fn finalize_pyth_unverified_series(
        ctx: Context<FinalizePythUnverifiedSeries>,
        id: [u8; 32],
        price: i64,
        conf: u64,
        expo: i32,
        publish_time: i64,
    ) -> Result<()> {
        instructions::finalize_pyth_unverified_series(ctx, id, price, conf, expo, publish_time)
    }
}
