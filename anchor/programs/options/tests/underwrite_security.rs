use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::{get_associated_token_address, ID as ASSOCIATED_TOKEN_PROGRAM_ID},
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use litesvm::LiteSVM;
use options::{
    accounts, instruction,
    state::{
        Market, OptionType, Series, SeriesState, LONG_MINT_SEED, SELLER_VAULT_SEED, SERIES_SEED,
    },
    OracleConfig, ID as PROGRAM_ID,
};
use solana_program_pack::Pack;
use solana_sdk::{
    account::Account, instruction::Instruction, pubkey::Pubkey, signature::Keypair, signer::Signer,
    transaction::Transaction,
};
use spl_token::state::{Account as SplTokenAccount, AccountState, Mint};

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
const EXPIRY_MS: u64 = 2_000_000_000_000;
const STRIKE: u64 = 350_000_000;
const ONE_OPTION_E18: u128 = 1_000_000_000_000_000_000;
const ONE_QUOTE_E18: u128 = 1_000_000_000_000_000_000;

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

fn token_amount(svm: &LiteSVM, key: Pubkey) -> u64 {
    let account = svm.get_account(&key).unwrap();
    SplTokenAccount::unpack(&account.data).unwrap().amount
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

fn seller_vault_address(market: Pubkey, option_type: OptionType, seller: Pubkey) -> Pubkey {
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

fn create_market(
    svm: &mut LiteSVM,
    payer: &Keypair,
    operator: &Keypair,
    quote_mint: Pubkey,
    base_mint: Pubkey,
    min_fee: u64,
    min_fee_bps: u16,
    max_fee_bps: u16,
) -> Pubkey {
    let market = market_address(operator.pubkey(), quote_mint, base_mint);
    let accounts = accounts::CreateMarket {
        payer: payer.pubkey(),
        operator: operator.pubkey(),
        quote_mint: quote_mint,
        base_mint: base_mint,
        market,
        token_program: TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    let instruction = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::CreateMarket {
            oracle_config: OracleConfig::PythTwap { feed_id: [1; 32] },
            min_fee,
            min_operational_fee_bps: min_fee_bps,
            max_operational_fee_bps: max_fee_bps,
        }
        .data(),
    };
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer, operator],
        svm.latest_blockhash(),
    ))
    .unwrap();
    market
}

fn create_series_instruction(
    payer: Pubkey,
    market: Pubkey,
    quote_mint: Pubkey,
    base_mint: Pubkey,
    option_type: OptionType,
) -> Instruction {
    let series = series_address(market, option_type);
    let accounts = accounts::CreateSeries {
        payer,
        market,
        base_mint: base_mint,
        quote_mint: quote_mint,
        series,
        long_mint: long_mint_address(market, option_type),
        base_collateral_vault: get_associated_token_address(&series, &base_mint),
        quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::CreateSeries {
            option_type,
            strike_price: STRIKE,
            expiry_ms: EXPIRY_MS,
        }
        .data(),
    }
}

#[derive(Clone, Copy)]
struct Participants {
    buyer: Pubkey,
    seller: Pubkey,
    buyer_quote_source: Pubkey,
    seller_collateral_source: Pubkey,
    fee_recipient: Pubkey,
}

fn underwrite_instruction(
    is_call: bool,
    market: Pubkey,
    quote_mint: Pubkey,
    base_mint: Pubkey,
    option_type: OptionType,
    participants: Participants,
    quantity_e18: u128,
    premium_e18: u128,
    fee_bps: u16,
) -> Instruction {
    let series = series_address(market, option_type);
    let long_mint = long_mint_address(market, option_type);
    let account_metas = if is_call {
        accounts::UnderwriteCall {
            buyer: participants.buyer,
            seller: participants.seller,
            market,
            base_mint,
            quote_mint,
            series,
            long_mint,
            buyer_long_ata: get_associated_token_address(&participants.buyer, &long_mint),
            buyer_quote_source: participants.buyer_quote_source,
            seller_base_source: participants.seller_collateral_source,
            seller_quote_destination: get_associated_token_address(
                &participants.seller,
                &quote_mint,
            ),
            fee_recipient: participants.fee_recipient,
            fee_recipient_quote_ata: get_associated_token_address(
                &participants.fee_recipient,
                &quote_mint,
            ),
            seller_vault: seller_vault_address(market, option_type, participants.seller),
            base_collateral_vault: get_associated_token_address(&series, &base_mint),
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None)
    } else {
        accounts::UnderwritePut {
            buyer: participants.buyer,
            seller: participants.seller,
            market,
            base_mint,
            quote_mint,
            series,
            long_mint,
            buyer_long_ata: get_associated_token_address(&participants.buyer, &long_mint),
            buyer_quote_source: participants.buyer_quote_source,
            seller_quote_account: participants.seller_collateral_source,
            fee_recipient: participants.fee_recipient,
            fee_recipient_quote_ata: get_associated_token_address(
                &participants.fee_recipient,
                &quote_mint,
            ),
            seller_vault: seller_vault_address(market, option_type, participants.seller),
            quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None)
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: if is_call {
            instruction::UnderwriteCallE18 {
                expiry_ms: EXPIRY_MS,
                strike_price_e8: STRIKE,
                quantity_e18,
                premium_e18,
                operational_fee_bps: fee_bps,
            }
            .data()
        } else {
            instruction::UnderwritePutE18 {
                expiry_ms: EXPIRY_MS,
                strike_price_e8: STRIKE,
                quantity_e18,
                premium_e18,
                operational_fee_bps: fee_bps,
            }
            .data()
        },
    }
}

struct TestEnv {
    svm: LiteSVM,
    payer: Keypair,
    buyer: Keypair,
    seller: Keypair,
    market: Pubkey,
    quote_mint: Pubkey,
    base_mint: Pubkey,
    option_type: OptionType,
}

fn new_env(option_type: OptionType, min_fee: u64, min_fee_bps: u16, max_fee_bps: u16) -> TestEnv {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    for wallet in [&payer, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(
        &mut svm,
        &payer,
        &operator,
        quote_mint,
        base_mint,
        min_fee,
        min_fee_bps,
        max_fee_bps,
    );
    svm.send_transaction(Transaction::new_signed_with_payer(
        &[create_series_instruction(
            payer.pubkey(),
            market,
            quote_mint,
            base_mint,
            option_type,
        )],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    ))
    .unwrap();
    TestEnv {
        svm,
        payer,
        buyer,
        seller,
        market,
        quote_mint,
        base_mint,
        option_type,
    }
}

fn valid_participants(env: &mut TestEnv) -> Participants {
    let buyer_quote_source = Pubkey::new_unique();
    let seller_collateral_source = Pubkey::new_unique();
    let collateral_mint = match env.option_type {
        OptionType::Call => env.base_mint,
        OptionType::Put => env.quote_mint,
    };
    add_token_account(
        &mut env.svm,
        buyer_quote_source,
        env.quote_mint,
        env.buyer.pubkey(),
        10_000_000,
    );
    add_token_account(
        &mut env.svm,
        seller_collateral_source,
        collateral_mint,
        env.seller.pubkey(),
        10_000_000_000,
    );
    if env.option_type == OptionType::Call {
        add_token_account(
            &mut env.svm,
            get_associated_token_address(&env.seller.pubkey(), &env.quote_mint),
            env.quote_mint,
            env.seller.pubkey(),
            0,
        );
    }
    Participants {
        buyer: env.buyer.pubkey(),
        seller: env.seller.pubkey(),
        buyer_quote_source,
        seller_collateral_source,
        fee_recipient: Pubkey::new_unique(),
    }
}

fn set_market_paused(svm: &mut LiteSVM, market_key: Pubkey) {
    let mut account = svm.get_account(&market_key).unwrap();
    let mut market = Market::try_deserialize(&mut account.data.as_slice()).unwrap();
    market.paused = true;
    let mut data = Vec::new();
    market.try_serialize(&mut data).unwrap();
    account.data = data;
    svm.set_account(market_key, account).unwrap();
}

fn set_series_state(svm: &mut LiteSVM, series_key: Pubkey, state: SeriesState) {
    let mut account = svm.get_account(&series_key).unwrap();
    let mut series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    series.state = state;
    let mut data = Vec::new();
    series.try_serialize(&mut data).unwrap();
    data.resize(account.data.len(), 0);
    account.data = data;
    svm.set_account(series_key, account).unwrap();
}

fn corrupt_series(svm: &mut LiteSVM, series_key: Pubkey, corruption: fn(&mut Series)) {
    let mut account = svm.get_account(&series_key).unwrap();
    let mut series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    corruption(&mut series);
    let mut data = Vec::new();
    series.try_serialize(&mut data).unwrap();
    data.resize(account.data.len(), 0);
    account.data = data;
    svm.set_account(series_key, account).unwrap();
}

#[test]
fn underwriting_never_repairs_an_already_allocated_series() {
    let mut env = new_env(OptionType::Call, 0, 0, 1_000);
    let participants = valid_participants(&mut env);
    let series_key = series_address(env.market, OptionType::Call);
    let mut account = env.svm.get_account(&series_key).unwrap();
    let mut series = Series::try_deserialize(&mut account.data.as_slice()).unwrap();
    series.market = Pubkey::default();
    let mut data = Vec::new();
    series.try_serialize(&mut data).unwrap();
    data.resize(account.data.len(), 0);
    account.data = data;
    env.svm.set_account(series_key, account).unwrap();

    let transaction = Transaction::new_signed_with_payer(
        &[underwrite_instruction(
            true,
            env.market,
            env.quote_mint,
            env.base_mint,
            OptionType::Call,
            participants,
            ONE_OPTION_E18,
            0,
            0,
        )],
        Some(&env.buyer.pubkey()),
        &[&env.buyer, &env.seller],
        env.svm.latest_blockhash(),
    );

    let result = env.svm.send_transaction(transaction);
    assert!(result.is_err(), "{result:?}");
}

#[test]
fn underwriting_validates_every_relevant_existing_series_field() {
    let corruptions: [fn(&mut Series); 9] = [
        |series| series.market = Pubkey::new_unique(),
        |series| series.option_type = OptionType::Put,
        |series| series.strike_price += 1,
        |series| series.expiry_ms += 1_000,
        |series| series.exercise_window_end_ms += 1_000,
        |series| series.expiry_price = Some(1),
        |series| series.total_manual_exercised_quantity = 1,
        |series| series.total_settled_quantity = 1,
        |series| series.total_quote_amount = 1,
    ];

    for corruption in corruptions {
        let mut env = new_env(OptionType::Call, 0, 0, 1_000);
        let participants = valid_participants(&mut env);
        let series_key = series_address(env.market, OptionType::Call);
        corrupt_series(&mut env.svm, series_key, corruption);
        let transaction = Transaction::new_signed_with_payer(
            &[underwrite_instruction(
                true,
                env.market,
                env.quote_mint,
                env.base_mint,
                OptionType::Call,
                participants,
                ONE_OPTION_E18,
                0,
                0,
            )],
            Some(&env.buyer.pubkey()),
            &[&env.buyer, &env.seller],
            env.svm.latest_blockhash(),
        );

        assert!(env.svm.send_transaction(transaction).is_err());
    }
}

#[test]
fn any_payer_can_create_a_series() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();
    let market_payer = Keypair::new();
    let operator = Keypair::new();
    let series_payer = Keypair::new();
    for wallet in [&market_payer, &series_payer] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(
        &mut svm,
        &market_payer,
        &operator,
        quote_mint,
        base_mint,
        0,
        0,
        1_000,
    );

    let transaction = Transaction::new_signed_with_payer(
        &[create_series_instruction(
            series_payer.pubkey(),
            market,
            quote_mint,
            base_mint,
            OptionType::Call,
        )],
        Some(&series_payer.pubkey()),
        &[&series_payer],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_ok());
}

#[test]
fn underwrite_rejects_missing_seller_signature_and_wrong_instruction_type() {
    let mut env = new_env(OptionType::Call, 0, 0, 1_000);
    let participants = valid_participants(&mut env);
    let instruction = underwrite_instruction(
        true,
        env.market,
        env.quote_mint,
        env.base_mint,
        OptionType::Call,
        participants,
        ONE_OPTION_E18,
        0,
        0,
    );
    let mut unsigned_seller =
        Transaction::new_with_payer(&[instruction], Some(&env.buyer.pubkey()));
    unsigned_seller.partial_sign(&[&env.buyer], env.svm.latest_blockhash());
    assert!(env.svm.send_transaction(unsigned_seller).is_err());
    env.svm.expire_blockhash();

    env.svm
        .send_transaction(Transaction::new_signed_with_payer(
            &[create_series_instruction(
                env.payer.pubkey(),
                env.market,
                env.quote_mint,
                env.base_mint,
                OptionType::Put,
            )],
            Some(&env.payer.pubkey()),
            &[&env.payer],
            env.svm.latest_blockhash(),
        ))
        .unwrap();
    let call_on_put = underwrite_instruction(
        true,
        env.market,
        env.quote_mint,
        env.base_mint,
        OptionType::Put,
        participants,
        ONE_OPTION_E18,
        0,
        0,
    );
    assert!(env
        .svm
        .send_transaction(Transaction::new_signed_with_payer(
            &[call_on_put],
            Some(&env.buyer.pubkey()),
            &[&env.buyer, &env.seller],
            env.svm.latest_blockhash(),
        ))
        .is_err());
    env.svm.expire_blockhash();

    let put_on_call = underwrite_instruction(
        false,
        env.market,
        env.quote_mint,
        env.base_mint,
        OptionType::Call,
        participants,
        ONE_OPTION_E18,
        0,
        0,
    );
    assert!(env
        .svm
        .send_transaction(Transaction::new_signed_with_payer(
            &[put_on_call],
            Some(&env.buyer.pubkey()),
            &[&env.buyer, &env.seller],
            env.svm.latest_blockhash(),
        ))
        .is_err());
}

#[test]
fn underwrite_rejects_paused_market_non_open_series_and_same_party() {
    let mut env = new_env(OptionType::Call, 0, 0, 1_000);
    let participants = valid_participants(&mut env);
    let instruction = |participants| {
        underwrite_instruction(
            true,
            env.market,
            env.quote_mint,
            env.base_mint,
            OptionType::Call,
            participants,
            ONE_OPTION_E18,
            0,
            0,
        )
    };
    set_market_paused(&mut env.svm, env.market);
    assert!(env
        .svm
        .send_transaction(Transaction::new_signed_with_payer(
            &[instruction(participants)],
            Some(&env.buyer.pubkey()),
            &[&env.buyer, &env.seller],
            env.svm.latest_blockhash(),
        ))
        .is_err());

    let mut env = new_env(OptionType::Call, 0, 0, 1_000);
    let participants = valid_participants(&mut env);
    let series = series_address(env.market, OptionType::Call);
    for state in [SeriesState::ExpirationPriceFinalized, SeriesState::Closed] {
        set_series_state(&mut env.svm, series, state);
        let transaction = Transaction::new_signed_with_payer(
            &[underwrite_instruction(
                true,
                env.market,
                env.quote_mint,
                env.base_mint,
                OptionType::Call,
                participants,
                ONE_OPTION_E18,
                0,
                0,
            )],
            Some(&env.buyer.pubkey()),
            &[&env.buyer, &env.seller],
            env.svm.latest_blockhash(),
        );
        assert!(env.svm.send_transaction(transaction).is_err());
        env.svm.expire_blockhash();
    }

    let mut env = new_env(OptionType::Call, 0, 0, 1_000);
    let buyer_quote_source = Pubkey::new_unique();
    let seller_collateral_source = Pubkey::new_unique();
    add_token_account(
        &mut env.svm,
        buyer_quote_source,
        env.quote_mint,
        env.buyer.pubkey(),
        1,
    );
    add_token_account(
        &mut env.svm,
        seller_collateral_source,
        env.base_mint,
        env.buyer.pubkey(),
        1,
    );
    let same_party = Participants {
        buyer: env.buyer.pubkey(),
        seller: env.buyer.pubkey(),
        buyer_quote_source,
        seller_collateral_source,
        fee_recipient: Pubkey::new_unique(),
    };
    assert!(env
        .svm
        .send_transaction(Transaction::new_signed_with_payer(
            &[underwrite_instruction(
                true,
                env.market,
                env.quote_mint,
                env.base_mint,
                OptionType::Call,
                same_party,
                ONE_OPTION_E18,
                0,
                0,
            )],
            Some(&env.buyer.pubkey()),
            &[&env.buyer],
            env.svm.latest_blockhash(),
        ))
        .is_err());
}

#[test]
fn underwrite_enforces_fee_bounds_and_minimum_fee() {
    let mut env = new_env(OptionType::Call, 0, 100, 200);
    let participants = valid_participants(&mut env);
    for fee_bps in [100, 200] {
        let transaction = Transaction::new_signed_with_payer(
            &[underwrite_instruction(
                true,
                env.market,
                env.quote_mint,
                env.base_mint,
                OptionType::Call,
                participants,
                ONE_OPTION_E18,
                ONE_QUOTE_E18,
                fee_bps,
            )],
            Some(&env.buyer.pubkey()),
            &[&env.buyer, &env.seller],
            env.svm.latest_blockhash(),
        );
        assert!(env.svm.send_transaction(transaction).is_ok());
        env.svm.expire_blockhash();
    }
    for fee_bps in [99, 201] {
        let transaction = Transaction::new_signed_with_payer(
            &[underwrite_instruction(
                true,
                env.market,
                env.quote_mint,
                env.base_mint,
                OptionType::Call,
                participants,
                ONE_OPTION_E18,
                ONE_QUOTE_E18,
                fee_bps,
            )],
            Some(&env.buyer.pubkey()),
            &[&env.buyer, &env.seller],
            env.svm.latest_blockhash(),
        );
        assert!(env.svm.send_transaction(transaction).is_err());
        env.svm.expire_blockhash();
    }

    let mut env = new_env(OptionType::Call, 1, 0, 1_000);
    let participants = valid_participants(&mut env);
    assert!(env
        .svm
        .send_transaction(Transaction::new_signed_with_payer(
            &[underwrite_instruction(
                true,
                env.market,
                env.quote_mint,
                env.base_mint,
                OptionType::Call,
                participants,
                ONE_OPTION_E18,
                0,
                0,
            )],
            Some(&env.buyer.pubkey()),
            &[&env.buyer, &env.seller],
            env.svm.latest_blockhash(),
        ))
        .is_err());
}

#[test]
fn underwrite_rejects_invalid_funding_accounts_and_collateral_vault() {
    let mut env = new_env(OptionType::Call, 0, 0, 1_000);
    let valid = valid_participants(&mut env);
    let wrong_buyer_owner = Pubkey::new_unique();
    let wrong_buyer_mint = Pubkey::new_unique();
    let wrong_seller_owner = Pubkey::new_unique();
    let wrong_seller_mint = Pubkey::new_unique();
    add_token_account(
        &mut env.svm,
        wrong_buyer_owner,
        env.quote_mint,
        env.seller.pubkey(),
        1,
    );
    add_token_account(
        &mut env.svm,
        wrong_buyer_mint,
        env.base_mint,
        env.buyer.pubkey(),
        1,
    );
    add_token_account(
        &mut env.svm,
        wrong_seller_owner,
        env.base_mint,
        env.buyer.pubkey(),
        1,
    );
    add_token_account(
        &mut env.svm,
        wrong_seller_mint,
        env.quote_mint,
        env.seller.pubkey(),
        1,
    );
    for participants in [
        Participants {
            buyer_quote_source: wrong_buyer_owner,
            ..valid
        },
        Participants {
            buyer_quote_source: wrong_buyer_mint,
            ..valid
        },
        Participants {
            seller_collateral_source: wrong_seller_owner,
            ..valid
        },
        Participants {
            seller_collateral_source: wrong_seller_mint,
            ..valid
        },
    ] {
        let transaction = Transaction::new_signed_with_payer(
            &[underwrite_instruction(
                true,
                env.market,
                env.quote_mint,
                env.base_mint,
                OptionType::Call,
                participants,
                ONE_OPTION_E18,
                0,
                0,
            )],
            Some(&env.buyer.pubkey()),
            &[&env.buyer, &env.seller],
            env.svm.latest_blockhash(),
        );
        assert!(env.svm.send_transaction(transaction).is_err());
        env.svm.expire_blockhash();
    }

    let vault = get_associated_token_address(
        &series_address(env.market, OptionType::Call),
        &env.base_mint,
    );
    let mut vault_account = env.svm.get_account(&vault).unwrap();
    let mut vault_data = SplTokenAccount::unpack(&vault_account.data).unwrap();
    vault_data.owner = env.buyer.pubkey();
    SplTokenAccount::pack(vault_data, &mut vault_account.data).unwrap();
    env.svm.set_account(vault, vault_account).unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[underwrite_instruction(
            true,
            env.market,
            env.quote_mint,
            env.base_mint,
            OptionType::Call,
            valid,
            ONE_OPTION_E18,
            0,
            0,
        )],
        Some(&env.buyer.pubkey()),
        &[&env.buyer, &env.seller],
        env.svm.latest_blockhash(),
    );
    assert!(env.svm.send_transaction(transaction).is_err());
}

#[test]
fn put_underwriting_rounds_fractional_collateral_up_with_mismatched_decimals() {
    let mut env = new_env(OptionType::Put, 0, 0, 1_000);
    let participants = valid_participants(&mut env);
    let transaction = Transaction::new_signed_with_payer(
        &[underwrite_instruction(
            false,
            env.market,
            env.quote_mint,
            env.base_mint,
            OptionType::Put,
            participants,
            1_000_000_000,
            0,
            0,
        )],
        Some(&env.buyer.pubkey()),
        &[&env.buyer, &env.seller],
        env.svm.latest_blockhash(),
    );
    assert!(env.svm.send_transaction(transaction).is_ok());
    let vault = get_associated_token_address(
        &series_address(env.market, OptionType::Put),
        &env.quote_mint,
    );
    assert_eq!(token_amount(&env.svm, vault), 1);
}

#[test]
fn underwrite_rejects_terms_whose_total_premium_is_a_fractional_quote() {
    let mut env = new_env(OptionType::Call, 0, 0, 1_000);
    let participants = valid_participants(&mut env);
    let transaction = Transaction::new_signed_with_payer(
        &[underwrite_instruction(
            true,
            env.market,
            env.quote_mint,
            env.base_mint,
            OptionType::Call,
            participants,
            500_000_000_000_000_000,
            1_000_000_000_000,
            0,
        )],
        Some(&env.buyer.pubkey()),
        &[&env.buyer, &env.seller],
        env.svm.latest_blockhash(),
    );

    assert!(env.svm.send_transaction(transaction).is_err());
}

#[test]
fn underwrite_rejects_e18_terms_with_unsupported_precision_or_base_unit_overflow() {
    let mut env = new_env(OptionType::Call, 0, 0, 1_000);
    let participants = valid_participants(&mut env);
    let overflowing_quantity_e18 = (u128::from(u64::MAX) + 1) * 1_000_000_000;
    let overflowing_premium_e18 = (u128::from(u64::MAX) + 1) * 1_000_000_000_000;

    for (quantity_e18, premium_e18) in [
        (1, 0),
        (ONE_OPTION_E18, 1),
        (overflowing_quantity_e18, 0),
        (ONE_OPTION_E18, overflowing_premium_e18),
    ] {
        let transaction = Transaction::new_signed_with_payer(
            &[underwrite_instruction(
                true,
                env.market,
                env.quote_mint,
                env.base_mint,
                OptionType::Call,
                participants,
                quantity_e18,
                premium_e18,
                0,
            )],
            Some(&env.buyer.pubkey()),
            &[&env.buyer, &env.seller],
            env.svm.latest_blockhash(),
        );
        assert!(env.svm.send_transaction(transaction).is_err());
        env.svm.expire_blockhash();
    }
}
