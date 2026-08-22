use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use options::{
    accounts, instruction,
    state::{Market, Series, SeriesState},
    OracleConfig, ID as PROGRAM_ID,
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

fn add_market(svm: &mut LiteSVM, key: Pubkey, operator: Pubkey, paused: bool) {
    store_account(
        svm,
        key,
        &Market {
            oracle_config: OracleConfig::PythTwap { feed_id: FEED_ID },
            base_coin_scale: 1_000_000_000,
            quote_coin_scale: 1_000_000,
            operator,
            paused,
            quote_coin_mint: Pubkey::new_unique(),
            base_coin_mint: Pubkey::new_unique(),
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
            strike_price: 1_000_000,
            expiry_ms,
            exercise_window_end_ms: expiry_ms + 3_600_000,
            expiry_price: None,
            total_contracts_quantity: 0,
            total_manual_exercised_quantity: 0,
            total_settled_quantity: 0,
        },
    );
}

fn finalize_instruction(
    operator: Pubkey,
    market: Pubkey,
    series: Pubkey,
    id: [u8; 32],
    publish_time: i64,
) -> Instruction {
    let accounts = accounts::FinalizePythUnverifiedSeries { operator, market };
    let mut account_metas = accounts.to_account_metas(None);
    account_metas.push(AccountMeta::new(series, false));
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
fn operator_can_finalize_with_unverified_pyth_metadata() {
    let operator = Keypair::new();
    let market = Pubkey::new_unique();
    let series = Pubkey::new_unique();
    let mut svm = new_svm(EXPIRY_MS);
    svm.airdrop(&operator.pubkey(), 1_000_000_000).unwrap();
    add_market(&mut svm, market, operator.pubkey(), false);
    add_series(&mut svm, series, market, EXPIRY_MS);

    let transaction = Transaction::new_signed_with_payer(
        &[finalize_instruction(
            operator.pubkey(),
            market,
            series,
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
    assert_eq!(finalized.state, SeriesState::ExpirationPriceFinalized);
    assert_eq!(finalized.expiry_price, Some(1_234_568));
}

#[test]
fn only_the_market_operator_can_use_the_unverified_fallback() {
    let operator = Keypair::new();
    let caller = Keypair::new();
    let market = Pubkey::new_unique();
    let series = Pubkey::new_unique();
    let mut svm = new_svm(EXPIRY_MS);
    svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();
    add_market(&mut svm, market, operator.pubkey(), false);
    add_series(&mut svm, series, market, EXPIRY_MS);

    let transaction = Transaction::new_signed_with_payer(
        &[finalize_instruction(
            caller.pubkey(),
            market,
            series,
            [0; 32],
            0,
        )],
        Some(&caller.pubkey()),
        &[&caller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_err());
}
