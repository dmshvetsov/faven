use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token::spl_token,
    token_interface::{Mint, TokenAccount, TokenInterface},
};
use spl_token_2022_interface::{
    extension::{
        default_account_state::DefaultAccountState, pausable::PausableConfig,
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::{Account as Token2022Account, AccountState, Mint as Token2022Mint},
};

use crate::errors::OptionsError;

pub(crate) fn validate_market_mint(
    mint: &InterfaceAccount<'_, Mint>,
    token_program: &Interface<'_, TokenInterface>,
) -> Result<()> {
    require_keys_eq!(
        *mint.to_account_info().owner,
        token_program.key(),
        OptionsError::InvalidMintTokenProgram
    );
    if token_program.key() == spl_token_2022_interface::id() {
        validate_token_2022_mint_extensions(&mint.to_account_info())?;
    }
    Ok(())
}

pub(crate) fn validate_mint_token_program(
    mint: &InterfaceAccount<'_, Mint>,
    token_program: &Interface<'_, TokenInterface>,
) -> Result<()> {
    require_keys_eq!(
        *mint.to_account_info().owner,
        token_program.key(),
        OptionsError::InvalidMintTokenProgram
    );
    Ok(())
}

pub(crate) fn validate_series_creation_mint(
    mint: &InterfaceAccount<'_, Mint>,
    token_program: &Interface<'_, TokenInterface>,
) -> Result<()> {
    validate_mint_token_program(mint, token_program)?;
    if token_program.key() != spl_token_2022_interface::id() {
        return Ok(());
    }
    let mint_info = mint.to_account_info();
    let data = mint_info.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(OptionsError::InvalidMintExtensions))?;
    if let Ok(default_state) = state.get_extension::<DefaultAccountState>() {
        require!(
            default_state.state == AccountState::Initialized as u8,
            OptionsError::OperationBlockedByMintIssuer
        );
    }
    Ok(())
}

pub(crate) fn validate_mint_transfer_allowed(
    mint: &InterfaceAccount<'_, Mint>,
    token_program: &Interface<'_, TokenInterface>,
) -> Result<()> {
    validate_mint_token_program(mint, token_program)?;
    if token_program.key() != spl_token_2022_interface::id() {
        return Ok(());
    }
    let mint_info = mint.to_account_info();
    let data = mint_info.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(OptionsError::InvalidMintExtensions))?;
    if let Ok(pausable) = state.get_extension::<PausableConfig>() {
        require!(
            !bool::from(pausable.paused),
            OptionsError::OperationBlockedByMintIssuer
        );
    }
    Ok(())
}

pub(crate) fn validate_associated_token_account_address(
    account: &Pubkey,
    authority: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *account,
        get_associated_token_address_with_program_id(authority, mint, token_program),
        OptionsError::InvalidAssociatedTokenAccount
    );
    Ok(())
}

pub(crate) fn validate_token_account(
    account: &InterfaceAccount<'_, TokenAccount>,
    token_program: &Interface<'_, TokenInterface>,
) -> Result<()> {
    validate_token_account_info(&account.to_account_info(), token_program)
}

pub(crate) fn validate_token_account_with_owner_and_mint(
    account: &AccountInfo<'_>,
    expected_owner: Pubkey,
    expected_mint: Pubkey,
    token_program: &Interface<'_, TokenInterface>,
) -> Result<()> {
    validate_token_account_with_owner_and_mint_for_error(
        account,
        expected_owner,
        expected_mint,
        token_program,
        OptionsError::InvalidExerciseTokenAccount,
    )
}

pub(crate) fn validate_token_account_with_owner_and_mint_for_error(
    account: &AccountInfo<'_>,
    expected_owner: Pubkey,
    expected_mint: Pubkey,
    token_program: &Interface<'_, TokenInterface>,
    invalid_account_error: OptionsError,
) -> Result<()> {
    validate_token_account_info(account, token_program)?;
    let data = account.try_borrow_data()?;
    let (owner, mint) = if token_program.key() == spl_token_2022_interface::id() {
        let state = StateWithExtensions::<Token2022Account>::unpack(&data)
            .map_err(|_| error!(OptionsError::UnsupportedTokenAccountExtension))?;
        (state.base.owner, state.base.mint)
    } else {
        let account = spl_token::state::Account::unpack(&data)
            .map_err(|_| error!(OptionsError::InvalidTokenAccountProgram))?;
        (account.owner, account.mint)
    };
    if owner != expected_owner || mint != expected_mint {
        return Err(invalid_account_error.into());
    }
    Ok(())
}

fn validate_token_account_info(
    account: &AccountInfo<'_>,
    token_program: &Interface<'_, TokenInterface>,
) -> Result<()> {
    require_keys_eq!(
        *account.owner,
        token_program.key(),
        OptionsError::InvalidTokenAccountProgram
    );
    if token_program.key() != spl_token_2022_interface::id() {
        return Ok(());
    }

    let data = account.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Account>::unpack(&data)
        .map_err(|_| error!(OptionsError::UnsupportedTokenAccountExtension))?;
    require!(
        state.base.state != AccountState::Frozen,
        OptionsError::OperationBlockedByMintIssuer
    );
    require!(
        state.base.state == AccountState::Initialized,
        OptionsError::UnsupportedTokenAccountExtension
    );
    for extension_type in state
        .get_extension_types()
        .map_err(|_| error!(OptionsError::UnsupportedTokenAccountExtension))?
    {
        match extension_type {
            ExtensionType::ImmutableOwner | ExtensionType::PausableAccount => {}
            _ => return err!(OptionsError::UnsupportedTokenAccountExtension),
        }
    }
    Ok(())
}

fn validate_token_2022_mint_extensions(mint: &AccountInfo<'_>) -> Result<()> {
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(OptionsError::InvalidMintExtensions))?;
    let extension_types = state
        .get_extension_types()
        .map_err(|_| error!(OptionsError::InvalidMintExtensions))?;

    for extension_type in extension_types {
        match extension_type {
            ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::PermanentDelegate
            | ExtensionType::ConfidentialTransferMint
            | ExtensionType::Pausable
            | ExtensionType::ScaledUiAmount => {}
            ExtensionType::DefaultAccountState => {
                let default_state = state
                    .get_extension::<DefaultAccountState>()
                    .map_err(|_| error!(OptionsError::InvalidMintExtensions))?;
                require!(
                    default_state.state == AccountState::Initialized as u8,
                    OptionsError::OperationBlockedByMintIssuer
                );
            }
            ExtensionType::TransferHook => {
                // TODO: review TransferHook support in the dedicated follow-up issue.
                return err!(OptionsError::UnsupportedMintExtension);
            }
            _ => return err!(OptionsError::UnsupportedMintExtension),
        }
    }
    Ok(())
}
