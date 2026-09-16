#![allow(dead_code)]

use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::{get_associated_token_address, ID as ASSOCIATED_TOKEN_PROGRAM_ID},
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use litesvm::LiteSVM;
use options::{
    accounts, instruction,
    state::{LONG_MINT_SEED, SELLER_VAULT_SEED, SERIES_SEED},
    OracleConfig, ID as PROGRAM_ID,
};
use solana_program_pack::Pack;
use solana_sdk::{
    account::Account, instruction::Instruction, pubkey::Pubkey, signature::Keypair, signer::Signer,
    transaction::Transaction,
};
use spl_token::state::{Account as SplTokenAccount, AccountState, Mint};
use spl_token_2022_interface::{
    extension::ExtensionType,
    state::{Account as Token2022Account, Mint as Token2022Mint},
};

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
pub const EXPIRY_MS: u64 = 2_000_000_000_000;
pub const ONE_OPTION_E18: u128 = 1_000_000_000_000_000_000;
pub const ONE_QUOTE_E18: u128 = 1_000_000_000_000_000_000;
pub const FIRST_UNDERWRITE_COMPUTE_UNITS: u32 = 400_000;

pub fn first_underwrite_compute_budget() -> Instruction {
    let mut data = vec![2];
    data.extend_from_slice(&FIRST_UNDERWRITE_COMPUTE_UNITS.to_le_bytes());
    Instruction {
        program_id: solana_sdk::pubkey!("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

pub fn deterministic_bytes(value: u32) -> [u8; 32] {
    let mut bytes = [0; 32];
    bytes[..4].copy_from_slice(&value.to_le_bytes());
    bytes
}

pub fn add_mint(svm: &mut LiteSVM, mint_key: Pubkey, decimals: u8) {
    add_mint_for_program(svm, mint_key, decimals, TOKEN_PROGRAM_ID);
}

pub fn add_mint_for_program(svm: &mut LiteSVM, mint_key: Pubkey, decimals: u8, program_id: Pubkey) {
    let mint = Mint {
        mint_authority: solana_sdk::program_option::COption::None,
        supply: 0,
        decimals,
        is_initialized: true,
        freeze_authority: solana_sdk::program_option::COption::None,
    };
    let mut data = vec![0; Mint::LEN];
    Mint::pack(mint, &mut data).unwrap();
    svm.set_account(
        mint_key,
        Account {
            lamports: 1_000_000,
            data,
            owner: program_id,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

pub fn add_token_2022_mint_with_extension(
    svm: &mut LiteSVM,
    mint_key: Pubkey,
    decimals: u8,
    extension_type: ExtensionType,
    extension_value: &[u8],
) {
    const BASE_ACCOUNT_AND_TYPE_LENGTH: usize = 166;
    const TLV_HEADER_LENGTH: usize = 4;
    let mut data =
        vec![0; BASE_ACCOUNT_AND_TYPE_LENGTH + TLV_HEADER_LENGTH + extension_value.len()];
    Token2022Mint::pack(
        Token2022Mint {
            decimals,
            is_initialized: true,
            ..Token2022Mint::default()
        },
        &mut data[..Token2022Mint::LEN],
    )
    .unwrap();
    data[165] = 1;
    data[166..168].copy_from_slice(&u16::from(extension_type).to_le_bytes());
    data[168..170].copy_from_slice(&u16::try_from(extension_value.len()).unwrap().to_le_bytes());
    data[170..].copy_from_slice(extension_value);
    svm.set_account(
        mint_key,
        Account {
            lamports: 1_000_000,
            data,
            owner: spl_token_2022_interface::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

pub fn add_token_account(svm: &mut LiteSVM, key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
    add_token_account_for_program(svm, key, mint, owner, amount, TOKEN_PROGRAM_ID);
}

pub fn add_token_account_for_program(
    svm: &mut LiteSVM,
    key: Pubkey,
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    program_id: Pubkey,
) {
    add_token_account_for_program_with_state(
        svm,
        key,
        mint,
        owner,
        amount,
        program_id,
        AccountState::Initialized,
    );
}

#[allow(clippy::too_many_arguments)]
pub fn add_token_account_for_program_with_state(
    svm: &mut LiteSVM,
    key: Pubkey,
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    program_id: Pubkey,
    state: AccountState,
) {
    let token_account = SplTokenAccount {
        mint,
        owner,
        amount,
        delegate: solana_sdk::program_option::COption::None,
        state,
        is_native: solana_sdk::program_option::COption::None,
        delegated_amount: 0,
        close_authority: solana_sdk::program_option::COption::None,
    };
    let mut data = vec![0; SplTokenAccount::LEN];
    SplTokenAccount::pack(token_account, &mut data).unwrap();
    svm.set_account(
        key,
        Account {
            lamports: 1_000_000,
            data,
            owner: program_id,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

pub fn add_token_2022_account_with_extension(
    svm: &mut LiteSVM,
    key: Pubkey,
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    extension_type: ExtensionType,
) {
    const BASE_ACCOUNT_AND_TYPE_LENGTH: usize = 166;
    const TLV_HEADER_LENGTH: usize = 4;
    let account_length =
        ExtensionType::try_calculate_account_len::<Token2022Account>(&[extension_type]).unwrap();
    let extension_length = account_length - BASE_ACCOUNT_AND_TYPE_LENGTH - TLV_HEADER_LENGTH;
    let token_account = SplTokenAccount {
        mint,
        owner,
        amount,
        delegate: solana_sdk::program_option::COption::None,
        state: AccountState::Initialized,
        is_native: solana_sdk::program_option::COption::None,
        delegated_amount: 0,
        close_authority: solana_sdk::program_option::COption::None,
    };
    let mut data = vec![0; account_length];
    SplTokenAccount::pack(token_account, &mut data[..SplTokenAccount::LEN]).unwrap();
    data[165] = 2;
    data[166..168].copy_from_slice(&u16::from(extension_type).to_le_bytes());
    data[168..170].copy_from_slice(&u16::try_from(extension_length).unwrap().to_le_bytes());
    svm.set_account(
        key,
        Account {
            lamports: 1_000_000,
            data,
            owner: spl_token_2022_interface::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

pub fn token_amount(svm: &LiteSVM, key: &Pubkey) -> u64 {
    let account = svm.get_account(key).unwrap();
    SplTokenAccount::unpack(&account.data).unwrap().amount
}

pub fn market_address(operator: &Pubkey, quote_mint: &Pubkey, base_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"market",
            b"PythTwap",
            &[1; 32],
            quote_mint.as_ref(),
            base_mint.as_ref(),
            operator.as_ref(),
        ],
        &PROGRAM_ID,
    )
    .0
}

pub fn series_address(market: &Pubkey, marker: u8, strike: u64, expiry: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            SERIES_SEED,
            market.as_ref(),
            &[marker],
            &expiry.to_le_bytes(),
            &strike.to_le_bytes(),
        ],
        &PROGRAM_ID,
    )
    .0
}

pub fn long_mint_address(market: &Pubkey, marker: u8, strike: u64, expiry: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            LONG_MINT_SEED,
            market.as_ref(),
            &[marker],
            &expiry.to_le_bytes(),
            &strike.to_le_bytes(),
        ],
        &PROGRAM_ID,
    )
    .0
}

pub fn seller_vault_address(
    market: &Pubkey,
    marker: u8,
    strike: u64,
    expiry: u64,
    seller: &Pubkey,
) -> Pubkey {
    Pubkey::find_program_address(
        &[
            SELLER_VAULT_SEED,
            market.as_ref(),
            &[marker],
            &expiry.to_le_bytes(),
            &strike.to_le_bytes(),
            seller.as_ref(),
        ],
        &PROGRAM_ID,
    )
    .0
}

pub fn new_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../../target/deploy/options.so"),
    )
    .unwrap();
    svm
}

pub fn create_market(
    svm: &mut LiteSVM,
    payer: &Keypair,
    operator: &Keypair,
    quote_mint: Pubkey,
    base_mint: Pubkey,
) -> Pubkey {
    let market = market_address(&operator.pubkey(), &quote_mint, &base_mint);
    let accounts = accounts::CreateMarket {
        payer: payer.pubkey(),
        operator: operator.pubkey(),
        quote_mint: quote_mint,
        base_mint: base_mint,
        market,
        quote_token_program: TOKEN_PROGRAM_ID,
        base_token_program: TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    let instruction = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::CreateMarket {
            oracle_config: OracleConfig::PythTwap { feed_id: [1; 32] },
            min_fee: 0,
            min_operational_fee_bps: 0,
            max_operational_fee_bps: 1_000,
        }
        .data(),
    };
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer, operator],
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction).unwrap();
    market
}

#[derive(Clone, Copy)]
pub struct UnderwriteAccounts {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub buyer_quote_source: Pubkey,
    pub seller_collateral_source: Pubkey,
    pub fee_recipient: Pubkey,
}

pub fn underwrite_instruction(
    is_call: bool,
    terms: (Pubkey, Pubkey, Pubkey, u8, u64, u64),
    participants: UnderwriteAccounts,
    quantity_e18: u128,
    premium_e18: u128,
    fee_bps: u16,
) -> Instruction {
    let (market, quote_mint, base_mint, marker, strike, expiry) = terms;
    let series = series_address(&market, marker, strike, expiry);
    let long_mint = long_mint_address(&market, marker, strike, expiry);
    let account_metas = if is_call {
        accounts::UnderwriteCall {
            buyer: participants.buyer,
            seller: participants.seller,
            market,
            base_mint,
            quote_mint,
            series,
            long_mint,
            buyer_long_ata: get_associated_token_address(&participants.buyer, &long_mint),
            buyer_quote_source: participants.buyer_quote_source,
            seller_base_source: participants.seller_collateral_source,
            seller_quote_destination: get_associated_token_address(
                &participants.seller,
                &quote_mint,
            ),
            fee_recipient: participants.fee_recipient,
            fee_recipient_quote_ata: get_associated_token_address(
                &participants.fee_recipient,
                &quote_mint,
            ),
            seller_vault: seller_vault_address(
                &market,
                marker,
                strike,
                expiry,
                &participants.seller,
            ),
            base_collateral_vault: get_associated_token_address(&series, &base_mint),
            quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
            long_token_program: TOKEN_PROGRAM_ID,
            base_token_program: TOKEN_PROGRAM_ID,
            quote_token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None)
    } else {
        accounts::UnderwritePut {
            buyer: participants.buyer,
            seller: participants.seller,
            market,
            base_mint,
            quote_mint,
            series,
            long_mint,
            buyer_long_ata: get_associated_token_address(&participants.buyer, &long_mint),
            buyer_quote_source: participants.buyer_quote_source,
            seller_quote_account: participants.seller_collateral_source,
            fee_recipient: participants.fee_recipient,
            fee_recipient_quote_ata: get_associated_token_address(
                &participants.fee_recipient,
                &quote_mint,
            ),
            seller_vault: seller_vault_address(
                &market,
                marker,
                strike,
                expiry,
                &participants.seller,
            ),
            quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
            base_collateral_vault: get_associated_token_address(&series, &base_mint),
            long_token_program: TOKEN_PROGRAM_ID,
            base_token_program: TOKEN_PROGRAM_ID,
            quote_token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None)
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: if is_call {
            instruction::UnderwriteCallE18 {
                expiry_ms: expiry,
                strike_price_e8: strike,
                quantity_e18,
                premium_e18,
                operational_fee_bps: fee_bps,
            }
            .data()
        } else {
            instruction::UnderwritePutE18 {
                expiry_ms: expiry,
                strike_price_e8: strike,
                quantity_e18,
                premium_e18,
                operational_fee_bps: fee_bps,
            }
            .data()
        },
    }
}
