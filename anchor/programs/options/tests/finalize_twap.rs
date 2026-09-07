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

fn add_finalization_vault(svm: &mut LiteSVM, series: Pubkey, quote_mint: Pubkey) -> Pubkey {
    let key = get_associated_token_address(&series, &quote_mint);
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
    key
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

fn add_market(svm: &mut LiteSVM, key: Pubkey) -> Pubkey {
    let quote_mint = Pubkey::new_unique();
    add_mint(svm, quote_mint);
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
            quote_coin_mint: quote_mint,
            base_coin_mint: Pubkey::new_unique(),
            min_fee: 0,
            min_operational_fee_bps: 0,
            max_operational_fee_bps: 0,
        },
    );
    quote_mint
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
    quote_collateral_vault: Pubkey,
) -> Instruction {
    let accounts = accounts::FinalizePythTwapSeries {
        caller,
        market,
        twap_update,
    };
    let mut account_metas = accounts.to_account_metas(None);
    account_metas.push(AccountMeta::new(series, false));
    account_metas.push(AccountMeta::new_readonly(quote_collateral_vault, false));
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: instruction::FinalizePythTwapSeries {}.data(),
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
    let quote_mint = add_market(&mut svm, market);
    add_series(&mut svm, series, market);
    let quote_collateral_vault = add_finalization_vault(&mut svm, series, quote_mint);
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
            quote_collateral_vault,
        )],
        Some(&caller.pubkey()),
        &[&caller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_ok());

    let account = svm.get_account(&series).unwrap();
    let finalized = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(finalized.state, SeriesState::ExpirationPriceFinalized);
    assert_eq!(finalized.expiry_price, Some(123_456_780));
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
        let quote_mint = add_market(&mut svm, market);
        add_series(&mut svm, series, market);
        let quote_collateral_vault = add_finalization_vault(&mut svm, series, quote_mint);
        add_twap(&mut svm, twap_update, owner, twap);

        let transaction = Transaction::new_signed_with_payer(
            &[finalize_instruction(
                caller.pubkey(),
                market,
                twap_update,
                series,
                quote_collateral_vault,
            )],
            Some(&caller.pubkey()),
            &[&caller],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(transaction).is_err());
    }
}
