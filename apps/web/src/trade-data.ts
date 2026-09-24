export type AssetKind = "crypto" | "stock";
export type Direction = "sellHigher" | "buyLower";

export type Asset = {
  contractAddress: string;
  id: string;
  kind: AssetKind;
  symbol: string;
  name: string;
  price: number;
  icon: string;
};

export type TradeDraft = {
  asset: Asset;
  assetKind: AssetKind;
  direction: Direction;
  amount: number;
  targetPrice: number;
  expiry: string;
};

export type TradeState = "active" | "settled" | "archived";
export type TradeResolution = "executed" | "notExecuted";

export type TradeRecord = TradeDraft & {
  created: string;
  id: string;
  resolution?: TradeResolution;
  state: TradeState;
};

export const assets: Asset[] = [
  {
    contractAddress: "0x8A2f3C914e56D7b8A9c0E1f2A3b4C5d6E7f84910",
    id: "btc",
    kind: "crypto",
    symbol: "BTC",
    name: "Bitcoin",
    price: 77975.93,
    icon: "/assets/bitcoin.svg",
  },
  {
    contractAddress: "0x71C3a5E9f2B48d6C0a1E7f3B9d5C2a8E4f6BEf89",
    id: "eth",
    kind: "crypto",
    symbol: "ETH",
    name: "Ethereum",
    price: 2742.18,
    icon: "/assets/ethereum.svg",
  },
  {
    contractAddress: "0x9E40c6A1f3B57d8E2a4C9f0B6d1E3a7C5f8Abd31",
    id: "sol",
    kind: "crypto",
    symbol: "SOL",
    name: "Solana",
    price: 147.92,
    icon: "/assets/solana.svg",
  },
  {
    contractAddress: "0x5DA7b3E1f9C42a8D6e0B5c7A1f4D9e2C8a6F29c4",
    id: "aapl",
    kind: "stock",
    symbol: "AAPL",
    name: "Apple",
    price: 223.41,
    icon: "/assets/apple.svg",
  },
  {
    contractAddress: "0x2F91d7A4e8C03b6F1a5D9c2E7f4B0a8C6e3Fa8d3",
    id: "nvda",
    kind: "stock",
    symbol: "NVDA",
    name: "NVIDIA",
    price: 171.11,
    icon: "/assets/nvidia.svg",
  },
];

export const expiryOptions = ["SEP 25", "OCT 10", "OCT 24", "NOV 07"];

export const targetOptions = [91000, 95000, 100000, 105000];

export const initialDraft: TradeDraft = {
  asset: assets[0],
  assetKind: "crypto",
  direction: "sellHigher",
  amount: 0.05,
  targetPrice: 91000,
  expiry: "SEP 25",
};

export function createMockTrades(draft: TradeDraft): TradeRecord[] {
  return [
    { ...draft, created: "Today", id: "new-trade", state: "active" },
    {
      amount: 0.3,
      asset: assets[1],
      assetKind: "crypto",
      created: "Sep 18",
      direction: "sellHigher",
      expiry: "OCT 10",
      id: "eth-active",
      state: "active",
      targetPrice: 3000,
    },
    {
      amount: 1.4,
      asset: assets[3],
      assetKind: "stock",
      created: "Aug 14",
      direction: "sellHigher",
      expiry: "AUG 28",
      id: "apple-settled",
      resolution: "executed",
      state: "settled",
      targetPrice: 230,
    },
    {
      amount: 0.35,
      asset: assets[4],
      assetKind: "stock",
      created: "Aug 02",
      direction: "sellHigher",
      expiry: "AUG 16",
      id: "nvidia-settled",
      resolution: "notExecuted",
      state: "settled",
      targetPrice: 180,
    },
    {
      amount: 5,
      asset: assets[2],
      assetKind: "crypto",
      created: "Jul 21",
      direction: "buyLower",
      expiry: "AUG 08",
      id: "solana-archived",
      state: "archived",
      targetPrice: 135,
    },
  ];
}

export function formatPrice(price: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: price % 1 === 0 ? 0 : 2,
  }).format(price);
}

export function formatExpiry(expiry: string, now = new Date()): string {
  const [month, day] = expiry.split(" ");
  const months = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];
  const monthIndex = months.indexOf(month);
  const currentDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const settlement = new Date(now.getFullYear(), monthIndex, Number(day));

  if (settlement < currentDay) settlement.setFullYear(now.getFullYear() + 1);

  return settlement.getFullYear() === now.getFullYear()
    ? expiry
    : `${expiry}, ${settlement.getFullYear()}`;
}

export function getPremium(draft: TradeDraft): number {
  const multiplier = draft.direction === "sellHigher" ? 0.001442 : 0.00118;
  return Number((draft.amount * draft.targetPrice * multiplier).toFixed(2));
}
