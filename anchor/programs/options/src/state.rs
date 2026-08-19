use anchor_lang::prelude::*;

pub const PYTH_UNVERIFIED_SEED: &[u8] = b"PythUnverified";
pub const SERIES_SEED: &[u8] = b"option_series";
pub const LONG_MINT_SEED: &[u8] = b"option_series_mint";
pub const SELLER_VAULT_SEED: &[u8] = b"option_series_seller_vault";
pub const MIN_UNDERWRITING_LEAD_TIME_MS: i64 = 8 * 60 * 60 * 1_000;
pub const EXERCISE_WINDOW_MS: i64 = 60 * 60 * 1_000;

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
pub enum OptionType {
    Call,
    Put,
}

impl OptionType {
    pub fn from_marker(marker: u8) -> Result<Self> {
        match marker {
            1 => Ok(Self::Call),
            2 => Ok(Self::Put),
            _ => err!(crate::errors::MarketError::InvalidOptionType),
        }
    }

    pub fn marker(self) -> u8 {
        match self {
            Self::Call => 1,
            Self::Put => 2,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum SeriesState {
    Open,
    ExpirationPriceFinalized,
    Closed,
}

#[account]
pub struct Series {
    pub state: SeriesState,
    pub market: Pubkey,
    pub option_type: OptionType,
    pub strike_price: u64,
    pub expiry_ms: i64,
    pub exercise_window_end_ms: i64,
    pub expiry_price: Option<u64>,
    pub total_short_quantity: u64,
    pub total_contracts_quantity: u64,
    pub total_manual_exercised_quantity: u64,
    pub total_settled_quantity: u64,
}

impl Series {
    pub const SPACE: usize = 8 + 1 + 32 + 1 + 8 + 8 + 8 + 9 + (8 * 4);
}

#[account]
pub struct SellerVault {
    pub owner: Pubkey,
    pub series: Pubkey,
    pub short_quantity: u64,
    pub collateral_quantity: u64,
}

impl SellerVault {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 8;
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
