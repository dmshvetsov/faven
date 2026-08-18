use anchor_lang::prelude::*;

#[error_code]
pub enum MarketError {
    #[msg("Base coin and quote coin mints must differ")]
    CoinMintsMustDiffer,
    #[msg("Mint decimals must not exceed 19")]
    MintDecimalsTooLarge,
    #[msg("Minimum operational fee bps must not exceed maximum operational fee bps")]
    InvalidOperationalFeeRange,
    #[msg("Operational fee bps must not exceed 10,000")]
    OperationalFeeBpsTooLarge,
}
