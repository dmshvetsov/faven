use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use options::{
    accounts, instruction,
    state::{Market, Series, SeriesState},
    OptionType, OracleConfig, ID as PROGRAM_ID,
};
use solana_sdk::{
    account::Account,
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::Transaction,
};

const EXPIRY_MS: u64 = 2_000_000_000_000;

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

struct BatchFixture {
    svm: LiteSVM,
    operator: Keypair,
    market: Pubkey,
    series: Vec<Pubkey>,
}

fn batch_fixture(series_count: usize) -> BatchFixture {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000).unwrap();
    svm.set_sysvar(&clock);
    let operator = Keypair::new();
    let market = Pubkey::new_unique();
    svm.airdrop(&operator.pubkey(), 1_000_000_000).unwrap();
    store_account(
        &mut svm,
        market,
        &Market {
            oracle_config: OracleConfig::PythTwap { feed_id: [7; 32] },
            base_coin_scale: 1_000_000_000,
            quote_coin_scale: 1_000_000,
            operator: operator.pubkey(),
            paused: false,
            quote_coin_mint: Pubkey::new_unique(),
            base_coin_mint: Pubkey::new_unique(),
            min_fee: 0,
            min_operational_fee_bps: 0,
            max_operational_fee_bps: 0,
        },
    );
    let series = (0..series_count)
        .map(|_| {
            let key = Pubkey::new_unique();
            store_account(
                &mut svm,
                key,
                &Series {
                    state: SeriesState::Open,
                    market,
                    option_type: OptionType::Call,
                    strike_price: 1_000_000,
                    expiry_ms: EXPIRY_MS,
                    exercise_window_end_ms: EXPIRY_MS + 3_600_000,
                    expiry_price: None,
                    total_contracts_quantity: 0,
                    total_manual_exercised_quantity: 0,
                    total_settled_quantity: 0,
                    total_quote_amount: 0,
                },
            );
            key
        })
        .collect();
    BatchFixture {
        svm,
        operator,
        market,
        series,
    }
}

fn submit(fixture: &mut BatchFixture, series: &[Pubkey]) -> bool {
    let accounts = accounts::FinalizePythUnverifiedSeries {
        operator: fixture.operator.pubkey(),
        market: fixture.market,
    };
    let mut account_metas = accounts.to_account_metas(None);
    account_metas.extend(series.iter().map(|key| AccountMeta::new(*key, false)));
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction {
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
        }],
        Some(&fixture.operator.pubkey()),
        &[&fixture.operator],
        fixture.svm.latest_blockhash(),
    );
    fixture.svm.send_transaction(transaction).is_ok()
}

fn replace_market(fixture: &mut BatchFixture, paused: bool) {
    let mut account = fixture.svm.get_account(&fixture.market).unwrap();
    let mut market = Market::try_deserialize(&mut account.data.as_slice()).unwrap();
    market.paused = paused;
    let mut data = Vec::new();
    market.try_serialize(&mut data).unwrap();
    data.resize(Market::SPACE, 0);
    account.data = data;
    fixture.svm.set_account(fixture.market, account).unwrap();
}

fn replace_series(fixture: &mut BatchFixture, index: usize, market: Pubkey, expiry_ms: u64) {
    let key = fixture.series[index];
    let mut account = fixture.svm.get_account(&key).unwrap();
    let mut series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    series.market = market;
    series.expiry_ms = expiry_ms;
    let mut data = Vec::new();
    series.try_serialize(&mut data).unwrap();
    data.resize(Series::SPACE, 0);
    account.data = data;
    fixture.svm.set_account(key, account).unwrap();
}

fn assert_finalized(fixture: &BatchFixture) {
    for key in &fixture.series {
        let account = fixture.svm.get_account(key).unwrap();
        let series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
        assert_eq!(series.state, SeriesState::ExpirationPriceFinalized);
        assert_eq!(series.expiry_price, Some(1_234_568));
    }
}

#[test]
fn operator_can_finalize_nine_series() {
    let mut fixture = batch_fixture(9);
    let series = fixture.series.clone();
    assert!(submit(&mut fixture, &series));
    assert_finalized(&fixture);
}

#[test]
fn operator_can_finalize_sixteen_series() {
    let mut fixture = batch_fixture(16);
    let series = fixture.series.clone();
    assert!(submit(&mut fixture, &series));
    assert_finalized(&fixture);
}

#[test]
fn unverified_finalization_rejects_more_than_sixteen_series() {
    let mut fixture = batch_fixture(17);
    let series = fixture.series.clone();
    assert!(!submit(&mut fixture, &series));
}

#[test]
fn shared_finalization_rules_reject_invalid_batches() {
    let mut paused = batch_fixture(2);
    replace_market(&mut paused, true);
    let series = paused.series.clone();
    assert!(!submit(&mut paused, &series));

    let mut pre_expiry = batch_fixture(2);
    let mut clock = pre_expiry.svm.get_sysvar::<Clock>();
    clock.unix_timestamp -= 1;
    pre_expiry.svm.set_sysvar(&clock);
    let series = pre_expiry.series.clone();
    assert!(!submit(&mut pre_expiry, &series));

    let mut finalized = batch_fixture(2);
    let series = finalized.series.clone();
    assert!(submit(&mut finalized, &series));
    assert!(!submit(&mut finalized, &series));

    let mut wrong_market = batch_fixture(2);
    replace_series(&mut wrong_market, 1, Pubkey::new_unique(), EXPIRY_MS);
    let series = wrong_market.series.clone();
    assert!(!submit(&mut wrong_market, &series));

    let mut wrong_expiry = batch_fixture(2);
    let market = wrong_expiry.market;
    replace_series(&mut wrong_expiry, 1, market, EXPIRY_MS + 1_000);
    let series = wrong_expiry.series.clone();
    assert!(!submit(&mut wrong_expiry, &series));
}

#[test]
fn unverified_finalization_rejects_duplicate_series() {
    let mut fixture = batch_fixture(2);
    let series = [fixture.series[0], fixture.series[0]];
    assert!(!submit(&mut fixture, &series));
}
