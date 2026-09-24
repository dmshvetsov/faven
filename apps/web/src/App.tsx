import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createMockTrades,
  formatExpiry,
  formatPrice,
  getPremium,
  initialDraft,
  type Asset,
  type TradeDraft,
  type TradeRecord,
  type TradeResolution,
  type TradeState,
} from "./trade-data";
import { MarketTradeForm } from "./MarketTradeForm";
import { initialMarket, toMarketChoices } from "./market-selection";
import type { MarketsResponse, RfqServerQueryKey } from "./rfq-server-api";
import { useTakerRfq } from "./use-taker-rfq";
import { detectWallets, getWalletPreview, type DetectedWallet } from "./wallet";
import type { TakerRfqTerms } from "sdk";

type View = "earn" | "dashboard" | "trade-detail";
type TradeTab = "active" | "settled";

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

function AssetBadge({ asset }: { asset: Asset }) {
  return (
    <span className={`asset-badge asset-${asset.id}`}>
      <img alt="" src={asset.icon} />
    </span>
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

// Retained as a visual reference for the future execution flow. The live RFQ
// preview does not render this mock or open positions.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function MockOpenedTradeDialog({
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
              {formatPrice(draft.targetPrice)} on {formatExpiry(draft.expiry)}
            </h2>
            <button
              className="review-button"
              disabled={isSigningIn}
              onClick={onConfirm}
              type="button"
            >
              Confirm &amp; Earn {premium.toFixed(2)} USDC
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
  const draft: TradeDraft = initialDraft;
  const [selectedTrade, setSelectedTrade] = useState<TradeRecord | null>(null);
  const [selectedMarketAddress, setSelectedMarketAddress] = useState<
    string | null
  >(null);
  const [rfqTerms, setRfqTerms] = useState<TakerRfqTerms | null>(null);
  const rfqState = useTakerRfq(rfqTerms);
  const [connectedWallet, setConnectedWallet] = useState<DetectedWallet | null>(
    null
  );
  const [walletsToChoose, setWalletsToChoose] = useState<
    DetectedWallet[] | null
  >(null);
  const [isDisconnectOpen, setDisconnectOpen] = useState(false);
  const [walletNotice, setWalletNotice] = useState<string | null>(null);

  const marketsQuery = useQuery<
    MarketsResponse,
    Error,
    MarketsResponse,
    RfqServerQueryKey
  >({ queryKey: ["markets"] });
  const marketChoices = useMemo(
    () => toMarketChoices(marketsQuery.data?.markets ?? []),
    [marketsQuery.data]
  );
  const selectedMarket = marketChoices.find(
    (market) => market.marketAddress === selectedMarketAddress
  );
  useEffect(() => {
    if (marketChoices.length === 0) return;
    setSelectedMarketAddress((current) => {
      if (
        current &&
        marketChoices.some((market) => market.marketAddress === current)
      ) {
        return current;
      }
      return initialMarket(marketChoices)?.marketAddress ?? null;
    });
  }, [marketChoices]);
  const previewTrades = useMemo(() => createMockTrades(draft), [draft]);
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

          {selectedMarket ? (
            <MarketTradeForm
              markets={marketChoices}
              onRfqTermsChange={setRfqTerms}
              onSelectMarket={(market) =>
                setSelectedMarketAddress(market.marketAddress)
              }
              rfqState={rfqState}
              selectedMarket={selectedMarket}
            />
          ) : marketsQuery.isError ? (
            <p className="market-load-notice">
              It is taking more time than usual to load market data...
            </p>
          ) : marketsQuery.isSuccess ? (
            <p className="market-terms-unavailable">Market terms unavailable</p>
          ) : null}
        </main>
      )}

      {walletsToChoose && (
        <WalletDialog
          onClose={() => {
            setWalletsToChoose(null);
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
