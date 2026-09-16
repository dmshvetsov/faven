use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::{
        get_associated_token_address, get_associated_token_address_with_program_id,
        ID as ASSOCIATED_TOKEN_PROGRAM_ID,
    },
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use options::{accounts, instruction, state::Series, OptionType, OracleConfig, ID as PROGRAM_ID};
use solana_program_pack::Pack;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::Transaction,
};
use spl_token::state::{Account as SplTokenAccount, AccountState};
use spl_token_2022_interface::{
    extension::{ExtensionType, StateWithExtensions},
    state::Account as Token2022Account,
};

#[path = "support/series.rs"]
mod support;
use support::*;

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

fn interface_underwrite_put_instruction(
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
            AccountMeta::new_readonly(accounts.fee_recipient, false),
            AccountMeta::new(accounts.fee_recipient_quote_ata, false),
            AccountMeta::new(accounts.seller_vault, false),
            AccountMeta::new(accounts.quote_collateral_vault, false),
            AccountMeta::new(accounts.base_collateral_vault, false),
            AccountMeta::new_readonly(ASSOCIATED_TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        data: instruction::UnderwritePutE18 {
            expiry_ms: EXPIRY_MS,
            strike_price_e8: strike,
            quantity_e18: ONE_OPTION_E18,
            premium_e18: 0,
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
        base_token_program,
        None,
    );
}

fn assert_call_series_with_supplied_token_programs(
    base_token_program: Pubkey,
    quote_token_program: Pubkey,
    supplied_base_token_program: Pubkey,
    supplied_quote_token_program: Pubkey,
    base_collateral_vault_token_program: Pubkey,
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
        &base_collateral_vault_token_program,
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

fn assert_put_series_token_program_pair(base_token_program: Pubkey, quote_token_program: Pubkey) {
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

    let buyer_quote_source = Pubkey::new_unique();
    let seller_quote_source = Pubkey::new_unique();
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
        seller_quote_source,
        quote_mint,
        seller.pubkey(),
        10_000_000,
        quote_token_program,
    );

    let strike = 350_000_000;
    let series = series_address(&market, OptionType::Put.marker(), strike, EXPIRY_MS);
    let long_mint = long_mint_address(&market, OptionType::Put.marker(), strike, EXPIRY_MS);
    let quote_collateral_vault =
        get_associated_token_address_with_program_id(&series, &quote_mint, &quote_token_program);
    let base_collateral_vault =
        get_associated_token_address_with_program_id(&series, &base_mint, &base_token_program);
    let underwrite = interface_underwrite_put_instruction(
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
            seller_base_source: seller_quote_source,
            seller_quote_destination: Pubkey::default(),
            fee_recipient,
            fee_recipient_quote_ata: get_associated_token_address_with_program_id(
                &fee_recipient,
                &quote_mint,
                &quote_token_program,
            ),
            seller_vault: seller_vault_address(
                &market,
                OptionType::Put.marker(),
                strike,
                EXPIRY_MS,
                &seller.pubkey(),
            ),
            base_collateral_vault,
            quote_collateral_vault,
            base_token_program,
            quote_token_program,
        },
        strike,
    );
    let result = svm.send_transaction(Transaction::new_signed_with_payer(
        &[first_underwrite_compute_budget(), underwrite],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    ));
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(svm.get_account(&long_mint).unwrap().owner, TOKEN_PROGRAM_ID);
    assert_eq!(
        svm.get_account(&get_associated_token_address(&buyer.pubkey(), &long_mint))
            .unwrap()
            .owner,
        TOKEN_PROGRAM_ID
    );
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&buyer.pubkey(), &long_mint)
        ),
        1_000_000_000
    );
    assert_eq!(
        svm.get_account(&base_collateral_vault).unwrap().owner,
        base_token_program
    );
    let quote_collateral = svm.get_account(&quote_collateral_vault).unwrap();
    assert_eq!(quote_collateral.owner, quote_token_program);
    let quote_collateral_amount = if quote_token_program == spl_token_2022_interface::id() {
        StateWithExtensions::<Token2022Account>::unpack(&quote_collateral.data)
            .unwrap()
            .base
            .amount
    } else {
        SplTokenAccount::unpack(&quote_collateral.data)
            .unwrap()
            .amount
    };
    assert_eq!(quote_collateral_amount, 3_500_000);
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
fn buyer_and_seller_can_create_put_series_for_every_token_program_pair() {
    let token_2022_program = spl_token_2022_interface::id();
    for (base_token_program, quote_token_program) in [
        (TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID),
        (TOKEN_PROGRAM_ID, token_2022_program),
        (token_2022_program, TOKEN_PROGRAM_ID),
        (token_2022_program, token_2022_program),
    ] {
        assert_put_series_token_program_pair(base_token_program, quote_token_program);
    }
}

#[test]
fn underwriting_rejects_a_mint_paired_with_the_wrong_token_program() {
    assert_call_series_with_supplied_token_programs(
        spl_token_2022_interface::id(),
        TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        Some("InvalidMintTokenProgram"),
    );
}

#[test]
fn underwriting_rejects_swapped_base_and_quote_token_programs() {
    assert_call_series_with_supplied_token_programs(
        spl_token_2022_interface::id(),
        TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        spl_token_2022_interface::id(),
        TOKEN_PROGRAM_ID,
        Some("An account required by the instruction is missing"),
    );
}

#[test]
fn underwriting_rejects_a_collateral_vault_derived_for_the_wrong_token_program() {
    assert_call_series_with_supplied_token_programs(
        spl_token_2022_interface::id(),
        TOKEN_PROGRAM_ID,
        spl_token_2022_interface::id(),
        TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        Some("An account required by the instruction is missing"),
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
fn existing_put_underwriting_reports_a_paused_base_mint() {
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
    add_token_2022_mint_with_extension(&mut svm, base_mint, 9, ExtensionType::Pausable, &[0; 33]);
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

    let buyer_quote_source = Pubkey::new_unique();
    let seller_quote_account = Pubkey::new_unique();
    add_token_account(
        &mut svm,
        buyer_quote_source,
        quote_mint,
        buyer.pubkey(),
        2_000_000,
    );
    add_token_account(
        &mut svm,
        seller_quote_account,
        quote_mint,
        seller.pubkey(),
        10_000_000,
    );
    let strike = 350_000_000;
    let series = series_address(&market, OptionType::Put.marker(), strike, EXPIRY_MS);
    let underwrite = interface_underwrite_put_instruction(
        InterfaceUnderwriteCallAccounts {
            buyer: buyer.pubkey(),
            seller: seller.pubkey(),
            market,
            base_mint,
            quote_mint,
            series,
            long_mint: long_mint_address(&market, OptionType::Put.marker(), strike, EXPIRY_MS),
            buyer_long_ata: get_associated_token_address(
                &buyer.pubkey(),
                &long_mint_address(&market, OptionType::Put.marker(), strike, EXPIRY_MS),
            ),
            buyer_quote_source,
            seller_base_source: seller_quote_account,
            seller_quote_destination: Pubkey::default(),
            fee_recipient,
            fee_recipient_quote_ata: get_associated_token_address(&fee_recipient, &quote_mint),
            seller_vault: seller_vault_address(
                &market,
                OptionType::Put.marker(),
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
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[first_underwrite_compute_budget(), underwrite.clone()],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    ))
    .unwrap();

    let mut mint = svm.get_account(&base_mint).unwrap();
    mint.data[202] = 1;
    svm.set_account(base_mint, mint).unwrap();
    let error = svm
        .send_transaction(Transaction::new_signed_with_payer(
            &[underwrite],
            Some(&buyer.pubkey()),
            &[&buyer, &seller],
            svm.latest_blockhash(),
        ))
        .unwrap_err();
    assert!(
        error
            .meta
            .logs
            .iter()
            .any(|log| log.contains("OperationBlockedByMintIssuer")),
        "{error:?}"
    );
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
