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

fn store_account<T: AccountSerialize>(svm: &mut LiteSVM, key: Pubkey, owner: Pubkey, value: &T) {
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

fn new_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000).unwrap();
    svm.set_sysvar(&clock);
    svm
}

fn add_market(svm: &mut LiteSVM, key: Pubkey) {
    store_account(
        svm,
        key,
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
}

fn add_series(svm: &mut LiteSVM, key: Pubkey, market: Pubkey) {
    store_account(
        svm,
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
}

fn add_twap(svm: &mut LiteSVM, key: Pubkey, owner: Pubkey, twap: TwapPrice) {
    store_account(
        svm,
        key,
        owner,
        &TwapUpdate {
            write_authority: Pubkey::new_unique(),
            twap,
        },
    );
}

fn valid_twap() -> TwapPrice {
    TwapPrice {
        feed_id: FEED_ID,
        start_time: i64::try_from(EXPIRY_MS / 1_000).unwrap() - 60,
        end_time: i64::try_from(EXPIRY_MS / 1_000).unwrap(),
        price: 12_345_678,
        conf: 42,
        exponent: -7,
        down_slots_ratio: 500_000,
    }
}

fn finalize_instruction(
    caller: Pubkey,
    market: Pubkey,
    twap_update: Pubkey,
    series: Pubkey,
) -> Instruction {
    let accounts = accounts::FinalizePythTwapOneSeries {
        caller,
        market,
        twap_update,
        series_one: series,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::FinalizePythTwapOneSeries {}.data(),
    }
}

#[test]
fn any_signer_can_finalize_from_a_valid_twap() {
    let caller = Keypair::new();
    let market = Pubkey::new_unique();
    let twap_update = Pubkey::new_unique();
    let series = Pubkey::new_unique();
    let mut svm = new_svm();
    svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();
    add_market(&mut svm, market);
    add_series(&mut svm, series, market);
    add_twap(
        &mut svm,
        twap_update,
        PYTH_RECEIVER_PROGRAM_ID,
        valid_twap(),
    );

    let transaction = Transaction::new_signed_with_payer(
        &[finalize_instruction(
            caller.pubkey(),
            market,
            twap_update,
            series,
        )],
        Some(&caller.pubkey()),
        &[&caller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_ok());

    let account = svm.get_account(&series).unwrap();
    let finalized = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(finalized.state, SeriesState::ExpirationPriceFinalized);
    assert_eq!(finalized.expiry_price, Some(1_234_568));
}

#[test]
fn twap_finalization_rejects_invalid_receiver_data() {
    let cases = [
        (Pubkey::new_unique(), valid_twap()),
        (
            PYTH_RECEIVER_PROGRAM_ID,
            TwapPrice {
                feed_id: [8; 32],
                ..valid_twap()
            },
        ),
        (
            PYTH_RECEIVER_PROGRAM_ID,
            TwapPrice {
                start_time: valid_twap().start_time - 1,
                ..valid_twap()
            },
        ),
        (
            PYTH_RECEIVER_PROGRAM_ID,
            TwapPrice {
                down_slots_ratio: 500_001,
                ..valid_twap()
            },
        ),
    ];

    for (owner, twap) in cases {
        let caller = Keypair::new();
        let market = Pubkey::new_unique();
        let twap_update = Pubkey::new_unique();
        let series = Pubkey::new_unique();
        let mut svm = new_svm();
        svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();
        add_market(&mut svm, market);
        add_series(&mut svm, series, market);
        add_twap(&mut svm, twap_update, owner, twap);

        let transaction = Transaction::new_signed_with_payer(
            &[finalize_instruction(
                caller.pubkey(),
                market,
                twap_update,
                series,
            )],
            Some(&caller.pubkey()),
            &[&caller],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(transaction).is_err());
    }
}
