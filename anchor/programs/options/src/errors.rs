use anchor_lang::prelude::*;

#[error_code]
pub enum OptionsError {
    #[msg("Base coin and quote coin mints must differ")]
    CoinMintsMustDiffer,
    #[msg("Mint decimals must not exceed 19")]
    MintDecimalsTooLarge,
    #[msg("Minimum operational fee bps must not exceed maximum operational fee bps")]
    InvalidOperationalFeeRange,
    #[msg("Operational fee bps must not exceed 10,000")]
    OperationalFeeBpsTooLarge,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Option type must be call (1) or put (2)")]
    InvalidOptionType,
    #[msg("Strike price must be greater than zero")]
    InvalidStrikePrice,
    #[msg("Expiry must be more than eight hours away")]
    ExpiryTooSoon,
    #[msg("Market is paused")]
    MarketPaused,
    #[msg("Series is not open")]
    SeriesNotOpen,
    #[msg("Buyer and seller must differ")]
    BuyerAndSellerMustDiffer,
    #[msg("Quantity must be greater than zero")]
    ZeroQuantity,
    #[msg("Funding token account has an invalid owner or mint")]
    InvalidFundingAccount,
    #[msg("Operational fee bps is outside the market range")]
    OperationalFeeBpsOutOfRange,
    #[msg("Operational fee cannot exceed premium")]
    FeeExceedsPremium,
    #[msg("Seller vault does not match the seller or series")]
    InvalidSellerVault,
    #[msg("Negative clock timestamp")]
    ClockNegativeTimestamp,
    #[msg("Zero division")]
    ZeroDivision,
}
