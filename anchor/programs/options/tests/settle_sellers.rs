use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::{get_associated_token_address, ID as ASSOCIATED_TOKEN_PROGRAM_ID},
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use litesvm::LiteSVM;
use options::{
    accounts, instruction,
    state::{
        Market, OptionType, OracleConfig, SellerVault, Series, SeriesState, SELLER_VAULT_SEED,
        SERIES_SEED,
    },
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
const STRIKE: u64 = 3_500_000;
const ACCOUNT_RENT: u64 = 1_000_000;

fn add_mint(svm: &mut LiteSVM, key: Pubkey, decimals: u8) {
    let mint = Mint {
        mint_authority: solana_sdk::program_option::COption::None,
        supply: 0,
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
            lamports: 1_000_000,
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
    SplTokenAccount::unpack(&account.data).unwrap().amount
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

fn seller_vault_address(market: Pubkey, seller: Pubkey, option_type: OptionType) -> Pubkey {
    Pubkey::find_program_address(
        &[
            SELLER_VAULT_SEED,
            market.as_ref(),
            &[option_type.marker()],
            &EXPIRY_MS.to_le_bytes(),
            &STRIKE.to_le_bytes(),
            seller.as_ref(),
        ],
        &PROGRAM_ID,
    )
    .0
}

struct SettlementFixture {
    svm: LiteSVM,
    settler: Keypair,
    seller: Pubkey,
    option_type: OptionType,
    market: Pubkey,
    series: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    base_vault: Pubkey,
    quote_vault: Pubkey,
    seller_vault: Pubkey,
    seller_base_ata: Pubkey,
    seller_quote_ata: Pubkey,
}

fn atm_call_fixture() -> SettlementFixture {
    settlement_fixture(OptionType::Call, false, true)
}

fn settlement_fixture(
    option_type: OptionType,
    seller_is_settler: bool,
    create_seller_payout_atas: bool,
) -> SettlementFixture {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();
    let settler = Keypair::new();
    let seller = if seller_is_settler {
        settler.pubkey()
    } else {
        Pubkey::new_unique()
    };
    let operator = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let market = Pubkey::new_unique();
    let series = series_address(market, option_type);
    let seller_vault = seller_vault_address(market, seller, option_type);
    let base_vault = get_associated_token_address(&series, &base_mint);
    let quote_vault = get_associated_token_address(&series, &quote_mint);
    let seller_base_ata = get_associated_token_address(&seller, &base_mint);
    let seller_quote_ata = get_associated_token_address(&seller, &quote_mint);

    svm.airdrop(&settler.pubkey(), 10_000_000_000).unwrap();
    add_mint(&mut svm, base_mint, 0);
    add_mint(&mut svm, quote_mint, 0);
    let (base_collateral, quote_collateral) = match option_type {
        OptionType::Call => (10, 0),
        OptionType::Put => (0, 10),
    };
    store_account(
        &mut svm,
        market,
        &Market {
            oracle_config: OracleConfig::PythTwap { feed_id: [1; 32] },
            base_coin_scale: 1,
            quote_coin_scale: 1,
            operator,
            paused: false,
            quote_coin_mint: quote_mint,
            base_coin_mint: base_mint,
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
            expiry_price: Some(STRIKE),
            total_contracts_quantity: 10,
            total_manual_exercised_quantity: 0,
            total_settled_quantity: 0,
            total_quote_amount: 0,
        },
    );
    store_account(
        &mut svm,
        seller_vault,
        &SellerVault {
            owner: seller,
            series,
            short_quantity: 10,
            collateral_quantity: 10,
        },
    );
    add_token_account(&mut svm, base_vault, base_mint, series, base_collateral);
    add_token_account(&mut svm, quote_vault, quote_mint, series, quote_collateral);
    if create_seller_payout_atas {
        add_token_account(&mut svm, seller_base_ata, base_mint, seller, 0);
        add_token_account(&mut svm, seller_quote_ata, quote_mint, seller, 0);
    } else {
        svm.airdrop(&seller, 1_000_000).unwrap();
    }
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000).unwrap();
    svm.set_sysvar(&clock);

    SettlementFixture {
        svm,
        settler,
        seller,
        option_type,
        market,
        series,
        base_mint,
        quote_mint,
        base_vault,
        quote_vault,
        seller_vault,
        seller_base_ata,
        seller_quote_ata,
    }
}

fn replace_series(fixture: &mut SettlementFixture, update: impl FnOnce(&mut Series)) {
    let mut account = fixture.svm.get_account(&fixture.series).unwrap();
    let mut series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    update(&mut series);
    let mut data = Vec::new();
    series.try_serialize(&mut data).unwrap();
    account.data = data;
    fixture.svm.set_account(fixture.series, account).unwrap();
}

fn replace_market(fixture: &mut SettlementFixture, update: impl FnOnce(&mut Market)) {
    let mut account = fixture.svm.get_account(&fixture.market).unwrap();
    let mut market = Market::try_deserialize(&mut account.data.as_slice()).unwrap();
    update(&mut market);
    let mut data = Vec::new();
    market.try_serialize(&mut data).unwrap();
    account.data = data;
    fixture.svm.set_account(fixture.market, account).unwrap();
}

fn replace_token_account(
    fixture: &mut SettlementFixture,
    key: Pubkey,
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
) {
    add_token_account(&mut fixture.svm, key, mint, owner, amount);
}

fn settle_instruction(fixture: &SettlementFixture) -> Instruction {
    let accounts = accounts::SettleSellersBatch {
        settler: fixture.settler.pubkey(),
        market: fixture.market,
        series: fixture.series,
        base_coin_mint: fixture.base_mint,
        quote_coin_mint: fixture.quote_mint,
        base_collateral_vault: fixture.base_vault,
        quote_collateral_vault: fixture.quote_vault,
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    let mut account_metas = accounts.to_account_metas(None);
    account_metas.push(AccountMeta::new(fixture.seller_vault, false));
    account_metas.push(AccountMeta::new(fixture.seller_base_ata, false));
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: instruction::SettleSellersBatch {}.data(),
    }
}

fn empty_settlement_instruction(fixture: &SettlementFixture) -> Instruction {
    let accounts = accounts::SettleSellersBatch {
        settler: fixture.settler.pubkey(),
        market: fixture.market,
        series: fixture.series,
        base_coin_mint: fixture.base_mint,
        quote_coin_mint: fixture.quote_mint,
        base_collateral_vault: fixture.base_vault,
        quote_collateral_vault: fixture.quote_vault,
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::SettleSellersBatch {}.data(),
    }
}

fn settle_instruction_with_payouts(
    fixture: &SettlementFixture,
    seller_vault: Pubkey,
    base_ata: Option<Pubkey>,
    quote_ata: Option<Pubkey>,
    seller: Option<Pubkey>,
) -> Instruction {
    let accounts = accounts::SettleSellersBatch {
        settler: fixture.settler.pubkey(),
        market: fixture.market,
        series: fixture.series,
        base_coin_mint: fixture.base_mint,
        quote_coin_mint: fixture.quote_mint,
        base_collateral_vault: fixture.base_vault,
        quote_collateral_vault: fixture.quote_vault,
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    let mut account_metas = accounts.to_account_metas(None);
    account_metas.push(AccountMeta::new(seller_vault, false));
    if let Some(base_ata) = base_ata {
        account_metas.push(AccountMeta::new(base_ata, false));
    }
    if let Some(quote_ata) = quote_ata {
        account_metas.push(AccountMeta::new(quote_ata, false));
    }
    if let Some(seller) = seller {
        account_metas.push(AccountMeta::new_readonly(seller, false));
    }
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: instruction::SettleSellersBatch {}.data(),
    }
}

fn send_settlement(fixture: &mut SettlementFixture, instruction: Instruction) -> bool {
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&fixture.settler.pubkey()),
        &[&fixture.settler],
        fixture.svm.latest_blockhash(),
    );
    fixture.svm.send_transaction(transaction).is_ok()
}

fn set_after_exercise_window(fixture: &mut SettlementFixture) {
    let mut clock = fixture.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from((EXPIRY_MS + 3_600_000) / 1_000).unwrap();
    fixture.svm.set_sysvar(&clock);
}

fn add_seller(
    fixture: &mut SettlementFixture,
    seller: Pubkey,
    short_quantity: u64,
    collateral_quantity: u64,
) -> (Pubkey, Pubkey, Pubkey) {
    let seller_vault = seller_vault_address(fixture.market, seller, fixture.option_type);
    let base_ata = get_associated_token_address(&seller, &fixture.base_mint);
    let quote_ata = get_associated_token_address(&seller, &fixture.quote_mint);
    store_account(
        &mut fixture.svm,
        seller_vault,
        &SellerVault {
            owner: seller,
            series: fixture.series,
            short_quantity,
            collateral_quantity,
        },
    );
    add_token_account(&mut fixture.svm, base_ata, fixture.base_mint, seller, 0);
    add_token_account(&mut fixture.svm, quote_ata, fixture.quote_mint, seller, 0);
    (seller_vault, base_ata, quote_ata)
}

#[test]
fn permissionless_atm_call_settlement_returns_exact_collateral_and_closes_the_series() {
    let mut fixture = atm_call_fixture();
    let transaction = Transaction::new_signed_with_payer(
        &[settle_instruction(&fixture)],
        Some(&fixture.settler.pubkey()),
        &[&fixture.settler],
        fixture.svm.latest_blockhash(),
    );

    fixture.svm.send_transaction(transaction).unwrap();
    assert_eq!(token_amount(&fixture.svm, fixture.seller_base_ata), 10);
    assert!(fixture.svm.get_account(&fixture.seller_vault).is_none());
    let series_account = fixture.svm.get_account(&fixture.series).unwrap();
    let series = Series::try_deserialize(&mut series_account.data.as_slice()).unwrap();
    assert_eq!(series.total_settled_quantity, 10);
    assert_eq!(series.state, SeriesState::Closed);
    assert_ne!(fixture.seller, fixture.settler.pubkey());
}

#[test]
fn itm_call_partial_settlement_returns_floor_pro_rata_base_and_quote_pools() {
    let mut fixture = atm_call_fixture();
    replace_series(&mut fixture, |series| {
        series.expiry_price = Some(STRIKE + 1);
        series.total_manual_exercised_quantity = 4;
        series.total_quote_amount = 14;
        series.total_contracts_quantity = 10;
    });
    let seller = fixture.seller;
    let seller_vault = fixture.seller_vault;
    let series = fixture.series;
    store_account(
        &mut fixture.svm,
        seller_vault,
        &SellerVault {
            owner: seller,
            series,
            short_quantity: 5,
            collateral_quantity: 5,
        },
    );
    let base_vault = fixture.base_vault;
    let base_mint = fixture.base_mint;
    replace_token_account(&mut fixture, base_vault, base_mint, series, 6);
    let quote_vault = fixture.quote_vault;
    let quote_mint = fixture.quote_mint;
    replace_token_account(&mut fixture, quote_vault, quote_mint, series, 14);
    let mut clock = fixture.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from((EXPIRY_MS + 3_600_000) / 1_000).unwrap();
    fixture.svm.set_sysvar(&clock);

    let mut instruction = settle_instruction(&fixture);
    instruction
        .accounts
        .push(AccountMeta::new(fixture.seller_quote_ata, false));
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&fixture.settler.pubkey()),
        &[&fixture.settler],
        fixture.svm.latest_blockhash(),
    );

    fixture.svm.send_transaction(transaction).unwrap();
    assert_eq!(token_amount(&fixture.svm, fixture.seller_base_ata), 3);
    assert_eq!(token_amount(&fixture.svm, fixture.seller_quote_ata), 7);
}

#[test]
fn atm_and_otm_put_settlement_return_exact_quote_collateral() {
    for expiry_price in [STRIKE, STRIKE + 1] {
        let mut fixture = settlement_fixture(OptionType::Put, false, true);
        replace_series(&mut fixture, |series| {
            series.expiry_price = Some(expiry_price)
        });
        let instruction = settle_instruction_with_payouts(
            &fixture,
            fixture.seller_vault,
            None,
            Some(fixture.seller_quote_ata),
            None,
        );

        assert!(send_settlement(&mut fixture, instruction));
        assert_eq!(token_amount(&fixture.svm, fixture.seller_quote_ata), 10);
        assert!(fixture.svm.get_account(&fixture.seller_vault).is_none());
    }
}

#[test]
fn otm_call_settlement_returns_exact_base_collateral() {
    let mut fixture = atm_call_fixture();
    replace_series(&mut fixture, |series| {
        series.expiry_price = Some(STRIKE - 1)
    });
    let instruction = settle_instruction(&fixture);

    assert!(send_settlement(&mut fixture, instruction));
    assert_eq!(token_amount(&fixture.svm, fixture.seller_base_ata), 10);
    assert!(fixture.svm.get_account(&fixture.seller_vault).is_none());
}

#[test]
fn itm_zero_exercise_returns_exact_collateral_for_calls_and_puts() {
    for option_type in [OptionType::Call, OptionType::Put] {
        let mut fixture = settlement_fixture(option_type, false, true);
        replace_series(&mut fixture, |series| {
            series.expiry_price = Some(match option_type {
                OptionType::Call => STRIKE + 1,
                OptionType::Put => STRIKE - 1,
            });
        });
        set_after_exercise_window(&mut fixture);
        let instruction = match option_type {
            OptionType::Call => settle_instruction_with_payouts(
                &fixture,
                fixture.seller_vault,
                Some(fixture.seller_base_ata),
                None,
                None,
            ),
            OptionType::Put => settle_instruction_with_payouts(
                &fixture,
                fixture.seller_vault,
                None,
                Some(fixture.seller_quote_ata),
                None,
            ),
        };

        assert!(send_settlement(&mut fixture, instruction));
        let payout_ata = match option_type {
            OptionType::Call => fixture.seller_base_ata,
            OptionType::Put => fixture.seller_quote_ata,
        };
        assert_eq!(token_amount(&fixture.svm, payout_ata), 10);
    }
}

#[test]
fn itm_put_partial_settlement_returns_floor_pro_rata_base_and_quote_pools() {
    let mut fixture = settlement_fixture(OptionType::Put, false, true);
    replace_series(&mut fixture, |series| {
        series.expiry_price = Some(STRIKE - 1);
        series.total_manual_exercised_quantity = 4;
        series.total_quote_amount = 14;
        series.total_contracts_quantity = 10;
    });
    let seller = fixture.seller;
    let seller_vault = fixture.seller_vault;
    let series = fixture.series;
    store_account(
        &mut fixture.svm,
        seller_vault,
        &SellerVault {
            owner: seller,
            series,
            short_quantity: 5,
            collateral_quantity: 5,
        },
    );
    let base_vault = fixture.base_vault;
    let base_mint = fixture.base_mint;
    replace_token_account(&mut fixture, base_vault, base_mint, series, 4);
    let quote_vault = fixture.quote_vault;
    let quote_mint = fixture.quote_mint;
    replace_token_account(&mut fixture, quote_vault, quote_mint, series, 14);
    set_after_exercise_window(&mut fixture);
    let instruction = settle_instruction_with_payouts(
        &fixture,
        fixture.seller_vault,
        Some(fixture.seller_base_ata),
        Some(fixture.seller_quote_ata),
        None,
    );

    assert!(send_settlement(&mut fixture, instruction));
    assert_eq!(token_amount(&fixture.svm, fixture.seller_base_ata), 2);
    assert_eq!(token_amount(&fixture.svm, fixture.seller_quote_ata), 7);
}

#[test]
fn itm_full_exercise_pays_quote_for_calls_and_base_for_puts() {
    let mut call_fixture = settlement_fixture(OptionType::Call, false, true);
    replace_series(&mut call_fixture, |series| {
        series.expiry_price = Some(STRIKE + 1);
        series.total_manual_exercised_quantity = 10;
        series.total_quote_amount = 15;
    });
    let call_series = call_fixture.series;
    let call_quote_vault = call_fixture.quote_vault;
    let call_quote_mint = call_fixture.quote_mint;
    replace_token_account(
        &mut call_fixture,
        call_quote_vault,
        call_quote_mint,
        call_series,
        15,
    );
    set_after_exercise_window(&mut call_fixture);
    let call_instruction = settle_instruction_with_payouts(
        &call_fixture,
        call_fixture.seller_vault,
        None,
        Some(call_fixture.seller_quote_ata),
        None,
    );
    assert!(send_settlement(&mut call_fixture, call_instruction));
    assert_eq!(
        token_amount(&call_fixture.svm, call_fixture.seller_base_ata),
        0
    );
    assert_eq!(
        token_amount(&call_fixture.svm, call_fixture.seller_quote_ata),
        15
    );

    let mut put_fixture = settlement_fixture(OptionType::Put, false, true);
    replace_series(&mut put_fixture, |series| {
        series.expiry_price = Some(STRIKE - 1);
        series.total_manual_exercised_quantity = 10;
        series.total_quote_amount = 4;
    });
    let put_series = put_fixture.series;
    let put_base_vault = put_fixture.base_vault;
    let put_base_mint = put_fixture.base_mint;
    replace_token_account(
        &mut put_fixture,
        put_base_vault,
        put_base_mint,
        put_series,
        10,
    );
    set_after_exercise_window(&mut put_fixture);
    let put_instruction = settle_instruction_with_payouts(
        &put_fixture,
        put_fixture.seller_vault,
        Some(put_fixture.seller_base_ata),
        None,
        None,
    );
    assert!(send_settlement(&mut put_fixture, put_instruction));
    assert_eq!(
        token_amount(&put_fixture.svm, put_fixture.seller_base_ata),
        10
    );
    assert_eq!(
        token_amount(&put_fixture.svm, put_fixture.seller_quote_ata),
        0
    );
}

#[test]
fn separate_settlement_batches_use_the_original_pro_rata_pools() {
    let mut fixture = atm_call_fixture();
    replace_series(&mut fixture, |series| {
        series.expiry_price = Some(STRIKE + 1);
        series.total_manual_exercised_quantity = 4;
        series.total_quote_amount = 13;
    });
    let seller = fixture.seller;
    let seller_vault = fixture.seller_vault;
    let series = fixture.series;
    store_account(
        &mut fixture.svm,
        seller_vault,
        &SellerVault {
            owner: seller,
            series,
            short_quantity: 3,
            collateral_quantity: 3,
        },
    );
    let base_vault = fixture.base_vault;
    let base_mint = fixture.base_mint;
    replace_token_account(&mut fixture, base_vault, base_mint, series, 6);
    let quote_vault = fixture.quote_vault;
    let quote_mint = fixture.quote_mint;
    replace_token_account(&mut fixture, quote_vault, quote_mint, series, 13);
    let second_seller = Pubkey::new_unique();
    let (second_vault, second_base_ata, second_quote_ata) =
        add_seller(&mut fixture, second_seller, 7, 7);
    set_after_exercise_window(&mut fixture);

    let first_instruction = settle_instruction_with_payouts(
        &fixture,
        fixture.seller_vault,
        Some(fixture.seller_base_ata),
        Some(fixture.seller_quote_ata),
        None,
    );
    assert!(send_settlement(&mut fixture, first_instruction));
    assert_eq!(token_amount(&fixture.svm, fixture.seller_base_ata), 1);
    assert_eq!(token_amount(&fixture.svm, fixture.seller_quote_ata), 3);

    let second_instruction = settle_instruction_with_payouts(
        &fixture,
        second_vault,
        Some(second_base_ata),
        Some(second_quote_ata),
        None,
    );
    assert!(send_settlement(&mut fixture, second_instruction));
    assert_eq!(token_amount(&fixture.svm, second_base_ata), 4);
    assert_eq!(token_amount(&fixture.svm, second_quote_ata), 9);
    assert_eq!(token_amount(&fixture.svm, fixture.base_vault), 1);
    assert_eq!(token_amount(&fixture.svm, fixture.quote_vault), 1);
    let series_account = fixture.svm.get_account(&fixture.series).unwrap();
    let series = Series::try_deserialize(&mut series_account.data.as_slice()).unwrap();
    assert_eq!(series.total_settled_quantity, 10);
    assert_eq!(series.state, SeriesState::Closed);
}

#[test]
fn seller_can_self_settle_and_third_party_funds_a_missing_payout_ata() {
    let mut self_fixture = settlement_fixture(OptionType::Call, true, true);
    let self_instruction = settle_instruction_with_payouts(
        &self_fixture,
        self_fixture.seller_vault,
        Some(self_fixture.seller_base_ata),
        None,
        None,
    );
    assert!(send_settlement(&mut self_fixture, self_instruction));
    assert_eq!(
        token_amount(&self_fixture.svm, self_fixture.seller_base_ata),
        10
    );

    let mut fixture = settlement_fixture(OptionType::Call, false, false);
    let settler_lamports_before = fixture
        .svm
        .get_account(&fixture.settler.pubkey())
        .unwrap()
        .lamports;
    assert!(fixture.svm.get_account(&fixture.seller_base_ata).is_none());
    let instruction = settle_instruction_with_payouts(
        &fixture,
        fixture.seller_vault,
        Some(fixture.seller_base_ata),
        None,
        Some(fixture.seller),
    );
    assert!(send_settlement(&mut fixture, instruction));
    assert_eq!(token_amount(&fixture.svm, fixture.seller_base_ata), 10);
    assert!(fixture.svm.get_account(&fixture.seller_vault).is_none());
    assert!(
        fixture
            .svm
            .get_account(&fixture.settler.pubkey())
            .unwrap()
            .lamports
            < settler_lamports_before,
    );
}

#[test]
fn seller_vault_rent_is_routed_to_the_settler() {
    let mut fixture = atm_call_fixture();
    let settler_lamports_before = fixture
        .svm
        .get_account(&fixture.settler.pubkey())
        .unwrap()
        .lamports;
    let instruction = settle_instruction(&fixture);

    assert!(send_settlement(&mut fixture, instruction));
    assert!(
        fixture
            .svm
            .get_account(&fixture.settler.pubkey())
            .unwrap()
            .lamports
            > settler_lamports_before + (ACCOUNT_RENT / 2),
    );
}

#[test]
fn settlement_rejects_paused_empty_duplicate_and_already_closed_batches() {
    let mut paused_fixture = atm_call_fixture();
    replace_market(&mut paused_fixture, |market| market.paused = true);
    let paused_instruction = settle_instruction(&paused_fixture);
    assert!(!send_settlement(&mut paused_fixture, paused_instruction));

    let mut empty_fixture = atm_call_fixture();
    let empty_instruction = empty_settlement_instruction(&empty_fixture);
    assert!(!send_settlement(&mut empty_fixture, empty_instruction));

    let mut duplicate_fixture = atm_call_fixture();
    let mut duplicate_instruction = settle_instruction(&duplicate_fixture);
    duplicate_instruction
        .accounts
        .push(AccountMeta::new(duplicate_fixture.seller_vault, false));
    duplicate_instruction
        .accounts
        .push(AccountMeta::new(duplicate_fixture.seller_base_ata, false));
    assert!(!send_settlement(
        &mut duplicate_fixture,
        duplicate_instruction
    ));

    let mut closed_fixture = atm_call_fixture();
    let instruction = settle_instruction(&closed_fixture);
    assert!(send_settlement(&mut closed_fixture, instruction));
    let closed_instruction = settle_instruction(&closed_fixture);
    assert!(!send_settlement(&mut closed_fixture, closed_instruction));
}

#[test]
fn settlement_rejects_wrong_series_malformed_and_wrong_pda_seller_vaults() {
    let mut wrong_series_fixture = atm_call_fixture();
    let seller = wrong_series_fixture.seller;
    let seller_vault = wrong_series_fixture.seller_vault;
    store_account(
        &mut wrong_series_fixture.svm,
        seller_vault,
        &SellerVault {
            owner: seller,
            series: Pubkey::new_unique(),
            short_quantity: 10,
            collateral_quantity: 10,
        },
    );
    let wrong_series_instruction = settle_instruction(&wrong_series_fixture);
    assert!(!send_settlement(
        &mut wrong_series_fixture,
        wrong_series_instruction
    ));

    let mut malformed_fixture = atm_call_fixture();
    let malformed_instruction = settle_instruction_with_payouts(
        &malformed_fixture,
        malformed_fixture.seller_vault,
        None,
        None,
        None,
    );
    assert!(!send_settlement(
        &mut malformed_fixture,
        malformed_instruction
    ));

    let mut wrong_pda_fixture = atm_call_fixture();
    let wrong_vault = Pubkey::new_unique();
    let seller = wrong_pda_fixture.seller;
    let series = wrong_pda_fixture.series;
    store_account(
        &mut wrong_pda_fixture.svm,
        wrong_vault,
        &SellerVault {
            owner: seller,
            series,
            short_quantity: 10,
            collateral_quantity: 10,
        },
    );
    let wrong_pda_instruction = settle_instruction_with_payouts(
        &wrong_pda_fixture,
        wrong_vault,
        Some(wrong_pda_fixture.seller_base_ata),
        None,
        None,
    );
    assert!(!send_settlement(
        &mut wrong_pda_fixture,
        wrong_pda_instruction
    ));
}

#[test]
fn settlement_rejects_over_settlement_insufficient_collateral_and_arithmetic_overflow() {
    let mut over_settlement_fixture = atm_call_fixture();
    let (extra_vault, extra_base_ata, _) =
        add_seller(&mut over_settlement_fixture, Pubkey::new_unique(), 1, 1);
    let mut over_settlement_instruction = settle_instruction(&over_settlement_fixture);
    over_settlement_instruction
        .accounts
        .push(AccountMeta::new(extra_vault, false));
    over_settlement_instruction
        .accounts
        .push(AccountMeta::new(extra_base_ata, false));
    assert!(!send_settlement(
        &mut over_settlement_fixture,
        over_settlement_instruction
    ));
    assert_eq!(
        token_amount(
            &over_settlement_fixture.svm,
            over_settlement_fixture.seller_base_ata,
        ),
        0,
    );

    let mut collateral_fixture = atm_call_fixture();
    let base_vault = collateral_fixture.base_vault;
    let base_mint = collateral_fixture.base_mint;
    let series = collateral_fixture.series;
    replace_token_account(&mut collateral_fixture, base_vault, base_mint, series, 9);
    let collateral_instruction = settle_instruction(&collateral_fixture);
    assert!(!send_settlement(
        &mut collateral_fixture,
        collateral_instruction
    ));

    let mut overflow_fixture = atm_call_fixture();
    replace_series(&mut overflow_fixture, |series| {
        series.total_contracts_quantity = u64::MAX;
        series.total_settled_quantity = 1;
    });
    let seller = overflow_fixture.seller;
    let seller_vault = overflow_fixture.seller_vault;
    let series = overflow_fixture.series;
    store_account(
        &mut overflow_fixture.svm,
        seller_vault,
        &SellerVault {
            owner: seller,
            series,
            short_quantity: u64::MAX,
            collateral_quantity: 0,
        },
    );
    let overflow_instruction = settle_instruction_with_payouts(
        &overflow_fixture,
        overflow_fixture.seller_vault,
        None,
        None,
        None,
    );
    assert!(!send_settlement(
        &mut overflow_fixture,
        overflow_instruction
    ));
}
