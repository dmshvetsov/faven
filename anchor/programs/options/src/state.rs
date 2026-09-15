use anchor_lang::prelude::*;

pub const PYTH_TWAP_SEED: &[u8] = b"PythTwap";
pub const SERIES_SEED: &[u8] = b"option_series";
pub const LONG_MINT_SEED: &[u8] = b"option_series_mint";
pub const SELLER_VAULT_SEED: &[u8] = b"option_series_seller_vault";
pub const MIN_UNDERWRITING_LEAD_TIME_MS: u64 = 8 * 60 * 60 * 1_000;
pub const EXERCISE_WINDOW_MS: u64 = 60 * 60 * 1_000;

pub fn current_time_ms() -> Result<u64> {
    u64::try_from(Clock::get()?.unix_timestamp)
        .map_err(|_| error!(crate::errors::OptionsError::ClockNegativeTimestamp))?
        .checked_mul(1_000)
        .ok_or(error!(crate::errors::OptionsError::ArithmeticOverflow))
}

#[account]
pub struct Market {
    pub oracle_config: OracleConfig,
    pub base_mint_decimals: u8,
    pub quote_mint_decimals: u8,
    pub operator: Pubkey,
    pub paused: bool,
    pub quote_mint: Pubkey,
    pub base_mint: Pubkey,
    pub min_fee: u64,
    pub min_operational_fee_bps: u16,
    pub max_operational_fee_bps: u16,
}

impl Market {
    pub const SPACE: usize = 8 + 33 + 1 + 1 + 32 + 1 + 32 + 32 + 8 + 2 + 2;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum OptionType {
    Call, // 0 call flag
    Put,  // 1 put flag
}

impl OptionType {
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
    pub expiry_ms: u64,
    pub exercise_window_end_ms: u64,
    pub expiry_price: Option<u64>,
    pub total_contracts_quantity: u64,
    pub total_manual_exercised_quantity: u64,
    pub total_settled_quantity: u64,
    pub total_quote_amount: u64,
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
    PythTwap { feed_id: [u8; 32] },
}

impl OracleConfig {
    pub fn kind_seed(&self) -> &'static [u8] {
        PYTH_TWAP_SEED
    }

    pub fn kind(&self) -> OracleKind {
        OracleKind::PythTwap
    }

    pub fn feed_id(&self) -> [u8; 32] {
        match self {
            Self::PythTwap { feed_id } => *feed_id,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum OracleKind {
    PythTwap,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalizationMethod {
    PythTwap,
    PythUnverified,
}
