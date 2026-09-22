export type WalletProvider = {
  connect: () => Promise<{ publicKey?: { toString(): string } }>;
  disconnect?: () => Promise<void>;
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: { toString(): string };
};

export type DetectedWallet = {
  id: string;
  name: string;
  provider: WalletProvider;
};

type WalletWindow = Window &
  typeof globalThis & {
    phantom?: { solana?: WalletProvider };
    solana?: WalletProvider;
    solflare?: WalletProvider;
  };

function addWallet(
  wallets: DetectedWallet[],
  id: string,
  name: string,
  provider: WalletProvider | undefined
) {
  if (provider && !wallets.some((wallet) => wallet.provider === provider)) {
    wallets.push({ id, name, provider });
  }
}

export function detectWallets(): DetectedWallet[] {
  const walletWindow = window as WalletWindow;
  const wallets: DetectedWallet[] = [];

  addWallet(
    wallets,
    "phantom",
    "Phantom",
    walletWindow.phantom?.solana ??
      (walletWindow.solana?.isPhantom ? walletWindow.solana : undefined)
  );
  addWallet(
    wallets,
    "solflare",
    "Solflare",
    walletWindow.solflare ??
      (walletWindow.solana?.isSolflare ? walletWindow.solana : undefined)
  );

  return wallets;
}
