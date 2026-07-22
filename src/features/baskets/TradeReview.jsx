import { ArrowRight, Check, LoaderCircle, X } from "lucide-react"
import { StockBadge } from "../../components/Brand"
import { getMintQuote, stocks } from "../../data/baskets"
import { addressKey, compactAddress, exactAmount } from "../shared"

export function TradeReview({ mode, basket, readiness, onConfirm, submitting }) {
  const constituents =
    readiness.constituents || readiness.backing || readiness.expectedConstituents || []
  const mintQuote = mode === "mint" ? getMintQuote(readiness) : null
  const approvalCount =
    mode === "mint" ? constituents.filter((item) => !item.hasAllowance).length : 0
  const hardMintBlockers =
    mode === "mint"
      ? (readiness.blockers || []).filter((blocker) => blocker !== "APPROVAL_REQUIRED")
      : []
  const canConfirm =
    mode === "mint"
      ? hardMintBlockers.length === 0
      : readiness.canRedeem !== false && !(readiness.blockers || []).length

  return (
    <section className="trade-review" aria-label={`${mode} review`} aria-live="polite">
      <div className="trade-review__head">
        <div>
          <span>ONCHAIN REVIEW</span>
          <h3>{mode === "mint" ? "Ready to mint" : "Redemption backing"}</h3>
        </div>
        <span className={canConfirm ? "trade-review__status" : "trade-review__status is-blocked"}>
          {canConfirm ? <Check size={13} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
          {canConfirm ? "Reviewed" : "Action blocked"}
        </span>
      </div>

      {mode === "mint" ? (
        <div className="trade-review__quote">
          <div>
            <span>Gross mint</span>
            <strong>
              {mintQuote.grossFormatted} {basket.symbol}
            </strong>
          </div>
          <div>
            <span>Exact mint fee</span>
            <strong>
              {mintQuote.feeFormatted} {basket.symbol} · {(mintQuote.feeBps / 100).toFixed(2)}%
            </strong>
          </div>
          <div className="trade-review__net">
            <span>You receive</span>
            <strong>
              {mintQuote.netFormatted} {basket.symbol}
            </strong>
          </div>
        </div>
      ) : (
        <div className="trade-review__quote">
          <div className="trade-review__net">
            <span>Basket tokens burned</span>
            <strong>
              {readiness.basketAmountFormatted} {basket.symbol}
            </strong>
          </div>
          <p>
            Listed amounts are the contract’s nominal backing before token-level transfer rules.
          </p>
        </div>
      )}

      <div className="trade-review__assets" aria-label="Required constituent amounts" role="list">
        {constituents.map((item) => {
          const configuredStock = stocks.find(
            (stock) => addressKey(stock.address) === addressKey(item.token),
          )
          const symbol = configuredStock?.ticker || item.symbol || compactAddress(item.token)
          const balanceShort = mode === "mint" && item.hasBalance === false
          const approvalNeeded = mode === "mint" && item.hasAllowance === false
          return (
            <div key={item.token} role="listitem">
              <span>
                {configuredStock ? (
                  <StockBadge symbol={configuredStock.symbol} tone={configuredStock.tone} small />
                ) : null}
                <span>
                  <strong>{symbol}</strong>
                  <small>Required {exactAmount(item)}</small>
                </span>
              </span>
              {balanceShort ? (
                <em className="is-blocked">Balance short</em>
              ) : approvalNeeded ? (
                <em className="is-approval">Approval needed</em>
              ) : (
                <em>
                  <Check size={12} aria-hidden="true" /> Ready
                </em>
              )}
            </div>
          )
        })}
      </div>

      {!canConfirm ? (
        <p className="trade-review__blocker">
          {mode === "mint" && hardMintBlockers.includes("UNDERBACKED")
            ? "This basket is underbacked. New issuance is blocked; existing holders may still redeem."
            : mode === "mint" && hardMintBlockers.includes("BACKING_STATUS_UNAVAILABLE")
              ? "Basket backing could not be verified. Minting remains blocked until the check succeeds."
              : mode === "mint" && hardMintBlockers.includes("INSUFFICIENT_BALANCE")
                ? "Add every required constituent amount to this wallet before minting."
                : mode === "mint" && hardMintBlockers.includes("MINT_PAUSED")
                  ? "Minting is paused for this basket."
                  : mode === "mint" && hardMintBlockers.includes("SUPPLY_CAP_EXCEEDED")
                    ? "This amount would exceed the current basket supply cap."
                    : "This wallet does not hold enough basket tokens for this redemption."}
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
          ? mode === "mint"
            ? "Minting…"
            : "Redeeming…"
          : mode === "mint" && approvalCount > 0
            ? `Approve ${approvalCount} ${approvalCount === 1 ? "asset" : "assets"} & mint`
            : mode === "mint"
              ? "Confirm mint"
              : "Confirm redemption"}
        {!submitting ? <ArrowRight size={16} aria-hidden="true" /> : null}
      </button>
      <small className="trade-review__footnote">
        {mode === "mint" && approvalCount > 0
          ? "Your wallet will request only the missing approvals, followed by the mint transaction."
          : "The next step opens your wallet. Review the contract and amounts before signing."}
      </small>
    </section>
  )
}
