use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::{get_associated_token_address, ID as ASSOCIATED_TOKEN_PROGRAM_ID},
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use litesvm::LiteSVM;
use options::{
    accounts, instruction,
    state::{Market, OptionType, OracleConfig, Series, SeriesState, SERIES_SEED},
    ID as PROGRAM_ID,
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

const EXPIRY_MS: u64 = 2_000_000_000_000;
const EXERCISE_WINDOW_END_MS: u64 = EXPIRY_MS + 3_600_000;
const STRIKE: u64 = 350_000_000;
const ACCOUNT_RENT: u64 = 1_000_000;

fn add_mint(svm: &mut LiteSVM, key: Pubkey) {
    let mint = Mint {
        mint_authority: solana_sdk::program_option::COption::None,
        supply: 0,
        decimals: 0,
        is_initialized: true,
        freeze_authority: solana_sdk::program_option::COption::None,
    };
    let mut data = vec![0; Mint::LEN];
    Mint::pack(mint, &mut data).unwrap();
    svm.set_account(
        key,
        Account {
            lamports: ACCOUNT_RENT,
            data,
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn add_token_account(svm: &mut LiteSVM, key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
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
    let mut data = vec![0; SplTokenAccount::LEN];
    SplTokenAccount::pack(token_account, &mut data).unwrap();
    svm.set_account(
        key,
        Account {
            lamports: ACCOUNT_RENT,
            data,
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn store_account<T: AccountSerialize>(svm: &mut LiteSVM, key: Pubkey, value: &T) {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    svm.set_account(
        key,
        Account {
            lamports: ACCOUNT_RENT,
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
    SplTokenAccount::unpack(&account.data).unwrap().amount
}

fn series_address(market: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            SERIES_SEED,
            market.as_ref(),
            &[OptionType::Call.marker()],
            &EXPIRY_MS.to_le_bytes(),
            &STRIKE.to_le_bytes(),
        ],
        &PROGRAM_ID,
    )
    .0
}

struct CloseSeriesFixture {
    svm: LiteSVM,
    series_closer: Keypair,
    market_operator: Pubkey,
    market: Pubkey,
    series: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    base_vault: Pubkey,
    quote_vault: Pubkey,
    closer_base_ata: Pubkey,
    closer_quote_ata: Pubkey,
}

fn closed_series_with_dust() -> CloseSeriesFixture {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();

    let series_closer = Keypair::new();
    let market_operator = Pubkey::new_unique();
    let market = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let series = series_address(market);
    let base_vault = get_associated_token_address(&series, &base_mint);
    let quote_vault = get_associated_token_address(&series, &quote_mint);
    let closer_base_ata = get_associated_token_address(&series_closer.pubkey(), &base_mint);
    let closer_quote_ata = get_associated_token_address(&series_closer.pubkey(), &quote_mint);

    svm.airdrop(&series_closer.pubkey(), 10_000_000_000)
        .unwrap();
    svm.airdrop(&market_operator, 10_000_000_000).unwrap();
    add_mint(&mut svm, base_mint);
    add_mint(&mut svm, quote_mint);
    store_account(
        &mut svm,
        market,
        &Market {
            oracle_config: OracleConfig::PythTwap { feed_id: [1; 32] },
            base_mint_decimals: 0,
            quote_mint_decimals: 0,
            operator: market_operator,
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
            state: SeriesState::Closed,
            market,
            option_type: OptionType::Call,
            strike_price: STRIKE,
            expiry_ms: EXPIRY_MS,
            exercise_window_end_ms: EXERCISE_WINDOW_END_MS,
            expiry_price: Some(STRIKE),
            total_contracts_quantity: 10,
            total_manual_exercised_quantity: 0,
            total_settled_quantity: 10,
            total_quote_amount: 0,
        },
    );
    add_token_account(&mut svm, base_vault, base_mint, series, 7);
    add_token_account(&mut svm, quote_vault, quote_mint, series, 9);
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXERCISE_WINDOW_END_MS / 1_000).unwrap();
    svm.set_sysvar(&clock);

    CloseSeriesFixture {
        svm,
        series_closer,
        market_operator,
        market,
        series,
        base_mint,
        quote_mint,
        base_vault,
        quote_vault,
        closer_base_ata,
        closer_quote_ata,
    }
}

fn close_series_instruction(fixture: &CloseSeriesFixture) -> Instruction {
    let accounts = accounts::CloseSeries {
        series_closer: fixture.series_closer.pubkey(),
        market: fixture.market,
        market_operator: fixture.market_operator,
        base_mint: fixture.base_mint,
        quote_mint: fixture.quote_mint,
        series: fixture.series,
        base_collateral_vault: fixture.base_vault,
        quote_collateral_vault: fixture.quote_vault,
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    let mut account_metas = accounts.to_account_metas(None);
    if token_amount(&fixture.svm, fixture.base_vault) > 0 {
        account_metas.push(AccountMeta::new(fixture.closer_base_ata, false));
    }
    if token_amount(&fixture.svm, fixture.quote_vault) > 0 {
        account_metas.push(AccountMeta::new(fixture.closer_quote_ata, false));
    }
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: instruction::CloseSeries {}.data(),
    }
}

fn replace_market(fixture: &mut CloseSeriesFixture, update: impl FnOnce(&mut Market)) {
    let mut account = fixture.svm.get_account(&fixture.market).unwrap();
    let mut market = Market::try_deserialize(&mut account.data.as_slice()).unwrap();
    update(&mut market);
    let mut data = Vec::new();
    market.try_serialize(&mut data).unwrap();
    account.data = data;
    fixture.svm.set_account(fixture.market, account).unwrap();
}

fn replace_series(fixture: &mut CloseSeriesFixture, update: impl FnOnce(&mut Series)) {
    let mut account = fixture.svm.get_account(&fixture.series).unwrap();
    let mut series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    update(&mut series);
    let mut data = Vec::new();
    series.try_serialize(&mut data).unwrap();
    account.data = data;
    fixture.svm.set_account(fixture.series, account).unwrap();
}

#[test]
fn permissionless_closure_sends_dust_to_closer_and_rent_to_market_operator() {
    let mut fixture = closed_series_with_dust();
    assert!(fixture.svm.get_account(&fixture.closer_base_ata).is_none());
    assert!(fixture.svm.get_account(&fixture.closer_quote_ata).is_none());
    let operator_lamports_before = fixture
        .svm
        .get_account(&fixture.market_operator)
        .unwrap()
        .lamports;
    let transaction = Transaction::new_signed_with_payer(
        &[close_series_instruction(&fixture)],
        Some(&fixture.series_closer.pubkey()),
        &[&fixture.series_closer],
        fixture.svm.latest_blockhash(),
    );

    fixture.svm.send_transaction(transaction).unwrap();

    assert_eq!(token_amount(&fixture.svm, fixture.closer_base_ata), 7);
    assert_eq!(token_amount(&fixture.svm, fixture.closer_quote_ata), 9);
    assert!(fixture.svm.get_account(&fixture.base_vault).is_none());
    assert!(fixture.svm.get_account(&fixture.quote_vault).is_none());
    assert!(fixture.svm.get_account(&fixture.series).is_none());
    assert_eq!(
        fixture
            .svm
            .get_account(&fixture.market_operator)
            .unwrap()
            .lamports,
        operator_lamports_before + (ACCOUNT_RENT * 3),
    );
}

#[test]
fn closure_is_rejected_when_the_market_is_paused() {
    let mut fixture = closed_series_with_dust();
    replace_market(&mut fixture, |market| market.paused = true);
    let transaction = Transaction::new_signed_with_payer(
        &[close_series_instruction(&fixture)],
        Some(&fixture.series_closer.pubkey()),
        &[&fixture.series_closer],
        fixture.svm.latest_blockhash(),
    );

    assert!(fixture.svm.send_transaction(transaction).is_err());
    assert!(fixture.svm.get_account(&fixture.series).is_some());
}

#[test]
fn closure_is_rejected_before_the_exercise_window_ends() {
    let mut fixture = closed_series_with_dust();
    let mut clock = fixture.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from((EXERCISE_WINDOW_END_MS / 1_000) - 1).unwrap();
    fixture.svm.set_sysvar(&clock);
    let transaction = Transaction::new_signed_with_payer(
        &[close_series_instruction(&fixture)],
        Some(&fixture.series_closer.pubkey()),
        &[&fixture.series_closer],
        fixture.svm.latest_blockhash(),
    );

    assert!(fixture.svm.send_transaction(transaction).is_err());
    assert!(fixture.svm.get_account(&fixture.series).is_some());
}

#[test]
fn closure_is_rejected_until_all_seller_quantity_is_settled() {
    let mut fixture = closed_series_with_dust();
    replace_series(&mut fixture, |series| series.total_settled_quantity = 9);
    let transaction = Transaction::new_signed_with_payer(
        &[close_series_instruction(&fixture)],
        Some(&fixture.series_closer.pubkey()),
        &[&fixture.series_closer],
        fixture.svm.latest_blockhash(),
    );

    assert!(fixture.svm.send_transaction(transaction).is_err());
    assert!(fixture.svm.get_account(&fixture.series).is_some());
}

#[test]
fn closure_without_dust_does_not_require_or_create_closer_atas() {
    let mut fixture = closed_series_with_dust();
    let base_vault = fixture.base_vault;
    let base_mint = fixture.base_mint;
    let series = fixture.series;
    add_token_account(&mut fixture.svm, base_vault, base_mint, series, 0);
    let quote_vault = fixture.quote_vault;
    let quote_mint = fixture.quote_mint;
    add_token_account(&mut fixture.svm, quote_vault, quote_mint, series, 0);
    let transaction = Transaction::new_signed_with_payer(
        &[close_series_instruction(&fixture)],
        Some(&fixture.series_closer.pubkey()),
        &[&fixture.series_closer],
        fixture.svm.latest_blockhash(),
    );

    fixture.svm.send_transaction(transaction).unwrap();

    assert!(fixture.svm.get_account(&fixture.closer_base_ata).is_none());
    assert!(fixture.svm.get_account(&fixture.closer_quote_ata).is_none());
    assert!(fixture.svm.get_account(&fixture.series).is_none());
}
