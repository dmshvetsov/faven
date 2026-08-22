use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use options::{
    accounts, instruction,
    state::{Market, Series, SeriesState, PYTH_RECEIVER_PROGRAM_ID},
    OptionType, OracleConfig, ID as PROGRAM_ID,
};
use pyth_solana_receiver_sdk::price_update::{TwapPrice, TwapUpdate};
use solana_sdk::{
    account::Account, clock::Clock, instruction::Instruction, pubkey::Pubkey, signature::Keypair,
    signer::Signer, transaction::Transaction,
};

const EXPIRY_MS: u64 = 2_000_000_000_000;
const FEED_ID: [u8; 32] = [7; 32];

fn store<T: AccountSerialize>(svm: &mut LiteSVM, key: Pubkey, owner: Pubkey, value: &T) {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data.resize(data.len() + 16, 0);
    svm.set_account(
        key,
        Account {
            lamports: 1_000_000,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

struct Fixture {
    svm: LiteSVM,
    caller: Keypair,
    market: Pubkey,
    twap: Pubkey,
    series: Vec<Pubkey>,
}

fn fixture(series_count: usize) -> Fixture {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000).unwrap();
    svm.set_sysvar(&clock);

    let caller = Keypair::new();
    let market = Pubkey::new_unique();
    let twap = Pubkey::new_unique();
    svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();
    store(
        &mut svm,
        market,
        PROGRAM_ID,
        &Market {
            oracle_config: OracleConfig::PythTwap { feed_id: FEED_ID },
            base_coin_scale: 1_000_000_000,
            quote_coin_scale: 1_000_000,
            operator: Pubkey::new_unique(),
            paused: false,
            quote_coin_mint: Pubkey::new_unique(),
            base_coin_mint: Pubkey::new_unique(),
            min_fee: 0,
            min_operational_fee_bps: 0,
            max_operational_fee_bps: 0,
        },
    );
    store(
        &mut svm,
        twap,
        PYTH_RECEIVER_PROGRAM_ID,
        &TwapUpdate {
            write_authority: Pubkey::new_unique(),
            twap: TwapPrice {
                feed_id: FEED_ID,
                start_time: i64::try_from(EXPIRY_MS / 1_000).unwrap() - 60,
                end_time: i64::try_from(EXPIRY_MS / 1_000).unwrap(),
                price: 12_345_678,
                conf: 0,
                exponent: -7,
                down_slots_ratio: 0,
            },
        },
    );
    let series = (0..series_count)
        .map(|_| {
            let key = Pubkey::new_unique();
            store(
                &mut svm,
                key,
                PROGRAM_ID,
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
                },
            );
            key
        })
        .collect();
    Fixture {
        svm,
        caller,
        market,
        twap,
        series,
    }
}

fn send<T: InstructionData>(
    fixture: &mut Fixture,
    accounts: Vec<solana_sdk::instruction::AccountMeta>,
    data: T,
) {
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: data.data(),
        }],
        Some(&fixture.caller.pubkey()),
        &[&fixture.caller],
        fixture.svm.latest_blockhash(),
    );
    assert!(fixture.svm.send_transaction(transaction).is_ok());
}

fn assert_finalized(fixture: &Fixture) {
    for key in &fixture.series {
        let account = fixture.svm.get_account(key).unwrap();
        let series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
        assert_eq!(series.expiry_price, Some(1_234_568));
    }
}

#[test]
fn any_signer_can_finalize_two_series_from_one_twap() {
    let mut fixture = fixture(2);
    let accounts = accounts::FinalizePythTwapTwoSeries {
        caller: fixture.caller.pubkey(),
        market: fixture.market,
        twap_update: fixture.twap,
        series_one: fixture.series[0],
        series_two: fixture.series[1],
    };
    send(
        &mut fixture,
        accounts.to_account_metas(None),
        instruction::FinalizePythTwapTwoSeries {},
    );
    assert_finalized(&fixture);
}

#[test]
fn any_signer_can_finalize_four_series_from_one_twap() {
    let mut fixture = fixture(4);
    let accounts = accounts::FinalizePythTwapFourSeries {
        caller: fixture.caller.pubkey(),
        market: fixture.market,
        twap_update: fixture.twap,
        series_one: fixture.series[0],
        series_two: fixture.series[1],
        series_three: fixture.series[2],
        series_four: fixture.series[3],
    };
    send(
        &mut fixture,
        accounts.to_account_metas(None),
        instruction::FinalizePythTwapFourSeries {},
    );
    assert_finalized(&fixture);
}

#[test]
fn any_signer_can_finalize_eight_series_from_one_twap() {
    let mut fixture = fixture(8);
    let accounts = accounts::FinalizePythTwapEightSeries {
        caller: fixture.caller.pubkey(),
        market: fixture.market,
        twap_update: fixture.twap,
        series_one: fixture.series[0],
        series_two: fixture.series[1],
        series_three: fixture.series[2],
        series_four: fixture.series[3],
        series_five: fixture.series[4],
        series_six: fixture.series[5],
        series_seven: fixture.series[6],
        series_eight: fixture.series[7],
    };
    send(
        &mut fixture,
        accounts.to_account_metas(None),
        instruction::FinalizePythTwapEightSeries {},
    );
    assert_finalized(&fixture);
}
