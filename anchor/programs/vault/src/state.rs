use anchor_lang::prelude::*;

pub const PYTH_UNVERIFIED_SEED: &[u8] = b"PythUnverified";

#[account]
pub struct Market {
    pub oracle_config: OracleConfig,
    pub base_coin_scale: u64,
    pub quote_coin_scale: u64,
    pub operator: Pubkey,
    pub paused: bool,
    pub quote_coin_mint: Pubkey,
    pub base_coin_mint: Pubkey,
    pub min_fee: u64,
    pub min_operational_fee_bps: u16,
    pub max_operational_fee_bps: u16,
}

impl Market {
    pub const SPACE: usize = 8 + 33 + 8 + 8 + 32 + 1 + 32 + 32 + 8 + 2 + 2;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum OracleConfig {
    PythUnverified { feed_id: [u8; 32] },
}

impl OracleConfig {
    pub fn kind_seed(&self) -> &'static [u8] {
        PYTH_UNVERIFIED_SEED
    }

    pub fn kind(&self) -> OracleKind {
        OracleKind::PythUnverified
    }

    pub fn feed_id(&self) -> [u8; 32] {
        match self {
            Self::PythUnverified { feed_id } => *feed_id,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum OracleKind {
    PythUnverified,
}
