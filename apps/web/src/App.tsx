import { useEffect, useMemo, useRef, useState } from "react";
import {
  assets,
  createMockTrades,
  expiryOptions,
  formatExpiry,
  formatPrice,
  getPremium,
  initialDraft,
  targetOptions,
  type Asset,
  type AssetKind,
  type Direction,
  type TradeDraft,
  type TradeRecord,
  type TradeResolution,
  type TradeState,
} from "./trade-data";
import { detectWallets, getWalletPreview, type DetectedWallet } from "./wallet";

type View = "earn" | "dashboard" | "trade-detail";
type OpenMenu = "asset" | "target" | "expiry" | null;
type TradeTab = "active" | "settled";

const showOpenedReviewPreview =
  new URLSearchParams(window.location.search).get("review") === "opened";

// Keep wallet sign-in available for production, but leave it off while the
// prototype is being tested end-to-end without a wallet extension.
const requireWalletSignInForReview = false;

const steps = [
  [
    "Buy or sell",
    "Choose whether you’d buy below today’s price or sell above it",
  ],
  ["Choose an asset type", "Pick a cryptocurrency or tokenized stock"],
  [
    "Choose a cryptocurrency",
    "You’ll see its current price before choosing yours",
  ],
  [
    "How much would you like to sell?",
    "Choose how much BTC you would sell if its price is above your target",
  ],
  ["Set target price", "The market price of BTC that triggers your trade"],
  [
    "How long are you willing to wait",
    "The longer you wait the higher APR. Your funds stay locked until chosen date",
  ],
] as const;

function Icon({
  name,
  className = "",
}: {
  name: "check" | "chevron" | "arrow";
  className?: string;
}) {
  const source = `/assets/${name === "arrow" ? "arrow-right" : name}.svg`;
  return (
    <img aria-hidden="true" className={`icon ${className}`} src={source} />
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" className="copy-icon" viewBox="0 0 16 16">
      <rect height="9" rx="1" width="9" x="5" y="2" />
      <path d="M11 5v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1" />
    </svg>
  );
}

function formatContractAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function RollingValue({
  children,
  value,
}: {
  children: React.ReactNode;
  value: string | number;
}) {
  return (
    <span className="rolling-value" key={value}>
      {children}
    </span>
  );
}

function StepHeading({
  index,
  title,
  description,
}: {
  index: number;
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="step-heading">
      <span className="step-number">{index}</span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </div>
  );
}

function BackpackMark({ className = "" }: { className?: string }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={`backpack-mark ${className}`}
      src="/assets/backpack.svg"
    />
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-content">
        <div className="footer-partners">
          <span className="footer-partner">
            <img alt="" src="/assets/solana.svg" />
            Build on Solana
          </span>
          <span className="footer-partner">
            <BackpackMark />
            Build with Backpack securities
          </span>
        </div>
        <nav aria-label="Footer navigation" className="footer-links">
          <a href="#terms-of-service">Terms of service</a>
          <a href="#email">Email</a>
          <a href="#tg-group">TG group</a>
          <a href="#documentation">Documentation</a>
        </nav>
      </div>
    </footer>
  );
}

function OptionButton({
  children,
  selected,
  onClick,
}: {
  children: React.ReactNode;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`segment-option ${selected ? "is-selected" : ""}`}
      onClick={onClick}
      type="button"
    >
      <span>{children}</span>
      {selected && <Icon name="check" />}
    </button>
  );
}

function Segmented({
  children,
  selectedIndex,
}: {
  children: React.ReactNode;
  selectedIndex: 0 | 1;
}) {
  return (
    <div className="segmented">
      <span
        aria-hidden="true"
        className={`segment-indicator ${selectedIndex === 1 ? "is-right" : ""}`}
      />
      {children}
    </div>
  );
}

function Dropdown({
  label,
  open,
  onToggle,
  children,
  alignValue = false,
}: {
  label: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  alignValue?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [opensUpward, setOpensUpward] = useState(false);

  useEffect(() => {
    if (!open || !rootRef.current) return;

    const spaceBelow =
      window.innerHeight - rootRef.current.getBoundingClientRect().bottom;
    setOpensUpward(spaceBelow < 280);
  }, [open]);

  return (
    <div
      className={`dropdown ${opensUpward ? "opens-upward" : ""}`}
      data-dropdown-root
      ref={rootRef}
    >
      <button
        aria-expanded={open}
        className={`select-trigger ${alignValue ? "align-value" : ""}`}
        onClick={onToggle}
        type="button"
      >
        <span className={alignValue ? "dropdown-trigger-value" : ""}>
          {label}
        </span>
        <Icon className={open ? "is-open" : ""} name="chevron" />
      </button>
      {open && <div className="dropdown-menu">{children}</div>}
    </div>
  );
}

function AssetBadge({ asset }: { asset: Asset }) {
  return (
    <span className={`asset-badge asset-${asset.id}`}>
      <img alt="" src={asset.icon} />
    </span>
  );
}

function TradeSummary({
  draft,
  onReview,
}: {
  draft: TradeDraft;
  onReview: () => void;
}) {
  const premium = getPremium(draft);
  const isSell = draft.direction === "sellHigher";
  const verb = isSell ? "sell" : "buy";
  const condition = isSell ? "above" : "at or below";
  const comparison = isSell ? "at or below" : "above";
  const targetValue = draft.amount * draft.targetPrice;
  const formattedExpiry = formatExpiry(draft.expiry);
  const days = draft.expiry === "SEP 25" ? 11 : 25;
  const annualizedApr = ((premium / targetValue) * (365 / days) * 100).toFixed(
    2
  );

  return (
    <aside className="trade-summary">
      <p className="summary-title">
        You’ll receive{" "}
        <RollingValue value={premium}>{premium.toFixed(2)}</RollingValue> USDC
        upfront. You’ll <RollingValue value={verb}>{verb}</RollingValue>{" "}
        <RollingValue value={draft.amount}>{draft.amount}</RollingValue>{" "}
        <RollingValue value={draft.asset.symbol}>
          {draft.asset.symbol}
        </RollingValue>{" "}
        if {draft.asset.symbol} is {condition} $
        <RollingValue value={draft.targetPrice}>
          {formatPrice(draft.targetPrice)}
        </RollingValue>{" "}
        on{" "}
        <RollingValue value={draft.expiry}>
          {formattedExpiry.replace(
            /^[A-Z]{3}/,
            (month) => `${month[0]}${month.slice(1).toLowerCase()}`
          )}
        </RollingValue>
      </p>

      <div className="summary-group">
        <span className="lime-label">Now</span>
        <section className="summary-card today-card">
          <ul>
            <li>
              Receive{" "}
              <RollingValue value={premium}>{premium.toFixed(2)}</RollingValue>{" "}
              USDC upfront
            </li>
            <li>
              Lock{" "}
              <RollingValue value={draft.amount}>{draft.amount}</RollingValue>{" "}
              <RollingValue value={draft.asset.symbol}>
                {draft.asset.symbol}
              </RollingValue>
            </li>
          </ul>
          <p>
            {((premium / targetValue) * 100).toFixed(2)}% over {days} days ·{" "}
            {annualizedApr}% APR
          </p>
        </section>
      </div>

      <div className="summary-group outcome-group">
        <div className="outcome-label">
          <span className="lime-label">
            <RollingValue value={draft.expiry}>{formattedExpiry}</RollingValue>
          </span>
          <strong>2 possible outcomes</strong>
        </div>
        <section className="summary-card outcome-card">
          <div>
            <h4>
              → If {draft.asset.symbol} {comparison} $
              {formatPrice(draft.targetPrice)}
            </h4>
            <ul>
              <li>
                {isSell
                  ? `Get your ${draft.amount} ${draft.asset.symbol} back`
                  : `Your ${draft.amount} ${draft.asset.symbol} is returned`}
              </li>
              <li>You keep the USDC already received upfront</li>
            </ul>
          </div>
          <div>
            <h4>
              → If {draft.asset.symbol} {isSell ? "above" : "at or below"} $
              {formatPrice(draft.targetPrice)}
            </h4>
            <ul>
              <li>
                {isSell
                  ? `Sell ${draft.amount} ${draft.asset.symbol} and receive ${formatPrice(targetValue)} USDC in your wallet`
                  : `Buy ${draft.amount} ${draft.asset.symbol} at the target price`}
              </li>
            </ul>
          </div>
        </section>
      </div>

      <button className="review-button" onClick={onReview} type="button">
        <span>
          Review &amp; Earn{" "}
          <RollingValue value={premium}>{premium.toFixed(2)}</RollingValue> USDC
        </span>
        <Icon name="arrow" />
      </button>
      <p className="summary-footnote">
        View the details and terms — the trade starts after confirmation.
      </p>
    </aside>
  );
}

function TradeStatus({
  expiry,
  resolution,
  state = "active",
}: {
  expiry: string;
  resolution?: TradeResolution;
  state?: TradeState;
}) {
  const label =
    resolution === "notExecuted"
      ? "Not executed"
      : state === "active"
        ? `Waiting for ${formatExpiry(expiry)}`
        : state === "settled"
          ? "Settled"
          : "Archived";

  return (
    <span className={`status-pill is-${resolution ?? state}`}>{label}</span>
  );
}

function OutcomeFlow({ draft }: { draft: TradeDraft }) {
  const isSell = draft.direction === "sellHigher";
  const targetValue = draft.amount * draft.targetPrice;

  return (
    <div className="review-outcomes outcome-flow">
      <span className="lime-label">{formatExpiry(draft.expiry)}</span>
      <p>2 possible outcomes</p>
      <img
        alt=""
        className="outcome-connector"
        src="/assets/outcome-connector.svg"
      />
      <div className="review-outcome-grid">
        <section>
          <h3>
            → If {draft.asset.symbol} {isSell ? "at or below" : "above"} $
            {formatPrice(draft.targetPrice)}
          </h3>
          <ul>
            <li>
              {isSell
                ? `Get your ${draft.amount} ${draft.asset.symbol} back`
                : `Your ${draft.amount} ${draft.asset.symbol} is returned`}
            </li>
            <li>You keep the USDC already received upfront</li>
          </ul>
        </section>
        <section>
          <h3>
            → If {draft.asset.symbol} {isSell ? "above" : "at or below"} $
            {formatPrice(draft.targetPrice)}
          </h3>
          <ul>
            <li>
              {isSell
                ? `Sell ${draft.amount} ${draft.asset.symbol} and receive ${formatPrice(targetValue)} USDC in your wallet`
                : `Buy ${draft.amount} ${draft.asset.symbol} at the target price`}
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function ReviewDialog({
  draft,
  onClose,
  onConfirm,
  isPositionOpen,
  isSigningIn,
  onViewTrade,
  onStartNewTrade,
}: {
  draft: TradeDraft;
  onClose: () => void;
  onConfirm: () => void;
  isPositionOpen: boolean;
  isSigningIn: boolean;
  onViewTrade: () => void;
  onStartNewTrade: () => void;
}) {
  const premium = getPremium(draft);
  const isSell = draft.direction === "sellHigher";
  return (
    <div
      aria-modal="true"
      className="dialog-backdrop"
      onMouseDown={onClose}
      role="dialog"
    >
      <section
        className="review-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          aria-label="Close review"
          className="dialog-close"
          onClick={onClose}
          type="button"
        >
          <img alt="" src="/assets/close.svg" />
        </button>
        {isPositionOpen ? (
          <div className="position-opened">
            <div aria-hidden="true" className="position-opened-mark">
              <span className="position-opened-stroke">
                <img alt="" src="/assets/check.svg" />
              </span>
            </div>
            <h2>Your trade is opened</h2>
            <p className="position-opened-reward">
              <strong>{premium.toFixed(2)} USDC</strong> has been sent to your
              wallet
            </p>
            <button
              className="sign-in-button success-action-button"
              onClick={onViewTrade}
              type="button"
            >
              View opened trade
            </button>
            <button
              className="sign-in-button success-action-button position-new-trade-button"
              onClick={onStartNewTrade}
              type="button"
            >
              Create new trade
            </button>
          </div>
        ) : (
          <>
            <h2>
              You’ll get {premium.toFixed(2)} USDC upfront for agreeing to{" "}
              {isSell ? "sell" : "buy"} {draft.amount} {draft.asset.symbol} if{" "}
              {draft.asset.symbol} is {isSell ? "above" : "at or below"} $
              {formatPrice(draft.targetPrice)} on{" "}
              {formatExpiry(draft.expiry).replace(
                /^[A-Z]{3}/,
                (month) => `${month[0]}${month.slice(1).toLowerCase()}`
              )}
            </h2>
            <div className="review-today">
              <span className="lime-label">Now</span>
              <section>
                <ul>
                  <li>Receive {premium.toFixed(2)} USDC upfront</li>
                  <li>
                    Lock {draft.amount} {draft.asset.symbol}
                  </li>
                </ul>
                <p className="review-yield">
                  <span>0.54% over 11 days</span>
                  <strong>14.77% APR</strong>
                </p>
              </section>
            </div>
            <OutcomeFlow draft={draft} />
            <button
              className="review-button"
              disabled={isSigningIn}
              onClick={onConfirm}
              type="button"
            >
              {isSigningIn ? (
                <>
                  Sign in a Wallet
                  <span aria-label="Signing in" className="button-spinner" />
                </>
              ) : (
                <>Confirm &amp; Earn {premium.toFixed(2)} USDC</>
              )}
            </button>
            <button
              className="review-back-button"
              onClick={onClose}
              type="button"
            >
              <Icon className="back-arrow" name="arrow" />
              Back
            </button>
          </>
        )}
      </section>
    </div>
  );
}

function WalletDialog({
  wallets,
  onClose,
  onSelect,
}: {
  wallets: DetectedWallet[];
  onClose: () => void;
  onSelect: (wallet: DetectedWallet) => void;
}) {
  return (
    <div
      aria-modal="true"
      className="dialog-backdrop"
      onMouseDown={onClose}
      role="dialog"
    >
      <section
        className="wallet-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          aria-label="Close wallet selection"
          className="dialog-close"
          onClick={onClose}
          type="button"
        >
          <img alt="" src="/assets/close.svg" />
        </button>
        <h2>Choose a wallet</h2>
        <p>Choose the wallet you’d like to use with Faven.</p>
        <div className="wallet-options">
          {wallets.map((wallet) => (
            <button
              key={wallet.id}
              onClick={() => onSelect(wallet)}
              type="button"
            >
              <span className={`wallet-mark wallet-${wallet.id}`}>
                {wallet.name.slice(0, 1)}
              </span>
              <strong>{wallet.name}</strong>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function DisconnectDialog({
  walletName,
  onClose,
  onConfirm,
}: {
  walletName: string;
  onClose: () => void;
  onConfirm: () => void;
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
        <h2>Disconnect {walletName}?</h2>
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

function tradeTitle(trade: TradeRecord) {
  const isSell = trade.direction === "sellHigher";

  if (trade.state === "settled") {
    if (trade.resolution === "executed") {
      return `${isSell ? "Sold" : "Bought"} ${trade.amount} ${trade.asset.symbol} at $${formatPrice(trade.targetPrice)}`;
    }

    return `Not executed — ${trade.amount} ${trade.asset.symbol} was not ${isSell ? "sold" : "bought"}`;
  }

  return `${isSell ? "Sell" : "Buy"} ${trade.amount} ${trade.asset.symbol} if ${trade.asset.symbol} is ${isSell ? "above" : "at or below"} $${formatPrice(trade.targetPrice)}`;
}

function Dashboard({
  onStartTrade,
  onOpenTrade,
  trades,
}: {
  onStartTrade: () => void;
  onOpenTrade: (trade: TradeRecord) => void;
  trades: TradeRecord[];
}) {
  const [tab, setTab] = useState<TradeTab>("active");
  const visibleTrades = trades.filter((trade) => trade.state === tab);
  const tabCount = (state: TradeState) =>
    trades.filter((trade) => trade.state === state).length;

  return (
    <main className="dashboard page-enter">
      <div className="dashboard-heading">
        <h1>Your trades</h1>
        <p>Select a trade to view its conditions and current outcome</p>
      </div>
      <nav aria-label="Trade status" className="dashboard-tabs">
        <button
          className={tab === "active" ? "is-active" : ""}
          onClick={() => setTab("active")}
          type="button"
        >
          Opened <span>{tabCount("active")}</span>
        </button>
        <button
          className={tab === "settled" ? "is-active" : ""}
          onClick={() => setTab("settled")}
          type="button"
        >
          Closed <span>{tabCount("settled")}</span>
        </button>
      </nav>
      {visibleTrades.length > 0 ? (
        <div className="trade-list">
          {visibleTrades.map((trade) => (
            <button
              className="trade-row"
              key={trade.id}
              onClick={() => onOpenTrade(trade)}
              type="button"
            >
              <span className="trade-row-main">
                <AssetBadge asset={trade.asset} />
                <span>
                  <strong>{tradeTitle(trade)}</strong>
                  <small>
                    {trade.state === "active"
                      ? `Settlement on ${formatExpiry(trade.expiry)}`
                      : `Created ${trade.created}`}
                  </small>
                </span>
              </span>
              <span className="trade-row-meta">
                <TradeStatus
                  expiry={trade.expiry}
                  resolution={trade.resolution}
                  state={trade.state}
                />
                <small>+{getPremium(trade).toFixed(2)} USDC received</small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="empty-trades">
          No {tab === "active" ? "opened" : "closed"} trades yet
        </p>
      )}
      <button
        className="sign-in-button new-trade-button"
        onClick={onStartTrade}
        type="button"
      >
        Create new trade
      </button>
    </main>
  );
}

function TradeDetail({
  onBack,
  onStartTrade,
  trade,
}: {
  onBack: () => void;
  onStartTrade: () => void;
  trade: TradeRecord;
}) {
  const draft = trade;
  const premium = getPremium(draft);

  return (
    <main className="trade-detail page-enter">
      <button className="back-button" onClick={onBack} type="button">
        <Icon className="back-arrow" name="arrow" />
        Back to trades
      </button>
      <div className="trade-detail-heading">
        <div>
          <TradeStatus
            expiry={draft.expiry}
            resolution={trade.resolution}
            state={trade.state}
          />
          <h1>{tradeTitle(trade)}</h1>
          {trade.resolution === "notExecuted" && (
            <p className="is-not-executed">
              This trade was not executed because the market maker declined it
            </p>
          )}
          <strong className="detail-current-price">
            Current {draft.asset.symbol} price: $
            {formatPrice(draft.asset.price)}
          </strong>
        </div>
      </div>
      <section className="detail-terms">
        <div>
          <span>Created</span>
          <strong>Today</strong>
        </div>
        <div>
          <span>Settlement</span>
          <strong>{formatExpiry(draft.expiry)}</strong>
        </div>
        <div>
          <span>Upfront reward</span>
          <strong>{premium.toFixed(2)} USDC</strong>
        </div>
        <div>
          <span>Locked</span>
          <strong>
            {draft.amount} {draft.asset.symbol}
          </strong>
        </div>
        <p>
          {((premium / (draft.amount * draft.targetPrice)) * 100).toFixed(2)}%
          {" over 11 days · "}
          {(
            (premium / (draft.amount * draft.targetPrice)) *
            (365 / 11) *
            100
          ).toFixed(2)}
          % APR
        </p>
      </section>
      <section className="detail-outcomes">
        <OutcomeFlow draft={draft} />
      </section>
      <button
        className="sign-in-button detail-new-trade-button"
        onClick={onStartTrade}
        type="button"
      >
        Create new trade
      </button>
    </main>
  );
}

export default function App() {
  const [view, setView] = useState<View>("earn");
  const [draft, setDraft] = useState<TradeDraft>(initialDraft);
  const [selectedTrade, setSelectedTrade] = useState<TradeRecord | null>(null);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [isReviewOpen, setReviewOpen] = useState(showOpenedReviewPreview);
  const [isPositionOpen, setPositionOpen] = useState(showOpenedReviewPreview);
  const [isReviewWalletSigning, setReviewWalletSigning] = useState(false);
  const [connectedWallet, setConnectedWallet] = useState<DetectedWallet | null>(
    null
  );
  const [walletsToChoose, setWalletsToChoose] = useState<
    DetectedWallet[] | null
  >(null);
  const [isDisconnectOpen, setDisconnectOpen] = useState(false);
  const [walletNotice, setWalletNotice] = useState<string | null>(null);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
        setReviewOpen(false);
        setPositionOpen(false);
      }
    };
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest("[data-dropdown-root]"))
        setOpenMenu(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, []);

  const relevantAssets = useMemo(
    () => assets.filter((asset) => asset.kind === draft.assetKind),
    [draft.assetKind]
  );
  const previewTrades = useMemo(() => createMockTrades(draft), [draft]);
  const setDirection = (direction: Direction) =>
    setDraft((current) => ({ ...current, direction }));
  const setKind = (assetKind: AssetKind) => {
    const nextAsset =
      assets.find((asset) => asset.kind === assetKind) ?? initialDraft.asset;
    setDraft((current) => ({ ...current, assetKind, asset: nextAsset }));
  };
  const setAsset = (asset: Asset) => {
    setDraft((current) => ({ ...current, asset }));
    setOpenMenu(null);
  };
  const connectWallet = async (wallet: DetectedWallet) => {
    try {
      await wallet.provider.connect();
      setConnectedWallet(wallet);
      setWalletsToChoose(null);
      setReviewWalletSigning(false);
      setWalletNotice(`${wallet.name} connected`);
    } catch {
      setWalletsToChoose(null);
      setReviewWalletSigning(false);
      setWalletNotice("Wallet connection was cancelled");
    }
  };
  const handleWalletButton = () => {
    if (connectedWallet) {
      setDisconnectOpen(true);
      return;
    }

    const wallets = getWalletPreview() ?? detectWallets();
    if (wallets.length === 0) {
      setWalletNotice("No supported wallet extension found");
    } else if (wallets.length === 1) {
      void connectWallet(wallets[0]);
    } else {
      setWalletsToChoose(wallets);
    }
  };
  const disconnectWallet = async () => {
    try {
      await connectedWallet?.provider.disconnect?.();
    } finally {
      setWalletNotice(`${connectedWallet?.name ?? "Wallet"} disconnected`);
      setConnectedWallet(null);
      setDisconnectOpen(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-content">
          <button
            aria-label="Faven home"
            className="brand"
            onClick={() => setView("earn")}
            type="button"
          >
            <img alt="Faven" src="/assets/faven-logo.svg" />
          </button>
          <nav aria-label="Primary navigation" className="main-nav">
            <button
              className={view === "earn" ? "is-current" : ""}
              onClick={() => setView("earn")}
              type="button"
            >
              Earn
            </button>
            <button
              className={view === "dashboard" ? "is-current" : ""}
              onClick={() => setView("dashboard")}
              type="button"
            >
              Dashboard
            </button>
            <a
              aria-label="Faven on X"
              href="https://x.com"
              rel="noreferrer"
              target="_blank"
            >
              <img alt="" src="/assets/x-logo.png" />
            </a>
          </nav>
          <button
            className="sign-in-button"
            onClick={handleWalletButton}
            type="button"
          >
            {connectedWallet ? connectedWallet.name : "Sign in"}
          </button>
        </div>
      </header>

      {view === "dashboard" ? (
        <Dashboard
          onOpenTrade={(trade) => {
            setSelectedTrade(trade);
            setView("trade-detail");
          }}
          onStartTrade={() => setView("earn")}
          trades={previewTrades}
        />
      ) : view === "trade-detail" ? (
        <TradeDetail
          onBack={() => setView("dashboard")}
          onStartTrade={() => setView("earn")}
          trade={selectedTrade ?? previewTrades[0]}
        />
      ) : (
        <main className="earn-page page-enter">
          <section className="hero">
            <h1>
              Get paid <mark>upfront</mark> to buy lower or sell higher
            </h1>
            <p>
              Choose a tokenized stock or cryptocurrency, set your price and
              settlement date: on that date, the trade will either be executed
              if your condition is met, or your locked funds will be returned.{" "}
              <a className="how-it-works-link" href="#how-it-works">
                <span aria-hidden="true" className="video-icon" />
                How it works (2 min)
              </a>
            </p>
          </section>

          <div className="trade-layout">
            <section
              aria-label="Choose your trade terms"
              className="terms-form"
            >
              <h2>Choose your terms</h2>
              <div className="form-section">
                <StepHeading
                  description={steps[0][1]}
                  index={1}
                  title={steps[0][0]}
                />
                <Segmented
                  selectedIndex={draft.direction === "buyLower" ? 0 : 1}
                >
                  <OptionButton
                    onClick={() => setDirection("buyLower")}
                    selected={draft.direction === "buyLower"}
                  >
                    Buy Lower
                  </OptionButton>
                  <OptionButton
                    onClick={() => setDirection("sellHigher")}
                    selected={draft.direction === "sellHigher"}
                  >
                    Sell Higher
                  </OptionButton>
                </Segmented>
              </div>
              <div className="form-section">
                <StepHeading
                  description={steps[1][1]}
                  index={2}
                  title={steps[1][0]}
                />
                <Segmented selectedIndex={draft.assetKind === "crypto" ? 0 : 1}>
                  <OptionButton
                    onClick={() => setKind("crypto")}
                    selected={draft.assetKind === "crypto"}
                  >
                    Crypto
                  </OptionButton>
                  <OptionButton
                    onClick={() => setKind("stock")}
                    selected={draft.assetKind === "stock"}
                  >
                    Tokenized stocks
                  </OptionButton>
                </Segmented>
              </div>
              <div className="form-section">
                <StepHeading
                  description={
                    <>
                      Explore available assets and their current prices
                      {draft.assetKind === "stock" && (
                        <span className="backpack-note">
                          <BackpackMark />
                          Build with Backpack securities
                        </span>
                      )}
                    </>
                  }
                  index={3}
                  title={
                    draft.assetKind === "crypto"
                      ? "Choose a cryptocurrency"
                      : "Choose a tokenized stock"
                  }
                />
                <Dropdown
                  label={
                    <span className="asset-choice">
                      <AssetBadge asset={draft.asset} />
                      <span>
                        {`${draft.asset.symbol} (now `}
                        <strong>${formatPrice(draft.asset.price)}</strong>
                        {`)`}
                      </span>
                    </span>
                  }
                  onToggle={() =>
                    setOpenMenu(openMenu === "asset" ? null : "asset")
                  }
                  open={openMenu === "asset"}
                >
                  {relevantAssets.map((asset) => (
                    <div
                      className="asset-option"
                      key={asset.id}
                      onClick={() => setAsset(asset)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setAsset(asset);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <AssetBadge asset={asset} />
                      <span className="asset-details">
                        <strong>{asset.name}</strong>
                        <span className="asset-contract">
                          <small>
                            {formatContractAddress(asset.contractAddress)}
                          </small>
                          <button
                            aria-label={`Copy ${asset.name} contract address`}
                            className="copy-address-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void navigator.clipboard?.writeText(
                                asset.contractAddress
                              );
                            }}
                            type="button"
                          >
                            <CopyIcon />
                          </button>
                        </span>
                      </span>
                      <b>${formatPrice(asset.price)}</b>
                      <span className="check-slot">
                        {draft.asset.id === asset.id && <Icon name="check" />}
                      </span>
                    </div>
                  ))}
                </Dropdown>
              </div>
              <div className="form-section">
                <StepHeading
                  description={`Choose how much ${draft.asset.symbol} to ${draft.direction === "sellHigher" ? "sell" : "buy"} at the target price`}
                  index={4}
                  title={
                    draft.direction === "sellHigher"
                      ? "How much would you like to sell?"
                      : "How much would you like to buy?"
                  }
                />
                <div className="amount-control">
                  <button
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        amount: Math.max(
                          0.01,
                          Number((current.amount - 0.05).toFixed(2))
                        ),
                      }))
                    }
                    type="button"
                  >
                    − 0.05
                  </button>
                  <div>
                    <strong>{draft.amount.toFixed(2)}</strong>
                    <span>
                      ≈${formatPrice(draft.amount * draft.asset.price)}
                    </span>
                  </div>
                  <button
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        amount: Number((current.amount + 0.05).toFixed(2)),
                      }))
                    }
                    type="button"
                  >
                    + 0.05
                  </button>
                </div>
              </div>
              <div className="form-section">
                <StepHeading
                  description={steps[4][1].replace("BTC", draft.asset.symbol)}
                  index={5}
                  title={steps[4][0]}
                />
                <Dropdown
                  alignValue
                  label={`$${formatPrice(draft.targetPrice)}`}
                  onToggle={() =>
                    setOpenMenu(openMenu === "target" ? null : "target")
                  }
                  open={openMenu === "target"}
                >
                  {targetOptions.map((price) => (
                    <button
                      className="plain-option"
                      key={price}
                      onClick={() => {
                        setDraft((current) => ({
                          ...current,
                          targetPrice: price,
                        }));
                        setOpenMenu(null);
                      }}
                      type="button"
                    >
                      <span>${formatPrice(price)}</span>
                      <span className="check-slot">
                        {draft.targetPrice === price && <Icon name="check" />}
                      </span>
                    </button>
                  ))}
                </Dropdown>
              </div>
              <div className="form-section">
                <StepHeading
                  description={steps[5][1]}
                  index={6}
                  title={steps[5][0]}
                />
                <Dropdown
                  alignValue
                  label={formatExpiry(draft.expiry)}
                  onToggle={() =>
                    setOpenMenu(openMenu === "expiry" ? null : "expiry")
                  }
                  open={openMenu === "expiry"}
                >
                  {expiryOptions.map((expiry) => (
                    <button
                      className="plain-option"
                      key={expiry}
                      onClick={() => {
                        setDraft((current) => ({ ...current, expiry }));
                        setOpenMenu(null);
                      }}
                      type="button"
                    >
                      <span>{formatExpiry(expiry)}</span>
                      <span className="check-slot">
                        {draft.expiry === expiry && <Icon name="check" />}
                      </span>
                    </button>
                  ))}
                </Dropdown>
              </div>
            </section>
            <TradeSummary
              onReview={() => {
                setPositionOpen(false);
                setReviewOpen(true);
              }}
              draft={draft}
            />
          </div>
        </main>
      )}

      {isReviewOpen && (
        <ReviewDialog
          draft={draft}
          isPositionOpen={isPositionOpen}
          isSigningIn={isReviewWalletSigning}
          onClose={() => {
            setPositionOpen(false);
            setReviewOpen(false);
            setReviewWalletSigning(false);
          }}
          onConfirm={() => {
            if (connectedWallet) {
              setPositionOpen(true);
              return;
            }

            if (!requireWalletSignInForReview) {
              setPositionOpen(true);
              return;
            }

            setReviewWalletSigning(true);
            handleWalletButton();
          }}
          onViewTrade={() => {
            setReviewOpen(false);
            setPositionOpen(false);
            setView("trade-detail");
          }}
          onStartNewTrade={() => {
            setReviewOpen(false);
            setPositionOpen(false);
            setView("earn");
          }}
        />
      )}
      {walletsToChoose && (
        <WalletDialog
          onClose={() => {
            setWalletsToChoose(null);
            setReviewWalletSigning(false);
          }}
          onSelect={(wallet) => void connectWallet(wallet)}
          wallets={walletsToChoose}
        />
      )}
      {isDisconnectOpen && connectedWallet && (
        <DisconnectDialog
          onClose={() => setDisconnectOpen(false)}
          onConfirm={() => void disconnectWallet()}
          walletName={connectedWallet.name}
        />
      )}
      {walletNotice && (
        <WalletNotice
          message={walletNotice}
          onClose={() => setWalletNotice(null)}
        />
      )}
      <SiteFooter />
    </div>
  );
}
