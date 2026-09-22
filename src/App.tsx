import { useEffect, useMemo, useRef, useState } from "react";
import {
  assets,
  expiryOptions,
  formatPrice,
  getPremium,
  initialDraft,
  targetOptions,
  type Asset,
  type AssetKind,
  type Direction,
  type TradeDraft,
} from "./trade-data";
import { detectWallets, type DetectedWallet } from "./wallet";

type View = "earn" | "dashboard" | "trade-detail";
type OpenMenu = "asset" | "target" | "expiry" | null;
type TradeTab = "active" | "settled" | "archived";

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
    "Choose how much BTC you would sell if the target price is reached",
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
  description: string;
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
  const comparison = isSell ? "at or below" : "above";
  const targetValue = draft.amount * draft.targetPrice;
  const days = draft.expiry === "SEP 25" ? 11 : 25;
  const annualizedApr = ((premium / targetValue) * (365 / days) * 100).toFixed(
    2
  );

  return (
    <aside className="trade-summary">
      <p className="summary-title">
        You’ll get{" "}
        <RollingValue value={premium}>{premium.toFixed(2)}</RollingValue> USDC
        upfront for agreeing to <RollingValue value={verb}>{verb}</RollingValue>{" "}
        <RollingValue value={draft.amount}>{draft.amount}</RollingValue>{" "}
        <RollingValue value={draft.asset.symbol}>
          {draft.asset.symbol}
        </RollingValue>{" "}
        if {draft.asset.symbol} reaches $
        <RollingValue value={draft.targetPrice}>
          {formatPrice(draft.targetPrice)}
        </RollingValue>{" "}
        on{" "}
        <RollingValue value={draft.expiry}>
          {draft.expiry.replace("SEP ", "Sep ")}
        </RollingValue>
      </p>

      <div className="summary-group">
        <span className="lime-label">Today</span>
        <section className="summary-card today-card">
          <ul>
            <li>
              Receive{" "}
              <RollingValue value={premium}>{premium.toFixed(2)}</RollingValue>{" "}
              USDC upfront
            </li>
            <li>
              {isSell ? "Lock" : "Set aside"}{" "}
              <RollingValue value={draft.amount}>{draft.amount}</RollingValue>{" "}
              <RollingValue value={draft.asset.symbol}>
                {draft.asset.symbol}
              </RollingValue>
            </li>
          </ul>
          <p>
            {((premium / targetValue) * 100).toFixed(2)}% over {days} days ·{" "}
            {annualizedApr}% APR annualized
          </p>
        </section>
      </div>

      <div className="summary-group outcome-group">
        <div className="outcome-label">
          <span className="lime-label">
            <RollingValue value={draft.expiry}>{draft.expiry}</RollingValue>
          </span>
          <strong>2 possible outcomes:</strong>
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
                  : `Buy ${draft.amount} ${draft.asset.symbol} at the target price`}
              </li>
              <li>You keep the USDC already received upfront</li>
            </ul>
          </div>
          <div>
            <h4>
              → If {draft.asset.symbol} {isSell ? "above" : "below"} $
              {formatPrice(draft.targetPrice)}
            </h4>
            <ul>
              <li>
                {isSell
                  ? `Sell ${draft.amount} ${draft.asset.symbol} for ${formatPrice(targetValue)} USDC`
                  : `Your funds are returned to your wallet`}
              </li>
              <li>Your collateral is exchanged at the target price</li>
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
        View the details and terms — the trade will only start after
        confirmation
      </p>
    </aside>
  );
}

function ReviewDialog({
  draft,
  onClose,
  onConfirm,
  isPositionOpen,
  onViewTrade,
}: {
  draft: TradeDraft;
  onClose: () => void;
  onConfirm: () => void;
  isPositionOpen: boolean;
  onViewTrade: () => void;
}) {
  const premium = getPremium(draft);
  const isSell = draft.direction === "sellHigher";
  const targetValue = draft.amount * draft.targetPrice;
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
            <p className="eyebrow">Position opened</p>
            <h2>Your trade is now waiting for {draft.expiry}</h2>
            <div className="position-opened-card">
              <p>{premium.toFixed(2)} USDC has been received upfront.</p>
              <p>
                Your {draft.amount} {draft.asset.symbol} will be evaluated
                against the target price on {draft.expiry}.
              </p>
            </div>
            <button
              className="review-button"
              onClick={onViewTrade}
              type="button"
            >
              View trade <Icon name="arrow" />
            </button>
          </div>
        ) : (
          <>
            <p className="eyebrow">Review your terms</p>
            <h2>
              You’ll get {premium.toFixed(2)} USDC upfront for agreeing to{" "}
              {isSell ? "sell" : "buy"} {draft.amount} {draft.asset.symbol} if
              it reaches ${formatPrice(draft.targetPrice)} on{" "}
              {draft.expiry.replace("SEP ", "Sep ")}
            </h2>
            <div className="review-today">
              <span className="lime-label">Today</span>
              <section>
                <ul>
                  <li>Receive {premium.toFixed(2)} USDC upfront</li>
                  <li>
                    {isSell ? "Lock" : "Set aside"} {draft.amount}{" "}
                    {draft.asset.symbol}
                  </li>
                </ul>
                <p>Review all terms before signing with your wallet.</p>
              </section>
            </div>
            <div className="review-outcomes">
              <span className="lime-label">{draft.expiry}</span>
              <img
                alt=""
                className="outcome-connector"
                src="/assets/outcome-connector.svg"
              />
              <p>2 possible outcomes:</p>
              <div className="review-outcome-grid">
                <section>
                  <h3>
                    → If {draft.asset.symbol} {isSell ? "at or below" : "above"}{" "}
                    ${formatPrice(draft.targetPrice)}
                  </h3>
                  <ul>
                    <li>
                      {isSell
                        ? `Get your ${draft.amount} ${draft.asset.symbol} back`
                        : `Buy ${draft.amount} ${draft.asset.symbol} at the target price`}
                    </li>
                    <li>You keep the USDC already received upfront</li>
                  </ul>
                </section>
                <section>
                  <h3>
                    → If {draft.asset.symbol} {isSell ? "above" : "below"} $
                    {formatPrice(draft.targetPrice)}
                  </h3>
                  <ul>
                    <li>
                      {isSell
                        ? `Sell ${draft.amount} ${draft.asset.symbol} for ${formatPrice(targetValue)} USDC`
                        : "Your funds are returned to your wallet"}
                    </li>
                    <li>Your collateral is exchanged at the target price</li>
                  </ul>
                </section>
              </div>
            </div>
            <button className="review-button" onClick={onConfirm} type="button">
              Confirm terms <Icon name="arrow" />
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
        <p className="eyebrow">Connect wallet</p>
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
              <Icon name="arrow" />
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

function Dashboard({
  draft,
  onStartTrade,
  onOpenTrade,
}: {
  draft: TradeDraft;
  onStartTrade: () => void;
  onOpenTrade: () => void;
}) {
  const premium = getPremium(draft);
  const [tab, setTab] = useState<TradeTab>("active");
  return (
    <main className="dashboard page-enter">
      <div className="dashboard-heading">
        <h1>Your trades</h1>
      </div>
      <nav aria-label="Trade status" className="dashboard-tabs">
        <button
          className={tab === "active" ? "is-active" : ""}
          onClick={() => setTab("active")}
          type="button"
        >
          Active <span>1</span>
        </button>
        <button
          className={tab === "settled" ? "is-active" : ""}
          onClick={() => setTab("settled")}
          type="button"
        >
          Settled <span>0</span>
        </button>
        <button
          className={tab === "archived" ? "is-active" : ""}
          onClick={() => setTab("archived")}
          type="button"
        >
          Archived <span>0</span>
        </button>
      </nav>
      {tab === "active" ? (
        <>
          <button className="trade-row" onClick={onOpenTrade} type="button">
            <span className="trade-row-main">
              <AssetBadge asset={draft.asset} />
              <span>
                <strong>
                  Sell {draft.amount} {draft.asset.symbol} if it reaches $
                  {formatPrice(draft.targetPrice)}
                </strong>
                <small>Settlement on {draft.expiry}</small>
              </span>
            </span>
            <span className="trade-row-meta">
              <strong>Waiting for {draft.expiry}</strong>
              <small>+{premium.toFixed(2)} USDC received</small>
            </span>
          </button>
          <p className="dashboard-note">
            Select a trade to view its conditions and current outcome.
          </p>
        </>
      ) : (
        <p className="empty-trades">
          {tab === "settled"
            ? "Completed trades will appear here."
            : "Archive completed trades when you no longer need them in your main history."}
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
  draft,
  onBack,
}: {
  draft: TradeDraft;
  onBack: () => void;
}) {
  const isSell = draft.direction === "sellHigher";
  const targetReached = isSell
    ? draft.asset.price >= draft.targetPrice
    : draft.asset.price <= draft.targetPrice;
  const targetValue = draft.amount * draft.targetPrice;
  const premium = getPremium(draft);
  const returningOutcome = !targetReached;

  return (
    <main className="trade-detail page-enter">
      <button className="back-button" onClick={onBack} type="button">
        ← Back to trades
      </button>
      <div className="trade-detail-heading">
        <div>
          <p className="eyebrow">Waiting for {draft.expiry}</p>
          <h1>
            Sell {draft.amount} {draft.asset.symbol} if it reaches $
            {formatPrice(draft.targetPrice)}
          </h1>
        </div>
        <AssetBadge asset={draft.asset} />
      </div>
      <section className="market-status">
        <span>Current {draft.asset.symbol} price</span>
        <strong>${formatPrice(draft.asset.price)}</strong>
        <p>
          {targetReached
            ? `The target has been reached. The execution outcome is currently in play.`
            : `The target has not been reached. The return outcome is currently in play.`}
        </p>
      </section>
      <section className="detail-terms">
        <div>
          <span>Created</span>
          <strong>Today</strong>
        </div>
        <div>
          <span>Settlement</span>
          <strong>{draft.expiry}</strong>
        </div>
        <div>
          <span>Upfront reward</span>
          <strong>{premium.toFixed(2)} USDC</strong>
        </div>
      </section>
      <section className="detail-outcomes">
        <h2>Possible outcomes</h2>
        <div className="detail-outcome-grid">
          <article className={returningOutcome ? "is-current" : ""}>
            <h3>
              → If {draft.asset.symbol}{" "}
              {isSell ? "stays at or below" : "moves above"} $
              {formatPrice(draft.targetPrice)}
            </h3>
            <p>
              {isSell
                ? `Your ${draft.amount} ${draft.asset.symbol} is returned.`
                : `You buy at the target price.`}
            </p>
            <span>{returningOutcome ? "Current outcome" : ""}</span>
          </article>
          <article className={!returningOutcome ? "is-current" : ""}>
            <h3>
              → If {draft.asset.symbol} {isSell ? "moves above" : "moves below"}{" "}
              ${formatPrice(draft.targetPrice)}
            </h3>
            <p>
              {isSell
                ? `Sell for ${formatPrice(targetValue)} USDC.`
                : "Your funds are returned."}
            </p>
            <span>{!returningOutcome ? "Current outcome" : ""}</span>
          </article>
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [view, setView] = useState<View>("earn");
  const [draft, setDraft] = useState<TradeDraft>(initialDraft);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [isReviewOpen, setReviewOpen] = useState(false);
  const [isPositionOpen, setPositionOpen] = useState(false);
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
      setWalletNotice(`${wallet.name} connected`);
    } catch {
      setWalletsToChoose(null);
      setWalletNotice("Wallet connection was cancelled");
    }
  };
  const handleWalletButton = () => {
    if (connectedWallet) {
      setDisconnectOpen(true);
      return;
    }

    const wallets = detectWallets();
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
          draft={draft}
          onOpenTrade={() => setView("trade-detail")}
          onStartTrade={() => setView("earn")}
        />
      ) : view === "trade-detail" ? (
        <TradeDetail draft={draft} onBack={() => setView("dashboard")} />
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
                <div className="segmented">
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
                </div>
              </div>
              <div className="form-section">
                <StepHeading
                  description={steps[1][1]}
                  index={2}
                  title={steps[1][0]}
                />
                <div className="segmented">
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
                </div>
              </div>
              <div className="form-section">
                <StepHeading
                  description={steps[2][1]}
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
                      <AssetBadge asset={draft.asset} /> {draft.asset.symbol}{" "}
                      (now <strong>${formatPrice(draft.asset.price)}</strong>)
                    </span>
                  }
                  onToggle={() =>
                    setOpenMenu(openMenu === "asset" ? null : "asset")
                  }
                  open={openMenu === "asset"}
                >
                  {relevantAssets.map((asset) => (
                    <button
                      className="asset-option"
                      key={asset.id}
                      onClick={() => setAsset(asset)}
                      type="button"
                    >
                      <AssetBadge asset={asset} />
                      <span>
                        <strong>{asset.name}</strong>
                        <small>
                          {asset.symbol}{" "}
                          {asset.kind === "crypto"
                            ? "Cryptocurrency"
                            : "Tokenized stock"}
                        </small>
                      </span>
                      <b>${formatPrice(asset.price)}</b>
                      <span className="check-slot">
                        {draft.asset.id === asset.id && <Icon name="check" />}
                      </span>
                    </button>
                  ))}
                </Dropdown>
              </div>
              <div className="form-section">
                <StepHeading
                  description={steps[3][1].replace("BTC", draft.asset.symbol)}
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
                    <span>{draft.asset.symbol}</span>
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
                  description={steps[4][1].replace(
                    "sell",
                    draft.direction === "sellHigher" ? "sell" : "buy"
                  )}
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
                  label={draft.expiry}
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
                      <span>{expiry}</span>
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
          onClose={() => {
            setPositionOpen(false);
            setReviewOpen(false);
          }}
          onConfirm={() => {
            setPositionOpen(true);
          }}
          onViewTrade={() => {
            setReviewOpen(false);
            setPositionOpen(false);
            setView("trade-detail");
          }}
        />
      )}
      {walletsToChoose && (
        <WalletDialog
          onClose={() => setWalletsToChoose(null)}
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
    </div>
  );
}
