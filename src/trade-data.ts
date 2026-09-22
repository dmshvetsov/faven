export type AssetKind = "crypto" | "stock";
export type Direction = "sellHigher" | "buyLower";

export type Asset = {
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

export const assets: Asset[] = [
  {
    id: "btc",
    kind: "crypto",
    symbol: "BTC",
    name: "Bitcoin",
    price: 77975.93,
    icon: "/assets/bitcoin.svg",
  },
  {
    id: "eth",
    kind: "crypto",
    symbol: "ETH",
    name: "Ethereum",
    price: 2742.18,
    icon: "/assets/ethereum.svg",
  },
  {
    id: "sol",
    kind: "crypto",
    symbol: "SOL",
    name: "Solana",
    price: 147.92,
    icon: "/assets/solana.svg",
  },
  {
    id: "aapl",
    kind: "stock",
    symbol: "AAPL",
    name: "Apple",
    price: 223.41,
    icon: "/assets/apple.svg",
  },
  {
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

export function formatPrice(price: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: price % 1 === 0 ? 0 : 2,
  }).format(price);
}

export function getPremium(draft: TradeDraft): number {
  const multiplier = draft.direction === "sellHigher" ? 0.001442 : 0.00118;
  return Number((draft.amount * draft.targetPrice * multiplier).toFixed(2));
}
