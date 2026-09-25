import {
  autoDiscover,
  createClient,
  filterByNames,
  type WalletConnector,
  type WalletSession,
  watchWalletStandardConnectors,
} from "@solana/client";
import { partiallySignTransaction, type Transaction } from "@solana/kit";
import {
  SolanaClientProvider,
  useWallet as useSolanaWallet,
  useWalletActions,
} from "@solana/react-hooks";
import {
  clearBrowserSessionWallet,
  getOrCreateBrowserSessionWallet,
  hasBrowserSessionWallet,
  loadBrowserSessionWallet,
  type BrowserSessionWallet,
} from "./browser-session-wallet";
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
const BURNER_WALLET_ID = "faven.browser-session-wallet";
const SHOW_WALLET_NOTIFICATIONS = false;
type WalletStandardChain =
  | "solana:devnet"
  | "solana:localhost"
  | "solana:mainnet"
  | "solana:testnet";

export type FavenWallet = Readonly<{
  id: string;
  kind: "browser-session" | "extension";
  name: string;
}>;

const BURNER_WALLET: FavenWallet = {
  id: BURNER_WALLET_ID,
  kind: "browser-session",
  name: "Burner Temporary Wallet",
};

/** A compiled version-0 transaction supplied by the caller. */
export type VersionZeroTransaction = Transaction;

export type FavenWalletState = Readonly<{
  approvedWallets: readonly FavenWallet[];
  burnerWallet: FavenWallet | null;
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

function configuredWalletStandardChain(): WalletStandardChain {
  const configuredChain = import.meta.env.VITE_SOLANA_CHAIN?.trim();
  if (configuredChain) {
    if (
      configuredChain === "solana:devnet" ||
      configuredChain === "solana:localhost" ||
      configuredChain === "solana:mainnet" ||
      configuredChain === "solana:testnet"
    ) {
      return configuredChain;
    }
    throw new Error("Unsupported network value in configuration");
  }

  const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL?.toLowerCase() ?? "";
  if (rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")) {
    return "solana:localhost";
  }
  if (rpcUrl.includes("devnet")) return "solana:devnet";
  if (rpcUrl.includes("testnet")) return "solana:testnet";
  if (rpcUrl.includes("mainnet")) return "solana:mainnet";

  throw new Error("Network configuration is missing");
}

const WALLET_STANDARD_CHAIN = configuredWalletStandardChain();

function walletConnectorOverrides() {
  return { defaultChain: WALLET_STANDARD_CHAIN };
}

function isBurnerWalletSupportedChain() {
  return (
    WALLET_STANDARD_CHAIN === "solana:localhost" ||
    WALLET_STANDARD_CHAIN === "solana:devnet" ||
    WALLET_STANDARD_CHAIN === "solana:testnet"
  );
}

function discoverApprovedWallets() {
  return autoDiscover({
    filter: filterByNames(...APPROVED_WALLET_NAMES),
    overrides: walletConnectorOverrides,
  });
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
  return { id: connector.id, kind: "extension", name: connector.name };
}

function getSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    throw new Error(
      "Browser session storage is unavailable. Temporary wallets cannot be used."
    );
  }
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
  const burnerWalletSupported = isBurnerWalletSupportedChain();
  const [preferredWalletId, setPreferredWalletId] =
    useState(loadSelectedWalletId);
  const [extensionActiveEoa, setExtensionActiveEoa] = useState<string | null>(
    null
  );
  const [burnerSessionWallet, setBurnerSessionWallet] =
    useState<BrowserSessionWallet | null>(null);
  const [hasStoredBurnerWallet, setHasStoredBurnerWallet] = useState(() => {
    if (!burnerWalletSupported) return false;
    try {
      return hasBrowserSessionWallet(getSessionStorage());
    } catch {
      return false;
    }
  });
  const [isRestoringBurnerWallet, setRestoringBurnerWallet] = useState(
    burnerWalletSupported && hasStoredBurnerWallet
  );
  const [isBurnerConnecting, setBurnerConnecting] = useState(false);
  const accountChangeReconnect = useRef<Promise<unknown> | null>(null);
  const silentlyReconnectedWalletId = useRef<string | null>(null);

  const approvedWallets = useMemo(
    () => connectors.map(toFavenWallet),
    [connectors]
  );
  const connectedWalletId =
    wallet.status === "connected" ? wallet.connectorId : null;
  const selectedWalletId = connectedWalletId ?? preferredWalletId;
  const selectedWallet = burnerSessionWallet
    ? BURNER_WALLET
    : (approvedWallets.find(
        (walletOption) => walletOption.id === selectedWalletId
      ) ?? null);
  const activeEoa = burnerSessionWallet?.address ?? extensionActiveEoa;

  useEffect(() => {
    if (!burnerWalletSupported || !hasStoredBurnerWallet) {
      setRestoringBurnerWallet(false);
      return;
    }

    void (async () => {
      try {
        const storedWallet =
          await loadBrowserSessionWallet(getSessionStorage());
        setBurnerSessionWallet(storedWallet);
        setHasStoredBurnerWallet(storedWallet !== null);
      } catch {
        setHasStoredBurnerWallet(false);
      } finally {
        setRestoringBurnerWallet(false);
      }
    })();
  }, [burnerWalletSupported, hasStoredBurnerWallet]);

  useEffect(() => {
    if (wallet.status === "connected") {
      setExtensionActiveEoa(wallet.session.account.address.toString());
      return;
    }

    if (wallet.status !== "connecting") {
      setExtensionActiveEoa(null);
    }
  }, [wallet]);

  useEffect(() => {
    if (
      wallet.status !== "disconnected" ||
      isRestoringBurnerWallet ||
      hasStoredBurnerWallet ||
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
  }, [
    connectors,
    hasStoredBurnerWallet,
    isRestoringBurnerWallet,
    preferredWalletId,
    wallet.status,
    walletActions,
  ]);

  useEffect(() => {
    if (wallet.status !== "connected" || !wallet.session.onAccountsChanged) {
      return;
    }

    return wallet.session.onAccountsChanged((accounts) => {
      const activeAccount = accounts[0];
      if (!activeAccount) {
        setExtensionActiveEoa(null);
        return;
      }

      setExtensionActiveEoa(activeAccount.address.toString());
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
      if (wallet.status === "connecting" || isBurnerConnecting) {
        throw new Error("A wallet connection is already in progress.");
      }

      if (walletId === BURNER_WALLET_ID) {
        if (!burnerWalletSupported) {
          throw new Error(
            "Temporary wallets are only available on localhost, devnet, and testnet."
          );
        }

        setBurnerConnecting(true);
        try {
          const sessionWallet =
            await getOrCreateBrowserSessionWallet(getSessionStorage());
          await walletActions.disconnectWallet();
          setExtensionActiveEoa(null);
          setPreferredWalletId(null);
          saveSelectedWalletId(null);
          setBurnerSessionWallet(sessionWallet);
          setHasStoredBurnerWallet(true);
          return;
        } finally {
          setBurnerConnecting(false);
        }
      }

      await walletActions.connectWallet(walletId);
      setPreferredWalletId(walletId);
      saveSelectedWalletId(walletId);
    },
    [burnerWalletSupported, isBurnerConnecting, wallet.status, walletActions]
  );

  const disconnect = useCallback(async () => {
    if (burnerSessionWallet) {
      clearBrowserSessionWallet(getSessionStorage());
      setBurnerSessionWallet(null);
      setHasStoredBurnerWallet(false);
      setPreferredWalletId(null);
      saveSelectedWalletId(null);
      return;
    }

    await walletActions.disconnectWallet();
    setPreferredWalletId(null);
    saveSelectedWalletId(null);
  }, [burnerSessionWallet, walletActions]);

  const signTransaction = useCallback(
    async (transaction: VersionZeroTransaction) => {
      if (burnerSessionWallet) {
        const signingStartedAt = performance.now();
        const slowSigningWarning = window.setTimeout(() => {
          console.warn({
            event: "browser_session_wallet_transaction_sign_slow",
            cluster: WALLET_STANDARD_CHAIN,
            elapsedMs: Math.round(performance.now() - signingStartedAt),
          });
        }, 5_000);

        console.info({
          event: "browser_session_wallet_transaction_sign_started",
          cluster: WALLET_STANDARD_CHAIN,
          messageBytesLength: transaction.messageBytes.byteLength,
        });

        try {
          const signedTransaction = await partiallySignTransaction(
            [burnerSessionWallet.keyPair],
            transaction
          );
          const signature =
            signedTransaction.signatures[burnerSessionWallet.address];

          if (!signature) {
            console.warn({
              event: "browser_session_wallet_transaction_signature_missing",
              cluster: WALLET_STANDARD_CHAIN,
              elapsedMs: Math.round(performance.now() - signingStartedAt),
            });
          } else {
            console.info({
              event: "browser_session_wallet_transaction_sign_succeeded",
              cluster: WALLET_STANDARD_CHAIN,
              elapsedMs: Math.round(performance.now() - signingStartedAt),
            });
          }

          return signedTransaction;
        } catch (error) {
          console.error({
            event: "browser_session_wallet_transaction_sign_failed",
            cluster: WALLET_STANDARD_CHAIN,
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorMessage:
              error instanceof Error ? error.message : "Unknown signing error",
            elapsedMs: Math.round(performance.now() - signingStartedAt),
          });
          throw error;
        } finally {
          window.clearTimeout(slowSigningWarning);
        }
      }
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
    [burnerSessionWallet, wallet]
  );

  const value = useMemo<FavenWalletState>(
    () => ({
      activeEoa,
      approvedWallets,
      burnerWallet: burnerWalletSupported ? BURNER_WALLET : null,
      connect,
      disconnect,
      isConnecting:
        wallet.status === "connecting" ||
        isBurnerConnecting ||
        isRestoringBurnerWallet,
      selectedWallet,
      signTransaction,
    }),
    [
      activeEoa,
      approvedWallets,
      burnerWalletSupported,
      connect,
      disconnect,
      isBurnerConnecting,
      isRestoringBurnerWallet,
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
      watchWalletStandardConnectors(
        (discoveredConnectors) => {
          const approvedConnectors =
            discoveredConnectors.filter(isApprovedConnector);
          setConnectors((current) =>
            sameWalletConnectors(current, approvedConnectors)
              ? current
              : approvedConnectors
          );
        },
        { overrides: walletConnectorOverrides }
      ),
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
  if (
    error instanceof Error &&
    (error.message.includes("already in progress") ||
      error.message.includes("session storage") ||
      error.message.includes("Temporary wallets"))
  ) {
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
  burnerWallet,
  wallets,
}: {
  error: string | null;
  isConnecting: boolean;
  onClose: () => void;
  onSelect: (wallet: FavenWallet) => void;
  burnerWallet: FavenWallet | null;
  wallets: readonly FavenWallet[];
}) {
  const hasSupportedWallet = wallets.length > 0;

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
          {hasSupportedWallet ? "Choose a wallet" : "No supported wallet found"}
        </h2>
        {!hasSupportedWallet && (
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
        )}
        {(hasSupportedWallet || burnerWallet) && (
          <>
            {hasSupportedWallet && (
              <p>Choose the wallet you’d like to use with Faven.</p>
            )}
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
              {burnerWallet && (
                <>
                  <div
                    aria-label="Other options"
                    className="wallet-option-separator"
                    role="separator"
                  >
                    <span>Other options</span>
                  </div>
                  <button
                    className="burner-wallet-option"
                    disabled={isConnecting}
                    onClick={() => onSelect(burnerWallet)}
                    type="button"
                  >
                    <span className="wallet-mark wallet-burner">−</span>
                    <span>
                      <strong>{burnerWallet.name}</strong>
                      <span className="burner-wallet-hint">
                        Stored only for this browser session; closing it
                        permanently loses access to its funds.
                      </span>
                    </span>
                  </button>
                </>
              )}
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
  isBurnerWallet,
  walletName,
}: {
  eoa: string;
  onClose: () => void;
  onConfirm: () => void;
  isBurnerWallet: boolean;
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
        <p>
          {isBurnerWallet
            ? "Disconnecting permanently removes this session wallet. Any remaining funds will be inaccessible."
            : "You can reconnect this wallet at any time."}
        </p>
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
    burnerWallet,
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
          burnerWallet={burnerWallet}
          wallets={approvedWallets}
        />
      )}
      {isDisconnectDialogOpen && selectedWallet && activeEoa && (
        <DisconnectDialog
          eoa={activeEoa}
          isBurnerWallet={selectedWallet.kind === "browser-session"}
          onClose={() => setDisconnectDialogOpen(false)}
          onConfirm={handleDisconnect}
          walletName={selectedWallet.name}
        />
      )}
      {SHOW_WALLET_NOTIFICATIONS && notice && (
        <WalletNotice message={notice} onClose={() => setNotice(null)} />
      )}
    </>
  );
}
