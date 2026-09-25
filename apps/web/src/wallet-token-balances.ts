import { useQuery } from "@tanstack/react-query";
import { address } from "@solana/kit";
import { deriveAssociatedTokenAddress } from "sdk";

import type { MarketChoice } from "./market-selection";

export type WalletTokenBalances = Readonly<{
  base: bigint;
  quote: bigint;
}>;

export function useWalletTokenBalances(
  activeEoa: string | null,
  market: MarketChoice
) {
  return useQuery({
    enabled: activeEoa !== null,
    queryFn: async (): Promise<WalletTokenBalances> => {
      if (activeEoa === null) throw new Error("Wallet is not connected.");
      return fetchWalletTokenBalances(activeEoa, market);
    },
    queryKey: [
      "wallet-token-balances",
      activeEoa,
      market.baseMint,
      market.baseTokenProgram,
      market.quoteMint,
      market.quoteTokenProgram,
    ],
    refetchInterval: 10_000,
  });
}

async function fetchWalletTokenBalances(
  activeEoa: string,
  market: MarketChoice
): Promise<WalletTokenBalances> {
  const [baseAta, quoteAta] = await Promise.all([
    deriveAssociatedTokenAddress({
      owner: address(activeEoa),
      mint: address(market.baseMint),
      tokenProgram: address(market.baseTokenProgram),
    }),
    deriveAssociatedTokenAddress({
      owner: address(activeEoa),
      mint: address(market.quoteMint),
      tokenProgram: address(market.quoteTokenProgram),
    }),
  ]);
  const response = await fetch(requiredSolanaRpcUrl(), {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method: "getMultipleAccounts",
      params: [
        [baseAta, quoteAta],
        { commitment: "confirmed", encoding: "jsonParsed" },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Solana RPC returned ${response.status}.`);
  }
  return parseWalletTokenBalances(await response.json(), activeEoa, market);
}

function parseWalletTokenBalances(
  value: unknown,
  owner: string,
  market: MarketChoice
): WalletTokenBalances {
  if (
    !isRecord(value) ||
    !isRecord(value.result) ||
    !Array.isArray(value.result.value) ||
    value.result.value.length !== 2
  ) {
    throw new Error("Solana RPC returned an invalid token-balance response.");
  }
  const [baseAccount, quoteAccount] = value.result.value;
  return {
    base: parseTokenAccountBalance(baseAccount, {
      mint: market.baseMint,
      owner,
      tokenProgram: market.baseTokenProgram,
    }),
    quote: parseTokenAccountBalance(quoteAccount, {
      mint: market.quoteMint,
      owner,
      tokenProgram: market.quoteTokenProgram,
    }),
  };
}

function parseTokenAccountBalance(
  value: unknown,
  expected: {
    readonly mint: string;
    readonly owner: string;
    readonly tokenProgram: string;
  }
): bigint {
  if (value === null) return 0n;
  if (
    !isRecord(value) ||
    value.owner !== expected.tokenProgram ||
    !isRecord(value.data) ||
    !isRecord(value.data.parsed) ||
    value.data.parsed.type !== "account" ||
    !isRecord(value.data.parsed.info) ||
    value.data.parsed.info.mint !== expected.mint ||
    value.data.parsed.info.owner !== expected.owner ||
    !isRecord(value.data.parsed.info.tokenAmount) ||
    typeof value.data.parsed.info.tokenAmount.amount !== "string" ||
    !/^\d+$/.test(value.data.parsed.info.tokenAmount.amount)
  ) {
    throw new Error("Solana RPC returned an invalid token account.");
  }
  return BigInt(value.data.parsed.info.tokenAmount.amount);
}

function requiredSolanaRpcUrl(): string {
  const value = import.meta.env.VITE_SOLANA_RPC_URL?.trim();
  if (!value) throw new Error("VITE_SOLANA_RPC_URL must be configured.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
