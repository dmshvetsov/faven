import {
  autoDiscover,
  createClient,
  filterByNames,
  type WalletConnector,
  type WalletSession,
  watchWalletStandardConnectors,
} from "@solana/client";
import type { Transaction } from "@solana/kit";
import {
  SolanaClientProvider,
  useWallet as useSolanaWallet,
  useWalletActions,
} from "@solana/react-hooks";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const APPROVED_WALLET_NAMES = ["Jupiter", "Backpack", "Phantom", "Solflare"];
const SELECTED_WALLET_STORAGE_KEY = "faven.selected-wallet";

export type FavenWallet = Readonly<{
  id: string;
  name: string;
}>;

/** A compiled version-0 transaction supplied by the caller. */
export type VersionZeroTransaction = Transaction;

export type FavenWalletState = Readonly<{
  approvedWallets: readonly FavenWallet[];
  selectedWallet: FavenWallet | null;
  activeEoa: string | null;
  isConnecting: boolean;
  connect(walletId: string): Promise<void>;
  disconnect(): Promise<void>;
  signTransaction(
    transaction: VersionZeroTransaction
  ): Promise<VersionZeroTransaction>;
}>;

const WalletContext = createContext<FavenWalletState | null>(null);

function isApprovedConnector(connector: WalletConnector) {
  const connectorName = connector.name.toLowerCase();
  return APPROVED_WALLET_NAMES.some((name) =>
    connectorName.includes(name.toLowerCase())
  );
}

function discoverApprovedWallets() {
  return autoDiscover({ filter: filterByNames(...APPROVED_WALLET_NAMES) });
}

function sameWalletConnectors(
  current: readonly WalletConnector[],
  next: readonly WalletConnector[]
) {
  return (
    current.length === next.length &&
    current.every((connector, index) => connector.id === next[index]?.id)
  );
}

function toFavenWallet(connector: WalletConnector): FavenWallet {
  return { id: connector.id, name: connector.name };
}

function loadSelectedWalletId() {
  try {
    return window.localStorage.getItem(SELECTED_WALLET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveSelectedWalletId(walletId: string | null) {
  try {
    if (walletId) {
      window.localStorage.setItem(SELECTED_WALLET_STORAGE_KEY, walletId);
    } else {
      window.localStorage.removeItem(SELECTED_WALLET_STORAGE_KEY);
    }
  } catch {
    // A private browser setting can deny storage. Wallet use remains available.
  }
}

function WalletStateProvider({
  children,
  connectors,
}: {
  children: ReactNode;
  connectors: readonly WalletConnector[];
}) {
  const wallet = useSolanaWallet();
  const walletActions = useWalletActions();
  const [preferredWalletId, setPreferredWalletId] =
    useState(loadSelectedWalletId);
  const [activeEoa, setActiveEoa] = useState<string | null>(null);
  const accountChangeReconnect = useRef<Promise<unknown> | null>(null);
  const silentlyReconnectedWalletId = useRef<string | null>(null);

  const approvedWallets = useMemo(
    () => connectors.map(toFavenWallet),
    [connectors]
  );
  const connectedWalletId =
    wallet.status === "connected" ? wallet.connectorId : null;
  const selectedWalletId = connectedWalletId ?? preferredWalletId;
  const selectedWallet =
    approvedWallets.find(
      (walletOption) => walletOption.id === selectedWalletId
    ) ?? null;

  useEffect(() => {
    if (wallet.status === "connected") {
      setActiveEoa(wallet.session.account.address.toString());
      return;
    }

    if (wallet.status !== "connecting") {
      setActiveEoa(null);
    }
  }, [wallet]);

  useEffect(() => {
    if (
      wallet.status !== "disconnected" ||
      !preferredWalletId ||
      !connectors.some((connector) => connector.id === preferredWalletId) ||
      silentlyReconnectedWalletId.current === preferredWalletId
    ) {
      return;
    }

    silentlyReconnectedWalletId.current = preferredWalletId;
    void walletActions
      .connectWallet(preferredWalletId, {
        allowInteractiveFallback: false,
        autoConnect: true,
      })
      .catch(() => undefined);
  }, [connectors, preferredWalletId, wallet.status, walletActions]);

  useEffect(() => {
    if (wallet.status !== "connected" || !wallet.session.onAccountsChanged) {
      return;
    }

    return wallet.session.onAccountsChanged((accounts) => {
      const activeAccount = accounts[0];
      if (!activeAccount) {
        setActiveEoa(null);
        return;
      }

      setActiveEoa(activeAccount.address.toString());
      if (accountChangeReconnect.current) return;
      accountChangeReconnect.current = walletActions
        .connectWallet(wallet.connectorId, {
          allowInteractiveFallback: false,
          autoConnect: true,
        })
        .catch(() => walletActions.disconnectWallet())
        .finally(() => {
          accountChangeReconnect.current = null;
        });
    });
  }, [wallet, walletActions]);

  const connect = useCallback(
    async (walletId: string) => {
      if (wallet.status === "connecting") {
        throw new Error("A wallet connection is already in progress.");
      }

      await walletActions.connectWallet(walletId);
      setPreferredWalletId(walletId);
      saveSelectedWalletId(walletId);
    },
    [wallet.status, walletActions]
  );

  const disconnect = useCallback(async () => {
    await walletActions.disconnectWallet();
    setPreferredWalletId(null);
    saveSelectedWalletId(null);
  }, [walletActions]);

  const signTransaction = useCallback(
    async (transaction: VersionZeroTransaction) => {
      if (wallet.status !== "connected") {
        throw new Error("Connect a wallet before signing a transaction.");
      }
      if (!wallet.session.signTransaction) {
        throw new Error("This wallet cannot sign transactions with Faven.");
      }

      // Wallet Standard accepts a partially signed v0 transaction here. The
      // client package type currently models only fully signed transactions.
      return wallet.session.signTransaction(
        transaction as Parameters<
          NonNullable<WalletSession["signTransaction"]>
        >[0]
      );
    },
    [wallet]
  );

  const value = useMemo<FavenWalletState>(
    () => ({
      activeEoa,
      approvedWallets,
      connect,
      disconnect,
      isConnecting: wallet.status === "connecting",
      selectedWallet,
      signTransaction,
    }),
    [
      activeEoa,
      approvedWallets,
      connect,
      disconnect,
      selectedWallet,
      signTransaction,
      wallet.status,
    ]
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

/** Owns Wallet Standard discovery and the Faven wallet connection lifecycle. */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [connectors, setConnectors] = useState(discoverApprovedWallets);
  const client = useMemo(
    () => createClient({ walletConnectors: connectors }),
    [connectors]
  );

  useEffect(() => {
    return () => client.destroy();
  }, [client]);

  useEffect(
    () =>
      watchWalletStandardConnectors((discoveredConnectors) => {
        const approvedConnectors =
          discoveredConnectors.filter(isApprovedConnector);
        setConnectors((current) =>
          sameWalletConnectors(current, approvedConnectors)
            ? current
            : approvedConnectors
        );
      }),
    []
  );

  return (
    <SolanaClientProvider client={client}>
      <WalletStateProvider connectors={connectors}>
        {children}
      </WalletStateProvider>
    </SolanaClientProvider>
  );
}

// This module deliberately exports Faven state and a provider together.
// eslint-disable-next-line react-refresh/only-export-components
export function useWallet() {
  const wallet = useContext(WalletContext);
  if (!wallet) {
    throw new Error("useWallet must be used inside WalletProvider.");
  }
  return wallet;
}

function shortenEoa(eoa: string) {
  return `${eoa.slice(0, 4)}…${eoa.slice(-4)}`;
}

function walletErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.includes("already in progress")) {
    return error.message;
  }
  return "Wallet connection was cancelled or failed. Please try again.";
}

function walletMarkClass(walletName: string) {
  const normalizedName = walletName.toLowerCase();
  if (normalizedName.includes("backpack")) return "wallet-backpack";
  if (normalizedName.includes("solflare")) return "wallet-solflare";
  return "";
}

function WalletDialog({
  error,
  isConnecting,
  onClose,
  onSelect,
  wallets,
}: {
  error: string | null;
  isConnecting: boolean;
  onClose: () => void;
  onSelect: (wallet: FavenWallet) => void;
  wallets: readonly FavenWallet[];
}) {
  return (
    <div
      aria-modal="true"
      className="dialog-backdrop"
      onMouseDown={isConnecting ? undefined : onClose}
      role="dialog"
    >
      <section
        className="wallet-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          aria-label="Close wallet selection"
          className="dialog-close"
          disabled={isConnecting}
          onClick={onClose}
          type="button"
        >
          <img alt="" src="/assets/close.svg" />
        </button>
        <h2>
          {wallets.length === 0
            ? "No supported wallet found"
            : "Choose a wallet"}
        </h2>
        {wallets.length === 0 ? (
          <>
            <p>
              Install Jupiter, Backpack, Phantom, or Solflare, then reopen this
              dialog.
            </p>
            <p className="wallet-install-links">
              <a href="https://jup.ag/wallet" rel="noreferrer" target="_blank">
                Jupiter
              </a>
              <a
                href="https://backpack.app/download"
                rel="noreferrer"
                target="_blank"
              >
                Backpack
              </a>
              <a
                href="https://phantom.com/download"
                rel="noreferrer"
                target="_blank"
              >
                Phantom
              </a>
              <a
                href="https://solflare.com/download"
                rel="noreferrer"
                target="_blank"
              >
                Solflare
              </a>
            </p>
          </>
        ) : (
          <>
            <p>Choose the wallet you’d like to use with Faven.</p>
            <div className="wallet-options">
              {wallets.map((wallet) => (
                <button
                  disabled={isConnecting}
                  key={wallet.id}
                  onClick={() => onSelect(wallet)}
                  type="button"
                >
                  <span
                    className={`wallet-mark ${walletMarkClass(wallet.name)}`}
                  >
                    {wallet.name.slice(0, 1)}
                  </span>
                  <strong>{wallet.name}</strong>
                </button>
              ))}
            </div>
            {isConnecting && (
              <p className="wallet-dialog-status">Connecting…</p>
            )}
            {error && <p className="wallet-dialog-error">{error}</p>}
          </>
        )}
      </section>
    </div>
  );
}

function DisconnectDialog({
  eoa,
  onClose,
  onConfirm,
  walletName,
}: {
  eoa: string;
  onClose: () => void;
  onConfirm: () => void;
  walletName: string;
}) {
  return (
    <div
      aria-modal="true"
      className="dialog-backdrop"
      onMouseDown={onClose}
      role="dialog"
    >
      <section
        className="wallet-dialog disconnect-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          aria-label="Close disconnect confirmation"
          className="dialog-close"
          onClick={onClose}
          type="button"
        >
          <img alt="" src="/assets/close.svg" />
        </button>
        <p className="eyebrow">Wallet connected</p>
        <h2>
          Disconnect {walletName} · {shortenEoa(eoa)}?
        </h2>
        <p>You can reconnect this wallet at any time.</p>
        <div className="dialog-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="primary-button" onClick={onConfirm} type="button">
            Disconnect
          </button>
        </div>
      </section>
    </div>
  );
}

function WalletNotice({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div className="wallet-notice" role="status">
      <span>{message}</span>
      <button aria-label="Dismiss" onClick={onClose} type="button">
        ×
      </button>
    </div>
  );
}

/** The Faven-owned header control. It only consumes the Faven useWallet hook. */
export function WalletConnectButton() {
  const {
    activeEoa,
    approvedWallets,
    connect,
    disconnect,
    isConnecting,
    selectedWallet,
  } = useWallet();
  const [isWalletDialogOpen, setWalletDialogOpen] = useState(false);
  const [isDisconnectDialogOpen, setDisconnectDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isConnected = Boolean(selectedWallet && activeEoa);
  const walletButtonLabel =
    selectedWallet && activeEoa
      ? `${selectedWallet.name} · ${shortenEoa(activeEoa)}`
      : isConnecting
        ? "Connecting…"
        : "Sign in";

  const handleWalletSelect = (wallet: FavenWallet) => {
    setError(null);
    void connect(wallet.id)
      .then(() => {
        setWalletDialogOpen(false);
        setNotice(`${wallet.name} connected`);
      })
      .catch((connectionError: unknown) => {
        setError(walletErrorMessage(connectionError));
      });
  };

  const handleDisconnect = () => {
    void disconnect()
      .then(() => {
        setNotice(`${selectedWallet?.name ?? "Wallet"} disconnected`);
      })
      .catch(() => {
        setNotice("Wallet disconnect failed. Please try again.");
      })
      .finally(() => {
        setDisconnectDialogOpen(false);
      });
  };

  return (
    <>
      <button
        className="sign-in-button"
        disabled={isConnecting}
        onClick={() => {
          if (isConnected) {
            setDisconnectDialogOpen(true);
          } else {
            setError(null);
            setWalletDialogOpen(true);
          }
        }}
        type="button"
      >
        {walletButtonLabel}
      </button>
      {isWalletDialogOpen && (
        <WalletDialog
          error={error}
          isConnecting={isConnecting}
          onClose={() => setWalletDialogOpen(false)}
          onSelect={handleWalletSelect}
          wallets={approvedWallets}
        />
      )}
      {isDisconnectDialogOpen && selectedWallet && activeEoa && (
        <DisconnectDialog
          eoa={activeEoa}
          onClose={() => setDisconnectDialogOpen(false)}
          onConfirm={handleDisconnect}
          walletName={selectedWallet.name}
        />
      )}
      {notice && (
        <WalletNotice message={notice} onClose={() => setNotice(null)} />
      )}
    </>
  );
}
