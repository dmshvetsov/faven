use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::{spl_token, ID as TOKEN_PROGRAM_ID};
use litesvm::LiteSVM;
use options::{accounts, instruction, state::Market, OracleConfig, ID as PROGRAM_ID};
use solana_program_pack::Pack;
use solana_sdk::{
    account::Account, instruction::Instruction, pubkey::Pubkey, signature::Keypair, signer::Signer,
    transaction::Transaction,
};
use spl_token::state::Mint;

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

fn add_mint(svm: &mut LiteSVM, mint_key: Pubkey, decimals: u8, owner: Pubkey) {
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
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn market_address(
    operator: &Pubkey,
    quote_mint: &Pubkey,
    base_mint: &Pubkey,
    feed_id: &[u8; 32],
) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"market",
            b"PythTwap",
            feed_id,
            quote_mint.as_ref(),
            base_mint.as_ref(),
            operator.as_ref(),
        ],
        &PROGRAM_ID,
    )
    .0
}

fn create_market_instruction(
    payer: Pubkey,
    operator: Pubkey,
    quote_mint: Pubkey,
    base_mint: Pubkey,
    oracle_config: OracleConfig,
    min_operational_fee_bps: u16,
    max_operational_fee_bps: u16,
) -> Instruction {
    let accounts = accounts::CreateMarket {
        payer,
        operator,
        quote_mint: quote_mint,
        base_mint: base_mint,
        market: market_address(&operator, &quote_mint, &base_mint, &oracle_config.feed_id()),
        token_program: TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::CreateMarket {
            oracle_config,
            min_fee: 500,
            min_operational_fee_bps,
            max_operational_fee_bps,
        }
        .data(),
    }
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

fn fund_and_add_mints(
    svm: &mut LiteSVM,
    payer: &Keypair,
    quote_mint: Pubkey,
    quote_decimals: u8,
    base_mint: Pubkey,
    base_decimals: u8,
) {
    svm.airdrop(&payer.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    add_mint(svm, quote_mint, quote_decimals, TOKEN_PROGRAM_ID);
    add_mint(svm, base_mint, base_decimals, TOKEN_PROGRAM_ID);
}

#[test]
fn user_can_create_a_market_with_spl_mints() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    let oracle_config = OracleConfig::PythTwap { feed_id: [7; 32] };
    let market = market_address(&operator.pubkey(), &quote_mint, &base_mint, &[7; 32]);
    fund_and_add_mints(&mut svm, &payer, quote_mint, 6, base_mint, 9);

    let instruction = create_market_instruction(
        payer.pubkey(),
        operator.pubkey(),
        quote_mint,
        base_mint,
        oracle_config,
        10,
        100,
    );
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[&payer, &operator],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_ok());

    let account = svm.get_account(&market).unwrap();
    let stored = Market::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(stored.oracle_config, oracle_config);
    assert_eq!(stored.operator, operator.pubkey());
    assert_eq!(stored.quote_mint, quote_mint);
    assert_eq!(stored.base_mint, base_mint);
    assert_eq!(stored.quote_mint_decimals, 6);
    assert_eq!(stored.base_mint_decimals, 9);
    assert_eq!(stored.min_fee, 500);
    assert_eq!(stored.min_operational_fee_bps, 10);
    assert_eq!(stored.max_operational_fee_bps, 100);
    assert!(!stored.paused);
}

#[test]
fn user_cannot_create_a_market_with_invalid_fee_configuration() {
    for (feed_id, min_bps, max_bps) in [(8, 101, 100), (9, 10_001, 10_001)] {
        let mut svm = new_svm();
        let payer = Keypair::new();
        let operator = Keypair::new();
        let quote_mint = Pubkey::new_unique();
        let base_mint = Pubkey::new_unique();
        fund_and_add_mints(&mut svm, &payer, quote_mint, 6, base_mint, 9);
        let instruction = create_market_instruction(
            payer.pubkey(),
            operator.pubkey(),
            quote_mint,
            base_mint,
            OracleConfig::PythTwap {
                feed_id: [feed_id; 32],
            },
            min_bps,
            max_bps,
        );
        let transaction = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&payer.pubkey()),
            &[&payer, &operator],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(transaction).is_err());
    }
}

#[test]
fn user_cannot_create_a_market_with_invalid_mints() {
    let cases = [(true, 6, 9), (false, 20, 9)];
    for (same_mint, quote_decimals, base_decimals) in cases {
        let mut svm = new_svm();
        let payer = Keypair::new();
        let operator = Keypair::new();
        let quote_mint = Pubkey::new_unique();
        let base_mint = if same_mint {
            quote_mint
        } else {
            Pubkey::new_unique()
        };
        svm.airdrop(&payer.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
        add_mint(&mut svm, quote_mint, quote_decimals, TOKEN_PROGRAM_ID);
        if !same_mint {
            add_mint(&mut svm, base_mint, base_decimals, TOKEN_PROGRAM_ID);
        }
        let instruction = create_market_instruction(
            payer.pubkey(),
            operator.pubkey(),
            quote_mint,
            base_mint,
            OracleConfig::PythTwap { feed_id: [10; 32] },
            0,
            0,
        );
        let transaction = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&payer.pubkey()),
            &[&payer, &operator],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(transaction).is_err());
    }
}

#[test]
fn user_cannot_create_a_market_with_a_non_spl_token_mint() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    svm.airdrop(&payer.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    add_mint(&mut svm, quote_mint, 6, Pubkey::new_unique());
    add_mint(&mut svm, base_mint, 9, TOKEN_PROGRAM_ID);
    let instruction = create_market_instruction(
        payer.pubkey(),
        operator.pubkey(),
        quote_mint,
        base_mint,
        OracleConfig::PythTwap { feed_id: [11; 32] },
        0,
        0,
    );
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[&payer, &operator],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_err());
}

#[test]
fn user_cannot_create_the_same_market_twice() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    let oracle_config = OracleConfig::PythTwap { feed_id: [12; 32] };
    fund_and_add_mints(&mut svm, &payer, quote_mint, 6, base_mint, 9);
    for expected_success in [true, false] {
        let instruction = create_market_instruction(
            payer.pubkey(),
            operator.pubkey(),
            quote_mint,
            base_mint,
            oracle_config,
            0,
            0,
        );
        let transaction = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&payer.pubkey()),
            &[&payer, &operator],
            svm.latest_blockhash(),
        );
        assert_eq!(svm.send_transaction(transaction).is_ok(), expected_success);
    }
}

#[test]
fn user_cannot_create_a_market_without_required_signatures() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    fund_and_add_mints(&mut svm, &payer, quote_mint, 6, base_mint, 9);
    let instruction = create_market_instruction(
        payer.pubkey(),
        operator.pubkey(),
        quote_mint,
        base_mint,
        OracleConfig::PythTwap { feed_id: [13; 32] },
        0,
        0,
    );
    let mut transaction = Transaction::new_with_payer(&[instruction], Some(&payer.pubkey()));
    transaction.partial_sign(&[&payer], svm.latest_blockhash());
    assert!(svm.send_transaction(transaction).is_err());
}

#[test]
fn user_cannot_create_a_market_without_the_payer_signature() {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let transaction_payer = Keypair::new();
    let operator = Keypair::new();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    fund_and_add_mints(&mut svm, &payer, quote_mint, 6, base_mint, 9);
    svm.airdrop(&transaction_payer.pubkey(), 10 * LAMPORTS_PER_SOL)
        .unwrap();
    let instruction = create_market_instruction(
        payer.pubkey(),
        operator.pubkey(),
        quote_mint,
        base_mint,
        OracleConfig::PythTwap { feed_id: [14; 32] },
        0,
        0,
    );
    let mut transaction =
        Transaction::new_with_payer(&[instruction], Some(&transaction_payer.pubkey()));
    transaction.partial_sign(&[&transaction_payer, &operator], svm.latest_blockhash());
    assert!(svm.send_transaction(transaction).is_err());
}
