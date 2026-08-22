use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
mod finalization;
pub mod instructions;
pub mod math;
pub mod options_rules;
pub mod state;

pub(crate) use instructions::__client_accounts_create_market;
pub(crate) use instructions::__client_accounts_create_series;
pub(crate) use instructions::__client_accounts_finalize_pyth_twap_eight_series;
pub(crate) use instructions::__client_accounts_finalize_pyth_twap_four_series;
pub(crate) use instructions::__client_accounts_finalize_pyth_twap_one_series;
pub(crate) use instructions::__client_accounts_finalize_pyth_twap_two_series;
pub(crate) use instructions::__client_accounts_finalize_pyth_unverified_eight_series;
pub(crate) use instructions::__client_accounts_finalize_pyth_unverified_four_series;
pub(crate) use instructions::__client_accounts_finalize_pyth_unverified_one_series;
pub(crate) use instructions::__client_accounts_finalize_pyth_unverified_two_series;
pub(crate) use instructions::__client_accounts_underwrite;
pub use instructions::{
    CreateMarket, CreateSeries, FinalizePythTwapEightSeries, FinalizePythTwapFourSeries,
    FinalizePythTwapOneSeries, FinalizePythTwapTwoSeries, FinalizePythUnverifiedEightSeries,
    FinalizePythUnverifiedFourSeries, FinalizePythUnverifiedOneSeries,
    FinalizePythUnverifiedTwoSeries, Underwrite,
};
pub use state::{OptionType, OracleConfig};

declare_id!("Hvfbh72e5Vw1Gq8RFsKLj9BLq1m5y9WFzBYn2fZR8UYX");

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

    pub fn create_series(
        ctx: Context<CreateSeries>,
        option_type: OptionType,
        strike_price: u64,
        expiry_ms: u64,
    ) -> Result<()> {
        instructions::create_series(ctx, option_type, strike_price, expiry_ms)
    }

    pub fn underwrite_call(
        ctx: Context<Underwrite>,
        quantity: u64,
        premium_per_contract: u64,
        operational_fee_bps: u16,
    ) -> Result<()> {
        instructions::underwrite_call(ctx, quantity, premium_per_contract, operational_fee_bps)
    }

    pub fn underwrite_put(
        ctx: Context<Underwrite>,
        quantity: u64,
        premium_per_contract: u64,
        operational_fee_bps: u16,
    ) -> Result<()> {
        instructions::underwrite_put(ctx, quantity, premium_per_contract, operational_fee_bps)
    }

    pub fn finalize_pyth_unverified_one_series(
        ctx: Context<FinalizePythUnverifiedOneSeries>,
        id: [u8; 32],
        price: i64,
        conf: u64,
        expo: i32,
        publish_time: i64,
    ) -> Result<()> {
        instructions::finalize_pyth_unverified_one_series(ctx, id, price, conf, expo, publish_time)
    }

    pub fn finalize_pyth_unverified_two_series(
        ctx: Context<FinalizePythUnverifiedTwoSeries>,
        id: [u8; 32],
        price: i64,
        conf: u64,
        expo: i32,
        publish_time: i64,
    ) -> Result<()> {
        instructions::finalize_pyth_unverified_two_series(ctx, id, price, conf, expo, publish_time)
    }

    pub fn finalize_pyth_unverified_four_series(
        ctx: Context<FinalizePythUnverifiedFourSeries>,
        id: [u8; 32],
        price: i64,
        conf: u64,
        expo: i32,
        publish_time: i64,
    ) -> Result<()> {
        instructions::finalize_pyth_unverified_four_series(ctx, id, price, conf, expo, publish_time)
    }

    pub fn finalize_pyth_unverified_eight_series(
        ctx: Context<FinalizePythUnverifiedEightSeries>,
        id: [u8; 32],
        price: i64,
        conf: u64,
        expo: i32,
        publish_time: i64,
    ) -> Result<()> {
        instructions::finalize_pyth_unverified_eight_series(
            ctx,
            id,
            price,
            conf,
            expo,
            publish_time,
        )
    }

    pub fn finalize_pyth_twap_one_series(ctx: Context<FinalizePythTwapOneSeries>) -> Result<()> {
        instructions::finalize_pyth_twap_one_series(ctx)
    }

    pub fn finalize_pyth_twap_two_series(ctx: Context<FinalizePythTwapTwoSeries>) -> Result<()> {
        instructions::finalize_pyth_twap_two_series(ctx)
    }

    pub fn finalize_pyth_twap_four_series(ctx: Context<FinalizePythTwapFourSeries>) -> Result<()> {
        instructions::finalize_pyth_twap_four_series(ctx)
    }

    pub fn finalize_pyth_twap_eight_series(
        ctx: Context<FinalizePythTwapEightSeries>,
    ) -> Result<()> {
        instructions::finalize_pyth_twap_eight_series(ctx)
    }
}
