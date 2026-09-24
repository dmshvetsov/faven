import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  address,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import {
  calculateTotalPremiumE18,
  deriveAssociatedTokenAddress,
  isQuoteValid,
  PREVIEW_SELLER_ADDRESS,
  type BestQuote,
  type TakerRfqTerms,
} from "sdk";

import {
  availableExpiries,
  defaultQuantity,
  defaultTerms,
  firstMarketForKind,
  formatExpiryUtc,
  formatQuantity,
  formatUsdE8,
  isQuantityValid,
  isTermAvailable,
  type AssetKind,
  type Direction,
  type MarketChoice,
  type SelectedTerms,
  uniqueStrikes,
} from "./market-selection";
import {
  requestDevelopmentWalletFunding,
  type MarketSeriesResponse,
  type RfqServerQueryKey,
} from "./rfq-server-api";
import type { TakerRfqController, TakerRfqState } from "./use-taker-rfq";
import { useWallet, type VersionZeroTransaction } from "./wallet";

type OpenMenu = "asset" | "target" | "expiry" | null;

export function MarketTradeForm({
  markets,
  selectedMarket,
  onSelectMarket,
  onRfqTermsChange,
  onStartNewTrade,
  onViewOpenedTrade,
  rfqState,
  takerRfq,
}: {
  readonly markets: readonly MarketChoice[];
  readonly selectedMarket: MarketChoice;
  readonly onSelectMarket: (market: MarketChoice) => void;
  readonly onRfqTermsChange: (terms: TakerRfqTerms | null) => void;
  readonly onStartNewTrade: () => void;
  readonly onViewOpenedTrade: () => void;
  readonly rfqState: TakerRfqState;
  readonly takerRfq: TakerRfqController;
}) {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<Direction>("buyLower");
  const [terms, setTerms] = useState<SelectedTerms | null>(null);
  const [quantity, setQuantity] = useState<bigint | null>(null);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [isReviewOpen, setReviewOpen] = useState(false);
  const [reviewEoa, setReviewEoa] = useState<string | null>(null);
  const wasUsable = useRef(false);
  const isFundingWallet = useDevelopmentWalletFunding(wallet.activeEoa);
  const sellerAccounts = useSellerAccounts(wallet.activeEoa, selectedMarket);
  const seriesQuery = useQuery<
    MarketSeriesResponse,
    Error,
    MarketSeriesResponse,
    RfqServerQueryKey
  >({ queryKey: ["markets", selectedMarket.marketAddress, "series"] });
  const series = seriesQuery.data?.series;
  const fallbackTerms = series ? defaultTerms(series, direction) : null;
  const selectedTerms =
    series && terms && isTermAvailable(series, direction, terms)
      ? terms
      : fallbackTerms;
  const selectedQuantity =
    quantity !== null && isQuantityValid(quantity, selectedMarket.quantity)
      ? quantity
      : defaultQuantity(selectedMarket.quantity);
  const termsAvailable = selectedTerms !== null;
  const controlsDisabled =
    !termsAvailable || seriesQuery.isFetching || seriesQuery.isError;
  const rfqTerms = useMemo(
    () =>
      selectedTerms
        ? toTakerRfqTerms({
            direction,
            market: selectedMarket,
            quantity: selectedQuantity,
            sellerAccounts: isFundingWallet ? null : sellerAccounts,
            terms: selectedTerms,
          })
        : null,
    [
      direction,
      isFundingWallet,
      selectedMarket,
      selectedQuantity,
      selectedTerms,
      sellerAccounts,
    ]
  );
  const verifiedQuote =
    rfqState.status === "quote" &&
    rfqTerms !== null &&
    quoteMatchesSelectedTerms(rfqState.quote, rfqTerms) &&
    isQuoteValid(rfqState.quote, Date.now())
      ? rfqState.quote
      : null;

  useEffect(() => {
    onRfqTermsChange(rfqTerms);
    return () => onRfqTermsChange(null);
  }, [onRfqTermsChange, rfqTerms]);

  useEffect(() => {
    if (!series) return;
    setTerms((current) =>
      current && isTermAvailable(series, direction, current)
        ? current
        : defaultTerms(series, direction)
    );
  }, [direction, series]);

  useEffect(() => {
    setQuantity((current) =>
      current !== null && isQuantityValid(current, selectedMarket.quantity)
        ? current
        : defaultQuantity(selectedMarket.quantity)
    );
  }, [selectedMarket]);

  useEffect(() => {
    if (termsAvailable) wasUsable.current = true;
  }, [termsAvailable]);

  useEffect(() => {
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest("[data-dropdown-root]")
      ) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, []);

  useEffect(() => {
    if (isReviewOpen && reviewEoa !== wallet.activeEoa) {
      setReviewOpen(false);
    }
  }, [isReviewOpen, reviewEoa, wallet.activeEoa]);

  const marketsForKind = useMemo(
    () =>
      markets.filter((market) => market.assetKind === selectedMarket.assetKind),
    [markets, selectedMarket.assetKind]
  );
  const strikes = series ? uniqueStrikes(series, direction) : [];
  const expiries =
    series && selectedTerms
      ? availableExpiries(series, direction, selectedTerms.strike)
      : [];

  if (!wasUsable.current && !termsAvailable) {
    if (seriesQuery.isError) {
      return (
        <p className="market-load-notice">
          It is taking more time than usual to load market data...
        </p>
      );
    }
    return null;
  }

  const chooseDirection = (nextDirection: Direction) => {
    setDirection(nextDirection);
    setTerms(series ? defaultTerms(series, nextDirection) : null);
    setOpenMenu(null);
  };
  const chooseKind = (kind: AssetKind) => {
    const market = firstMarketForKind(markets, kind);
    if (market) chooseMarket(market);
  };
  const chooseMarket = (market: MarketChoice) => {
    if (market.marketAddress === selectedMarket.marketAddress) {
      void queryClient.refetchQueries({
        queryKey: ["markets", market.marketAddress, "series"],
        exact: true,
      });
    } else {
      setTerms(null);
      setQuantity((current) =>
        current !== null && isQuantityValid(current, market.quantity)
          ? current
          : defaultQuantity(market.quantity)
      );
      onSelectMarket(market);
    }
    setOpenMenu(null);
  };
  const chooseStrike = (strike: bigint) => {
    if (!series) return;
    const nextExpiry = availableExpiries(series, direction, strike)[0];
    if (nextExpiry === undefined) return;
    setTerms((current) => ({
      strike,
      expiryUnixMs:
        current &&
        availableExpiries(series, direction, strike).includes(
          current.expiryUnixMs
        )
          ? current.expiryUnixMs
          : nextExpiry,
    }));
    setOpenMenu(null);
  };

  return (
    <div className="trade-layout market-trade-layout">
      <section aria-label="Choose your trade terms" className="terms-form">
        <h2>Choose your terms</h2>
        <div className="form-section">
          <StepHeading
            description="Choose whether you’d buy below today’s price or sell above it"
            index={1}
            title="Buy or sell"
          />
          <Segmented selectedIndex={direction === "buyLower" ? 0 : 1}>
            <OptionButton
              onClick={() => chooseDirection("buyLower")}
              selected={direction === "buyLower"}
            >
              Buy Lower
            </OptionButton>
            <OptionButton
              onClick={() => chooseDirection("sellHigher")}
              selected={direction === "sellHigher"}
            >
              Sell Higher
            </OptionButton>
          </Segmented>
        </div>
        <div className="form-section">
          <StepHeading
            description="Pick a cryptocurrency or tokenized stock"
            index={2}
            title="Choose an asset type"
          />
          <Segmented
            selectedIndex={selectedMarket.assetKind === "crypto" ? 0 : 1}
          >
            <OptionButton
              disabled={firstMarketForKind(markets, "crypto") === null}
              onClick={() => chooseKind("crypto")}
              selected={selectedMarket.assetKind === "crypto"}
            >
              Crypto
            </OptionButton>
            <OptionButton
              disabled={firstMarketForKind(markets, "stock") === null}
              onClick={() => chooseKind("stock")}
              selected={selectedMarket.assetKind === "stock"}
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
                {selectedMarket.assetKind === "stock" && (
                  <span className="backpack-note">
                    <img
                      alt=""
                      className="backpack-mark"
                      src="/assets/backpack.svg"
                    />
                    Build with Backpack securities
                  </span>
                )}
              </>
            }
            index={3}
            title={
              selectedMarket.assetKind === "crypto"
                ? "Choose a cryptocurrency"
                : "Choose a tokenized stock"
            }
          />
          <Dropdown
            label={<AssetChoice market={selectedMarket} />}
            onToggle={() => setOpenMenu(openMenu === "asset" ? null : "asset")}
            open={openMenu === "asset"}
          >
            {marketsForKind.map((market) => (
              <button
                className="asset-option"
                key={market.marketAddress}
                onClick={() => chooseMarket(market)}
                type="button"
              >
                <AssetBadge market={market} />
                <span className="asset-details">
                  <strong>
                    {market.baseTokenSymbol} / {market.quoteTokenSymbol}
                  </strong>
                  <span className="asset-contract">
                    <small>{formatContractAddress(market.baseMint)}</small>
                    <span
                      aria-label={`Copy ${market.baseTokenSymbol} contract address`}
                      className="copy-address-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void navigator.clipboard?.writeText(market.baseMint);
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <CopyIcon />
                    </span>
                  </span>
                </span>
                <b>{formatPrice(market.lastPrice)}</b>
                <span className="check-slot">
                  {market.marketAddress === selectedMarket.marketAddress && (
                    <Icon name="check" />
                  )}
                </span>
              </button>
            ))}
          </Dropdown>
        </div>
        <div className="form-section">
          <StepHeading
            description={`Choose how much ${selectedMarket.baseTokenSymbol} to ${direction === "sellHigher" ? "sell" : "buy"} at the target price`}
            index={4}
            title={
              direction === "sellHigher"
                ? "How much would you like to sell?"
                : "How much would you like to buy?"
            }
          />
          <div className="amount-control">
            <button
              disabled={
                selectedQuantity - selectedMarket.quantity.step <
                selectedMarket.quantity.minimum
              }
              onClick={() =>
                setQuantity(selectedQuantity - selectedMarket.quantity.step)
              }
              type="button"
            >
              −{" "}
              {formatQuantity(
                selectedMarket.quantity.step,
                selectedMarket.quantityDecimals
              )}
            </button>
            <div>
              <strong>
                {formatQuantity(
                  selectedQuantity,
                  selectedMarket.quantityDecimals
                )}
              </strong>
              <span>
                ≈{formatApproximateUsd(selectedQuantity, selectedMarket)}
              </span>
            </div>
            <button
              disabled={
                selectedQuantity + selectedMarket.quantity.step >
                selectedMarket.quantity.maximum
              }
              onClick={() =>
                setQuantity(selectedQuantity + selectedMarket.quantity.step)
              }
              type="button"
            >
              +{" "}
              {formatQuantity(
                selectedMarket.quantity.step,
                selectedMarket.quantityDecimals
              )}
            </button>
          </div>
        </div>
        <div className="form-section">
          <StepHeading
            description={`The market price of ${selectedMarket.baseTokenSymbol} that triggers your trade`}
            index={5}
            title="Set target price"
          />
          <Dropdown
            alignValue
            disabled={controlsDisabled}
            label={selectedTerms ? formatUsdE8(selectedTerms.strike) : "—"}
            onToggle={() =>
              setOpenMenu(openMenu === "target" ? null : "target")
            }
            open={openMenu === "target"}
          >
            {strikes.map((strike) => (
              <button
                className="plain-option"
                key={strike.toString()}
                onClick={() => chooseStrike(strike)}
                type="button"
              >
                <span>{formatUsdE8(strike)}</span>
                <span className="check-slot">
                  {selectedTerms?.strike === strike && <Icon name="check" />}
                </span>
              </button>
            ))}
          </Dropdown>
        </div>
        <div className="form-section">
          <StepHeading
            description="The longer you wait, the longer your funds stay locked until the chosen date"
            index={6}
            title="How long are you willing to wait"
          />
          <Dropdown
            alignValue
            disabled={controlsDisabled}
            label={
              selectedTerms ? formatExpiryUtc(selectedTerms.expiryUnixMs) : "—"
            }
            onToggle={() =>
              setOpenMenu(openMenu === "expiry" ? null : "expiry")
            }
            open={openMenu === "expiry"}
          >
            {expiries.map((expiryUnixMs) => (
              <button
                className="plain-option"
                key={expiryUnixMs}
                onClick={() => {
                  if (selectedTerms)
                    setTerms({ ...selectedTerms, expiryUnixMs });
                  setOpenMenu(null);
                }}
                type="button"
              >
                <span>{formatExpiryUtc(expiryUnixMs)}</span>
                <span className="check-slot">
                  {selectedTerms?.expiryUnixMs === expiryUnixMs && (
                    <Icon name="check" />
                  )}
                </span>
              </button>
            ))}
          </Dropdown>
          {seriesQuery.isSuccess && !termsAvailable && (
            <p className="market-terms-unavailable">Market terms unavailable</p>
          )}
        </div>
      </section>
      <MarketReviewPanel
        direction={direction}
        market={selectedMarket}
        onReview={() => {
          if (verifiedQuote && isQuoteValid(verifiedQuote, Date.now())) {
            setReviewEoa(wallet.activeEoa);
            setReviewOpen(true);
          }
        }}
        quantity={selectedQuantity}
        quote={verifiedQuote}
        rfqState={rfqState}
        terms={selectedTerms}
      />
      {isReviewOpen && verifiedQuote && selectedTerms && (
        <ReviewDialog
          direction={direction}
          market={selectedMarket}
          onClose={() => setReviewOpen(false)}
          onStartNewTrade={onStartNewTrade}
          onViewOpenedTrade={onViewOpenedTrade}
          quantity={selectedQuantity}
          quote={verifiedQuote}
          signTransaction={wallet.signTransaction}
          submitUnderwrite={takerRfq.submitUnderwrite}
          terms={selectedTerms}
        />
      )}
    </div>
  );
}

function MarketReviewPanel({
  direction,
  market,
  onReview,
  quantity,
  quote,
  rfqState,
  terms,
}: {
  readonly direction: Direction;
  readonly market: MarketChoice;
  readonly onReview: () => void;
  readonly quantity: bigint;
  readonly quote: BestQuote | null;
  readonly rfqState: TakerRfqState;
  readonly terms: SelectedTerms | null;
}) {
  const isSell = direction === "sellHigher";
  const verb = isSell ? "sell" : "buy";
  const condition = isSell ? "above" : "at or below";
  const comparison = isSell ? "at or below" : "above";
  const quantityText = formatQuantity(quantity, market.quantityDecimals);
  const targetText = terms ? formatUsdE8(terms.strike) : "—";
  const expiryText = terms ? formatExpiryUtc(terms.expiryUnixMs) : "—";
  const targetValue = terms
    ? (quantity * terms.strike) / 10n ** BigInt(market.quantityDecimals)
    : 0n;
  const premiumText = quote
    ? formatPremiumE18(
        calculateTotalPremiumE18({
          premiumE18: quote.premium,
          quantityE18: toQuantityE18(quantity, market.quantityDecimals),
        }),
        market.quoteTokenDecimals
      )
    : "—";
  const collateralText = isSell ? quantityText : formatUsdE8(targetValue);
  const collateralSymbol = isSell
    ? market.baseTokenSymbol
    : market.quoteTokenSymbol;
  return (
    <aside className="trade-summary">
      <p className="summary-title">
        Receive {premiumText} {market.quoteTokenSymbol} upfront. On {expiryText}
        , {verb} {quantityText} {market.baseTokenSymbol} at {targetText} each if{" "}
        its price is {condition} {targetText}
      </p>
      <div className="summary-group">
        <span className="lime-label">Now</span>
        <section className="summary-card today-card">
          <ul>
            <li>
              Receive {premiumText} {market.quoteTokenSymbol} upfront
            </li>
            <li>
              Lock {collateralText} {collateralSymbol}
            </li>
          </ul>
          <p>
            Market price: {formatPrice(market.lastPrice)}{" "}
            {market.quoteTokenSymbol}
          </p>
        </section>
      </div>

      <div className="summary-group outcome-group">
        <div className="outcome-label">
          <span className="lime-label">{expiryText}</span>
          <strong>2 possible outcomes</strong>
        </div>
        <section className="summary-card outcome-card">
          <div>
            <h4>
              → If {market.baseTokenSymbol} {comparison} {targetText}
            </h4>
            <ul>
              <li>
                {isSell
                  ? `Get your ${quantityText} ${market.baseTokenSymbol} back`
                  : `Get your ${collateralText} ${collateralSymbol} back`}
              </li>
              <li>
                You keep the {market.quoteTokenSymbol} already received upfront
              </li>
            </ul>
          </div>
          <div>
            <h4>
              → If {market.baseTokenSymbol} {condition} {targetText}
            </h4>
            <ul>
              <li>
                {isSell
                  ? `Sell ${quantityText} ${market.baseTokenSymbol} and receive ${formatUsdE8(targetValue)} in your wallet`
                  : `Buy ${quantityText} ${market.baseTokenSymbol} at the target price`}
              </li>
              <li>
                You keep the {market.quoteTokenSymbol} already received upfront
              </li>
            </ul>
          </div>
        </section>
      </div>

      <button
        className="review-button"
        disabled={quote === null}
        onClick={onReview}
        type="button"
      >
        <span>
          Review &amp; Earn {premiumText} {market.quoteTokenSymbol}
        </span>
        <Icon name="arrow" />
      </button>
      {rfqState.status === "loading" && (
        <p className="quote-notice">
          {rfqState.message ?? "Getting a live quote..."}
        </p>
      )}
      {rfqState.status === "no-buyers" && (
        <p className="quote-notice">
          No quote, try change your terms or try current terms in 10-30 minutes.
        </p>
      )}
      {rfqState.status === "error" && (
        <p className="quote-notice">{rfqState.message}</p>
      )}
      <p className="summary-footnote">
        Connect a wallet to underwrite a live quote.
      </p>
    </aside>
  );
}

function ReviewDialog({
  direction,
  market,
  onClose,
  onStartNewTrade,
  onViewOpenedTrade,
  quantity,
  quote,
  signTransaction,
  submitUnderwrite,
  terms,
}: {
  readonly direction: Direction;
  readonly market: MarketChoice;
  readonly onClose: () => void;
  readonly onStartNewTrade: () => void;
  readonly onViewOpenedTrade: () => void;
  readonly quantity: bigint;
  readonly quote: BestQuote;
  readonly signTransaction: TakerTransactionSigner;
  readonly submitUnderwrite: TakerRfqController["submitUnderwrite"];
  readonly terms: SelectedTerms;
}) {
  const isSell = direction === "sellHigher";
  const quantityText = formatQuantity(quantity, market.quantityDecimals);
  const targetText = formatUsdE8(terms.strike);
  const expiryText = formatExpiryUtc(terms.expiryUnixMs);
  const condition = isSell ? "above" : "at or below";
  const comparison = isSell ? "at or below" : "above";
  const targetValue =
    (quantity * terms.strike) / 10n ** BigInt(market.quantityDecimals);
  const collateralText = isSell ? quantityText : formatUsdE8(targetValue);
  const collateralSymbol = isSell
    ? market.baseTokenSymbol
    : market.quoteTokenSymbol;
  const premiumText = formatPremiumE18(
    calculateTotalPremiumE18({
      premiumE18: quote.premium,
      quantityE18: toQuantityE18(quantity, market.quantityDecimals),
    }),
    market.quoteTokenDecimals
  );
  const [phase, setPhase] = useState<
    "review" | "signing" | "submitting" | "waiting" | "success"
  >("review");
  const [signedTransaction, setSignedTransaction] = useState<string | null>(
    null
  );
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isLocked =
    phase === "signing" || phase === "submitting" || phase === "waiting";
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const confirm = async () => {
    if (isLocked || !isQuoteValid(quote, Date.now())) return;
    setInfo(null);
    setError(null);

    let underwriteTx = signedTransaction;
    if (!underwriteTx) {
      setPhase("signing");
      try {
        const transaction = getTransactionDecoder().decode(
          getBase64Encoder().encode(quote.underwriteTx)
        );
        const signed = await signTransaction(transaction);
        if (cancelledRef.current) return;
        if (!isQuoteValid(quote, Date.now())) {
          setPhase("review");
          return;
        }
        underwriteTx = getBase64EncodedWireTransaction(signed);
        setSignedTransaction(underwriteTx);
      } catch (signingError: unknown) {
        console.error("Could not sign underwrite transaction.", signingError);
        setPhase("review");
        if (isSignatureCancelled(signingError)) {
          setInfo("Signature request cancelled.");
        } else {
          setError(
            "Could not submit the transaction. Reload the page and try again."
          );
        }
        return;
      }
    }

    if (!isQuoteValid(quote, Date.now())) {
      setPhase("review");
      return;
    }

    setPhase("submitting");
    try {
      const result = await submitUnderwrite({
        rfqId: quote.rfqId,
        underwriteTx,
      });
      if (cancelledRef.current) return;
      setPhase("waiting");
      const confirmed = await waitForTransactionConfirmation(
        result.txSignature,
        () => !cancelledRef.current
      );
      if (!confirmed) return;
      setPhase("success");
    } catch (submissionError: unknown) {
      if (cancelledRef.current) return;
      console.error(
        "Could not submit or confirm underwrite transaction.",
        submissionError
      );
      setPhase("review");
      setError(
        "Could not submit the transaction. Reload the page and try again."
      );
    }
  };

  return createPortal(
    <div
      aria-modal="true"
      className="dialog-backdrop"
      onMouseDown={isLocked ? undefined : onClose}
      role="dialog"
    >
      <section
        className="review-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          aria-label="Close review"
          className="dialog-close"
          disabled={isLocked}
          onClick={onClose}
          type="button"
        >
          <img alt="" src="/assets/close.svg" />
        </button>
        {phase === "success" ? (
          <div className="position-opened">
            <div aria-hidden="true" className="position-opened-mark">
              <span className="position-opened-stroke">
                <img alt="" src="/assets/check.svg" />
              </span>
            </div>
            <h2>Your trade is opened</h2>
            <p className="position-opened-reward">
              <strong>
                {premiumText} {market.quoteTokenSymbol}
              </strong>{" "}
              has been sent to your wallet
            </p>
            <button
              className="sign-in-button success-action-button"
              onClick={() => {
                onClose();
                onViewOpenedTrade();
              }}
              type="button"
            >
              View opened trade
            </button>
            <button
              className="sign-in-button success-action-button position-new-trade-button"
              onClick={() => {
                onClose();
                onStartNewTrade();
              }}
              type="button"
            >
              Create new trade
            </button>
          </div>
        ) : (
          <>
            <h2>
              You’ll get {premiumText} {market.quoteTokenSymbol} upfront for
              agreeing to {isSell ? "sell" : "buy"} {quantityText}{" "}
              {market.baseTokenSymbol} if {market.baseTokenSymbol} is{" "}
              {condition} {targetText} on {expiryText}
            </h2>
            <div className="review-today">
              <span className="lime-label">Now</span>
              <section>
                <ul>
                  <li>
                    Receive {premiumText} {market.quoteTokenSymbol} upfront
                  </li>
                  <li>
                    Lock {collateralText} {collateralSymbol}
                  </li>
                </ul>
              </section>
            </div>
            <div className="review-outcomes outcome-flow">
              <span className="lime-label">{expiryText}</span>
              <p>2 possible outcomes</p>
              <img
                alt=""
                className="outcome-connector"
                src="/assets/outcome-connector.svg"
              />
              <div className="review-outcome-grid">
                <section>
                  <h3>
                    → If {market.baseTokenSymbol} {comparison} {targetText}
                  </h3>
                  <ul>
                    <li>
                      {isSell
                        ? `Get your ${quantityText} ${market.baseTokenSymbol} back`
                        : `Get your ${collateralText} ${collateralSymbol} back`}
                    </li>
                    <li>
                      You keep the {market.quoteTokenSymbol} already received
                      upfront
                    </li>
                  </ul>
                </section>
                <section>
                  <h3>
                    → If {market.baseTokenSymbol} {condition} {targetText}
                  </h3>
                  <ul>
                    <li>
                      {isSell
                        ? `Sell ${quantityText} ${market.baseTokenSymbol} and receive ${formatUsdE8(targetValue)} in your wallet`
                        : `Buy ${quantityText} ${market.baseTokenSymbol} at the target price`}
                    </li>
                    <li>
                      You keep the {market.quoteTokenSymbol} already received
                      upfront
                    </li>
                  </ul>
                </section>
              </div>
            </div>
            {info && <p className="review-info">{info}</p>}
            {error && <p className="review-error">{error}</p>}
            <button
              className="review-button"
              disabled={isLocked}
              onClick={() => void confirm()}
              type="button"
            >
              {phase === "waiting"
                ? "Waiting for confirmation…"
                : phase === "signing"
                  ? "Waiting for wallet…"
                  : phase === "submitting"
                    ? "Submitting…"
                    : `Confirm & Earn ${premiumText} ${market.quoteTokenSymbol}`}
            </button>
            <button
              className="review-back-button"
              disabled={isLocked}
              onClick={onClose}
              type="button"
            >
              <Icon className="back-arrow" name="arrow" />
              Back
            </button>
          </>
        )}
      </section>
    </div>,
    document.body
  );
}

type TakerTransactionSigner = (
  transaction: VersionZeroTransaction
) => Promise<VersionZeroTransaction>;

async function waitForTransactionConfirmation(
  signature: string,
  shouldContinue: () => boolean
): Promise<boolean> {
  while (shouldContinue()) {
    try {
      const response = await fetch(requiredSolanaRpcUrl(), {
        body: JSON.stringify({
          id: crypto.randomUUID(),
          jsonrpc: "2.0",
          method: "getSignatureStatuses",
          params: [[signature], { searchTransactionHistory: true }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Solana RPC returned ${response.status}.`);
      }
      if (hasConfirmedSignature(await response.json())) return true;
    } catch (rpcError: unknown) {
      console.error(
        "Could not poll Solana transaction confirmation.",
        rpcError
      );
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1_000));
  }
  return false;
}

function requiredSolanaRpcUrl(): string {
  const value = import.meta.env.VITE_SOLANA_RPC_URL?.trim();
  if (!value) throw new Error("VITE_SOLANA_RPC_URL must be configured.");
  return value;
}

function hasConfirmedSignature(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isRecord(value.result) ||
    !Array.isArray(value.result.value)
  ) {
    return false;
  }
  const status = value.result.value[0];
  return (
    isRecord(status) &&
    (status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized")
  );
}

function isSignatureCancelled(error: unknown): boolean {
  return (
    error instanceof Error && /cancel|reject|declin|denied/i.test(error.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTakerRfqTerms({
  direction,
  market,
  quantity,
  sellerAccounts,
  terms,
}: {
  readonly direction: Direction;
  readonly market: MarketChoice;
  readonly quantity: bigint;
  readonly sellerAccounts: SellerAccounts | null;
  readonly terms: SelectedTerms;
}): TakerRfqTerms | null {
  if (
    market.quantityDecimals > 18 ||
    !Number.isSafeInteger(terms.expiryUnixMs) ||
    terms.expiryUnixMs < 0
  ) {
    return null;
  }
  const isPut = direction === "buyLower";
  if (!sellerAccounts) return null;
  return {
    market: market.marketAddress,
    expiry: Math.floor(terms.expiryUnixMs / 1_000),
    isPut,
    quantity: toQuantityE18(quantity, market.quantityDecimals),
    strike: terms.strike.toString(),
    seller: sellerAccounts.seller,
    sellerCollateralSource: isPut
      ? sellerAccounts.quoteAta
      : sellerAccounts.baseAta,
    ...(isPut ? {} : { sellerQuoteDestination: sellerAccounts.quoteAta }),
    premiumAsset: market.quoteMint,
    collateralAsset: isPut ? market.quoteMint : market.baseMint,
  };
}

type SellerAccounts = Readonly<{
  seller: string;
  baseAta: string;
  quoteAta: string;
}>;

function useDevelopmentWalletFunding(activeEoa: string | null): boolean {
  const [isFunding, setFunding] = useState(activeEoa !== null);

  useEffect(() => {
    let cancelled = false;
    if (activeEoa === null) {
      setFunding(false);
      return;
    }

    setFunding(true);
    void requestDevelopmentWalletFunding(activeEoa)
      .catch((error: unknown) => {
        // Mainnet has no faucet. A funded wallet can still underwrite there.
        console.error(
          "Could not prepare the connected wallet for underwriting.",
          error
        );
      })
      .finally(() => {
        if (!cancelled) setFunding(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeEoa]);

  return isFunding;
}

function useSellerAccounts(
  activeEoa: string | null,
  market: MarketChoice
): SellerAccounts | null {
  const [sellerAccounts, setSellerAccounts] = useState<SellerAccounts | null>(
    activeEoa === null
      ? {
          seller: PREVIEW_SELLER_ADDRESS,
          baseAta: PREVIEW_SELLER_ADDRESS,
          quoteAta: PREVIEW_SELLER_ADDRESS,
        }
      : null
  );

  useEffect(() => {
    let cancelled = false;
    if (!activeEoa) {
      setSellerAccounts({
        seller: PREVIEW_SELLER_ADDRESS,
        baseAta: PREVIEW_SELLER_ADDRESS,
        quoteAta: PREVIEW_SELLER_ADDRESS,
      });
      return;
    }

    setSellerAccounts(null);
    void Promise.all([
      deriveAssociatedTokenAddress({
        owner: address(activeEoa),
        mint: address(market.baseMint),
        tokenProgram: address(market.baseTokenProgram),
      }),
      deriveAssociatedTokenAddress({
        owner: address(activeEoa),
        mint: address(market.quoteMint),
        tokenProgram: address(market.quoteTokenProgram),
      }),
    ])
      .then(([baseAta, quoteAta]) => {
        if (!cancelled) {
          setSellerAccounts({
            seller: activeEoa,
            baseAta,
            quoteAta,
          });
        }
      })
      .catch((error: unknown) => {
        console.error("Could not derive seller token accounts.", error);
        if (!cancelled) setSellerAccounts(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeEoa,
    market.baseMint,
    market.baseTokenProgram,
    market.quoteMint,
    market.quoteTokenProgram,
  ]);

  return sellerAccounts;
}

function toQuantityE18(quantity: bigint, quantityDecimals: number): string {
  return (quantity * 10n ** BigInt(18 - quantityDecimals)).toString();
}

function quoteMatchesSelectedTerms(
  quote: BestQuote,
  terms: TakerRfqTerms
): boolean {
  return (
    quote.expiry === terms.expiry &&
    quote.isPut === terms.isPut &&
    quote.quantity === terms.quantity &&
    quote.strike === terms.strike &&
    quote.premiumAsset === terms.premiumAsset &&
    quote.collateralAsset === terms.collateralAsset
  );
}

function formatPremiumE18(value: string, tokenDecimals: number): string {
  const amount = BigInt(value);
  const scale = 10n ** 18n;
  const decimals = Math.min(tokenDecimals, 18);
  const whole = amount / scale;
  const fraction = (amount % scale)
    .toString()
    .padStart(18, "0")
    .slice(0, decimals)
    .replace(/0+$/, "");
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${wholeText}${fraction ? `.${fraction}` : ""}`;
}

function Dropdown({
  label,
  open,
  onToggle,
  children,
  alignValue = false,
  disabled = false,
}: {
  readonly label: React.ReactNode;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: React.ReactNode;
  readonly alignValue?: boolean;
  readonly disabled?: boolean;
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
        disabled={disabled}
        onClick={onToggle}
        type="button"
      >
        <span className={alignValue ? "dropdown-trigger-value" : ""}>
          {label}
        </span>
        <Icon className={open ? "is-open" : ""} name="chevron" />
      </button>
      {open && !disabled && <div className="dropdown-menu">{children}</div>}
    </div>
  );
}

function StepHeading({
  index,
  title,
  description,
}: {
  readonly index: number;
  readonly title: string;
  readonly description: React.ReactNode;
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

function Segmented({
  children,
  selectedIndex,
}: {
  readonly children: React.ReactNode;
  readonly selectedIndex: 0 | 1;
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

function OptionButton({
  children,
  selected,
  onClick,
  disabled = false,
}: {
  readonly children: React.ReactNode;
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      className={`segment-option ${selected ? "is-selected" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span>{children}</span>
      {selected && <Icon name="check" />}
    </button>
  );
}

function AssetChoice({ market }: { readonly market: MarketChoice }) {
  return (
    <span className="asset-choice">
      <AssetBadge market={market} />
      <span>
        {market.baseTokenSymbol} / {market.quoteTokenSymbol} (now{" "}
        <strong>{formatPrice(market.lastPrice)}</strong>)
      </span>
    </span>
  );
}

function AssetBadge({ market }: { readonly market: MarketChoice }) {
  return (
    <span className="asset-badge">
      <img alt="" src={market.icon} />
    </span>
  );
}

function Icon({
  name,
  className = "",
}: {
  readonly name: "check" | "chevron" | "arrow";
  readonly className?: string;
}) {
  return (
    <img
      aria-hidden="true"
      className={`icon ${className}`}
      src={`/assets/${name === "arrow" ? "arrow-right" : name}.svg`}
    />
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" className="copy-icon" viewBox="0 0 16 16">
      <rect height="9" rx="1" width="9" x="5" y="2" />
      <path d="M11 5v7a2 2 0 0 1-2 2H4a2 2 0 0 1 2-2h1" />
    </svg>
  );
}

function formatContractAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatPrice(price: string): string {
  return price === "0" ? "$0" : `$${price}`;
}

function formatApproximateUsd(quantity: bigint, market: MarketChoice): string {
  const [whole, fraction = ""] = market.lastPrice.split(".");
  const priceE8 =
    BigInt(whole) * 100_000_000n + BigInt(fraction.slice(0, 8).padEnd(8, "0"));
  const amountE8 =
    (quantity * priceE8) / 10n ** BigInt(market.quantityDecimals);
  return formatUsdE8(amountE8);
}
