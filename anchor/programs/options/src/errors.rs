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
    #[msg("Expiry must be aligned to a whole second")]
    ExpiryNotWholeSecond,
    #[msg("Action is not allowed when market is paused")]
    MarketPaused,
    #[msg("Series is not open")]
    SeriesNotOpen,
    #[msg("Buyer and seller must differ")]
    BuyerAndSellerMustDiffer,
    #[msg("Quantity must be greater than zero")]
    ZeroQuantity,
    #[msg("Funding token account has an invalid owner or mint")]
    InvalidFundingAccount,
    #[msg("Series does not belong to the provided market")]
    SeriesMarketMismatch,
    #[msg("Operational fee bps is outside the market range")]
    OperationalFeeBpsOutOfRange,
    #[msg("Operational fee cannot exceed premium")]
    FeeExceedsPremium,
    #[msg("Seller vault does not match the seller or series")]
    InvalidSellerVault,
    #[msg("Negative clock timestamp")]
    ClockNegativeTimestamp,
    #[msg("Division by zero")]
    ZeroDivision,
    #[msg("Pyth price must be positive")]
    InvalidPythPrice,
    #[msg("Pyth price cannot be represented at the strike scale")]
    PythPriceOutOfRange,
    #[msg("Only the market operator may use this finalization method")]
    UnauthorizedFinalizer,
    #[msg("Expiry price cannot be finalized for an unexpired option series")]
    FinalizationTooEarly,
    #[msg("All finalized series must have the same expiry")]
    SeriesExpiryMismatch,
    #[msg("Pyth TWAP feed does not match the market")]
    PythTwapFeedMismatch,
    #[msg("Pyth TWAP window does not match the series expiry")]
    PythTwapWindowMismatch,
    #[msg("Pyth TWAP does not have sufficient coverage")]
    InsufficientPythTwapCoverage,
    #[msg("Finalization requires at least one series")]
    EmptyFinalizationBatch,
    #[msg("Finalization supports at most sixteen series")]
    FinalizationBatchTooLarge,
    #[msg("The same series cannot appear more than once in a finalization batch")]
    DuplicateFinalizationSeries,
    #[msg("Finalization series accounts must be writable")]
    FinalizationSeriesNotWritable,
}
