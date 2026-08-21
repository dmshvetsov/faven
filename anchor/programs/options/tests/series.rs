use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::{get_associated_token_address, ID as ASSOCIATED_TOKEN_PROGRAM_ID},
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use litesvm::LiteSVM;
use options::{
    accounts, instruction,
    state::{SellerVault, Series, SeriesState, LONG_MINT_SEED, SELLER_VAULT_SEED, SERIES_SEED},
    OptionType, OracleConfig, ID as PROGRAM_ID,
};
use solana_program_pack::Pack;
use solana_sdk::{
    account::Account, clock::Clock, instruction::Instruction, pubkey::Pubkey, signature::Keypair,
    signer::Signer, transaction::Transaction,
};
use spl_token::state::{Account as SplTokenAccount, AccountState, Mint};

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
const EXPIRY_MS: u64 = 2_000_000_000_000;

fn add_mint(svm: &mut LiteSVM, mint_key: Pubkey, decimals: u8) {
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
        mint_key,
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

fn token_amount(svm: &LiteSVM, key: &Pubkey) -> u64 {
    let account = svm.get_account(key).unwrap();
    SplTokenAccount::unpack(&account.data).unwrap().amount
}

fn market_address(operator: &Pubkey, quote_mint: &Pubkey, base_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"market",
            b"PythUnverified",
            &[1; 32],
            quote_mint.as_ref(),
            base_mint.as_ref(),
            operator.as_ref(),
        ],
        &PROGRAM_ID,
    )
    .0
}

fn series_address(market: &Pubkey, marker: u8, strike: u64, expiry: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            SERIES_SEED,
            market.as_ref(),
            &[marker],
            &expiry.to_le_bytes(),
            &strike.to_le_bytes(),
        ],
        &PROGRAM_ID,
    )
    .0
}

fn long_mint_address(market: &Pubkey, marker: u8, strike: u64, expiry: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            LONG_MINT_SEED,
            market.as_ref(),
            &[marker],
            &expiry.to_le_bytes(),
            &strike.to_le_bytes(),
        ],
        &PROGRAM_ID,
    )
    .0
}

fn seller_vault_address(
    market: &Pubkey,
    marker: u8,
    strike: u64,
    expiry: u64,
    seller: &Pubkey,
) -> Pubkey {
    Pubkey::find_program_address(
        &[
            SELLER_VAULT_SEED,
            market.as_ref(),
            &[marker],
            &expiry.to_le_bytes(),
            &strike.to_le_bytes(),
            seller.as_ref(),
        ],
        &PROGRAM_ID,
    )
    .0
}

fn new_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        include_bytes!("../../../target/deploy/options.so"),
    )
    .unwrap();
    svm
}

fn create_market(
    svm: &mut LiteSVM,
    payer: &Keypair,
    operator: &Keypair,
    quote_mint: Pubkey,
    base_mint: Pubkey,
) -> Pubkey {
    let market = market_address(&operator.pubkey(), &quote_mint, &base_mint);
    let accounts = accounts::CreateMarket {
        payer: payer.pubkey(),
        operator: operator.pubkey(),
        quote_coin_mint: quote_mint,
        base_coin_mint: base_mint,
        market,
        token_program: TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    let instruction = Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::CreateMarket {
            oracle_config: OracleConfig::PythUnverified { feed_id: [1; 32] },
            min_fee: 0,
            min_operational_fee_bps: 0,
            max_operational_fee_bps: 1_000,
        }
        .data(),
    };
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer, operator],
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction).unwrap();
    market
}

fn create_series_instruction(
    payer: Pubkey,
    market: Pubkey,
    quote_mint: Pubkey,
    base_mint: Pubkey,
    option_type: OptionType,
    strike: u64,
    expiry: u64,
) -> Instruction {
    let marker = option_type.marker();
    let series = series_address(&market, marker, strike, expiry);
    let long_mint = long_mint_address(&market, marker, strike, expiry);
    let accounts = accounts::CreateSeries {
        payer,
        market,
        base_coin_mint: base_mint,
        quote_coin_mint: quote_mint,
        series,
        long_mint,
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
            strike_price: strike,
            expiry_ms: expiry,
        }
        .data(),
    }
}

#[derive(Clone, Copy)]
struct UnderwriteAccounts {
    buyer: Pubkey,
    seller: Pubkey,
    buyer_quote_source: Pubkey,
    seller_collateral_source: Pubkey,
    fee_recipient: Pubkey,
}

fn underwrite_instruction(
    is_call: bool,
    terms: (Pubkey, Pubkey, Pubkey, u8, u64, u64),
    participants: UnderwriteAccounts,
    quantity: u64,
    premium_per_contract: u64,
    fee_bps: u16,
) -> Instruction {
    let (market, quote_mint, base_mint, marker, strike, expiry) = terms;
    let series = series_address(&market, marker, strike, expiry);
    let long_mint = long_mint_address(&market, marker, strike, expiry);
    let accounts = accounts::Underwrite {
        buyer: participants.buyer,
        seller: participants.seller,
        market,
        base_coin_mint: base_mint,
        quote_coin_mint: quote_mint,
        series,
        long_mint,
        buyer_long_ata: get_associated_token_address(&participants.buyer, &long_mint),
        buyer_quote_source: participants.buyer_quote_source,
        seller_collateral_source: participants.seller_collateral_source,
        seller_quote_ata: get_associated_token_address(&participants.seller, &quote_mint),
        fee_recipient: participants.fee_recipient,
        fee_recipient_quote_ata: get_associated_token_address(
            &participants.fee_recipient,
            &quote_mint,
        ),
        seller_vault: seller_vault_address(&market, marker, strike, expiry, &participants.seller),
        base_collateral_vault: get_associated_token_address(&series, &base_mint),
        quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: if is_call {
            instruction::UnderwriteCall {
                quantity,
                premium_per_contract,
                operational_fee_bps: fee_bps,
            }
            .data()
        } else {
            instruction::UnderwritePut {
                quantity,
                premium_per_contract,
                operational_fee_bps: fee_bps,
            }
            .data()
        },
    }
}

#[test]
fn user_can_create_a_series_with_long_mint_and_collateral_vaults() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    svm.airdrop(&payer.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
    let instruction = create_series_instruction(
        payer.pubkey(),
        market,
        quote_mint,
        base_mint,
        OptionType::Call,
        3_500_000,
        EXPIRY_MS,
    );

    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_ok());

    let series_key = series_address(&market, 1, 3_500_000, EXPIRY_MS);
    let series_account = svm.get_account(&series_key).unwrap();
    let series = Series::try_deserialize(&mut series_account.data.as_slice()).unwrap();
    assert_eq!(series.state, SeriesState::Open);
    assert_eq!(series.market, market);
    assert_eq!(series.total_contracts_quantity, 0);
    assert_eq!(series.total_manual_exercised_quantity, 0);
    assert_eq!(series.total_settled_quantity, 0);

    let long_mint = svm
        .get_account(&long_mint_address(&market, 1, 3_500_000, EXPIRY_MS))
        .unwrap();
    let long_mint = Mint::unpack(&long_mint.data).unwrap();
    assert_eq!(long_mint.decimals, 9);
    assert_eq!(
        long_mint.mint_authority,
        solana_sdk::program_option::COption::Some(series_key)
    );
    assert_eq!(
        long_mint.freeze_authority,
        solana_sdk::program_option::COption::None
    );

    for mint in [base_mint, quote_mint] {
        let vault = svm
            .get_account(&get_associated_token_address(&series_key, &mint))
            .unwrap();
        let vault = SplTokenAccount::unpack(&vault.data).unwrap();
        assert_eq!(vault.mint, mint);
        assert_eq!(vault.owner, series_key);
        assert_eq!(vault.amount, 0);
    }
}

#[test]
fn user_cannot_create_a_series_with_invalid_terms() {
    for (option_type, strike, expiry) in [(OptionType::Call, 0, EXPIRY_MS), (OptionType::Put, 1, 1)]
    {
        let mut svm = new_svm();
        let payer = Keypair::new();
        let operator = Keypair::new();
        let quote_mint = Pubkey::new_unique();
        let base_mint = Pubkey::new_unique();
        svm.airdrop(&payer.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
        add_mint(&mut svm, quote_mint, 6);
        add_mint(&mut svm, base_mint, 9);
        let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
        let transaction = Transaction::new_signed_with_payer(
            &[create_series_instruction(
                payer.pubkey(),
                market,
                quote_mint,
                base_mint,
                option_type,
                strike,
                expiry,
            )],
            Some(&payer.pubkey()),
            &[&payer],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(transaction).is_err());
    }
}

#[test]
fn buyer_and_seller_can_underwrite_a_call_and_reuse_the_seller_vault() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    let fee_recipient = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    for wallet in [&payer, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
    let strike = 3_500_000;
    let create_series = create_series_instruction(
        payer.pubkey(),
        market,
        quote_mint,
        base_mint,
        OptionType::Call,
        strike,
        EXPIRY_MS,
    );
    let create_series_tx = Transaction::new_signed_with_payer(
        &[create_series],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(create_series_tx).unwrap();

    let buyer_quote_source = Pubkey::new_unique();
    let seller_base_source = Pubkey::new_unique();
    add_token_account(
        &mut svm,
        buyer_quote_source,
        quote_mint,
        buyer.pubkey(),
        2_000_000,
    );
    add_token_account(
        &mut svm,
        seller_base_source,
        base_mint,
        seller.pubkey(),
        2_000_000_000,
    );
    let participants = UnderwriteAccounts {
        buyer: buyer.pubkey(),
        seller: seller.pubkey(),
        buyer_quote_source,
        seller_collateral_source: seller_base_source,
        fee_recipient,
    };
    let terms = (market, quote_mint, base_mint, 1, strike, EXPIRY_MS);
    for _ in 0..2 {
        let transaction = Transaction::new_signed_with_payer(
            &[underwrite_instruction(
                true,
                terms,
                UnderwriteAccounts { ..participants },
                1_000_000_000,
                1_000_000,
                500,
            )],
            Some(&buyer.pubkey()),
            &[&buyer, &seller],
            svm.latest_blockhash(),
        );
        let result = svm.send_transaction(transaction);
        assert!(result.is_ok(), "{result:?}");
        svm.expire_blockhash();
    }

    let series = series_address(&market, 1, strike, EXPIRY_MS);
    let long_mint = long_mint_address(&market, 1, strike, EXPIRY_MS);
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&buyer.pubkey(), &long_mint)
        ),
        2_000_000_000
    );
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&seller.pubkey(), &quote_mint)
        ),
        1_900_000
    );
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&fee_recipient, &quote_mint)
        ),
        100_000
    );
    assert_eq!(
        token_amount(&svm, &get_associated_token_address(&series, &base_mint)),
        2_000_000_000
    );
    let seller_vault = svm
        .get_account(&seller_vault_address(
            &market,
            1,
            strike,
            EXPIRY_MS,
            &seller.pubkey(),
        ))
        .unwrap();
    let seller_vault = SellerVault::try_deserialize(&mut seller_vault.data.as_slice()).unwrap();
    assert_eq!(seller_vault.short_quantity, 2_000_000_000);
    assert_eq!(seller_vault.collateral_quantity, 2_000_000_000);
    let series_account = svm.get_account(&series).unwrap();
    let series = Series::try_deserialize(&mut series_account.data.as_slice()).unwrap();
    assert_eq!(series.total_contracts_quantity, 2_000_000_000);
}

#[test]
fn buyer_and_seller_can_underwrite_a_put_with_rounded_up_collateral() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    let fee_recipient = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    for wallet in [&payer, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
    let strike = 3_500_000;
    let create_series_tx = Transaction::new_signed_with_payer(
        &[create_series_instruction(
            payer.pubkey(),
            market,
            quote_mint,
            base_mint,
            OptionType::Put,
            strike,
            EXPIRY_MS,
        )],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(create_series_tx).unwrap();
    let buyer_quote_source = Pubkey::new_unique();
    let seller_quote_source = Pubkey::new_unique();
    add_token_account(
        &mut svm,
        buyer_quote_source,
        quote_mint,
        buyer.pubkey(),
        1_000_000,
    );
    add_token_account(
        &mut svm,
        seller_quote_source,
        quote_mint,
        seller.pubkey(),
        3_500_000,
    );
    let transaction = Transaction::new_signed_with_payer(
        &[underwrite_instruction(
            false,
            (market, quote_mint, base_mint, 2, strike, EXPIRY_MS),
            UnderwriteAccounts {
                buyer: buyer.pubkey(),
                seller: seller.pubkey(),
                buyer_quote_source,
                seller_collateral_source: seller_quote_source,
                fee_recipient,
            },
            1_000_000_000,
            1_000_000,
            0,
        )],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_ok());

    let series = series_address(&market, 2, strike, EXPIRY_MS);
    assert_eq!(
        token_amount(&svm, &get_associated_token_address(&series, &quote_mint)),
        3_500_000
    );
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&seller.pubkey(), &quote_mint)
        ),
        1_000_000
    );
}

#[test]
fn underwriting_rejects_invalid_inputs_and_allows_zero_premium_without_a_fee() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    let fee_recipient = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    for wallet in [&payer, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
    let strike = 3_500_000;
    let create_series_tx = Transaction::new_signed_with_payer(
        &[create_series_instruction(
            payer.pubkey(),
            market,
            quote_mint,
            base_mint,
            OptionType::Call,
            strike,
            EXPIRY_MS,
        )],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(create_series_tx).unwrap();
    let buyer_quote_source = Pubkey::new_unique();
    let seller_base_source = Pubkey::new_unique();
    add_token_account(
        &mut svm,
        buyer_quote_source,
        quote_mint,
        buyer.pubkey(),
        1_000_000,
    );
    add_token_account(
        &mut svm,
        seller_base_source,
        base_mint,
        seller.pubkey(),
        2_000_000_000,
    );
    let terms = (market, quote_mint, base_mint, 1, strike, EXPIRY_MS);
    let participants = UnderwriteAccounts {
        buyer: buyer.pubkey(),
        seller: seller.pubkey(),
        buyer_quote_source,
        seller_collateral_source: seller_base_source,
        fee_recipient,
    };
    for (quantity, fee_bps, source) in [
        (0, 0, seller_base_source),
        (1_000_000_000, 1_001, seller_base_source),
        (1_000_000_000, 0, buyer_quote_source),
    ] {
        let transaction = Transaction::new_signed_with_payer(
            &[underwrite_instruction(
                true,
                terms,
                UnderwriteAccounts {
                    seller_collateral_source: source,
                    ..participants
                },
                quantity,
                0,
                fee_bps,
            )],
            Some(&buyer.pubkey()),
            &[&buyer, &seller],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(transaction).is_err());
        svm.expire_blockhash();
    }
    let mut missing_buyer_signature = Transaction::new_with_payer(
        &[underwrite_instruction(
            true,
            terms,
            participants,
            1_000_000_000,
            0,
            0,
        )],
        Some(&seller.pubkey()),
    );
    missing_buyer_signature.partial_sign(&[&seller], svm.latest_blockhash());
    assert!(svm.send_transaction(missing_buyer_signature).is_err());
    svm.expire_blockhash();

    let zero_premium = Transaction::new_signed_with_payer(
        &[underwrite_instruction(
            true,
            terms,
            participants,
            1_000_000_000,
            0,
            0,
        )],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(zero_premium).is_ok());
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&seller.pubkey(), &quote_mint)
        ),
        0
    );
    assert_eq!(
        token_amount(
            &svm,
            &get_associated_token_address(&fee_recipient, &quote_mint)
        ),
        0
    );
    svm.expire_blockhash();

    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000 - 8 * 60 * 60).unwrap();
    svm.set_sysvar(&clock);
    let expiry_boundary = Transaction::new_signed_with_payer(
        &[underwrite_instruction(true, terms, participants, 1, 0, 0)],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(expiry_boundary).is_err());
}
