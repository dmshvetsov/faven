import {
  AccountRole,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { describe, expect, it } from "vitest";

import type { MarketConfig } from "../src/config";
import type { RfqTerms } from "../src/rfq-book";
import { validateSignedUnderwrite } from "../src/transaction-validation";

const UNDERWRITE_CALL = [0xe3, 0x33, 0x07, 0x44, 0xf3, 0xe8, 0x20, 0xf6];
const BLOCKHASH = blockhash("11111111111111111111111111111111");

Object.defineProperty(globalThis, "isSecureContext", { value: true });

describe("signed underwrite validation", () => {
  it("rejects a valid buyer-signed transaction that differs from the seller RFQ", async () => {
    const rfq = await createRfqFixture();
    const alteredBuyer = await generateKeyPairSigner();
    const alteredQuote = await encodeUnderwrite(
      { ...rfq.accounts, buyer: alteredBuyer },
      25,
      [alteredBuyer]
    );

    await expect(
      validateSignedUnderwrite(alteredQuote, rfq.terms, "25", rfq.market, false)
    ).rejects.toThrow("premium-free RFQ transaction");
  });
});

interface RfqFixture {
  readonly accounts: TransactionAccounts;
  readonly market: MarketConfig;
  readonly terms: RfqTerms;
}

interface TransactionAccounts {
  readonly buyer: KeyPairSigner;
  readonly seller: KeyPairSigner;
  readonly optionsProgram: Address;
  readonly market: Address;
  readonly baseCoinMint: Address;
  readonly quoteCoinMint: Address;
  readonly series: Address;
  readonly longMint: Address;
  readonly buyerLongAta: Address;
  readonly buyerQuoteSource: Address;
  readonly sellerCollateralSource: Address;
  readonly sellerQuoteAta: Address;
  readonly feeRecipient: Address;
  readonly feeRecipientQuoteAta: Address;
  readonly sellerVault: Address;
  readonly baseCollateralVault: Address;
  readonly quoteCollateralVault: Address;
  readonly tokenProgram: Address;
  readonly associatedTokenProgram: Address;
  readonly systemProgram: Address;
}

async function createRfqFixture(): Promise<RfqFixture> {
  const accounts = await createTransactionAccounts();
  const premiumFreeTransaction = await encodeUnderwrite(accounts, 0, []);
  return {
    accounts,
    market: {
      optionsProgramId: accounts.optionsProgram,
      marketAddress: accounts.market,
      oracleBase: "BTC",
      baseCoinMint: accounts.baseCoinMint,
      quoteCoinMint: accounts.quoteCoinMint,
      baseCoinSymbol: "WBTC",
      quoteCoinSymbol: "USDC",
      feeRecipient: accounts.feeRecipient,
      operationalFeeBps: 50,
      quantity: { minimum: 1n, step: 1n, maximum: 1_000n },
    },
    terms: {
      asset: accounts.baseCoinMint,
      assetName: "BTC",
      chainId: "solana:testnet",
      expiry: 1_735_689_600,
      isPut: false,
      quantity: "10",
      strike: "6000000000000",
      collateralAsset: accounts.baseCoinMint,
      premiumAsset: accounts.quoteCoinMint,
      requestDeadline: 1_735_600_040_000,
      underwriteTx: premiumFreeTransaction,
    },
  };
}

async function createTransactionAccounts(): Promise<TransactionAccounts> {
  const signers = await Promise.all(
    Array.from({ length: 20 }, () => generateKeyPairSigner())
  );
  const [buyer, seller, ...addresses] = signers;
  return {
    buyer,
    seller,
    optionsProgram: addresses[0].address,
    market: addresses[1].address,
    baseCoinMint: addresses[2].address,
    quoteCoinMint: addresses[3].address,
    series: addresses[4].address,
    longMint: addresses[5].address,
    buyerLongAta: addresses[6].address,
    buyerQuoteSource: addresses[7].address,
    sellerCollateralSource: addresses[8].address,
    sellerQuoteAta: addresses[9].address,
    feeRecipient: addresses[10].address,
    feeRecipientQuoteAta: addresses[11].address,
    sellerVault: addresses[12].address,
    baseCollateralVault: addresses[13].address,
    quoteCollateralVault: addresses[14].address,
    tokenProgram: addresses[15].address,
    associatedTokenProgram: addresses[16].address,
    systemProgram: addresses[17].address,
  };
}

async function encodeUnderwrite(
  accounts: TransactionAccounts,
  premium: number,
  signers: readonly KeyPairSigner[]
): Promise<string> {
  const data = new Uint8Array(26);
  data.set(UNDERWRITE_CALL);
  new DataView(data.buffer).setBigUint64(8, 10n, true);
  new DataView(data.buffer).setBigUint64(16, BigInt(premium), true);
  new DataView(data.buffer).setUint16(24, 50, true);
  const message = appendTransactionMessageInstructions(
    [
      {
        programAddress: accounts.optionsProgram,
        data,
        accounts: [
          {
            address: accounts.buyer.address,
            role: AccountRole.READONLY_SIGNER,
          },
          {
            address: accounts.seller.address,
            role: AccountRole.WRITABLE_SIGNER,
          },
          { address: accounts.market, role: AccountRole.READONLY },
          { address: accounts.baseCoinMint, role: AccountRole.READONLY },
          { address: accounts.quoteCoinMint, role: AccountRole.READONLY },
          { address: accounts.series, role: AccountRole.WRITABLE },
          { address: accounts.longMint, role: AccountRole.WRITABLE },
          { address: accounts.buyerLongAta, role: AccountRole.WRITABLE },
          { address: accounts.buyerQuoteSource, role: AccountRole.WRITABLE },
          {
            address: accounts.sellerCollateralSource,
            role: AccountRole.WRITABLE,
          },
          { address: accounts.sellerQuoteAta, role: AccountRole.WRITABLE },
          { address: accounts.feeRecipient, role: AccountRole.READONLY },
          {
            address: accounts.feeRecipientQuoteAta,
            role: AccountRole.WRITABLE,
          },
          { address: accounts.sellerVault, role: AccountRole.WRITABLE },
          { address: accounts.baseCollateralVault, role: AccountRole.WRITABLE },
          {
            address: accounts.quoteCollateralVault,
            role: AccountRole.WRITABLE,
          },
          { address: accounts.tokenProgram, role: AccountRole.READONLY },
          {
            address: accounts.associatedTokenProgram,
            role: AccountRole.READONLY,
          },
          { address: accounts.systemProgram, role: AccountRole.READONLY },
        ],
      },
    ],
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
      setTransactionMessageFeePayer(
        accounts.seller.address,
        createTransactionMessage({ version: "legacy" })
      )
    )
  );
  const transaction = await partiallySignTransaction(
    signers.map((signer) => signer.keyPair),
    compileTransaction(message)
  );
  return getBase64EncodedWireTransaction(transaction);
}
