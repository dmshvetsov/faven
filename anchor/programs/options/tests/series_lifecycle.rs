use anchor_lang::{AccountDeserialize, AccountSerialize, Event, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::{get_associated_token_address, ID as ASSOCIATED_TOKEN_PROGRAM_ID},
    token::{spl_token, ID as TOKEN_PROGRAM_ID},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use options::{
    accounts,
    events::SeriesCreated,
    instruction,
    state::{SellerVault, Series},
    OptionType, ID as PROGRAM_ID,
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
use spl_token::state::Account as SplTokenAccount;

#[path = "support/series.rs"]
mod support;
use support::*;

#[test]
fn buyer_and_seller_can_create_and_reuse_a_call_series_while_underwriting() {
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
    let strike = 350_000_000;
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
    add_token_account(
        &mut svm,
        get_associated_token_address(&seller.pubkey(), &quote_mint),
        quote_mint,
        seller.pubkey(),
        0,
    );
    let participants = UnderwriteAccounts {
        buyer: buyer.pubkey(),
        seller: seller.pubkey(),
        buyer_quote_source,
        seller_collateral_source: seller_base_source,
        fee_recipient,
    };
    let terms = (market, quote_mint, base_mint, 1, strike, EXPIRY_MS);
    let series = series_address(&market, 1, strike, EXPIRY_MS);
    let expected_created_log = format!(
        "Program data: {}",
        STANDARD.encode(
            SeriesCreated {
                series,
                market,
                option_type: OptionType::Call,
                strike_price: strike,
                expiry_ms: EXPIRY_MS,
            }
            .data()
        )
    );
    for underwriting_index in 0..2 {
        let underwrite = underwrite_instruction(
            true,
            terms,
            UnderwriteAccounts { ..participants },
            ONE_OPTION_E18,
            ONE_QUOTE_E18,
            500,
        );
        let instructions = if underwriting_index == 0 {
            vec![first_underwrite_compute_budget(), underwrite]
        } else {
            vec![underwrite]
        };
        let transaction = Transaction::new_signed_with_payer(
            &instructions,
            Some(&buyer.pubkey()),
            &[&buyer, &seller],
            svm.latest_blockhash(),
        );
        let result = svm.send_transaction(transaction);
        assert!(result.is_ok(), "{result:?}");
        let result = result.unwrap();
        if underwriting_index == 0 {
            assert!(
                result.compute_units_consumed <= u64::from(FIRST_UNDERWRITE_COMPUTE_UNITS),
                "first underwriting consumed {} compute units",
                result.compute_units_consumed
            );
        }
        let emitted_series_created = result.logs.iter().any(|log| log == &expected_created_log);
        assert_eq!(emitted_series_created, underwriting_index == 0);
        svm.expire_blockhash();
    }

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
    let quote_vault = svm
        .get_account(&get_associated_token_address(&series, &quote_mint))
        .expect("fresh call series must initialize its quote collateral vault");
    let quote_vault = SplTokenAccount::unpack(&quote_vault.data).unwrap();
    assert_eq!(quote_vault.mint, quote_mint);
    assert_eq!(quote_vault.owner, series);
    assert_eq!(quote_vault.amount, 0);
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
fn underwriting_rejects_a_seller_vault_with_an_invalid_owner() {
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
    let strike = 350_000_000;
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
        1_000_000_000,
    );
    add_token_account(
        &mut svm,
        get_associated_token_address(&seller.pubkey(), &quote_mint),
        quote_mint,
        seller.pubkey(),
        0,
    );
    let series = series_address(&market, 1, strike, EXPIRY_MS);
    let seller_vault = seller_vault_address(&market, 1, strike, EXPIRY_MS, &seller.pubkey());
    let mut seller_vault_data = Vec::new();
    SellerVault {
        owner: Pubkey::new_unique(),
        series,
        short_quantity: 0,
        collateral_quantity: 0,
    }
    .try_serialize(&mut seller_vault_data)
    .unwrap();
    svm.set_account(
        seller_vault,
        Account {
            lamports: 1_000_000,
            data: seller_vault_data,
            owner: PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let transaction = Transaction::new_signed_with_payer(
        &[underwrite_instruction(
            true,
            (market, quote_mint, base_mint, 1, strike, EXPIRY_MS),
            UnderwriteAccounts {
                buyer: buyer.pubkey(),
                seller: seller.pubkey(),
                buyer_quote_source,
                seller_collateral_source: seller_base_source,
                fee_recipient,
            },
            ONE_OPTION_E18,
            0,
            0,
        )],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(transaction).is_err());
}

#[test]
fn buyer_and_seller_can_create_a_put_series_while_underwriting() {
    let mut svm = new_svm();
    let payer = Keypair::new_from_array(deterministic_bytes(95_650));
    let operator = Keypair::new_from_array(deterministic_bytes(95_651));
    let buyer = Keypair::new_from_array(deterministic_bytes(195_651));
    let seller = Keypair::new_from_array(deterministic_bytes(295_651));
    let fee_recipient = Pubkey::new_from_array(deterministic_bytes(395_651));
    let quote_mint = Pubkey::new_from_array(deterministic_bytes(495_651));
    let base_mint = Pubkey::new_from_array(deterministic_bytes(595_651));
    for wallet in [&payer, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
    let strike = 350_000_000;
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
        &[
            first_underwrite_compute_budget(),
            underwrite_instruction(
                false,
                (market, quote_mint, base_mint, 2, strike, EXPIRY_MS),
                UnderwriteAccounts {
                    buyer: buyer.pubkey(),
                    seller: seller.pubkey(),
                    buyer_quote_source,
                    seller_collateral_source: seller_quote_source,
                    fee_recipient,
                },
                ONE_OPTION_E18,
                ONE_QUOTE_E18,
                0,
            ),
        ],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    let result = svm.send_transaction(transaction);
    assert!(result.is_ok(), "{result:?}");
    let compute_units_consumed = result.unwrap().compute_units_consumed;
    assert!(
        compute_units_consumed > 200_000,
        "first underwriting consumed {compute_units_consumed} compute units"
    );
    assert!(
        compute_units_consumed <= u64::from(FIRST_UNDERWRITE_COMPUTE_UNITS),
        "first underwriting consumed {compute_units_consumed} compute units"
    );

    let series = series_address(&market, 2, strike, EXPIRY_MS);
    assert_eq!(
        token_amount(&svm, &get_associated_token_address(&series, &quote_mint)),
        3_500_000
    );
    let base_vault = svm
        .get_account(&get_associated_token_address(&series, &base_mint))
        .expect("fresh put series must initialize its base collateral vault");
    let base_vault = SplTokenAccount::unpack(&base_vault.data).unwrap();
    assert_eq!(base_vault.mint, base_mint);
    assert_eq!(base_vault.owner, series);
    assert_eq!(base_vault.amount, 0);
    assert_eq!(token_amount(&svm, &seller_quote_source), 1_000_000);
}

fn finalize_unverified_instruction(
    operator: Pubkey,
    market: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    series: Pubkey,
    quote_collateral_vault: Pubkey,
    price: u64,
) -> Instruction {
    let accounts = accounts::FinalizePythUnverifiedSeries {
        operator,
        market,
        base_token_program: TOKEN_PROGRAM_ID,
        quote_token_program: TOKEN_PROGRAM_ID,
        base_mint,
        quote_mint,
    };
    let mut account_metas = accounts.to_account_metas(None);
    account_metas.push(AccountMeta::new(series, false));
    account_metas.push(AccountMeta::new_readonly(quote_collateral_vault, false));
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: instruction::FinalizePythUnverifiedSeries {
            id: [1; 32],
            price: i64::try_from(price).unwrap(),
            conf: 0,
            expo: -8,
            publish_time: 0,
        }
        .data(),
    }
}

fn exercise_instruction(
    is_call: bool,
    buyer: Pubkey,
    market: Pubkey,
    series: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    long_mint: Pubkey,
    buyer_long_ata: Pubkey,
    buyer_payment_source: Pubkey,
) -> Instruction {
    let accounts = accounts::Exercise {
        holder: buyer,
        market,
        base_mint,
        quote_mint,
        series,
        long_mint,
        holder_long_source: buyer_long_ata,
        holder_payment_source: buyer_payment_source,
        holder_receipt_ata: get_associated_token_address(
            &buyer,
            if is_call { &base_mint } else { &quote_mint },
        ),
        base_collateral_vault: get_associated_token_address(&series, &base_mint),
        quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
        long_token_program: TOKEN_PROGRAM_ID,
        base_token_program: TOKEN_PROGRAM_ID,
        quote_token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::ExerciseE18 {
            quantity_e18: ONE_OPTION_E18,
        }
        .data(),
    }
}

fn settle_instruction(
    settler: Pubkey,
    market: Pubkey,
    series: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
    seller_vault: Pubkey,
    seller_base_ata: Option<Pubkey>,
    seller_quote_ata: Option<Pubkey>,
) -> Instruction {
    let accounts = accounts::SettleSellersBatch {
        settler,
        market,
        base_token_program: TOKEN_PROGRAM_ID,
        quote_token_program: TOKEN_PROGRAM_ID,
        base_mint,
        quote_mint,
        series,
        base_collateral_vault: get_associated_token_address(&series, &base_mint),
        quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    let mut account_metas = accounts.to_account_metas(None);
    account_metas.push(AccountMeta::new(seller_vault, false));
    if let Some(seller_base_ata) = seller_base_ata {
        account_metas.push(AccountMeta::new(seller_base_ata, false));
    }
    if let Some(seller_quote_ata) = seller_quote_ata {
        account_metas.push(AccountMeta::new(seller_quote_ata, false));
    }
    Instruction {
        program_id: PROGRAM_ID,
        accounts: account_metas,
        data: instruction::SettleSellersBatch {}.data(),
    }
}

fn close_series_instruction(
    series_closer: Pubkey,
    market: Pubkey,
    market_operator: Pubkey,
    series: Pubkey,
    base_mint: Pubkey,
    quote_mint: Pubkey,
) -> Instruction {
    let accounts = accounts::CloseSeries {
        series_closer,
        market,
        market_operator,
        base_mint,
        quote_mint,
        series,
        base_collateral_vault: get_associated_token_address(&series, &base_mint),
        quote_collateral_vault: get_associated_token_address(&series, &quote_mint),
        base_token_program: TOKEN_PROGRAM_ID,
        quote_token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: anchor_lang::system_program::ID,
    };
    Instruction {
        program_id: PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: instruction::CloseSeries {}.data(),
    }
}

fn assert_fresh_series_lifecycle(is_call: bool, exercise: bool) {
    let mut svm = new_svm();
    let payer = Keypair::new();
    let operator = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    let fee_recipient = Pubkey::new_unique();
    let quote_mint = Pubkey::new_unique();
    let base_mint = Pubkey::new_unique();
    for wallet in [&payer, &operator, &buyer, &seller] {
        svm.airdrop(&wallet.pubkey(), 10 * LAMPORTS_PER_SOL)
            .unwrap();
    }
    add_mint(&mut svm, quote_mint, 6);
    add_mint(&mut svm, base_mint, 9);
    let market = create_market(&mut svm, &payer, &operator, quote_mint, base_mint);
    let strike = 350_000_000;
    let marker = if is_call { 1 } else { 2 };
    let series = series_address(&market, marker, strike, EXPIRY_MS);
    let long_mint = long_mint_address(&market, marker, strike, EXPIRY_MS);
    let buyer_quote_ata = get_associated_token_address(&buyer.pubkey(), &quote_mint);
    let buyer_base_ata = get_associated_token_address(&buyer.pubkey(), &base_mint);
    let seller_base_ata = get_associated_token_address(&seller.pubkey(), &base_mint);
    let seller_quote_ata = get_associated_token_address(&seller.pubkey(), &quote_mint);
    add_token_account(
        &mut svm,
        buyer_quote_ata,
        quote_mint,
        buyer.pubkey(),
        10_000_000,
    );
    add_token_account(
        &mut svm,
        buyer_base_ata,
        base_mint,
        buyer.pubkey(),
        1_000_000_000,
    );
    add_token_account(
        &mut svm,
        seller_base_ata,
        base_mint,
        seller.pubkey(),
        if is_call { 1_000_000_000 } else { 0 },
    );
    add_token_account(
        &mut svm,
        seller_quote_ata,
        quote_mint,
        seller.pubkey(),
        if is_call { 0 } else { 3_500_000 },
    );
    let participants = UnderwriteAccounts {
        buyer: buyer.pubkey(),
        seller: seller.pubkey(),
        buyer_quote_source: buyer_quote_ata,
        seller_collateral_source: if is_call {
            seller_base_ata
        } else {
            seller_quote_ata
        },
        fee_recipient,
    };
    let underwrite = underwrite_instruction(
        is_call,
        (market, quote_mint, base_mint, marker, strike, EXPIRY_MS),
        participants,
        ONE_OPTION_E18,
        0,
        0,
    );
    let transaction = Transaction::new_signed_with_payer(
        &[first_underwrite_compute_budget(), underwrite],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction).unwrap();
    assert!(svm
        .get_account(&get_associated_token_address(&series, &base_mint))
        .is_some());
    assert!(svm
        .get_account(&get_associated_token_address(&series, &quote_mint))
        .is_some());

    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from(EXPIRY_MS / 1_000).unwrap();
    svm.set_sysvar(&clock);
    let price = if exercise {
        if is_call {
            strike + 1
        } else {
            strike - 1
        }
    } else {
        strike
    };
    let transaction = Transaction::new_signed_with_payer(
        &[finalize_unverified_instruction(
            operator.pubkey(),
            market,
            base_mint,
            quote_mint,
            series,
            get_associated_token_address(&series, &quote_mint),
            price,
        )],
        Some(&operator.pubkey()),
        &[&operator],
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction).unwrap();

    if exercise {
        let transaction = Transaction::new_signed_with_payer(
            &[exercise_instruction(
                is_call,
                buyer.pubkey(),
                market,
                series,
                base_mint,
                quote_mint,
                long_mint,
                get_associated_token_address(&buyer.pubkey(), &long_mint),
                if is_call {
                    buyer_quote_ata
                } else {
                    buyer_base_ata
                },
            )],
            Some(&buyer.pubkey()),
            &[&buyer],
            svm.latest_blockhash(),
        );
        svm.send_transaction(transaction).unwrap();
    }

    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::try_from((EXPIRY_MS + 3_600_000) / 1_000).unwrap();
    svm.set_sysvar(&clock);
    let seller_vault = seller_vault_address(&market, marker, strike, EXPIRY_MS, &seller.pubkey());
    let (seller_base_payout, seller_quote_payout) = if exercise {
        if is_call {
            (None, Some(seller_quote_ata))
        } else {
            (Some(seller_base_ata), None)
        }
    } else if is_call {
        (Some(seller_base_ata), None)
    } else {
        (None, Some(seller_quote_ata))
    };
    let transaction = Transaction::new_signed_with_payer(
        &[settle_instruction(
            payer.pubkey(),
            market,
            series,
            base_mint,
            quote_mint,
            seller_vault,
            seller_base_payout,
            seller_quote_payout,
        )],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction).unwrap();
    if exercise {
        if is_call {
            assert_eq!(token_amount(&svm, &seller_base_ata), 0);
            assert_eq!(token_amount(&svm, &seller_quote_ata), 3_500_000);
        } else {
            assert_eq!(token_amount(&svm, &seller_base_ata), 1_000_000_000);
            assert_eq!(token_amount(&svm, &seller_quote_ata), 0);
        }
    } else if is_call {
        assert_eq!(token_amount(&svm, &seller_base_ata), 1_000_000_000);
    } else {
        assert_eq!(token_amount(&svm, &seller_quote_ata), 3_500_000);
    }
    let transaction = Transaction::new_signed_with_payer(
        &[close_series_instruction(
            payer.pubkey(),
            market,
            operator.pubkey(),
            series,
            base_mint,
            quote_mint,
        )],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction).unwrap();
    assert!(svm.get_account(&series).is_none());
    assert!(svm
        .get_account(&get_associated_token_address(&series, &base_mint))
        .is_none());
    assert!(svm
        .get_account(&get_associated_token_address(&series, &quote_mint))
        .is_none());
}

#[test]
fn fresh_call_and_put_series_settle_without_exercise_and_close() {
    assert_fresh_series_lifecycle(true, false);
    assert_fresh_series_lifecycle(false, false);
}

#[test]
fn fresh_call_and_put_series_exercise_settle_and_close() {
    assert_fresh_series_lifecycle(true, true);
    assert_fresh_series_lifecycle(false, true);
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
    let strike = 350_000_000;
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
    add_token_account(
        &mut svm,
        get_associated_token_address(&seller.pubkey(), &quote_mint),
        quote_mint,
        seller.pubkey(),
        0,
    );
    let terms = (market, quote_mint, base_mint, 1, strike, EXPIRY_MS);
    let participants = UnderwriteAccounts {
        buyer: buyer.pubkey(),
        seller: seller.pubkey(),
        buyer_quote_source,
        seller_collateral_source: seller_base_source,
        fee_recipient,
    };
    for (invalid_strike, invalid_expiry) in [(0, EXPIRY_MS), (strike, 1), (strike, EXPIRY_MS + 1)] {
        let transaction = Transaction::new_signed_with_payer(
            &[
                first_underwrite_compute_budget(),
                underwrite_instruction(
                    true,
                    (
                        market,
                        quote_mint,
                        base_mint,
                        1,
                        invalid_strike,
                        invalid_expiry,
                    ),
                    participants,
                    ONE_OPTION_E18,
                    0,
                    0,
                ),
            ],
            Some(&buyer.pubkey()),
            &[&buyer, &seller],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(transaction).is_err());
        svm.expire_blockhash();
    }
    let zero_quantity = Transaction::new_signed_with_payer(
        &[
            first_underwrite_compute_budget(),
            underwrite_instruction(true, terms, participants, 0, 0, 0),
        ],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(zero_quantity).is_err());
    svm.expire_blockhash();
    let mut missing_buyer_signature = Transaction::new_with_payer(
        &[underwrite_instruction(
            true,
            terms,
            participants,
            ONE_OPTION_E18,
            0,
            0,
        )],
        Some(&seller.pubkey()),
    );
    missing_buyer_signature.partial_sign(&[&seller], svm.latest_blockhash());
    assert!(svm.send_transaction(missing_buyer_signature).is_err());
    svm.expire_blockhash();

    let zero_premium = Transaction::new_signed_with_payer(
        &[
            first_underwrite_compute_budget(),
            underwrite_instruction(true, terms, participants, ONE_OPTION_E18, 0, 0),
        ],
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
        &[underwrite_instruction(
            true,
            terms,
            participants,
            ONE_OPTION_E18,
            0,
            0,
        )],
        Some(&buyer.pubkey()),
        &[&buyer, &seller],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(expiry_boundary).is_err());
}
