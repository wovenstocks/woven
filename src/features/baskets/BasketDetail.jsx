import { useRef, useState } from "react"
import { ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react"
import { StockBadge } from "../../components/Brand"
import {
  contractAddressesConfigured,
  oneClickContractsConfigured,
  wovenContracts,
} from "../../config/contracts"
import { getConfiguredBasketRecipe } from "../../data/baskets"
import { isPositiveDecimal, toneBySymbol } from "../shared"
import { BasketComposition } from "./BasketComposition"
import { BasketFeeDistribution } from "./BasketFeeDistribution"
import { TradeReview } from "./TradeReview"
import { UsdcBuyReview } from "./UsdcBuyReview"

export function BasketDetail({
  basket,
  onBack,
  wallet,
  onPrepare,
  onAction,
  busyAction,
  getPublicClient,
  activityRevision,
}) {
  const buyRouteExpected = basket?.oneClickRoute === true
  const [mode, setMode] = useState(buyRouteExpected ? "buy" : "mint")
  const [amount, setAmount] = useState("1")
  const [review, setReview] = useState(null)
  const [reviewing, setReviewing] = useState(false)
  const reviewRevisionRef = useRef(0)
  const amountValid = isPositiveDecimal(amount)
  const configuredRecipe = getConfiguredBasketRecipe(basket)
  const basketRouteConfigured = contractAddressesConfigured && Boolean(configuredRecipe)
  const routeConfigured =
    basketRouteConfigured && (mode !== "buy" || (buyRouteExpected && oneClickContractsConfigured))
  const submitting = busyAction === mode
  const actionLabel = reviewing
    ? mode === "buy"
      ? "Building onchain quote…"
      : "Reading onchain details…"
    : !routeConfigured
      ? mode === "buy"
        ? "Buy with USDC"
        : `Review ${mode === "mint" ? "mint" : "redemption"}`
      : !wallet.account
        ? "Connect wallet"
        : wallet.chainId === null
          ? "Check wallet network"
          : !wallet.isBnbChain
            ? `Switch to ${wovenContracts.networkName}`
            : mode === "buy"
              ? "Review purchase"
              : `Review ${mode === "mint" ? "mint" : "redemption"}`

  const prepare = async () => {
    if (reviewing) return
    const revision = ++reviewRevisionRef.current
    setReview(null)
    setReviewing(true)
    try {
      const nextReview = await onPrepare({ type: mode, basket, amount })
      if (revision === reviewRevisionRef.current && nextReview) setReview(nextReview)
    } finally {
      if (revision === reviewRevisionRef.current) setReviewing(false)
    }
  }

  const invalidateReview = () => {
    reviewRevisionRef.current += 1
    setReview(null)
    setReviewing(false)
  }

  return (
    <main id="app-content" className="app-main basket-detail" tabIndex={-1}>
      <button className="back-link" type="button" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" /> All baskets
      </button>
      <section className="basket-detail__heading">
        <div>
          <span className="basket-symbol">${basket.symbol}</span>
          <h1>{basket.name}</h1>
          <p>{basket.description}</p>
        </div>
        <div className="detail-meta">
          <span>{basket.assets.length} assets</span>
        </div>
      </section>

      <div className="basket-detail__grid">
        <section className="composition-card">
          <div className="composition-card__head">
            <h2>Basket assets</h2>
            <strong>{basket.assets.length} holdings</strong>
          </div>
          <BasketComposition
            basket={basket}
            enabled={basketRouteConfigured}
            recipe={configuredRecipe}
            getPublicClient={getPublicClient}
          />
          <BasketFeeDistribution
            basket={basket}
            enabled={basketRouteConfigured}
            getPublicClient={getPublicClient}
            onAction={onAction}
            busyAction={busyAction}
            refreshSignal={activityRevision}
          />
        </section>

        <section className="trade-card">
          <h2 className="sr-only">
            {buyRouteExpected ? "Buy, mint or redeem basket units" : "Mint or redeem basket units"}
          </h2>
          <div className="segmented-control" aria-label="Basket action" role="group">
            {buyRouteExpected ? (
              <button
                className={mode === "buy" ? "active" : ""}
                type="button"
                disabled={reviewing || Boolean(busyAction)}
                aria-pressed={mode === "buy"}
                onClick={() => {
                  invalidateReview()
                  setMode("buy")
                }}
              >
                Buy
              </button>
            ) : null}
            <button
              className={mode === "mint" ? "active" : ""}
              type="button"
              disabled={reviewing || Boolean(busyAction)}
              aria-pressed={mode === "mint"}
              onClick={() => {
                invalidateReview()
                setMode("mint")
              }}
            >
              Mint
            </button>
            <button
              className={mode === "redeem" ? "active" : ""}
              type="button"
              disabled={reviewing || Boolean(busyAction)}
              aria-pressed={mode === "redeem"}
              onClick={() => {
                invalidateReview()
                setMode("redeem")
              }}
            >
              Redeem
            </button>
          </div>
          <label className="amount-field">
            <span>{mode === "redeem" ? "Basket tokens to redeem" : "Gross basket amount"}</span>
            <div>
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                disabled={reviewing || Boolean(busyAction)}
                value={amount}
                onChange={(event) => {
                  invalidateReview()
                  setAmount(event.target.value)
                }}
              />
              <strong>{basket.symbol}</strong>
            </div>
          </label>
          <div className="trade-summary">
            <div>
              <span>
                {mode === "buy"
                  ? "Gross basket amount"
                  : mode === "mint"
                    ? "Gross basket amount"
                    : "Basket tokens burned"}
              </span>
              <strong>
                {amount || "0"} {basket.symbol}
              </strong>
            </div>
            <div>
              <span>{mode === "buy" ? "Payment" : "Constituents"}</span>
              <strong>{mode === "buy" ? "USDC" : `${basket.assets.length} bStock tokens`}</strong>
            </div>
            <div>
              <span>
                {mode === "buy" ? "Execution" : mode === "mint" ? "Mint fee" : "Redemption fee"}
              </span>
              <strong>
                {mode === "buy"
                  ? "Atomic onchain"
                  : mode === "mint"
                    ? "Read from contract"
                    : "0% protocol fee"}
              </strong>
            </div>
          </div>
          <p className="trade-disclaimer">
            {routeConfigured
              ? mode === "buy"
                ? "You supply USDC. The router buys every required bStock and mints the basket in one atomic transaction. If any market leg cannot fill within the reviewed maximum, the entire purchase reverts."
                : mode === "mint"
                  ? "Minting supplies every listed asset in the exact required units. Your wallet confirms each required approval."
                  : "Redemption burns basket tokens and returns the listed constituents when their external transfer rules permit."
              : mode === "buy"
                ? "USDC buying remains disabled until the router, basket and bStock routes are configured."
                : "The route remains disabled until the factory, basket and asset addresses match the approved basket definition."}{" "}
            Only proceed when your jurisdiction and every constituent&apos;s terms permit it.
          </p>
          <div
            className="route-assets"
            aria-label={`${basket.assets.length} basket assets`}
            role="list"
          >
            {basket.assets.map((symbol) => (
              <span key={symbol} role="listitem">
                <StockBadge symbol={symbol} tone={toneBySymbol[symbol]} small />
                <span className="sr-only">{symbol.replace(/B$/, "")}</span>
              </span>
            ))}
          </div>
          <button
            className="button button--ink trade-submit"
            type="button"
            disabled={!amountValid || Boolean(busyAction) || reviewing}
            onClick={prepare}
          >
            {reviewing ? (
              <LoaderCircle className="button-spinner" size={16} aria-hidden="true" />
            ) : null}
            {review
              ? mode === "buy"
                ? "Refresh quote"
                : `Refresh ${mode === "mint" ? "mint" : "redemption"} review`
              : actionLabel}{" "}
            {!reviewing && <ArrowRight size={16} aria-hidden="true" />}
          </button>
          {review && mode === "buy" ? (
            <UsdcBuyReview
              key={review.fingerprint || review.reviewExpiresAtMs}
              basket={basket}
              readiness={review}
              submitting={submitting}
              onConfirm={() => onAction({ type: mode, basket, amount, review })}
            />
          ) : review ? (
            <TradeReview
              mode={mode}
              basket={basket}
              readiness={review}
              submitting={submitting}
              onConfirm={() => onAction({ type: mode, basket, amount, review })}
            />
          ) : null}
        </section>
      </div>
    </main>
  )
}
