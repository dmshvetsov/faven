use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

pub(crate) use instructions::__client_accounts_create_market;
pub use instructions::CreateMarket;
pub use state::OracleConfig;

declare_id!("Hvfbh72e5Vw1Gq8RFsKLj9BLq1m5y9WFzBYn2fZR8UYX");

#[program]
pub mod vault {
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
}
