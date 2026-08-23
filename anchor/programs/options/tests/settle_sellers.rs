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
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();
    let settler = Keypair::new();
    let seller = Pubkey::new_unique();
    let operator = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let market = Pubkey::new_unique();
    let option_type = OptionType::Call;
    let series = series_address(market, option_type);
    let seller_vault = seller_vault_address(market, seller, option_type);
    let base_vault = get_associated_token_address(&series, &base_mint);
    let quote_vault = get_associated_token_address(&series, &quote_mint);
    let seller_base_ata = get_associated_token_address(&seller, &base_mint);
    let seller_quote_ata = get_associated_token_address(&seller, &quote_mint);

    svm.airdrop(&settler.pubkey(), 10_000_000_000).unwrap();
    add_mint(&mut svm, base_mint, 0);
    add_mint(&mut svm, quote_mint, 0);
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
    add_token_account(&mut svm, base_vault, base_mint, series, 10);
    add_token_account(&mut svm, quote_vault, quote_mint, series, 0);
    add_token_account(&mut svm, seller_base_ata, base_mint, seller, 0);
    add_token_account(&mut svm, seller_quote_ata, quote_mint, seller, 0);
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000).unwrap();
    svm.set_sysvar(&clock);

    SettlementFixture {
        svm,
        settler,
        seller,
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
