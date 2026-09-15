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
    #[msg("Signed terms use precision unsupported by the token mint")]
    UnsupportedTokenPrecision,
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
    PriceFinalizationSeriesExpiryMismatch,
    #[msg("Finalization requires at least one series")]
    EmptyFinalizationBatch,
    #[msg("Finalization supports at most sixteen series")]
    FinalizationBatchTooLarge,
    #[msg("The same series cannot appear more than once in a finalization batch")]
    DuplicateFinalizationSeries,
    #[msg("Finalization series accounts must be writable")]
    FinalizationSeriesNotWritable,
    #[msg("Finalization requires a QuoteCoin collateral vault for every series")]
    FinalizationSeriesVaultPairRequired,
    #[msg("Manual exercise is not available in the current series phase")]
    InvalidExercisePhase,
    #[msg("Only in-the-money options may be exercised")]
    SeriesNotInTheMoney,
    #[msg("Exercise quantity exceeds the holder Long token balance")]
    ExerciseQuantityExceedsLongBalance,
    #[msg("Exercise quantity exceeds contracts issued for this series")]
    ExerciseQuantityExceedsIssuedContracts,
    #[msg("Series collateral is insufficient for exercise")]
    InsufficientSeriesCollateral,
    #[msg("Holder payment account has insufficient funds for exercise")]
    InsufficientHolderPayment,
    #[msg("Exercise token account has an invalid owner or mint")]
    InvalidExerciseTokenAccount,
    #[msg("Seller settlement is not available in the current series phase")]
    InvalidSettlementPhase,
    #[msg("Seller settlement requires at least one seller vault")]
    EmptySettlementBatch,
    #[msg("Seller payout token account has an invalid owner or mint")]
    InvalidSellerPayoutAccount,
    #[msg("Seller vault does not match the expected program-derived address")]
    SellerVaultPdaMismatch,
    #[msg("Seller settlement would exceed the series issued quantity")]
    SettlementQuantityExceedsIssuedContracts,
    #[msg("A seller vault may appear only once in a settlement batch")]
    DuplicateSettlementSellerVault,
    #[msg("Settlement seller accounts are malformed")]
    MalformedSettlementAccounts,
    #[msg("Series closure is not available in the current series phase")]
    InvalidClosurePhase,
    #[msg("Series closure accounts are malformed")]
    MalformedClosureAccounts,
    #[msg("Series closer token account has an invalid owner or mint")]
    InvalidSeriesCloserPayoutAccount,
    #[msg("Series option type does not match the underwriting terms")]
    SeriesOptionTypeMismatch,
    #[msg("Series expiry does not match the underwriting terms")]
    SeriesExpiryMismatch,
    #[msg("Series strike price does not match the underwriting terms")]
    SeriesStrikePriceMismatch,
    #[msg("Series exercise window does not match window derived from provided expiry_ms")]
    SeriesExerciseWindowMismatch,
    #[msg("Series open-state accounting is invalid")]
    InvalidOpenSeriesAccounting,
    #[msg("The supplied token program does not own this mint")]
    InvalidMintTokenProgram,
    #[msg("Token-2022 mint data or extensions are invalid")]
    InvalidMintExtensions,
    #[msg("This Token-2022 mint extension is not supported")]
    UnsupportedMintExtension,
    #[msg("The token issuer currently blocks this operation")]
    OperationBlockedByMintIssuer,
    #[msg("The supplied token program does not own this token account")]
    InvalidTokenAccountProgram,
    #[msg("This Token-2022 token-account extension is not supported")]
    UnsupportedTokenAccountExtension,
    #[msg("The supplied associated token account address is invalid")]
    InvalidAssociatedTokenAccount,
}
