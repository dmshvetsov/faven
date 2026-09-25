import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MarketTradeForm } from "./MarketTradeForm";
import { initialMarket, toMarketChoices } from "./market-selection";
import {
  type ApiUnderwritePosition,
  type MarketsResponse,
  type RfqServerQueryKey,
  type TradesResponse,
} from "./rfq-server-api";
import { TradesDashboard, TradePositionDetail } from "./TradesDashboard";
import { useTakerRfq } from "./use-taker-rfq";
import { useWallet, WalletConnectButton } from "./wallet";
import type { TakerRfqTerms } from "sdk";

type View = "earn" | "dashboard" | "trade-detail";

function currentNetwork() {
  const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL?.toLowerCase() ?? "";
  if (rpcUrl.includes("devnet")) return "Devnet";
  if (rpcUrl.includes("testnet")) return "Testnet";
  if (rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")) {
    return "Localnet";
  }
  return "Mainnet";
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

export default function App() {
  const [view, setView] = useState<View>("earn");
  const [selectedPosition, setSelectedPosition] =
    useState<ApiUnderwritePosition | null>(null);
  const [selectedMarketAddress, setSelectedMarketAddress] = useState<
    string | null
  >(null);
  const [rfqTerms, setRfqTerms] = useState<TakerRfqTerms | null>(null);
  const wallet = useWallet();
  const takerRfq = useTakerRfq(rfqTerms);

  const marketsQuery = useQuery<
    MarketsResponse,
    Error,
    MarketsResponse,
    RfqServerQueryKey
  >({ queryKey: ["markets"] });
  const tradesQuery = useQuery<
    TradesResponse,
    Error,
    TradesResponse,
    RfqServerQueryKey
  >({
    enabled: wallet.activeEoa !== null,
    queryKey: ["trades", wallet.activeEoa ?? ""],
  });
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
          <div className="header-wallet-controls">
            <span className="current-network">{currentNetwork()}</span>
            <WalletConnectButton />
          </div>
        </div>
      </header>

      {view === "dashboard" ? (
        <TradesDashboard
          activeEoa={wallet.activeEoa}
          isError={tradesQuery.isError}
          isLoading={tradesQuery.isLoading}
          onOpenPosition={(position) => {
            setSelectedPosition(position);
            setView("trade-detail");
          }}
          onStartTrade={() => setView("earn")}
          positions={tradesQuery.data?.positions ?? []}
        />
      ) : view === "trade-detail" && selectedPosition ? (
        <TradePositionDetail
          onBack={() => setView("dashboard")}
          onStartTrade={() => setView("earn")}
          position={selectedPosition}
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
              onStartNewTrade={() => setView("earn")}
              onSelectMarket={(market) =>
                setSelectedMarketAddress(market.marketAddress)
              }
              onViewOpenedTrade={() => {
                setView("dashboard");
                void tradesQuery.refetch();
              }}
              rfqState={takerRfq.state}
              selectedMarket={selectedMarket}
              takerRfq={takerRfq}
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

      <SiteFooter />
    </div>
  );
}
