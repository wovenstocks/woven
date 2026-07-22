import { useEffect, useMemo, useState } from "react"
import { ArrowRight, Check, LoaderCircle, X } from "lucide-react"
import { StockBadge } from "../../components/Brand"
import { stocks } from "../../data/baskets"
import { formatTokenAmount } from "../../protocol"
import { addressKey, compactAddress } from "../shared"

function formatRaw(value, decimals, formatted) {
  if (typeof formatted === "string" && formatted) return formatted
  if (typeof value !== "bigint" || !Number.isInteger(decimals)) return "—"
  return formatTokenAmount(value, decimals)
}

function totalExpectedUsdc(readiness) {
  if (typeof readiness.expectedTotalUsdcIn === "bigint") {
    return readiness.expectedTotalUsdcIn
  }
  if (!Array.isArray(readiness.legs)) return null
  if (readiness.legs.some((leg) => typeof leg.expectedUsdcIn !== "bigint")) return null
  return readiness.legs.reduce((total, leg) => total + leg.expectedUsdcIn, 0n)
}

function blockerMessage(blocker) {
  const messages = {
    UNDERBACKED: "This basket is not fully backed. New purchases remain disabled.",
    MINT_PAUSED: "Minting is paused for this basket.",
    SUPPLY_CAP_EXCEEDED: "This purchase would exceed the basket supply cap.",
    INSUFFICIENT_USDC_BALANCE: "This wallet does not hold the reviewed maximum USDC amount.",
  }
  return messages[blocker] || "The current onchain state does not permit this purchase."
}

function quoteExpiry(readiness) {
  if (Number.isFinite(readiness.reviewExpiresAtMs)) return readiness.reviewExpiresAtMs
  const expiresIn =
    typeof readiness.expiresIn === "bigint" ? Number(readiness.expiresIn) : readiness.expiresIn
  return Date.now() + Math.max(0, Number.isFinite(expiresIn) ? expiresIn : 0) * 1_000
}

function countdownLabel(seconds) {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

export function UsdcBuyReview({ basket, readiness, onConfirm, submitting }) {
  const expiry = useMemo(() => quoteExpiry(readiness), [readiness])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (expiry <= Date.now()) return undefined
    const interval = window.setInterval(() => {
      const next = Date.now()
      setNow(next)
      if (next >= expiry) window.clearInterval(interval)
    }, 1_000)
    return () => window.clearInterval(interval)
  }, [expiry])

  const remainingSeconds = Math.max(0, Math.ceil((expiry - now) / 1_000))
  const expired = remainingSeconds === 0
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : []
  const approvalRequired = blockers.includes("APPROVAL_REQUIRED")
  const hardBlockers = blockers.filter((blocker) => blocker !== "APPROVAL_REQUIRED")
  const canConfirm = !expired && hardBlockers.length === 0
  const usdcDecimals = readiness.usdcDecimals
  const usdcSymbol = readiness.usdcSymbol || "USDC"
  const expectedUsdc = totalExpectedUsdc(readiness)
  const expectedUsdcFormatted = formatRaw(
    expectedUsdc,
    usdcDecimals,
    readiness.expectedTotalUsdcInFormatted,
  )
  const maxUsdcFormatted = formatRaw(
    readiness.maxTotalUsdcIn,
    usdcDecimals,
    readiness.maxTotalUsdcInFormatted,
  )
  const feeRate = Number.isInteger(readiness.mintFeeBps)
    ? `${(readiness.mintFeeBps / 100).toFixed(2)}%`
    : "—"

  return (
    <section className="trade-review usdc-buy-review" aria-label="USDC purchase review">
      <div className="trade-review__head">
        <div>
          <span>USDC PURCHASE</span>
          <h3>Review purchase</h3>
        </div>
        <span
          className={`trade-review__status${expired || hardBlockers.length ? " is-blocked" : ""}`}
          aria-label={expired ? "Quote expired" : `Quote expires in ${remainingSeconds} seconds`}
        >
          {expired || hardBlockers.length ? (
            <X size={13} aria-hidden="true" />
          ) : (
            <Check size={13} aria-hidden="true" />
          )}
          {expired ? "Quote expired" : `Quote ${countdownLabel(remainingSeconds)}`}
        </span>
      </div>

      <div className="trade-review__quote usdc-buy-review__quote">
        <div>
          <span>Expected cost</span>
          <strong>
            {expectedUsdcFormatted} {usdcSymbol}
          </strong>
        </div>
        <div>
          <span>Maximum cost</span>
          <strong>
            {maxUsdcFormatted} {usdcSymbol}
          </strong>
        </div>
        <div className="trade-review__net">
          <span>You receive</span>
          <strong>
            {readiness.netBasketOutFormatted || "—"} {basket.symbol}
          </strong>
        </div>
        <div>
          <span>Mint fee</span>
          <strong>
            {readiness.feeAmountFormatted || "—"} {basket.symbol} · {feeRate}
          </strong>
        </div>
      </div>

      <div
        className="usdc-buy-review__routes"
        aria-label="Atomic bStock purchase routes"
        role="list"
      >
        {(readiness.legs || []).map((leg, index) => {
          const fallbackSymbol = basket.assets?.[index]
          const configuredStock =
            stocks.find((stock) => addressKey(stock.address) === addressKey(leg.expectedToken)) ||
            stocks.find((stock) => stock.symbol === fallbackSymbol)
          const stockSymbol =
            configuredStock?.symbol || leg.symbol || compactAddress(leg.expectedToken)
          const expectedLegCost = formatRaw(
            leg.expectedUsdcIn,
            usdcDecimals,
            leg.expectedUsdcInFormatted,
          )
          const maxLegCost = formatRaw(leg.maxUsdcIn, usdcDecimals, leg.maxUsdcInFormatted)

          return (
            <div key={`${leg.expectedToken}-${leg.routeId || index}`} role="listitem">
              <span className="usdc-buy-review__asset">
                {configuredStock ? (
                  <StockBadge symbol={configuredStock.symbol} tone={configuredStock.tone} small />
                ) : null}
                <span>
                  <strong>{configuredStock?.ticker || stockSymbol}</strong>
                  <small>
                    {usdcSymbol} → {stockSymbol}
                  </small>
                </span>
              </span>
              <span className="usdc-buy-review__leg-cost">
                <strong>
                  {expectedLegCost} {usdcSymbol}
                </strong>
                <small>
                  max {maxLegCost} {usdcSymbol}
                </small>
              </span>
            </div>
          )
        })}
      </div>

      {hardBlockers.length > 0 ? (
        <div className="trade-review__blocker" role="alert">
          {hardBlockers.map((blocker) => (
            <p key={blocker}>{blockerMessage(blocker)}</p>
          ))}
        </div>
      ) : expired ? (
        <p className="trade-review__blocker" role="alert">
          This price bound expired. Refresh the onchain quote before opening your wallet.
        </p>
      ) : null}

      <button
        className="button button--ink trade-review__confirm"
        type="button"
        disabled={!canConfirm || submitting}
        onClick={onConfirm}
      >
        {submitting ? (
          <LoaderCircle className="button-spinner" size={16} aria-hidden="true" />
        ) : null}
        {submitting
          ? "Buying…"
          : expired
            ? "Quote expired"
            : approvalRequired
              ? `Approve ${usdcSymbol} & buy`
              : `Buy with ${usdcSymbol}`}
        {!submitting && canConfirm ? <ArrowRight size={16} aria-hidden="true" /> : null}
      </button>
      <small className="trade-review__footnote">
        {approvalRequired
          ? `Your wallet may first reset an existing allowance, then approve only the reviewed ${usdcSymbol} maximum. The following purchase buys every required bStock and mints the basket atomically.`
          : "One router transaction buys every required bStock and mints the basket. Unspent USDC is returned; any failed swap reverts the entire purchase."}
      </small>
    </section>
  )
}
