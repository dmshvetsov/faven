import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export type UnderwriteStatus = "queued" | "submitted" | "confirmed" | "failed";

export const underwrites = sqliteTable(
  "underwrites",
  {
    txSignature: text("tx_signature").notNull(),
    ixIndex: integer("ix_index").notNull(),
    rfqId: text("rfq_id").notNull(),
    status: text("status").$type<UnderwriteStatus>().notNull(),
    sellerAddress: text("seller_address").notNull(),
    buyerAddress: text("buyer_address").notNull(),
    marketAddress: text("market_address").notNull(),
    seriesAddress: text("series_address").notNull(),
    ticker: text("ticker").notNull(),
    isPut: integer("is_put", { mode: "boolean" }).notNull(),
    expiryMs: integer("expiry_ms").notNull(),
    strike: text("strike").notNull(),
    quantity: text("quantity").notNull(),
    premium: text("premium").notNull(),
    baseCoinMint: text("base_coin_mint").notNull(),
    quoteCoinMint: text("quote_coin_mint").notNull(),
    feeRecipient: text("fee_recipient").notNull(),
    operationalFeeBps: integer("operational_fee_bps").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    submittedAtMs: integer("submitted_at_ms"),
    confirmedAtMs: integer("confirmed_at_ms"),
    confirmedReceipt: text("confirmed_receipt"),
    lastError: text("last_error"),
  },
  (table) => [
    primaryKey({ columns: [table.txSignature, table.ixIndex] }),
    index("underwrites_seller_status_expiry_idx").on(
      table.sellerAddress,
      table.status,
      table.expiryMs
    ),
  ]
);

export const underwriteAudit = sqliteTable(
  "underwrite_audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    txSignature: text("tx_signature").notNull(),
    ixIndex: integer("ix_index").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    status: text("status").$type<UnderwriteStatus>().notNull(),
  },
  (table) => [
    index("underwrite_audit_underwrite_idx").on(
      table.txSignature,
      table.ixIndex
    ),
    uniqueIndex("underwrite_audit_transition_idx").on(
      table.txSignature,
      table.ixIndex,
      table.status
    ),
  ]
);

export const optionSeries = sqliteTable("option_series", {
  seriesAddress: text("series_address").primaryKey(),
  marketAddress: text("market_address").notNull(),
  ticker: text("ticker").notNull(),
  isPut: integer("is_put", { mode: "boolean" }).notNull(),
  expiryMs: integer("expiry_ms").notNull(),
  strike: text("strike").notNull(),
  baseCoinMint: text("base_coin_mint").notNull(),
  quoteCoinMint: text("quote_coin_mint").notNull(),
  confirmedAtMs: integer("confirmed_at_ms").notNull(),
});

export type WalletFundingStatus = "pending" | "succeeded" | "failed";

export const walletFundings = sqliteTable(
  "wallet_fundings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    walletAddress: text("wallet_address").notNull(),
    status: text("status").$type<WalletFundingStatus>().notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    transactionSignature: text("transaction_signature"),
    completedAtMs: integer("completed_at_ms"),
    failureReason: text("failure_reason"),
  },
  (table) => [
    index("wallet_fundings_wallet_succeeded_idx").on(
      table.walletAddress,
      table.status,
      table.completedAtMs
    ),
  ]
);
