import { useState } from "react";

import {
  formatExpiryUtc,
  formatQuantity,
  formatUsdE8,
} from "./market-selection";
import type { ApiUnderwritePosition } from "./rfq-server-api";

type TradeTab = "open" | "closed";

export function TradesDashboard({
  activeEoa,
  isError,
  isLoading,
  onOpenPosition,
  onStartTrade,
  positions,
}: {
  readonly activeEoa: string | null;
  readonly isError: boolean;
  readonly isLoading: boolean;
  readonly onOpenPosition: (position: ApiUnderwritePosition) => void;
  readonly onStartTrade: () => void;
  readonly positions: readonly ApiUnderwritePosition[];
}) {
  const [tab, setTab] = useState<TradeTab>("open");
  const visiblePositions = positions.filter(
    (position) => position.positionState === tab
  );
  const tabCount = (state: TradeTab) =>
    positions.filter((position) => position.positionState === state).length;

  return (
    <main className="dashboard page-enter">
      <div className="dashboard-heading">
        <h1>Your trades</h1>
        <p>Select a trade to view its conditions and current outcome</p>
      </div>
      <nav aria-label="Trade status" className="dashboard-tabs">
        <button
          className={tab === "open" ? "is-active" : ""}
          onClick={() => setTab("open")}
          type="button"
        >
          Opened <span>{tabCount("open")}</span>
        </button>
        <button
          className={tab === "closed" ? "is-active" : ""}
          onClick={() => setTab("closed")}
          type="button"
        >
          Closed <span>{tabCount("closed")}</span>
        </button>
      </nav>
      {activeEoa === null ? (
        <p className="empty-trades">Connect your wallet to view your trades</p>
      ) : isLoading ? (
        <p className="empty-trades">Loading your trades…</p>
      ) : isError ? (
        <p className="empty-trades">
          Your trades could not be loaded. Please try again shortly.
        </p>
      ) : visiblePositions.length > 0 ? (
        <div className="trade-list">
          {visiblePositions.map((position) => (
            <button
              className="trade-row"
              key={`${position.txSignature}:${position.ixIndex}`}
              onClick={() => onOpenPosition(position)}
              type="button"
            >
              <span className="trade-row-main">
                <span className="asset-badge">{position.baseAsset}</span>
                <span>
                  <strong>{tradeTitle(position)}</strong>
                  <small>
                    {position.positionState === "open"
                      ? `Settlement on ${formatExpiryUtc(position.expiryMs)}`
                      : `Settled on ${formatExpiryUtc(position.expiryMs)}`}
                  </small>
                </span>
              </span>
              <span className="trade-row-meta">
                <TradeStatus position={position} />
                <small>
                  +{totalPremium(position)} {position.quoteAsset} received
                </small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="empty-trades">
          No {tab === "open" ? "opened" : "closed"} trades yet
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

export function TradePositionDetail({
  onBack,
  onStartTrade,
  position,
}: {
  readonly onBack: () => void;
  readonly onStartTrade: () => void;
  readonly position: ApiUnderwritePosition;
}) {
  const quantity = formatQuantity(BigInt(position.quantity), 18);
  const direction = position.isPut ? "buy" : "sell";
  const condition = position.isPut ? "at or below" : "above";
  const oppositeCondition = position.isPut ? "above" : "at or below";
  const collateral = position.isPut
    ? `${formatUsdE8((BigInt(position.quantity) * BigInt(position.strike)) / 10n ** 18n)} ${position.quoteAsset}`
    : `${quantity} ${position.baseAsset}`;

  return (
    <main className="trade-detail page-enter">
      <button className="back-button" onClick={onBack} type="button">
        <ArrowIcon />
        Back to trades
      </button>
      <div className="trade-detail-heading">
        <div>
          <TradeStatus position={position} />
          <h1>{tradeTitle(position)}</h1>
          {position.closeReason === "expired_worthless" && (
            <p className="is-not-executed">
              This trade expired without being exercised.
            </p>
          )}
        </div>
      </div>
      <section className="detail-terms">
        <div>
          <span>Opened</span>
          <strong>{formatDate(position.confirmedAtMs)}</strong>
        </div>
        <div>
          <span>Settlement</span>
          <strong>{formatExpiryUtc(position.expiryMs)}</strong>
        </div>
        <div>
          <span>Upfront reward</span>
          <strong>
            {totalPremium(position)} {position.quoteAsset}
          </strong>
        </div>
        <div>
          <span>Locked</span>
          <strong>{collateral}</strong>
        </div>
      </section>
      <section className="detail-outcomes">
        <div className="review-outcomes outcome-flow">
          <span className="lime-label">
            {formatExpiryUtc(position.expiryMs)}
          </span>
          <p>2 possible outcomes</p>
          <img
            alt=""
            className="outcome-connector"
            src="/assets/outcome-connector.svg"
          />
          <div className="review-outcome-grid">
            <section>
              <h3>
                → If {position.baseAsset} is {oppositeCondition}{" "}
                {formatStrike(position)}
              </h3>
              <ul>
                <li>Get your {collateral} back</li>
                <li>You keep the {position.quoteAsset} received upfront</li>
              </ul>
            </section>
            <section>
              <h3>
                → If {position.baseAsset} is {condition}{" "}
                {formatStrike(position)}
              </h3>
              <ul>
                <li>
                  {direction === "sell"
                    ? `Sell ${quantity} ${position.baseAsset}`
                    : `Buy ${quantity} ${position.baseAsset} at the strike price`}
                </li>
              </ul>
            </section>
          </div>
        </div>
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

function TradeStatus({
  position,
}: {
  readonly position: ApiUnderwritePosition;
}) {
  const label =
    position.positionState === "closed"
      ? position.closeReason === "exercised"
        ? "Executed"
        : "Not executed"
      : position.seriesState === "expiration_price_finalized"
        ? "Price finalized"
        : "Opened";
  return (
    <span className={`status-pill is-${position.positionState}`}>{label}</span>
  );
}

function ArrowIcon() {
  return (
    <img
      alt=""
      aria-hidden="true"
      className="icon back-arrow"
      src="/assets/arrow-right.svg"
    />
  );
}

function tradeTitle(position: ApiUnderwritePosition) {
  const quantity = formatQuantity(BigInt(position.quantity), 18);
  const direction = position.isPut ? "Buy" : "Sell";
  const condition = position.isPut ? "at or below" : "above";

  if (position.positionState === "closed") {
    if (position.closeReason === "exercised") {
      return `${position.isPut ? "Bought" : "Sold"} ${quantity} ${position.baseAsset} at ${formatStrike(position)}`;
    }
    return `Not executed — ${quantity} ${position.baseAsset} was not ${position.isPut ? "bought" : "sold"}`;
  }

  return `${direction} ${quantity} ${position.baseAsset} if ${position.baseAsset} is ${condition} ${formatStrike(position)}`;
}

function totalPremium(position: ApiUnderwritePosition) {
  return formatQuantity(
    (BigInt(position.premium) * BigInt(position.quantity)) / 10n ** 18n,
    18
  );
}

function formatStrike(position: ApiUnderwritePosition) {
  return formatUsdE8(BigInt(position.strike));
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
