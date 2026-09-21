import { useEffect, useMemo, useState } from "react";
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

type View = "earn" | "dashboard";
type OpenMenu = "asset" | "target" | "expiry" | null;

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
    "The price you’d be willing to sell BTC at",
  ],
  ["Choose target price", "Price you are willing to sell at"],
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
}: {
  label: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="dropdown" data-dropdown-root>
      <button
        aria-expanded={open}
        className="select-trigger"
        onClick={onToggle}
        type="button"
      >
        <span>{label}</span>
        <Icon className={open ? "is-open" : ""} name="chevron" />
      </button>
      {open && <div className="dropdown-menu">{children}</div>}
    </div>
  );
}

function AssetBadge({ asset }: { asset: Asset }) {
  return <span className={`asset-badge asset-${asset.id}`}>{asset.icon}</span>;
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
        You’ll get {premium.toFixed(2)} USDC upfront for agreeing to {verb}{" "}
        {draft.amount} {draft.asset.symbol} at ${formatPrice(draft.targetPrice)}{" "}
        on {draft.expiry.replace("SEP ", "Sep ")}
      </p>

      <div className="summary-group">
        <span className="lime-label">Today</span>
        <section className="summary-card today-card">
          <ul>
            <li>Receive {premium.toFixed(2)} USDC upfront</li>
            <li>
              {isSell ? "Lock" : "Set aside"} {draft.amount}{" "}
              {draft.asset.symbol}
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
          <span className="lime-label">{draft.expiry}</span>
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
        <span>Review &amp; Earn {premium.toFixed(2)} USDC</span>
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
}: {
  draft: TradeDraft;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const premium = getPremium(draft);
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
          ×
        </button>
        <p className="eyebrow">Review your terms</p>
        <h2>Earn {premium.toFixed(2)} USDC upfront</h2>
        <dl>
          <div>
            <dt>Asset</dt>
            <dd>
              {draft.amount} {draft.asset.symbol}
            </dd>
          </div>
          <div>
            <dt>Condition</dt>
            <dd>
              {draft.direction === "sellHigher" ? "Sell higher" : "Buy lower"}{" "}
              at ${formatPrice(draft.targetPrice)}
            </dd>
          </div>
          <div>
            <dt>Settlement</dt>
            <dd>{draft.expiry}</dd>
          </div>
        </dl>
        <p className="dialog-note">
          Your trade starts only after confirmation. You can review all terms
          before signing with your wallet.
        </p>
        <button className="review-button" onClick={onConfirm} type="button">
          Confirm terms <Icon name="arrow" />
        </button>
      </section>
    </div>
  );
}

function Dashboard({
  draft,
  onStartTrade,
}: {
  draft: TradeDraft;
  onStartTrade: () => void;
}) {
  const premium = getPremium(draft);
  return (
    <main className="dashboard page-enter">
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>Your trades</h1>
        </div>
        <button className="primary-button" onClick={onStartTrade} type="button">
          Create trade
        </button>
      </div>
      <nav aria-label="Trade status" className="dashboard-tabs">
        <button className="is-active" type="button">
          Active <span>1</span>
        </button>
        <button type="button">
          Settled <span>0</span>
        </button>
        <button type="button">
          Archived <span>0</span>
        </button>
      </nav>
      <article className="trade-row">
        <div className="trade-row-main">
          <AssetBadge asset={draft.asset} />
          <div>
            <h2>
              Sell {draft.amount} {draft.asset.symbol} at $
              {formatPrice(draft.targetPrice)}
            </h2>
            <p>Settlement on {draft.expiry}</p>
          </div>
        </div>
        <div>
          <span className="status-pill">Active</span>
          <p className="trade-premium">+{premium.toFixed(2)} USDC</p>
        </div>
      </article>
      <p className="dashboard-note">
        Trades appear here after you confirm them with your wallet.
      </p>
    </main>
  );
}

export default function App() {
  const [view, setView] = useState<View>("earn");
  const [draft, setDraft] = useState<TradeDraft>(initialDraft);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [isReviewOpen, setReviewOpen] = useState(false);
  const [isSignedIn, setSignedIn] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
        setReviewOpen(false);
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
            onClick={() => setSignedIn((signedIn) => !signedIn)}
            type="button"
          >
            {isSignedIn ? "Wallet connected" : "Sign in"}
          </button>
        </div>
      </header>

      {view === "dashboard" ? (
        <Dashboard draft={draft} onStartTrade={() => setView("earn")} />
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
              <a href="#how-it-works">How it works (2-minute video)</a>
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
                      {draft.asset.id === asset.id && <Icon name="check" />}
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
                      ${formatPrice(price)}
                      {draft.targetPrice === price && <Icon name="check" />}
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
                      {expiry}
                      {draft.expiry === expiry && <Icon name="check" />}
                    </button>
                  ))}
                </Dropdown>
              </div>
            </section>
            <TradeSummary draft={draft} onReview={() => setReviewOpen(true)} />
          </div>
        </main>
      )}

      {isReviewOpen && (
        <ReviewDialog
          draft={draft}
          onClose={() => setReviewOpen(false)}
          onConfirm={() => {
            setReviewOpen(false);
            setView("dashboard");
          }}
        />
      )}
    </div>
  );
}
