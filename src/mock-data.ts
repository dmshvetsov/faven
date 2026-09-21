/**
 * Temporary respondent-test fixtures.
 * Remove this file and all MOCK_MODE branches when production data is wired.
 */
export const MOCK_MODE = true;

export const MOCK_DATA = {
  pricingMultiplier: 131.2,
  assets: [
    { symbol: "BTC", name: "Bitcoin", kind: "BTC Cryptocurrency", price: 77975.93, menuPrice: "$79,460", icon: "https://cdn.simpleicons.org/bitcoin/F7931A" },
    { symbol: "ETH", name: "Ethereum", kind: "ETH Cryptocurrency", price: 3840, menuPrice: "$3,840", icon: "https://cdn.simpleicons.org/ethereum/627EEA" },
    { symbol: "SOL", name: "Solana", kind: "SOL Cryptocurrency", price: 184, menuPrice: "$184", icon: "https://cdn.simpleicons.org/solana/9945FF" },
  ],
  targetPrices: [85000, 91000, 95000],
  settlementDates: ["SEP 25", "OCT 01", "OCT 15"],
} as const;
