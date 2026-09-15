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
    events::Exercised,
    instruction,
    state::{Market, OptionType, OracleConfig, Series, SeriesState, LONG_MINT_SEED, SERIES_SEED},
    ID as PROGRAM_ID,
};
use solana_program_pack::Pack;
use solana_sdk::{
    account::Account, clock::Clock, instruction::Instruction, pubkey::Pubkey, signature::Keypair,
    signer::Signer, transaction::Transaction,
};
use spl_token::state::{Account as SplTokenAccount, AccountState, Mint};
use spl_token_2022_interface::{
    extension::{ExtensionType, StateWithExtensions},
    state::{Account as Token2022Account, Mint as Token2022Mint},
};

const EXPIRY_MS: u64 = 2_000_000_000_000;
const STRIKE: u64 = 350_000_000;
const QUANTITY: u64 = 1_000_000_000;
const EXERCISE_QUANTITY: u64 = 400_000_000;
const BASE_UNIT_E18: u128 = 1_000_000_000;

fn quantity_e18(quantity: u64) -> u128 {
    u128::from(quantity) * BASE_UNIT_E18
}

fn add_mint(svm: &mut LiteSVM, key: Pubkey, decimals: u8, supply: u64) {
    add_mint_for_program(svm, key, decimals, supply, TOKEN_PROGRAM_ID);
}

fn add_mint_for_program(
    svm: &mut LiteSVM,
    key: Pubkey,
    decimals: u8,
    supply: u64,
    token_program: Pubkey,
) {
    let mint = Mint {
        mint_authority: solana_sdk::program_option::COption::None,
        supply,
        decimals,
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

fn add_token_account(svm: &mut LiteSVM, key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
    add_token_account_for_program(
        svm,
        key,
        mint,
        owner,
        amount,
        TOKEN_PROGRAM_ID,
        AccountState::Initialized,
    );
}

fn add_token_account_for_program(
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

fn pause_token_2022_mint(svm: &mut LiteSVM, key: Pubkey, decimals: u8) {
    const BASE_ACCOUNT_AND_TYPE_LENGTH: usize = 166;
    const TLV_HEADER_LENGTH: usize = 4;
    const PAUSABLE_CONFIG_LENGTH: usize = 33;
    let mut data =
        vec![0; BASE_ACCOUNT_AND_TYPE_LENGTH + TLV_HEADER_LENGTH + PAUSABLE_CONFIG_LENGTH];
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
    data[166..168].copy_from_slice(&u16::from(ExtensionType::Pausable).to_le_bytes());
    data[168..170].copy_from_slice(&u16::try_from(PAUSABLE_CONFIG_LENGTH).unwrap().to_le_bytes());
    data[202] = 1;
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

fn token_amount(svm: &LiteSVM, key: Pubkey) -> u64 {
    let account = svm.get_account(&key).unwrap();
    if account.owner == spl_token_2022_interface::id() {
        StateWithExtensions::<Token2022Account>::unpack(&account.data)
            .unwrap()
            .base
            .amount
    } else {
        SplTokenAccount::unpack(&account.data).unwrap().amount
    }
}

fn market_address(operator: Pubkey, quote_mint: Pubkey, base_mint: Pubkey) -> Pubkey {
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

fn series_address(market: Pubkey, option_type: OptionType) -> Pubkey {
    Pubkey::find_program_address(
        &[
            SERIES_SEED,
            market.as_ref(),
            &[option_type.marker()],
            &EXPIRY_MS.to_le_bytes(),
            &STRIKE.to_le_bytes(),
        ],
        &PROGRAM_ID,
    )
    .0
}

fn long_mint_address(market: Pubkey, option_type: OptionType) -> Pubkey {
    Pubkey::find_program_address(
        &[
            LONG_MINT_SEED,
            market.as_ref(),
            &[option_type.marker()],
            &EXPIRY_MS.to_le_bytes(),
            &STRIKE.to_le_bytes(),
        ],
        &PROGRAM_ID,
    )
    .0
}

struct ExerciseFixture {
    svm: LiteSVM,
    operator: Keypair,
    holder: Keypair,
    market: Pubkey,
    series: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    long_mint: Pubkey,
    option_type: OptionType,
    base_token_program: Pubkey,
    quote_token_program: Pubkey,
    long_source: Pubkey,
    payment_source: Pubkey,
    base_vault: Pubkey,
    quote_vault: Pubkey,
}

fn fixture(
    option_type: OptionType,
    base_token_program: Pubkey,
    quote_token_program: Pubkey,
) -> ExerciseFixture {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();
    let holder = Keypair::new();
    let operator = Keypair::new();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    let market = market_address(operator.pubkey(), quote_mint, base_mint);
    let series = series_address(market, option_type);
    let long_mint = long_mint_address(market, option_type);
    let long_source = Pubkey::new_unique();
    let payment_source = Pubkey::new_unique();
    let base_vault =
        get_associated_token_address_with_program_id(&series, &base_mint, &base_token_program);
    let quote_vault =
        get_associated_token_address_with_program_id(&series, &quote_mint, &quote_token_program);
    svm.airdrop(&holder.pubkey(), 10_000_000_000).unwrap();
    add_mint_for_program(&mut svm, base_mint, 9, 0, base_token_program);
    add_mint_for_program(&mut svm, quote_mint, 6, 0, quote_token_program);
    add_mint(&mut svm, long_mint, 9, QUANTITY);
    store_account(
        &mut svm,
        market,
        &Market {
            oracle_config: OracleConfig::PythTwap { feed_id: [1; 32] },
            base_mint_decimals: 9,
            quote_mint_decimals: 6,
            operator: operator.pubkey(),
            paused: false,
            quote_mint: quote_mint,
            base_mint: base_mint,
            min_fee: 0,
            min_operational_fee_bps: 0,
            max_operational_fee_bps: 0,
        },
    );
    store_account(
        &mut svm,
        series,
        &Series {
            state: SeriesState::ExpirationPriceFinalized,
            market,
            option_type,
            strike_price: STRIKE,
            expiry_ms: EXPIRY_MS,
            exercise_window_end_ms: EXPIRY_MS + 3_600_000,
            expiry_price: Some(match option_type {
                OptionType::Call => STRIKE + 1,
                OptionType::Put => STRIKE - 1,
            }),
            total_contracts_quantity: QUANTITY,
            total_manual_exercised_quantity: 0,
            total_settled_quantity: 0,
            total_quote_amount: match option_type {
                OptionType::Call => 0,
                OptionType::Put => 3_500_000,
            },
        },
    );
    add_token_account(&mut svm, long_source, long_mint, holder.pubkey(), QUANTITY);
    let (payment_mint, payment_amount, base_vault_amount, quote_vault_amount) = match option_type {
        OptionType::Call => (quote_mint, 2_000_000, QUANTITY, 0),
        OptionType::Put => (base_mint, 2_000_000_000, 0, 3_500_000),
    };
    add_token_account_for_program(
        &mut svm,
        payment_source,
        payment_mint,
        holder.pubkey(),
        payment_amount,
        if payment_mint == base_mint {
            base_token_program
        } else {
            quote_token_program
        },
        AccountState::Initialized,
    );
    add_token_account_for_program(
        &mut svm,
        base_vault,
        base_mint,
        series,
        base_vault_amount,
        base_token_program,
        AccountState::Initialized,
    );
    add_token_account_for_program(
        &mut svm,
        quote_vault,
        quote_mint,
        series,
        quote_vault_amount,
        quote_token_program,
        AccountState::Initialized,
    );
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000).unwrap();
    svm.set_sysvar(&clock);
    ExerciseFixture {
        svm,
        operator,
        holder,
        market,
        series,
        base_mint,
        quote_mint,
        long_mint,
        option_type,
        base_token_program,
        quote_token_program,
        long_source,
        payment_source,
        base_vault,
        quote_vault,
    }
}

fn call_fixture() -> ExerciseFixture {
    fixture(OptionType::Call, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID)
}

fn put_fixture() -> ExerciseFixture {
    fixture(OptionType::Put, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID)
}

fn exercise_instruction(fixture: &ExerciseFixture, quantity_e18: u128) -> Instruction {
    exercise_instruction_with_vaults(
        fixture,
        quantity_e18,
        fixture.base_vault,
        fixture.quote_vault,
    )
}

fn finalize_unverified_instruction(fixture: &ExerciseFixture) -> Instruction {
    let accounts = accounts::FinalizePythUnverifiedSeries {
        operator: fixture.operator.pubkey(),
        market: fixture.market,
    };
    let mut account_metas = accounts.to_account_metas(None);
    account_metas.push(solana_sdk::instruction::AccountMeta::new(
        fixture.series,
        false,
    ));
    account_metas.push(solana_sdk::instruction::AccountMeta::new_readonly(
        fixture.quote_vault,
        false,
    ));
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: instruction::FinalizePythUnverifiedSeries {
            id: [1; 32],
            price: 12_345_678,
            conf: 0,
            expo: -7,
            publish_time: 0,
        }
        .data(),
    }
}

fn exercise_instruction_with_vaults(
    fixture: &ExerciseFixture,
    quantity_e18: u128,
    base_collateral_vault: Pubkey,
    quote_collateral_vault: Pubkey,
) -> Instruction {
    let accounts = accounts::Exercise {
        holder: fixture.holder.pubkey(),
        market: fixture.market,
        series: fixture.series,
        base_mint: fixture.base_mint,
        quote_mint: fixture.quote_mint,
        long_mint: fixture.long_mint,
        holder_long_source: fixture.long_source,
        holder_payment_source: fixture.payment_source,
        holder_receipt_ata: get_associated_token_address_with_program_id(
            &fixture.holder.pubkey(),
            &match fixture.option_type {
                OptionType::Call => fixture.base_mint,
                OptionType::Put => fixture.quote_mint,
            },
            &match fixture.option_type {
                OptionType::Call => fixture.base_token_program,
                OptionType::Put => fixture.quote_token_program,
            },
        ),
        base_collateral_vault,
        quote_collateral_vault,
        long_token_program: TOKEN_PROGRAM_ID,
        base_token_program: fixture.base_token_program,
        quote_token_program: fixture.quote_token_program,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::ExerciseE18 { quantity_e18 }.data(),
    }
}

fn update_series(fixture: &mut ExerciseFixture, update: impl FnOnce(&mut Series)) {
    let mut account = fixture.svm.get_account(&fixture.series).unwrap();
    let mut series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    update(&mut series);
    let mut data = Vec::new();
    series.try_serialize(&mut data).unwrap();
    data.resize(Series::SPACE, 0);
    account.data = data;
    fixture.svm.set_account(fixture.series, account).unwrap();
}

fn update_market(fixture: &mut ExerciseFixture, update: impl FnOnce(&mut Market)) {
    let mut account = fixture.svm.get_account(&fixture.market).unwrap();
    let mut market = Market::try_deserialize(&mut account.data.as_slice()).unwrap();
    update(&mut market);
    let mut data = Vec::new();
    market.try_serialize(&mut data).unwrap();
    account.data = data;
    fixture.svm.set_account(fixture.market, account).unwrap();
}

fn exercise_fails(fixture: &mut ExerciseFixture, quantity_e18: u128) -> bool {
    let transaction = Transaction::new_signed_with_payer(
        &[exercise_instruction(fixture, quantity_e18)],
        Some(&fixture.holder.pubkey()),
        &[&fixture.holder],
        fixture.svm.latest_blockhash(),
    );
    fixture.svm.send_transaction(transaction).is_err()
}

fn exercise_error_contains(
    fixture: &mut ExerciseFixture,
    quantity_e18: u128,
    expected_error: &str,
) -> bool {
    let transaction = Transaction::new_signed_with_payer(
        &[exercise_instruction(fixture, quantity_e18)],
        Some(&fixture.holder.pubkey()),
        &[&fixture.holder],
        fixture.svm.latest_blockhash(),
    );
    fixture
        .svm
        .send_transaction(transaction)
        .unwrap_err()
        .meta
        .logs
        .iter()
        .any(|log| log.contains(expected_error))
}

fn assert_exercised_event(
    logs: &[String],
    series: Pubkey,
    holder: Pubkey,
    option_type: OptionType,
    quantity: u64,
    input_asset_amount: u64,
    output_asset_amount: u64,
) {
    let event = Exercised {
        series,
        holder,
        option_type,
        quantity,
        input_asset_amount,
        output_asset_amount,
    };
    let expected_log = format!("Program data: {}", STANDARD.encode(event.data()));
    assert!(logs.iter().any(|log| log == &expected_log));
}

#[test]
fn itm_put_can_exercise_after_finalization_snapshots_the_quote_vault() {
    let mut fixture = put_fixture();
    update_series(&mut fixture, |series| {
        series.state = SeriesState::Open;
        series.expiry_price = None;
        series.total_quote_amount = 0;
    });
    let finalization = Transaction::new_signed_with_payer(
        &[finalize_unverified_instruction(&fixture)],
        Some(&fixture.holder.pubkey()),
        &[&fixture.holder, &fixture.operator],
        fixture.svm.latest_blockhash(),
    );
    let finalization_result = fixture.svm.send_transaction(finalization);
    assert!(finalization_result.is_ok(), "{finalization_result:?}");

    let transaction = Transaction::new_signed_with_payer(
        &[exercise_instruction(
            &fixture,
            quantity_e18(EXERCISE_QUANTITY + 1),
        )],
        Some(&fixture.holder.pubkey()),
        &[&fixture.holder],
        fixture.svm.latest_blockhash(),
    );
    assert!(fixture.svm.send_transaction(transaction).is_ok());

    let account = fixture.svm.get_account(&fixture.series).unwrap();
    let series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(series.total_quote_amount, 2_100_000);
}

#[test]
fn itm_call_partial_exercise_burns_only_requested_long_and_delivers_base_coin() {
    let mut fixture = call_fixture();
    let receipt = get_associated_token_address(&fixture.holder.pubkey(), &fixture.base_mint);
    let transaction = Transaction::new_signed_with_payer(
        &[exercise_instruction(
            &fixture,
            quantity_e18(EXERCISE_QUANTITY),
        )],
        Some(&fixture.holder.pubkey()),
        &[&fixture.holder],
        fixture.svm.latest_blockhash(),
    );

    let result = fixture.svm.send_transaction(transaction);
    assert!(result.is_ok(), "{result:?}");
    assert_exercised_event(
        &result.unwrap().logs,
        fixture.series,
        fixture.holder.pubkey(),
        OptionType::Call,
        EXERCISE_QUANTITY,
        1_400_000,
        EXERCISE_QUANTITY,
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.long_source),
        QUANTITY - EXERCISE_QUANTITY
    );
    assert_eq!(token_amount(&fixture.svm, fixture.payment_source), 600_000);
    assert_eq!(token_amount(&fixture.svm, fixture.quote_vault), 1_400_000);
    assert_eq!(token_amount(&fixture.svm, receipt), EXERCISE_QUANTITY);
    let account = fixture.svm.get_account(&fixture.series).unwrap();
    let series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(series.total_manual_exercised_quantity, EXERCISE_QUANTITY);
    assert_eq!(series.total_quote_amount, 1_400_000);
}

#[test]
fn exercise_supports_every_base_and_quote_token_program_pair() {
    let token_2022_program = spl_token_2022_interface::id();
    for (base_token_program, quote_token_program) in [
        (TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID),
        (TOKEN_PROGRAM_ID, token_2022_program),
        (token_2022_program, TOKEN_PROGRAM_ID),
        (token_2022_program, token_2022_program),
    ] {
        let mut fixture = fixture(OptionType::Call, base_token_program, quote_token_program);
        let receipt = get_associated_token_address_with_program_id(
            &fixture.holder.pubkey(),
            &fixture.base_mint,
            &base_token_program,
        );
        let transaction = Transaction::new_signed_with_payer(
            &[exercise_instruction(
                &fixture,
                quantity_e18(EXERCISE_QUANTITY),
            )],
            Some(&fixture.holder.pubkey()),
            &[&fixture.holder],
            fixture.svm.latest_blockhash(),
        );
        let result = fixture.svm.send_transaction(transaction);
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(token_amount(&fixture.svm, receipt), EXERCISE_QUANTITY);
    }
}

#[test]
fn exercise_rejects_unsupported_token_2022_account_extensions() {
    let mut fixture = fixture(
        OptionType::Call,
        TOKEN_PROGRAM_ID,
        spl_token_2022_interface::id(),
    );
    add_token_2022_account_with_extension(
        &mut fixture.svm,
        fixture.payment_source,
        fixture.quote_mint,
        fixture.holder.pubkey(),
        2_000_000,
        ExtensionType::CpiGuard,
    );

    assert!(exercise_error_contains(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY),
        "UnsupportedTokenAccountExtension",
    ));
}

#[test]
fn exercise_reports_an_issuer_frozen_account_or_paused_mint() {
    let mut frozen_account = fixture(
        OptionType::Call,
        TOKEN_PROGRAM_ID,
        spl_token_2022_interface::id(),
    );
    add_token_account_for_program(
        &mut frozen_account.svm,
        frozen_account.payment_source,
        frozen_account.quote_mint,
        frozen_account.holder.pubkey(),
        2_000_000,
        spl_token_2022_interface::id(),
        AccountState::Frozen,
    );
    assert!(exercise_error_contains(
        &mut frozen_account,
        quantity_e18(EXERCISE_QUANTITY),
        "OperationBlockedByMintIssuer",
    ));

    let mut paused_mint = fixture(
        OptionType::Call,
        TOKEN_PROGRAM_ID,
        spl_token_2022_interface::id(),
    );
    pause_token_2022_mint(&mut paused_mint.svm, paused_mint.quote_mint, 6);
    assert!(exercise_error_contains(
        &mut paused_mint,
        quantity_e18(EXERCISE_QUANTITY),
        "OperationBlockedByMintIssuer",
    ));
}

#[test]
fn multiple_call_exercises_snapshot_each_rounded_quote_payment() {
    let mut fixture = call_fixture();
    add_token_account(
        &mut fixture.svm,
        fixture.payment_source,
        fixture.quote_mint,
        fixture.holder.pubkey(),
        3_000_000,
    );
    for quantity in [200_000_001, 200_000_002] {
        let transaction = Transaction::new_signed_with_payer(
            &[exercise_instruction(&fixture, quantity_e18(quantity))],
            Some(&fixture.holder.pubkey()),
            &[&fixture.holder],
            fixture.svm.latest_blockhash(),
        );
        let result = fixture.svm.send_transaction(transaction);
        assert!(result.is_ok(), "{result:?}");
    }

    let account = fixture.svm.get_account(&fixture.series).unwrap();
    let series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(series.total_manual_exercised_quantity, 400_000_003);
    assert_eq!(series.total_quote_amount, 1_400_002);
    assert_eq!(token_amount(&fixture.svm, fixture.quote_vault), 1_400_002);
}

#[test]
fn itm_put_partial_exercise_collects_base_coin_and_delivers_floor_rounded_quote_coin() {
    let mut fixture = put_fixture();
    let receipt = get_associated_token_address(&fixture.holder.pubkey(), &fixture.quote_mint);
    let transaction = Transaction::new_signed_with_payer(
        &[exercise_instruction(
            &fixture,
            quantity_e18(EXERCISE_QUANTITY + 1),
        )],
        Some(&fixture.holder.pubkey()),
        &[&fixture.holder],
        fixture.svm.latest_blockhash(),
    );

    let result = fixture.svm.send_transaction(transaction);
    assert!(result.is_ok(), "{result:?}");
    assert_exercised_event(
        &result.unwrap().logs,
        fixture.series,
        fixture.holder.pubkey(),
        OptionType::Put,
        EXERCISE_QUANTITY + 1,
        EXERCISE_QUANTITY + 1,
        1_400_000,
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.long_source),
        QUANTITY - EXERCISE_QUANTITY - 1
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.payment_source),
        1_599_999_999
    );
    assert_eq!(
        token_amount(&fixture.svm, fixture.base_vault),
        EXERCISE_QUANTITY + 1
    );
    assert_eq!(token_amount(&fixture.svm, receipt), 1_400_000);
    let account = fixture.svm.get_account(&fixture.series).unwrap();
    let series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(series.total_quote_amount, 2_100_000);
}

#[test]
fn exercise_rejects_invalid_quantity_phase_accounts_and_insufficient_funds_without_changes() {
    let mut fixture = call_fixture();
    assert!(exercise_fails(&mut fixture, 0));
    assert!(exercise_fails(&mut fixture, quantity_e18(QUANTITY + 1)));

    let mut fixture = call_fixture();
    let long_before = token_amount(&fixture.svm, fixture.long_source);
    let payment_before = token_amount(&fixture.svm, fixture.payment_source);
    let vault_before = token_amount(&fixture.svm, fixture.base_vault);
    add_token_account(
        &mut fixture.svm,
        fixture.payment_source,
        fixture.quote_mint,
        fixture.holder.pubkey(),
        0,
    );
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY)
    ));
    assert_eq!(token_amount(&fixture.svm, fixture.long_source), long_before);
    assert_eq!(token_amount(&fixture.svm, fixture.payment_source), 0);
    assert_eq!(token_amount(&fixture.svm, fixture.base_vault), vault_before);
    assert_eq!(payment_before, 2_000_000);

    let mut fixture = call_fixture();
    add_token_account(
        &mut fixture.svm,
        fixture.base_vault,
        fixture.base_mint,
        fixture.series,
        EXERCISE_QUANTITY - 1,
    );
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY)
    ));
    assert_eq!(token_amount(&fixture.svm, fixture.long_source), QUANTITY);
    assert_eq!(
        token_amount(&fixture.svm, fixture.payment_source),
        2_000_000
    );

    let mut fixture = call_fixture();
    update_market(&mut fixture, |market| market.paused = true);
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY)
    ));

    let mut fixture = call_fixture();
    update_series(&mut fixture, |series| series.state = SeriesState::Open);
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY)
    ));

    let mut fixture = call_fixture();
    update_series(&mut fixture, |series| series.expiry_price = Some(STRIKE));
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY)
    ));

    let mut fixture = call_fixture();
    update_series(&mut fixture, |series| {
        series.expiry_price = Some(STRIKE - 1)
    });
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY)
    ));

    let mut fixture = call_fixture();
    let mut clock = fixture.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000 - 1).unwrap();
    fixture.svm.set_sysvar(&clock);
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY)
    ));

    let mut fixture = call_fixture();
    let mut clock = fixture.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000 + 3_600).unwrap();
    fixture.svm.set_sysvar(&clock);
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY)
    ));
}

#[test]
fn exercise_rejects_wrong_holder_token_mints_owners_and_series_vault() {
    let mut fixture = call_fixture();
    add_token_account(
        &mut fixture.svm,
        fixture.long_source,
        Pubkey::new_unique(),
        fixture.holder.pubkey(),
        QUANTITY,
    );
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY)
    ));

    let mut fixture = call_fixture();
    add_token_account(
        &mut fixture.svm,
        fixture.long_source,
        fixture.long_mint,
        Pubkey::new_unique(),
        QUANTITY,
    );
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY)
    ));

    let mut fixture = call_fixture();
    add_token_account(
        &mut fixture.svm,
        fixture.payment_source,
        fixture.base_mint,
        fixture.holder.pubkey(),
        2_000_000,
    );
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY)
    ));

    let mut fixture = call_fixture();
    let transaction = Transaction::new_signed_with_payer(
        &[exercise_instruction_with_vaults(
            &fixture,
            quantity_e18(EXERCISE_QUANTITY),
            Pubkey::new_unique(),
            fixture.quote_vault,
        )],
        Some(&fixture.holder.pubkey()),
        &[&fixture.holder],
        fixture.svm.latest_blockhash(),
    );
    assert!(fixture.svm.send_transaction(transaction).is_err());
}

#[test]
fn exercise_rejects_quantity_that_exceeds_the_series_issued_contracts() {
    let mut fixture = call_fixture();
    update_series(&mut fixture, |series| {
        series.total_manual_exercised_quantity = QUANTITY - 100;
    });

    assert!(exercise_fails(&mut fixture, quantity_e18(101)));
    assert_eq!(token_amount(&fixture.svm, fixture.long_source), QUANTITY);
    assert_eq!(
        token_amount(&fixture.svm, fixture.payment_source),
        2_000_000
    );
}

#[test]
fn exercise_rejects_e18_quantities_that_are_not_exact_base_coin_units_or_overflow() {
    let mut fixture = call_fixture();
    let long_before = token_amount(&fixture.svm, fixture.long_source);
    let payment_before = token_amount(&fixture.svm, fixture.payment_source);
    assert!(exercise_fails(
        &mut fixture,
        quantity_e18(EXERCISE_QUANTITY) + 1
    ));
    assert_eq!(token_amount(&fixture.svm, fixture.long_source), long_before);
    assert_eq!(
        token_amount(&fixture.svm, fixture.payment_source),
        payment_before
    );

    let mut fixture = call_fixture();
    let overflow_quantity_e18 = (u128::MAX / BASE_UNIT_E18) * BASE_UNIT_E18;
    assert!(exercise_fails(&mut fixture, overflow_quantity_e18));
    assert_eq!(token_amount(&fixture.svm, fixture.long_source), QUANTITY);
    assert_eq!(
        token_amount(&fixture.svm, fixture.payment_source),
        2_000_000
    );
}
