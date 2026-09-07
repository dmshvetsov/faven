use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use litesvm::LiteSVM;
use options::{
    accounts, instruction,
    state::{Market, Series, SeriesState, PYTH_RECEIVER_PROGRAM_ID},
    OptionType, OracleConfig, ID as PROGRAM_ID,
};
use pyth_solana_receiver_sdk::price_update::{TwapPrice, TwapUpdate};
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

fn add_mint(svm: &mut LiteSVM, key: Pubkey) {
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
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn add_finalization_vault(svm: &mut LiteSVM, series: Pubkey, quote_mint: Pubkey) {
    let token_account = SplTokenAccount {
        mint: quote_mint,
        owner: series,
        amount: 0,
        delegate: solana_sdk::program_option::COption::None,
        state: AccountState::Initialized,
        is_native: solana_sdk::program_option::COption::None,
        delegated_amount: 0,
        close_authority: solana_sdk::program_option::COption::None,
    };
    let mut data = vec![0; SplTokenAccount::LEN];
    SplTokenAccount::pack(token_account, &mut data).unwrap();
    svm.set_account(
        get_associated_token_address(&series, &quote_mint),
        Account {
            lamports: 1_000_000,
            data,
            owner: TOKEN_PROGRAM_ID,
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
    quote_mint: Pubkey,
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
    let quote_mint = Pubkey::new_unique();
    let twap = Pubkey::new_unique();
    svm.airdrop(&caller.pubkey(), 1_000_000_000).unwrap();
    add_mint(&mut svm, quote_mint);
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
            quote_coin_mint: quote_mint,
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
                    strike_price: 100_000_000,
                    expiry_ms: EXPIRY_MS,
                    exercise_window_end_ms: EXPIRY_MS + 3_600_000,
                    expiry_price: None,
                    total_contracts_quantity: 1,
                    total_manual_exercised_quantity: 0,
                    total_settled_quantity: 0,
                    total_quote_amount: 0,
                },
            );
            add_finalization_vault(&mut svm, key, quote_mint);
            key
        })
        .collect();
    Fixture {
        svm,
        caller,
        market,
        quote_mint,
        twap,
        series,
    }
}

fn submit(fixture: &mut Fixture, series: &[Pubkey]) -> bool {
    let accounts = accounts::FinalizePythTwapSeries {
        caller: fixture.caller.pubkey(),
        market: fixture.market,
        twap_update: fixture.twap,
    };
    let mut account_metas = accounts.to_account_metas(None);
    for key in series {
        account_metas.push(AccountMeta::new(*key, false));
        account_metas.push(AccountMeta::new_readonly(
            get_associated_token_address(key, &fixture.quote_mint),
            false,
        ));
    }
    let transaction = Transaction::new_signed_with_payer(
        &[Instruction {
            program_id: PROGRAM_ID,
            accounts: account_metas,
            data: instruction::FinalizePythTwapSeries {}.data(),
        }],
        Some(&fixture.caller.pubkey()),
        &[&fixture.caller],
        fixture.svm.latest_blockhash(),
    );
    fixture.svm.send_transaction(transaction).is_ok()
}

fn assert_finalized(fixture: &Fixture) {
    for key in &fixture.series {
        let account = fixture.svm.get_account(key).unwrap();
        let series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
        assert_eq!(series.expiry_price, Some(123_456_780));
    }
}

#[test]
fn any_signer_can_finalize_nine_series_from_one_twap() {
    let mut fixture = fixture(9);
    let series = fixture.series.clone();
    assert!(submit(&mut fixture, &series));
    assert_finalized(&fixture);
}

#[test]
fn any_signer_can_finalize_sixteen_series_from_one_twap() {
    let mut fixture = fixture(16);
    let series = fixture.series.clone();
    assert!(submit(&mut fixture, &series));
    assert_finalized(&fixture);
}

#[test]
fn twap_finalization_rejects_more_than_sixteen_series() {
    let mut fixture = fixture(17);
    let series = fixture.series.clone();
    assert!(!submit(&mut fixture, &series));
}

#[test]
fn twap_finalization_rejects_duplicate_series() {
    let mut fixture = fixture(2);
    let series = [fixture.series[0], fixture.series[0]];
    assert!(!submit(&mut fixture, &series));
}
