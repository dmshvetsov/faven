use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};
use spl_token_2022_interface::{
    extension::{
        default_account_state::DefaultAccountState, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
    state::{AccountState, Mint as Token2022Mint},
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
