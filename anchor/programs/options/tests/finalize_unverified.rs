use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use litesvm::LiteSVM;
use options::{
    accounts, instruction,
    state::{Market, Series, SeriesState},
    OracleConfig, ID as PROGRAM_ID,
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
use spl_token_2022_interface::{extension::ExtensionType, state::Account as Token2022Account};

const EXPIRY_MS: u64 = 2_000_000_000_000;
const FEED_ID: [u8; 32] = [7; 32];

fn store_account<T: AccountSerialize>(svm: &mut LiteSVM, key: Pubkey, value: &T) {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data.resize(data.len() + 16, 0);
    svm.set_account(
        key,
        Account {
            lamports: 1_000_000,
            data,
            owner: PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn new_svm(expiry_ms: u64) -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(expiry_ms / 1_000).unwrap();
    svm.set_sysvar(&clock);
    svm
}

fn add_mint(svm: &mut LiteSVM, key: Pubkey, token_program: Pubkey) {
    let mint = Mint {
        mint_authority: solana_sdk::program_option::COption::None,
        supply: 0,
        decimals: 6,
        is_initialized: true,
        freeze_authority: solana_sdk::program_option::COption::None,
    };
    let mut data = vec![0; Mint::LEN];
    Mint::pack(mint, &mut data).unwrap();
    svm.set_account(
        key,
        Account {
            lamports: 1_000_000,
            data,
            owner: token_program,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn add_token_account(
    svm: &mut LiteSVM,
    key: Pubkey,
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    token_program: Pubkey,
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
            owner: token_program,
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

fn add_market(
    svm: &mut LiteSVM,
    key: Pubkey,
    operator: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
) {
    store_account(
        svm,
        key,
        &Market {
            oracle_config: OracleConfig::PythTwap { feed_id: FEED_ID },
            base_mint_decimals: 9,
            quote_mint_decimals: 6,
            operator,
            paused: false,
            quote_mint: quote_mint,
            base_mint,
            min_fee: 0,
            min_operational_fee_bps: 0,
            max_operational_fee_bps: 0,
        },
    );
}

fn add_series(svm: &mut LiteSVM, key: Pubkey, market: Pubkey, expiry_ms: u64) {
    store_account(
        svm,
        key,
        &Series {
            state: SeriesState::Open,
            market,
            option_type: options::OptionType::Call,
            strike_price: 100_000_000,
            expiry_ms,
            exercise_window_end_ms: expiry_ms + 3_600_000,
            expiry_price: None,
            total_contracts_quantity: 0,
            total_manual_exercised_quantity: 0,
            total_settled_quantity: 0,
            total_quote_amount: 0,
        },
    );
}

fn finalize_instruction(
    operator: Pubkey,
    market: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    base_token_program: Pubkey,
    quote_token_program: Pubkey,
    series: Pubkey,
    quote_collateral_vault: Option<Pubkey>,
    id: [u8; 32],
    publish_time: i64,
) -> Instruction {
    let accounts = accounts::FinalizePythUnverifiedSeries {
        operator,
        market,
        base_token_program,
        quote_token_program,
        base_mint,
        quote_mint,
    };
    let mut account_metas = accounts.to_account_metas(None);
    account_metas.push(AccountMeta::new(series, false));
    if let Some(quote_collateral_vault) = quote_collateral_vault {
        account_metas.push(AccountMeta::new_readonly(quote_collateral_vault, false));
    }
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: instruction::FinalizePythUnverifiedSeries {
            id,
            price: 12_345_678,
            conf: u64::MAX,
            expo: -7,
            publish_time,
        }
        .data(),
    }
}

#[test]
fn finalizing_a_zero_issued_series_supports_every_token_program_pair() {
    let token_2022_program = spl_token_2022_interface::id();
    for (base_token_program, quote_token_program) in [
        (TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID),
        (TOKEN_PROGRAM_ID, token_2022_program),
        (token_2022_program, TOKEN_PROGRAM_ID),
        (token_2022_program, token_2022_program),
    ] {
        let operator = Keypair::new();
        let market = Pubkey::new_unique();
        let series = Pubkey::new_unique();
        let base_mint = Pubkey::new_unique();
        let quote_mint = Pubkey::new_unique();
        let quote_collateral_vault = get_associated_token_address_with_program_id(
            &series,
            &quote_mint,
            &quote_token_program,
        );
        let mut svm = new_svm(EXPIRY_MS);
        svm.airdrop(&operator.pubkey(), 1_000_000_000).unwrap();
        add_mint(&mut svm, base_mint, base_token_program);
        add_mint(&mut svm, quote_mint, quote_token_program);
        add_market(&mut svm, market, operator.pubkey(), base_mint, quote_mint);
        add_series(&mut svm, series, market, EXPIRY_MS);
        add_token_account(
            &mut svm,
            quote_collateral_vault,
            quote_mint,
            series,
            2_100_000,
            quote_token_program,
            AccountState::Initialized,
        );

        let transaction = Transaction::new_signed_with_payer(
            &[finalize_instruction(
                operator.pubkey(),
                market,
                base_mint,
                quote_mint,
                base_token_program,
                quote_token_program,
                series,
                Some(quote_collateral_vault),
                [99; 32],
                i64::MIN,
            )],
            Some(&operator.pubkey()),
            &[&operator],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(transaction).is_ok());

        let account = svm.get_account(&series).unwrap();
        let finalized = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
        assert_eq!(finalized.state, SeriesState::Closed);
        assert_eq!(finalized.expiry_price, Some(123_456_780));
        assert_eq!(finalized.total_quote_amount, 2_100_000);
    }
}

#[test]
fn finalization_requires_the_series_quote_collateral_vault() {
    let operator = Keypair::new();
    let market = Pubkey::new_unique();
    let series = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let mut svm = new_svm(EXPIRY_MS);
    svm.airdrop(&operator.pubkey(), 1_000_000_000).unwrap();
    add_mint(&mut svm, base_mint, TOKEN_PROGRAM_ID);
    add_mint(&mut svm, quote_mint, TOKEN_PROGRAM_ID);
    add_market(&mut svm, market, operator.pubkey(), base_mint, quote_mint);
    add_series(&mut svm, series, market, EXPIRY_MS);

    let transaction = Transaction::new_signed_with_payer(
        &[finalize_instruction(
            operator.pubkey(),
            market,
            base_mint,
            quote_mint,
            TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            series,
            None,
            [99; 32],
            i64::MIN,
        )],
        Some(&operator.pubkey()),
        &[&operator],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_err());

    let account = svm.get_account(&series).unwrap();
    let series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(series.state, SeriesState::Open);
}

#[test]
fn finalization_rejects_unsupported_or_issuer_frozen_token_2022_vaults() {
    for (state, extension_type, expected_error) in [
        (
            AccountState::Initialized,
            Some(ExtensionType::CpiGuard),
            "UnsupportedTokenAccountExtension",
        ),
        (AccountState::Frozen, None, "OperationBlockedByMintIssuer"),
    ] {
        let operator = Keypair::new();
        let market = Pubkey::new_unique();
        let series = Pubkey::new_unique();
        let base_mint = Pubkey::new_unique();
        let quote_mint = Pubkey::new_unique();
        let quote_token_program = spl_token_2022_interface::id();
        let quote_collateral_vault = get_associated_token_address_with_program_id(
            &series,
            &quote_mint,
            &quote_token_program,
        );
        let mut svm = new_svm(EXPIRY_MS);
        svm.airdrop(&operator.pubkey(), 1_000_000_000).unwrap();
        add_mint(&mut svm, base_mint, TOKEN_PROGRAM_ID);
        add_mint(&mut svm, quote_mint, quote_token_program);
        add_market(&mut svm, market, operator.pubkey(), base_mint, quote_mint);
        add_series(&mut svm, series, market, EXPIRY_MS);
        if let Some(extension_type) = extension_type {
            add_token_2022_account_with_extension(
                &mut svm,
                quote_collateral_vault,
                quote_mint,
                series,
                2_100_000,
                extension_type,
            );
        } else {
            add_token_account(
                &mut svm,
                quote_collateral_vault,
                quote_mint,
                series,
                2_100_000,
                quote_token_program,
                state,
            );
        }

        let transaction = Transaction::new_signed_with_payer(
            &[finalize_instruction(
                operator.pubkey(),
                market,
                base_mint,
                quote_mint,
                TOKEN_PROGRAM_ID,
                quote_token_program,
                series,
                Some(quote_collateral_vault),
                [99; 32],
                i64::MIN,
            )],
            Some(&operator.pubkey()),
            &[&operator],
            svm.latest_blockhash(),
        );
        let error = svm.send_transaction(transaction).unwrap_err();
        assert!(
            error
                .meta
                .logs
                .iter()
                .any(|log| log.contains(expected_error)),
            "{error:?}"
        );
    }
}

#[test]
fn only_the_market_operator_can_use_the_unverified_fallback() {
    let operator = Keypair::new();
    let caller = Keypair::new();
    let market = Pubkey::new_unique();
    let series = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let mut svm = new_svm(EXPIRY_MS);
    svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();
    add_mint(&mut svm, base_mint, TOKEN_PROGRAM_ID);
    add_mint(&mut svm, quote_mint, TOKEN_PROGRAM_ID);
    add_market(&mut svm, market, operator.pubkey(), base_mint, quote_mint);
    add_series(&mut svm, series, market, EXPIRY_MS);

    let transaction = Transaction::new_signed_with_payer(
        &[finalize_instruction(
            caller.pubkey(),
            market,
            base_mint,
            quote_mint,
            TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            series,
            None,
            [0; 32],
            0,
        )],
        Some(&caller.pubkey()),
        &[&caller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_err());
}
