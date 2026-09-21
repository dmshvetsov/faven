import { useEffect, useMemo, useRef, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { MOCK_DATA, MOCK_MODE } from "./mock-data";

type TradeSide = "buy" | "sell";
type AssetType = "crypto" | "stock";
type AppView = "earn" | "dashboard";
type DashboardTab = "active" | "archive";
type Deal = {
  id: string;
  asset: string;
  amount: number;
  targetPrice: number;
  quote: string;
  settlementDate: string;
  createdAt: string;
  status: "active" | "archived";
};

function Chevron() { return <span aria-hidden className="chevron" />; }
function Checkmark() { return <span aria-hidden className="checkmark" />; }
function StepNumber({ number }: { number: number }) { return <span className="step-number">{number}</span>; }

function DashboardView({ deals, tab, onTabChange, onCreateDeal, onArchive }: { deals: Deal[]; tab: DashboardTab; onTabChange: (tab: DashboardTab) => void; onCreateDeal: () => void; onArchive: (id: string) => void; }) {
  const activeDeals = deals.filter((deal) => deal.status === "active");
  const archivedDeals = deals.filter((deal) => deal.status === "archived");
  const visibleDeals = tab === "active" ? activeDeals : archivedDeals;
  return <section className="dashboard-page" id="dashboard">
    <div className="dashboard-heading"><div><p className="eyebrow">Portfolio</p><h1>{tab === "active" ? "Your positions" : "Trade archive"}</h1><p className="dashboard-description">Track your active option positions and review completed settlements.</p></div><button className="primary-action" onClick={onCreateDeal}>Create a deal <span>→</span></button></div>
    <div className="dashboard-tabs"><button className={tab === "active" ? "selected" : ""} onClick={() => onTabChange("active")}>Active positions <span>{activeDeals.length}</span></button><button className={tab === "archive" ? "selected" : ""} onClick={() => onTabChange("archive")}>Archive <span>{archivedDeals.length}</span></button></div>
    {visibleDeals.length === 0 ? <div className="empty-state"><div className="empty-state-icon">＋</div><h2>{tab === "active" ? "No active positions yet" : "Your archive is empty"}</h2><p>{tab === "active" ? "Create your first deal to receive an upfront premium." : "Settled and expired positions will appear here."}</p><button className="primary-action" onClick={onCreateDeal}>{tab === "active" ? "Create a deal" : "Back to positions"}</button></div> : <div className="deal-list">{visibleDeals.map((deal) => <article className="deal-card" key={deal.id}><div className="deal-card-header"><div><span className={tab === "active" ? "status-pill active" : "status-pill archived"}>{tab === "active" ? "Active" : "Archived"}</span><h2>{deal.asset} · {deal.amount.toFixed(2)} contract</h2></div><span className="deal-date">{deal.settlementDate}</span></div><div className="deal-metrics"><div><span>Upfront premium</span><strong>{deal.quote} USDC</strong></div><div><span>Target price</span><strong>${deal.targetPrice.toLocaleString()}</strong></div><div><span>Settlement</span><strong>{deal.settlementDate}</strong></div></div><div className="deal-card-footer"><span>{tab === "active" ? "Funds locked until settlement" : `Created ${deal.createdAt}`}</span>{tab === "active" ? <button onClick={() => onArchive(deal.id)}>Archive position</button> : <button onClick={onCreateDeal}>Create another →</button>}</div></article>)}</div>}
  </section>;
}

export default function App() {
  const { connectors, connect, status } = useWalletConnection();
  const [side, setSide] = useState<TradeSide>("sell");
  const [assetType, setAssetType] = useState<AssetType>("crypto");
  const [amount, setAmount] = useState(0.05);
  const [targetPrice, setTargetPrice] = useState(91000);
  const [selectedAsset, setSelectedAsset] = useState(MOCK_DATA.assets[0]);
  const [settlementDate, setSettlementDate] = useState(MOCK_DATA.settlementDates[0]);
  const [mockConnected, setMockConnected] = useState(false);
  const [view, setView] = useState<AppView>("earn");
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("active");
  const [deals, setDeals] = useState<Deal[]>([]);
  const [assetMenuOpen, setAssetMenuOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const [priceMenuOpen, setPriceMenuOpen] = useState(false);
  const assetMenuRef = useRef<HTMLDivElement>(null);
  const dateMenuRef = useRef<HTMLDivElement>(null);
  const priceMenuRef = useRef<HTMLDivElement>(null);
  const quote = useMemo(() => (amount * MOCK_DATA.pricingMultiplier).toFixed(2), [amount]);
  const isConnected = MOCK_MODE ? mockConnected : status === "connected";

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAssetMenuOpen(false);
        setDateMenuOpen(false);
        setPriceMenuOpen(false);
      }
    };
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!assetMenuRef.current?.contains(target)) setAssetMenuOpen(false);
      if (!dateMenuRef.current?.contains(target)) setDateMenuOpen(false);
      if (!priceMenuRef.current?.contains(target)) setPriceMenuOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("mousedown", closeOnOutsideClick);
    };
  }, []);

  const signIn = () => {
    if (MOCK_MODE) {
      setMockConnected(true);
      return;
    }
    if (status === "connected" || connectors.length === 0) return;
    void connect(connectors[0].id);
  };

  const handleOpenPosition = () => {
    if (!MOCK_MODE) {
      signIn();
      return;
    }
    signIn();
    setDeals((current) => [{ id: crypto.randomUUID(), asset: selectedAsset.symbol, amount, targetPrice, quote, settlementDate, createdAt: "Today", status: "active" }, ...current]);
    setReviewOpen(false);
    setView("dashboard");
    setDashboardTab("active");
  };

  const archiveDeal = (id: string) => {
    setDeals((current) => current.map((deal) => deal.id === id ? { ...deal, status: "archived" } : deal));
    setDashboardTab("archive");
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Faven home"><img src="https://www.figma.com/api/mcp/asset/4392cb35-50e4-43c0-b44c-d9867be03f25.svg" alt="Faven" /></a>
        <nav className="main-nav" aria-label="Main navigation"><a href="#earn" onClick={() => setView("earn")}>Earn</a><a href="#dashboard" onClick={() => setView("dashboard")}>Dashboard</a><a href="https://x.com" target="_blank" rel="noreferrer">𝕏</a></nav>
        <button className="sign-in" onClick={signIn} disabled={!MOCK_MODE && status === "connecting"}>{isConnected ? "Connected" : !MOCK_MODE && status === "connecting" ? "Connecting…" : "Sign in"}</button>
      </header>
      <main id="top" className="page-content">
        {view === "earn" ? <>
        <section className="hero" id="earn">
          <h1>Get paid <mark>upfront</mark> to buy lower or sell higher</h1>
          <p>Choose a tokenized stock or cryptocurrency, set your price and settlement date: on that date, the trade will either be executed if your condition is met, or your locked funds will be returned. <a href="#how-it-works">How it works (2-minute video)</a></p>
        </section>
        <section className="trade-layout" id="dashboard">
          <div className="terms-panel">
            <h2>Choose your terms</h2>
            <div className="form-step"><StepNumber number={1} /><h3>Buy or sell</h3><p>Choose whether you’d buy below today’s price or sell above it</p><div className="segmented-control"><button className={side === "buy" ? "selected" : ""} onClick={() => setSide("buy")}>Buy Lower {side === "buy" && <Checkmark />}</button><button className={side === "sell" ? "selected" : ""} onClick={() => setSide("sell")}>Sell Higher {side === "sell" && <Checkmark />}</button></div></div>
            <div className="form-step"><StepNumber number={2} /><h3>Choose an asset type</h3><p>Pick a cryptocurrency or tokenized stock</p><div className="segmented-control"><button className={assetType === "crypto" ? "selected" : ""} onClick={() => setAssetType("crypto")}>Crypto {assetType === "crypto" && <Checkmark />}</button><button className={assetType === "stock" ? "selected" : ""} onClick={() => setAssetType("stock")}>Tokenized stocks {assetType === "stock" && <Checkmark />}</button></div></div>
            <div className="form-step asset-step" ref={assetMenuRef}><StepNumber number={3} /><h3>Choose a cryptocurrency</h3><p>You’ll see its current price before choosing yours</p><button className="select-field" onClick={() => setAssetMenuOpen((open) => !open)}>{selectedAsset.symbol} (now <strong>${selectedAsset.price.toLocaleString()}</strong>) <Chevron /></button>{assetMenuOpen && <div className="asset-menu"><input autoFocus placeholder="Find crypto" />{MOCK_DATA.assets.map((asset) => <button key={asset.symbol} onClick={() => { setSelectedAsset(asset); setAssetMenuOpen(false); }}><img src={asset.icon} alt="" /><span><strong>{asset.name}</strong><small>{asset.kind}</small></span><em>{asset.menuPrice}</em></button>)}</div>}</div>
            <div className="form-step amount-step"><StepNumber number={4} /><h3>How much would you like to sell?</h3><p>The price you’d be willing to sell {selectedAsset.symbol} at</p><div className="amount-control"><button onClick={() => setAmount(Math.max(0.05, amount - 0.05))}>– 0.05</button><div><strong>{amount.toFixed(2)}</strong><span>{selectedAsset.symbol}</span></div><button onClick={() => setAmount(amount + 0.05)}>+ 0.05</button></div></div>
            <div className="form-step price-step" ref={priceMenuRef}><StepNumber number={5} /><h3>Choose target price</h3><p>Price you are willing to sell at</p><button className="select-field price-field" onClick={() => setPriceMenuOpen((open) => !open)}>${targetPrice.toLocaleString()} <Chevron /></button>{priceMenuOpen && <div className="simple-menu"><button onClick={() => { setTargetPrice(85000); setPriceMenuOpen(false); }}>$85,000</button><button onClick={() => { setTargetPrice(91000); setPriceMenuOpen(false); }}>$91,000</button><button onClick={() => { setTargetPrice(95000); setPriceMenuOpen(false); }}>$95,000</button></div>}</div>
            <div className="form-step last-step" ref={dateMenuRef}><StepNumber number={6} /><h3>How long are you willing to wait</h3><p>The longer you wait the higher APR. Your funds stay locked until chosen date</p><button className="select-field" onClick={() => setDateMenuOpen((open) => !open)}>{settlementDate} <Chevron /></button>{dateMenuOpen && <div className="simple-menu">{MOCK_DATA.settlementDates.map((date) => <button key={date} onClick={() => { setSettlementDate(date); setDateMenuOpen(false); }}>{date}</button>)}</div>}</div>
          </div>
          <aside className="summary-card">
            <h2>You’ll get {quote} USDC upfront for agreeing to {side === "sell" ? "sell higher" : "buy lower"} {amount.toFixed(2)} {selectedAsset.symbol} at ${targetPrice.toLocaleString()} on {settlementDate}</h2>
            <div className="summary-section"><span className="summary-badge">Today</span><div className="upfront-box"><strong>•&nbsp; Receive {quote} USDC upfront</strong><strong>•&nbsp; Lock {amount.toFixed(2)} BTC</strong><small>0.54% over 11 days • 14.77% APR annualized</small></div></div>
            <div className="summary-section outcomes"><div className="outcomes-heading"><span className="summary-badge">SEP 25</span><h3>2 possible outcomes:</h3></div><div className="outcome-grid"><div className="outcome-card"><strong>→ If BTC at or below ${targetPrice.toLocaleString()}</strong><p>•&nbsp; Get your {amount.toFixed(2)} BTC back<br />•&nbsp; You keep the USDC already received upfront</p></div><div className="outcome-card"><strong>→ If BTC above ${targetPrice.toLocaleString()}</strong><p>•&nbsp; Sell {amount.toFixed(2)} BTC for {(amount * targetPrice).toLocaleString()} USDC<br />•&nbsp; Your collateral is exchanged at the target price</p></div></div></div>
            <button className="review-button" onClick={() => setReviewOpen(true)}>Review &amp; Earn {quote} USDC <span>→</span></button><p className="summary-footnote">View the details and terms — the trade will only start after confirmation</p>
          </aside>
        </section>
        </> : <DashboardView deals={deals} tab={dashboardTab} onTabChange={setDashboardTab} onCreateDeal={() => setView("earn")} onArchive={archiveDeal} />}
      </main>
      {reviewOpen && <div className="modal-backdrop" role="presentation" onClick={() => setReviewOpen(false)}><section className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title" onClick={(event) => event.stopPropagation()}><button className="modal-close" aria-label="Close" onClick={() => setReviewOpen(false)}>×</button><h2 id="review-title">You’ll get {quote} USDC upfront for agreeing to sell {amount.toFixed(2)} {selectedAsset.symbol} at ${targetPrice.toLocaleString()} on {settlementDate}</h2><span className="date-badge">Today</span><div className="modal-upfront"><ul><li>Receive {quote} USDC upfront</li><li>Lock {amount.toFixed(2)} {selectedAsset.symbol}</li></ul><p>0.54% over 11 days<br />14.77% APR annualized</p></div><span className="date-badge">{settlementDate}</span><h3>2 possible outcomes:</h3><div className="modal-outcomes"><div><strong>→ If {selectedAsset.symbol} at or below ${targetPrice.toLocaleString()}</strong><p>Get your {amount.toFixed(2)} {selectedAsset.symbol} back<br />You keep the USDC already received upfront</p></div><div><strong>→ If {selectedAsset.symbol} above ${targetPrice.toLocaleString()}</strong><p>Sell {amount.toFixed(2)} {selectedAsset.symbol} for {(amount * targetPrice).toLocaleString()} USDC<br />Your collateral is exchanged at the target price</p></div></div><button className="review-button" onClick={handleOpenPosition}>Open position</button><button className="modal-back" onClick={() => setReviewOpen(false)}>← Back</button></section></div>}
    </div>
  );
}
