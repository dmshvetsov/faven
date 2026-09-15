use anchor_lang::{AccountDeserialize, AccountSerialize, Event, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::{
        get_associated_token_address, get_associated_token_address_with_program_id,
        ID as ASSOCIATED_TOKEN_PROGRAM_ID,
    },
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use litesvm::LiteSVM;
use options::{
    accounts,
    events::SeriesCreated,
    instruction,
    state::{SellerVault, Series, LONG_MINT_SEED, SELLER_VAULT_SEED, SERIES_SEED},
    OptionType, OracleConfig, ID as PROGRAM_ID,
};
use solana_program_pack::Pack;
use solana_sdk::{
    account::Account,
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::Transaction,
};
use spl_token::state::{Account as SplTokenAccount, AccountState, Mint};
use spl_token_2022_interface::{
    extension::{ExtensionType, StateWithExtensions},
    state::{Account as Token2022Account, Mint as Token2022Mint},
};

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
const EXPIRY_MS: u64 = 2_000_000_000_000;
const ONE_OPTION_E18: u128 = 1_000_000_000_000_000_000;
const ONE_QUOTE_E18: u128 = 1_000_000_000_000_000_000;
const FIRST_UNDERWRITE_COMPUTE_UNITS: u32 = 400_000;

fn first_underwrite_compute_budget() -> Instruction {
    let mut data = vec![2];
    data.extend_from_slice(&FIRST_UNDERWRITE_COMPUTE_UNITS.to_le_bytes());
    Instruction {
        program_id: solana_sdk::pubkey!("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

fn deterministic_bytes(value: u32) -> [u8; 32] {
    let mut bytes = [0; 32];
    bytes[..4].copy_from_slice(&value.to_le_bytes());
    bytes
}

fn add_mint(svm: &mut LiteSVM, mint_key: Pubkey, decimals: u8) {
    add_mint_for_program(svm, mint_key, decimals, TOKEN_PROGRAM_ID);
}

fn add_mint_for_program(svm: &mut LiteSVM, mint_key: Pubkey, decimals: u8, program_id: Pubkey) {
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

fn add_token_2022_mint_with_extension(
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

fn add_token_account(svm: &mut LiteSVM, key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
    add_token_account_for_program(svm, key, mint, owner, amount, TOKEN_PROGRAM_ID);
}

fn add_token_account_for_program(
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
fn add_token_account_for_program_with_state(
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

fn add_token_2022_account_with_extension(
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

#[derive(Clone, Copy)]
struct InterfaceUnderwriteCallAccounts {
    buyer: Pubkey,
    seller: Pubkey,
    market: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    series: Pubkey,
    long_mint: Pubkey,
    buyer_long_ata: Pubkey,
    buyer_quote_source: Pubkey,
    seller_base_source: Pubkey,
    seller_quote_destination: Pubkey,
    fee_recipient: Pubkey,
    fee_recipient_quote_ata: Pubkey,
    seller_vault: Pubkey,
    base_collateral_vault: Pubkey,
    quote_collateral_vault: Pubkey,
    base_token_program: Pubkey,
    quote_token_program: Pubkey,
}

fn interface_underwrite_call_instruction(
    accounts: InterfaceUnderwriteCallAccounts,
    strike: u64,
) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(accounts.buyer, true),
            AccountMeta::new(accounts.seller, true),
            AccountMeta::new_readonly(accounts.market, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(accounts.base_token_program, false),
            AccountMeta::new_readonly(accounts.quote_token_program, false),
            AccountMeta::new_readonly(accounts.base_mint, false),
            AccountMeta::new_readonly(accounts.quote_mint, false),
            AccountMeta::new(accounts.series, false),
            AccountMeta::new(accounts.long_mint, false),
            AccountMeta::new(accounts.buyer_long_ata, false),
            AccountMeta::new(accounts.buyer_quote_source, false),
            AccountMeta::new(accounts.seller_base_source, false),
            AccountMeta::new(accounts.seller_quote_destination, false),
            AccountMeta::new_readonly(accounts.fee_recipient, false),
            AccountMeta::new(accounts.fee_recipient_quote_ata, false),
            AccountMeta::new(accounts.seller_vault, false),
            AccountMeta::new(accounts.base_collateral_vault, false),
            AccountMeta::new(accounts.quote_collateral_vault, false),
            AccountMeta::new_readonly(ASSOCIATED_TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        data: instruction::UnderwriteCallE18 {
            expiry_ms: EXPIRY_MS,
            strike_price_e8: strike,
            quantity_e18: ONE_OPTION_E18,
            premium_e18: ONE_QUOTE_E18,
            operational_fee_bps: 0,
        }
        .data(),
    }
}

fn assert_call_series_token_program_pair(base_token_program: Pubkey, quote_token_program: Pubkey) {
    assert_call_series_with_supplied_token_programs(
        base_token_program,
        quote_token_program,
        base_token_program,
        quote_token_program,
        None,
    );
}

fn assert_call_series_with_supplied_token_programs(
    base_token_program: Pubkey,
    quote_token_program: Pubkey,
    supplied_base_token_program: Pubkey,
    supplied_quote_token_program: Pubkey,
    expected_error: Option<&str>,
) {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    let fee_recipient = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    for wallet in [&payer, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint_for_program(&mut svm, quote_mint, 6, quote_token_program);
    add_mint_for_program(&mut svm, base_mint, 9, base_token_program);
    let market = market_address(&operator.pubkey(), &quote_mint, &base_mint);
    let create_market = accounts::CreateMarket {
        payer: payer.pubkey(),
        operator: operator.pubkey(),
        quote_mint,
        base_mint,
        market,
        quote_token_program,
        base_token_program,
        system_program: anchor_lang::system_program::ID,
    };
    let create_market = Instruction {
        program_id: PROGRAM_ID,
        accounts: create_market.to_account_metas(None),
        data: instruction::CreateMarket {
            oracle_config: OracleConfig::PythTwap { feed_id: [1; 32] },
            min_fee: 0,
            min_operational_fee_bps: 0,
            max_operational_fee_bps: 1_000,
        }
        .data(),
    };
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[create_market],
        Some(&payer.pubkey()),
        &[&payer, &operator],
        svm.latest_blockhash(),
    ))
    .unwrap();

    let buyer_quote_source = Pubkey::new_unique();
    let seller_base_source = Pubkey::new_unique();
    add_token_account_for_program(
        &mut svm,
        buyer_quote_source,
        quote_mint,
        buyer.pubkey(),
        1_000_000,
        quote_token_program,
    );
    add_token_account_for_program(
        &mut svm,
        seller_base_source,
        base_mint,
        seller.pubkey(),
        1_000_000_000,
        base_token_program,
    );
    let seller_quote_destination = get_associated_token_address_with_program_id(
        &seller.pubkey(),
        &quote_mint,
        &quote_token_program,
    );
    add_token_account_for_program(
        &mut svm,
        seller_quote_destination,
        quote_mint,
        seller.pubkey(),
        0,
        quote_token_program,
    );

    let strike = 350_000_000;
    let series = series_address(&market, OptionType::Call.marker(), strike, EXPIRY_MS);
    let long_mint = long_mint_address(&market, OptionType::Call.marker(), strike, EXPIRY_MS);
    let buyer_long_ata = get_associated_token_address(&buyer.pubkey(), &long_mint);
    let base_collateral_vault = get_associated_token_address_with_program_id(
        &series,
        &base_mint,
        &supplied_base_token_program,
    );
    let quote_collateral_vault = get_associated_token_address_with_program_id(
        &series,
        &quote_mint,
        &supplied_quote_token_program,
    );
    let fee_recipient_quote_ata = get_associated_token_address_with_program_id(
        &fee_recipient,
        &quote_mint,
        &quote_token_program,
    );
    let seller_vault = seller_vault_address(
        &market,
        OptionType::Call.marker(),
        strike,
        EXPIRY_MS,
        &seller.pubkey(),
    );
    if supplied_base_token_program != base_token_program {
        add_token_account_for_program(
            &mut svm,
            base_collateral_vault,
            base_mint,
            series,
            0,
            supplied_base_token_program,
        );
        let mut collateral = svm.get_account(&base_collateral_vault).unwrap();
        collateral.lamports = 10_000_000;
        svm.set_account(base_collateral_vault, collateral).unwrap();
    }
    let underwrite = interface_underwrite_call_instruction(
        InterfaceUnderwriteCallAccounts {
            buyer: buyer.pubkey(),
            seller: seller.pubkey(),
            market,
            base_mint,
            quote_mint,
            series,
            long_mint,
            buyer_long_ata,
            buyer_quote_source,
            seller_base_source,
            seller_quote_destination,
            fee_recipient,
            fee_recipient_quote_ata,
            seller_vault,
            base_collateral_vault,
            quote_collateral_vault,
            base_token_program: supplied_base_token_program,
            quote_token_program: supplied_quote_token_program,
        },
        strike,
    );
    let result = svm.send_transaction(Transaction::new_signed_with_payer(
        &[first_underwrite_compute_budget(), underwrite],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    ));
    if let Some(expected_error) = expected_error {
        let error = result.unwrap_err();
        assert!(
            error
                .meta
                .logs
                .iter()
                .any(|log| log.contains(expected_error)),
            "{error:?}"
        );
        return;
    }
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(svm.get_account(&long_mint).unwrap().owner, TOKEN_PROGRAM_ID);
    assert_eq!(
        svm.get_account(&buyer_long_ata).unwrap().owner,
        TOKEN_PROGRAM_ID
    );
    assert_eq!(token_amount(&svm, &buyer_long_ata), 1_000_000_000);
    let series_account = svm.get_account(&series).unwrap();
    let created_series = Series::try_deserialize(&mut series_account.data.as_slice()).unwrap();
    assert_eq!(created_series.option_type, OptionType::Call);
    assert_eq!(created_series.total_contracts_quantity, 1_000_000_000);
    let collateral = svm.get_account(&base_collateral_vault).unwrap();
    assert_eq!(collateral.owner, base_token_program);
    let collateral_amount = if base_token_program == spl_token_2022_interface::id() {
        StateWithExtensions::<Token2022Account>::unpack(&collateral.data)
            .unwrap()
            .base
            .amount
    } else {
        SplTokenAccount::unpack(&collateral.data).unwrap().amount
    };
    assert_eq!(collateral_amount, 1_000_000_000);
}

#[test]
fn buyer_and_seller_can_create_a_call_series_with_token_2022_base_coin() {
    assert_call_series_token_program_pair(spl_token_2022_interface::id(), TOKEN_PROGRAM_ID);
}

#[test]
fn buyer_and_seller_can_create_call_series_for_the_other_token_program_pairs() {
    let token_2022_program = spl_token_2022_interface::id();
    for (base_token_program, quote_token_program) in [
        (TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID),
        (TOKEN_PROGRAM_ID, token_2022_program),
        (token_2022_program, token_2022_program),
    ] {
        assert_call_series_token_program_pair(base_token_program, quote_token_program);
    }
}

#[test]
fn underwriting_rejects_a_mint_paired_with_the_wrong_token_program() {
    assert_call_series_with_supplied_token_programs(
        spl_token_2022_interface::id(),
        TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        Some("InvalidMintTokenProgram"),
    );
}

#[derive(Clone, Copy)]
enum Token2022BaseFailure {
    FrozenDefault,
    FrozenAccount,
    PausedMint,
    UnsupportedAccountExtension(ExtensionType),
}

fn assert_token_2022_base_underwriting_failure(case: Token2022BaseFailure) {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    let fee_recipient = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    let token_2022_program = spl_token_2022_interface::id();
    for wallet in [&payer, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint(&mut svm, quote_mint, 6);
    match case {
        Token2022BaseFailure::FrozenDefault => add_token_2022_mint_with_extension(
            &mut svm,
            base_mint,
            9,
            ExtensionType::DefaultAccountState,
            &[AccountState::Initialized as u8],
        ),
        Token2022BaseFailure::PausedMint => add_token_2022_mint_with_extension(
            &mut svm,
            base_mint,
            9,
            ExtensionType::Pausable,
            &[0; 33],
        ),
        _ => add_mint_for_program(&mut svm, base_mint, 9, token_2022_program),
    }
    let market = market_address(&operator.pubkey(), &quote_mint, &base_mint);
    let create_market = accounts::CreateMarket {
        payer: payer.pubkey(),
        operator: operator.pubkey(),
        quote_mint,
        base_mint,
        market,
        quote_token_program: TOKEN_PROGRAM_ID,
        base_token_program: token_2022_program,
        system_program: anchor_lang::system_program::ID,
    };
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[Instruction {
            program_id: PROGRAM_ID,
            accounts: create_market.to_account_metas(None),
            data: instruction::CreateMarket {
                oracle_config: OracleConfig::PythTwap { feed_id: [1; 32] },
                min_fee: 0,
                min_operational_fee_bps: 0,
                max_operational_fee_bps: 1_000,
            }
            .data(),
        }],
        Some(&payer.pubkey()),
        &[&payer, &operator],
        svm.latest_blockhash(),
    ))
    .unwrap();
    if matches!(case, Token2022BaseFailure::FrozenDefault) {
        let mut mint = svm.get_account(&base_mint).unwrap();
        mint.data[170] = AccountState::Frozen as u8;
        svm.set_account(base_mint, mint).unwrap();
    } else if matches!(case, Token2022BaseFailure::PausedMint) {
        let mut mint = svm.get_account(&base_mint).unwrap();
        mint.data[202] = 1;
        svm.set_account(base_mint, mint).unwrap();
    }

    let buyer_quote_source = Pubkey::new_unique();
    let seller_base_source = Pubkey::new_unique();
    add_token_account(
        &mut svm,
        buyer_quote_source,
        quote_mint,
        buyer.pubkey(),
        1_000_000,
    );
    match case {
        Token2022BaseFailure::UnsupportedAccountExtension(extension_type) => {
            add_token_2022_account_with_extension(
                &mut svm,
                seller_base_source,
                base_mint,
                seller.pubkey(),
                1_000_000_000,
                extension_type,
            );
        }
        Token2022BaseFailure::FrozenDefault | Token2022BaseFailure::PausedMint => {
            add_token_account_for_program(
                &mut svm,
                seller_base_source,
                base_mint,
                seller.pubkey(),
                1_000_000_000,
                token_2022_program,
            )
        }
        Token2022BaseFailure::FrozenAccount => add_token_account_for_program_with_state(
            &mut svm,
            seller_base_source,
            base_mint,
            seller.pubkey(),
            1_000_000_000,
            token_2022_program,
            AccountState::Frozen,
        ),
    }
    let seller_quote_destination = get_associated_token_address(&seller.pubkey(), &quote_mint);
    add_token_account(
        &mut svm,
        seller_quote_destination,
        quote_mint,
        seller.pubkey(),
        0,
    );
    let strike = 350_000_000;
    let series = series_address(&market, OptionType::Call.marker(), strike, EXPIRY_MS);
    let long_mint = long_mint_address(&market, OptionType::Call.marker(), strike, EXPIRY_MS);
    let underwrite = interface_underwrite_call_instruction(
        InterfaceUnderwriteCallAccounts {
            buyer: buyer.pubkey(),
            seller: seller.pubkey(),
            market,
            base_mint,
            quote_mint,
            series,
            long_mint,
            buyer_long_ata: get_associated_token_address(&buyer.pubkey(), &long_mint),
            buyer_quote_source,
            seller_base_source,
            seller_quote_destination,
            fee_recipient,
            fee_recipient_quote_ata: get_associated_token_address(&fee_recipient, &quote_mint),
            seller_vault: seller_vault_address(
                &market,
                OptionType::Call.marker(),
                strike,
                EXPIRY_MS,
                &seller.pubkey(),
            ),
            base_collateral_vault: get_associated_token_address_with_program_id(
                &series,
                &base_mint,
                &token_2022_program,
            ),
            quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
            base_token_program: token_2022_program,
            quote_token_program: TOKEN_PROGRAM_ID,
        },
        strike,
    );
    let error = svm
        .send_transaction(Transaction::new_signed_with_payer(
            &[first_underwrite_compute_budget(), underwrite],
            Some(&buyer.pubkey()),
            &[&buyer, &seller],
            svm.latest_blockhash(),
        ))
        .unwrap_err();
    let expected_error = match case {
        Token2022BaseFailure::FrozenDefault
        | Token2022BaseFailure::FrozenAccount
        | Token2022BaseFailure::PausedMint => "OperationBlockedByMintIssuer",
        Token2022BaseFailure::UnsupportedAccountExtension(_) => "UnsupportedTokenAccountExtension",
    };
    assert!(
        error
            .meta
            .logs
            .iter()
            .any(|log| log.contains(expected_error)),
        "{error:?}"
    );
}

#[test]
fn underwriting_created_series_rechecks_frozen_default_account_state() {
    assert_token_2022_base_underwriting_failure(Token2022BaseFailure::FrozenDefault);
}

#[test]
fn underwriting_reports_an_issuer_frozen_required_account() {
    assert_token_2022_base_underwriting_failure(Token2022BaseFailure::FrozenAccount);
}

#[test]
fn underwriting_reports_an_issuer_paused_mint() {
    assert_token_2022_base_underwriting_failure(Token2022BaseFailure::PausedMint);
}

#[test]
fn underwriting_rejects_unsupported_token_2022_account_extensions() {
    for extension_type in [
        ExtensionType::CpiGuard,
        ExtensionType::ConfidentialTransferAccount,
        ExtensionType::MemoTransfer,
        ExtensionType::TransferFeeAmount,
    ] {
        assert_token_2022_base_underwriting_failure(
            Token2022BaseFailure::UnsupportedAccountExtension(extension_type),
        );
    }
}

fn token_amount(svm: &LiteSVM, key: &Pubkey) -> u64 {
    let account = svm.get_account(key).unwrap();
    SplTokenAccount::unpack(&account.data).unwrap().amount
}

fn market_address(operator: &Pubkey, quote_mint: &Pubkey, base_mint: &Pubkey) -> Pubkey {
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

fn series_address(market: &Pubkey, marker: u8, strike: u64, expiry: u64) -> Pubkey {
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

fn long_mint_address(market: &Pubkey, marker: u8, strike: u64, expiry: u64) -> Pubkey {
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

fn seller_vault_address(
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

fn new_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();
    svm
}

fn create_market(
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
struct UnderwriteAccounts {
    buyer: Pubkey,
    seller: Pubkey,
    buyer_quote_source: Pubkey,
    seller_collateral_source: Pubkey,
    fee_recipient: Pubkey,
}

fn underwrite_instruction(
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

#[test]
fn buyer_and_seller_can_create_and_reuse_a_call_series_while_underwriting() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    let fee_recipient = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    for wallet in [&payer, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
    let strike = 350_000_000;
    let buyer_quote_source = Pubkey::new_unique();
    let seller_base_source = Pubkey::new_unique();
    add_token_account(
        &mut svm,
        buyer_quote_source,
        quote_mint,
        buyer.pubkey(),
        2_000_000,
    );
    add_token_account(
        &mut svm,
        seller_base_source,
        base_mint,
        seller.pubkey(),
        2_000_000_000,
    );
    add_token_account(
        &mut svm,
        get_associated_token_address(&seller.pubkey(), &quote_mint),
        quote_mint,
        seller.pubkey(),
        0,
    );
    let participants = UnderwriteAccounts {
        buyer: buyer.pubkey(),
        seller: seller.pubkey(),
        buyer_quote_source,
        seller_collateral_source: seller_base_source,
        fee_recipient,
    };
    let terms = (market, quote_mint, base_mint, 1, strike, EXPIRY_MS);
    let series = series_address(&market, 1, strike, EXPIRY_MS);
    let expected_created_log = format!(
        "Program data: {}",
        STANDARD.encode(
            SeriesCreated {
                series,
                market,
                option_type: OptionType::Call,
                strike_price: strike,
                expiry_ms: EXPIRY_MS,
            }
            .data()
        )
    );
    for underwriting_index in 0..2 {
        let underwrite = underwrite_instruction(
            true,
            terms,
            UnderwriteAccounts { ..participants },
            ONE_OPTION_E18,
            ONE_QUOTE_E18,
            500,
        );
        let instructions = if underwriting_index == 0 {
            vec![first_underwrite_compute_budget(), underwrite]
        } else {
            vec![underwrite]
        };
        let transaction = Transaction::new_signed_with_payer(
            &instructions,
            Some(&buyer.pubkey()),
            &[&buyer, &seller],
            svm.latest_blockhash(),
        );
        let result = svm.send_transaction(transaction);
        assert!(result.is_ok(), "{result:?}");
        let result = result.unwrap();
        if underwriting_index == 0 {
            assert!(
                result.compute_units_consumed <= u64::from(FIRST_UNDERWRITE_COMPUTE_UNITS),
                "first underwriting consumed {} compute units",
                result.compute_units_consumed
            );
        }
        let emitted_series_created = result.logs.iter().any(|log| log == &expected_created_log);
        assert_eq!(emitted_series_created, underwriting_index == 0);
        svm.expire_blockhash();
    }

    let long_mint = long_mint_address(&market, 1, strike, EXPIRY_MS);
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&buyer.pubkey(), &long_mint)
        ),
        2_000_000_000
    );
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&seller.pubkey(), &quote_mint)
        ),
        1_900_000
    );
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&fee_recipient, &quote_mint)
        ),
        100_000
    );
    assert_eq!(
        token_amount(&svm, &get_associated_token_address(&series, &base_mint)),
        2_000_000_000
    );
    let quote_vault = svm
        .get_account(&get_associated_token_address(&series, &quote_mint))
        .expect("fresh call series must initialize its quote collateral vault");
    let quote_vault = SplTokenAccount::unpack(&quote_vault.data).unwrap();
    assert_eq!(quote_vault.mint, quote_mint);
    assert_eq!(quote_vault.owner, series);
    assert_eq!(quote_vault.amount, 0);
    let seller_vault = svm
        .get_account(&seller_vault_address(
            &market,
            1,
            strike,
            EXPIRY_MS,
            &seller.pubkey(),
        ))
        .unwrap();
    let seller_vault = SellerVault::try_deserialize(&mut seller_vault.data.as_slice()).unwrap();
    assert_eq!(seller_vault.short_quantity, 2_000_000_000);
    assert_eq!(seller_vault.collateral_quantity, 2_000_000_000);
    let series_account = svm.get_account(&series).unwrap();
    let series = Series::try_deserialize(&mut series_account.data.as_slice()).unwrap();
    assert_eq!(series.total_contracts_quantity, 2_000_000_000);
}

#[test]
fn underwriting_rejects_a_seller_vault_with_invalid_owner_or_series() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    let fee_recipient = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    for wallet in [&payer, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
    let strike = 350_000_000;
    let buyer_quote_source = Pubkey::new_unique();
    let seller_base_source = Pubkey::new_unique();
    add_token_account(
        &mut svm,
        buyer_quote_source,
        quote_mint,
        buyer.pubkey(),
        1_000_000,
    );
    add_token_account(
        &mut svm,
        seller_base_source,
        base_mint,
        seller.pubkey(),
        1_000_000_000,
    );
    add_token_account(
        &mut svm,
        get_associated_token_address(&seller.pubkey(), &quote_mint),
        quote_mint,
        seller.pubkey(),
        0,
    );
    let series = series_address(&market, 1, strike, EXPIRY_MS);
    let seller_vault = seller_vault_address(&market, 1, strike, EXPIRY_MS, &seller.pubkey());
    let mut seller_vault_data = Vec::new();
    SellerVault {
        owner: Pubkey::new_unique(),
        series,
        short_quantity: 0,
        collateral_quantity: 0,
    }
    .try_serialize(&mut seller_vault_data)
    .unwrap();
    svm.set_account(
        seller_vault,
        Account {
            lamports: 1_000_000,
            data: seller_vault_data,
            owner: PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let transaction = Transaction::new_signed_with_payer(
        &[underwrite_instruction(
            true,
            (market, quote_mint, base_mint, 1, strike, EXPIRY_MS),
            UnderwriteAccounts {
                buyer: buyer.pubkey(),
                seller: seller.pubkey(),
                buyer_quote_source,
                seller_collateral_source: seller_base_source,
                fee_recipient,
            },
            ONE_OPTION_E18,
            0,
            0,
        )],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_err());
}

#[test]
fn buyer_and_seller_can_create_a_put_series_while_underwriting() {
    let mut svm = new_svm();
    let payer = Keypair::new_from_array(deterministic_bytes(95_650));
    let operator = Keypair::new_from_array(deterministic_bytes(95_651));
    let buyer = Keypair::new_from_array(deterministic_bytes(195_651));
    let seller = Keypair::new_from_array(deterministic_bytes(295_651));
    let fee_recipient = Pubkey::new_from_array(deterministic_bytes(395_651));
    let quote_mint = Pubkey::new_from_array(deterministic_bytes(495_651));
    let base_mint = Pubkey::new_from_array(deterministic_bytes(595_651));
    for wallet in [&payer, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
    let strike = 350_000_000;
    let buyer_quote_source = Pubkey::new_unique();
    let seller_quote_source = Pubkey::new_unique();
    add_token_account(
        &mut svm,
        buyer_quote_source,
        quote_mint,
        buyer.pubkey(),
        1_000_000,
    );
    add_token_account(
        &mut svm,
        seller_quote_source,
        quote_mint,
        seller.pubkey(),
        3_500_000,
    );
    let transaction = Transaction::new_signed_with_payer(
        &[
            first_underwrite_compute_budget(),
            underwrite_instruction(
                false,
                (market, quote_mint, base_mint, 2, strike, EXPIRY_MS),
                UnderwriteAccounts {
                    buyer: buyer.pubkey(),
                    seller: seller.pubkey(),
                    buyer_quote_source,
                    seller_collateral_source: seller_quote_source,
                    fee_recipient,
                },
                ONE_OPTION_E18,
                ONE_QUOTE_E18,
                0,
            ),
        ],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    let result = svm.send_transaction(transaction);
    assert!(result.is_ok(), "{result:?}");
    let compute_units_consumed = result.unwrap().compute_units_consumed;
    assert!(
        compute_units_consumed > 200_000,
        "first underwriting consumed {compute_units_consumed} compute units"
    );
    assert!(
        compute_units_consumed <= u64::from(FIRST_UNDERWRITE_COMPUTE_UNITS),
        "first underwriting consumed {compute_units_consumed} compute units"
    );

    let series = series_address(&market, 2, strike, EXPIRY_MS);
    assert_eq!(
        token_amount(&svm, &get_associated_token_address(&series, &quote_mint)),
        3_500_000
    );
    let base_vault = svm
        .get_account(&get_associated_token_address(&series, &base_mint))
        .expect("fresh put series must initialize its base collateral vault");
    let base_vault = SplTokenAccount::unpack(&base_vault.data).unwrap();
    assert_eq!(base_vault.mint, base_mint);
    assert_eq!(base_vault.owner, series);
    assert_eq!(base_vault.amount, 0);
    assert_eq!(token_amount(&svm, &seller_quote_source), 1_000_000);
}

fn finalize_unverified_instruction(
    operator: Pubkey,
    market: Pubkey,
    series: Pubkey,
    quote_collateral_vault: Pubkey,
    price: u64,
) -> Instruction {
    let accounts = accounts::FinalizePythUnverifiedSeries { operator, market };
    let mut account_metas = accounts.to_account_metas(None);
    account_metas.push(AccountMeta::new(series, false));
    account_metas.push(AccountMeta::new_readonly(quote_collateral_vault, false));
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: instruction::FinalizePythUnverifiedSeries {
            id: [1; 32],
            price: i64::try_from(price).unwrap(),
            conf: 0,
            expo: -8,
            publish_time: 0,
        }
        .data(),
    }
}

fn exercise_instruction(
    is_call: bool,
    buyer: Pubkey,
    market: Pubkey,
    series: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    long_mint: Pubkey,
    buyer_long_ata: Pubkey,
    buyer_payment_source: Pubkey,
) -> Instruction {
    let accounts = accounts::Exercise {
        holder: buyer,
        market,
        base_mint,
        quote_mint,
        series,
        long_mint,
        holder_long_source: buyer_long_ata,
        holder_payment_source: buyer_payment_source,
        holder_receipt_ata: get_associated_token_address(
            &buyer,
            if is_call { &base_mint } else { &quote_mint },
        ),
        base_collateral_vault: get_associated_token_address(&series, &base_mint),
        quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::ExerciseE18 {
            quantity_e18: ONE_OPTION_E18,
        }
        .data(),
    }
}

fn settle_instruction(
    settler: Pubkey,
    market: Pubkey,
    series: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    seller_vault: Pubkey,
    seller_base_ata: Option<Pubkey>,
    seller_quote_ata: Option<Pubkey>,
) -> Instruction {
    let accounts = accounts::SettleSellersBatch {
        settler,
        market,
        base_mint,
        quote_mint,
        series,
        base_collateral_vault: get_associated_token_address(&series, &base_mint),
        quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    let mut account_metas = accounts.to_account_metas(None);
    account_metas.push(AccountMeta::new(seller_vault, false));
    if let Some(seller_base_ata) = seller_base_ata {
        account_metas.push(AccountMeta::new(seller_base_ata, false));
    }
    if let Some(seller_quote_ata) = seller_quote_ata {
        account_metas.push(AccountMeta::new(seller_quote_ata, false));
    }
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: instruction::SettleSellersBatch {}.data(),
    }
}

fn close_series_instruction(
    series_closer: Pubkey,
    market: Pubkey,
    market_operator: Pubkey,
    series: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
) -> Instruction {
    let accounts = accounts::CloseSeries {
        series_closer,
        market,
        market_operator,
        base_mint,
        quote_mint,
        series,
        base_collateral_vault: get_associated_token_address(&series, &base_mint),
        quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::CloseSeries {}.data(),
    }
}

fn assert_fresh_series_lifecycle(is_call: bool, exercise: bool) {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    let fee_recipient = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    for wallet in [&payer, &operator, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
    let strike = 350_000_000;
    let marker = if is_call { 1 } else { 2 };
    let series = series_address(&market, marker, strike, EXPIRY_MS);
    let long_mint = long_mint_address(&market, marker, strike, EXPIRY_MS);
    let buyer_quote_ata = get_associated_token_address(&buyer.pubkey(), &quote_mint);
    let buyer_base_ata = get_associated_token_address(&buyer.pubkey(), &base_mint);
    let seller_base_ata = get_associated_token_address(&seller.pubkey(), &base_mint);
    let seller_quote_ata = get_associated_token_address(&seller.pubkey(), &quote_mint);
    add_token_account(
        &mut svm,
        buyer_quote_ata,
        quote_mint,
        buyer.pubkey(),
        10_000_000,
    );
    add_token_account(
        &mut svm,
        buyer_base_ata,
        base_mint,
        buyer.pubkey(),
        1_000_000_000,
    );
    add_token_account(
        &mut svm,
        seller_base_ata,
        base_mint,
        seller.pubkey(),
        if is_call { 1_000_000_000 } else { 0 },
    );
    add_token_account(
        &mut svm,
        seller_quote_ata,
        quote_mint,
        seller.pubkey(),
        if is_call { 0 } else { 3_500_000 },
    );
    let participants = UnderwriteAccounts {
        buyer: buyer.pubkey(),
        seller: seller.pubkey(),
        buyer_quote_source: buyer_quote_ata,
        seller_collateral_source: if is_call {
            seller_base_ata
        } else {
            seller_quote_ata
        },
        fee_recipient,
    };
    let underwrite = underwrite_instruction(
        is_call,
        (market, quote_mint, base_mint, marker, strike, EXPIRY_MS),
        participants,
        ONE_OPTION_E18,
        0,
        0,
    );
    let transaction = Transaction::new_signed_with_payer(
        &[first_underwrite_compute_budget(), underwrite],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction).unwrap();
    assert!(svm
        .get_account(&get_associated_token_address(&series, &base_mint))
        .is_some());
    assert!(svm
        .get_account(&get_associated_token_address(&series, &quote_mint))
        .is_some());

    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000).unwrap();
    svm.set_sysvar(&clock);
    let price = if exercise {
        if is_call {
            strike + 1
        } else {
            strike - 1
        }
    } else {
        strike
    };
    let transaction = Transaction::new_signed_with_payer(
        &[finalize_unverified_instruction(
            operator.pubkey(),
            market,
            series,
            get_associated_token_address(&series, &quote_mint),
            price,
        )],
        Some(&operator.pubkey()),
        &[&operator],
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction).unwrap();

    if exercise {
        let transaction = Transaction::new_signed_with_payer(
            &[exercise_instruction(
                is_call,
                buyer.pubkey(),
                market,
                series,
                base_mint,
                quote_mint,
                long_mint,
                get_associated_token_address(&buyer.pubkey(), &long_mint),
                if is_call {
                    buyer_quote_ata
                } else {
                    buyer_base_ata
                },
            )],
            Some(&buyer.pubkey()),
            &[&buyer],
            svm.latest_blockhash(),
        );
        svm.send_transaction(transaction).unwrap();
    }

    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from((EXPIRY_MS + 3_600_000) / 1_000).unwrap();
    svm.set_sysvar(&clock);
    let seller_vault = seller_vault_address(&market, marker, strike, EXPIRY_MS, &seller.pubkey());
    let (seller_base_payout, seller_quote_payout) = if exercise {
        if is_call {
            (None, Some(seller_quote_ata))
        } else {
            (Some(seller_base_ata), None)
        }
    } else if is_call {
        (Some(seller_base_ata), None)
    } else {
        (None, Some(seller_quote_ata))
    };
    let transaction = Transaction::new_signed_with_payer(
        &[settle_instruction(
            payer.pubkey(),
            market,
            series,
            base_mint,
            quote_mint,
            seller_vault,
            seller_base_payout,
            seller_quote_payout,
        )],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction).unwrap();
    if exercise {
        if is_call {
            assert_eq!(token_amount(&svm, &seller_base_ata), 0);
            assert_eq!(token_amount(&svm, &seller_quote_ata), 3_500_000);
        } else {
            assert_eq!(token_amount(&svm, &seller_base_ata), 1_000_000_000);
            assert_eq!(token_amount(&svm, &seller_quote_ata), 0);
        }
    } else if is_call {
        assert_eq!(token_amount(&svm, &seller_base_ata), 1_000_000_000);
    } else {
        assert_eq!(token_amount(&svm, &seller_quote_ata), 3_500_000);
    }
    let transaction = Transaction::new_signed_with_payer(
        &[close_series_instruction(
            payer.pubkey(),
            market,
            operator.pubkey(),
            series,
            base_mint,
            quote_mint,
        )],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction).unwrap();
    assert!(svm.get_account(&series).is_none());
    assert!(svm
        .get_account(&get_associated_token_address(&series, &base_mint))
        .is_none());
    assert!(svm
        .get_account(&get_associated_token_address(&series, &quote_mint))
        .is_none());
}

#[test]
fn fresh_call_and_put_series_settle_without_exercise_and_close() {
    assert_fresh_series_lifecycle(true, false);
    assert_fresh_series_lifecycle(false, false);
}

#[test]
fn fresh_call_and_put_series_exercise_settle_and_close() {
    assert_fresh_series_lifecycle(true, true);
    assert_fresh_series_lifecycle(false, true);
}

#[test]
fn underwriting_rejects_invalid_inputs_and_allows_zero_premium_without_a_fee() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    let fee_recipient = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    for wallet in [&payer, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
    let strike = 350_000_000;
    let buyer_quote_source = Pubkey::new_unique();
    let seller_base_source = Pubkey::new_unique();
    add_token_account(
        &mut svm,
        buyer_quote_source,
        quote_mint,
        buyer.pubkey(),
        1_000_000,
    );
    add_token_account(
        &mut svm,
        seller_base_source,
        base_mint,
        seller.pubkey(),
        2_000_000_000,
    );
    add_token_account(
        &mut svm,
        get_associated_token_address(&seller.pubkey(), &quote_mint),
        quote_mint,
        seller.pubkey(),
        0,
    );
    let terms = (market, quote_mint, base_mint, 1, strike, EXPIRY_MS);
    let participants = UnderwriteAccounts {
        buyer: buyer.pubkey(),
        seller: seller.pubkey(),
        buyer_quote_source,
        seller_collateral_source: seller_base_source,
        fee_recipient,
    };
    for (invalid_strike, invalid_expiry) in [(0, EXPIRY_MS), (strike, 1), (strike, EXPIRY_MS + 1)] {
        let transaction = Transaction::new_signed_with_payer(
            &[
                first_underwrite_compute_budget(),
                underwrite_instruction(
                    true,
                    (
                        market,
                        quote_mint,
                        base_mint,
                        1,
                        invalid_strike,
                        invalid_expiry,
                    ),
                    participants,
                    ONE_OPTION_E18,
                    0,
                    0,
                ),
            ],
            Some(&buyer.pubkey()),
            &[&buyer, &seller],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(transaction).is_err());
        svm.expire_blockhash();
    }
    for (quantity, fee_bps, source) in [
        (0, 0, seller_base_source),
        (ONE_OPTION_E18, 1_001, seller_base_source),
        (ONE_OPTION_E18, 0, buyer_quote_source),
    ] {
        let transaction = Transaction::new_signed_with_payer(
            &[
                first_underwrite_compute_budget(),
                underwrite_instruction(
                    true,
                    terms,
                    UnderwriteAccounts {
                        seller_collateral_source: source,
                        ..participants
                    },
                    quantity,
                    0,
                    fee_bps,
                ),
            ],
            Some(&buyer.pubkey()),
            &[&buyer, &seller],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(transaction).is_err());
        svm.expire_blockhash();
    }
    let mut missing_buyer_signature = Transaction::new_with_payer(
        &[underwrite_instruction(
            true,
            terms,
            participants,
            ONE_OPTION_E18,
            0,
            0,
        )],
        Some(&seller.pubkey()),
    );
    missing_buyer_signature.partial_sign(&[&seller], svm.latest_blockhash());
    assert!(svm.send_transaction(missing_buyer_signature).is_err());
    svm.expire_blockhash();

    let zero_premium = Transaction::new_signed_with_payer(
        &[
            first_underwrite_compute_budget(),
            underwrite_instruction(true, terms, participants, ONE_OPTION_E18, 0, 0),
        ],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(zero_premium).is_ok());
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&seller.pubkey(), &quote_mint)
        ),
        0
    );
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&fee_recipient, &quote_mint)
        ),
        0
    );
    svm.expire_blockhash();

    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000 - 8 * 60 * 60).unwrap();
    svm.set_sysvar(&clock);
    let expiry_boundary = Transaction::new_signed_with_payer(
        &[underwrite_instruction(
            true,
            terms,
            participants,
            ONE_OPTION_E18,
            0,
            0,
        )],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(expiry_boundary).is_err());
}
