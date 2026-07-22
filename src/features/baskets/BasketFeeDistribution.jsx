import { useEffect, useState } from "react"
import { LoaderCircle } from "lucide-react"
import { formatProtocolError, formatTokenAmount, getFeeDistributionStatus } from "../../protocol"
import { addressKey } from "../shared"

export function BasketFeeDistribution({
  basket,
  enabled,
  getPublicClient,
  getStatus = getFeeDistributionStatus,
  onAction,
  busyAction,
  refreshSignal = 0,
}) {
  const [refreshIndex, setRefreshIndex] = useState(0)
  const [feeState, setFeeState] = useState({
    requestKey: "",
    status: "idle",
    data: null,
    error: "",
  })
  const requestKey = `${addressKey(basket?.address)}:${refreshIndex}:${refreshSignal}`

  useEffect(() => {
    if (!enabled || !basket?.address) return undefined

    let active = true
    void getPublicClient()
      .then((publicClient) => getStatus({ publicClient, basketAddress: basket.address }))
      .then((data) => {
        if (active) setFeeState({ requestKey, status: "ready", data, error: "" })
      })
      .catch((error) => {
        if (active) {
          setFeeState({
            requestKey,
            status: "error",
            data: null,
            error: formatProtocolError(error),
          })
        }
      })

    return () => {
      active = false
    }
  }, [basket?.address, enabled, getPublicClient, getStatus, requestKey])

  if (!enabled) return null

  const loading = feeState.requestKey !== requestKey
  const status = loading ? null : feeState.data
  const pending = status?.pendingBalance ?? 0n
  const canDistribute = Boolean(status?.canDistribute && pending > 0n)
  const distributing = busyAction === "fees"
  const statusId = `fee-distribution-status-${basket.address.slice(2)}`

  const distribute = async () => {
    const result = await onAction({ type: "fees", basket })
    if (result) setRefreshIndex((value) => value + 1)
  }

  return (
    <section className="fee-distribution" aria-labelledby={`${statusId}-title`}>
      <div className="fee-distribution__head">
        <div>
          <span>MINT FEES</span>
          <h3 id={`${statusId}-title`}>Fee distribution</h3>
        </div>
        <span>60 / 40</span>
      </div>

      {loading ? (
        <p className="fee-distribution__state" id={statusId} role="status">
          <LoaderCircle className="button-spinner" size={14} aria-hidden="true" /> Reading pending
          fees…
        </p>
      ) : feeState.status === "error" ? (
        <div className="fee-distribution__state fee-distribution__state--error" id={statusId}>
          <p role="alert">Fee status unavailable. {feeState.error}</p>
          <button type="button" onClick={() => setRefreshIndex((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <dl className="fee-distribution__rows" id={statusId} aria-live="polite">
            <div>
              <dt>Pending</dt>
              <dd>
                {formatTokenAmount(pending, 18)} {basket.symbol}
              </dd>
            </div>
            <div>
              <dt>Creator · 60%</dt>
              <dd>
                {formatTokenAmount(status?.creatorAmount ?? 0n, 18)} {basket.symbol}
              </dd>
            </div>
            <div>
              <dt>Treasury · 40%</dt>
              <dd>
                {formatTokenAmount(status?.treasuryAmount ?? 0n, 18)} {basket.symbol}
              </dd>
            </div>
          </dl>
          <div className="fee-distribution__foot">
            <small>Anyone can trigger the contract distribution.</small>
            <button
              className="button button--outline fee-distribution__action"
              type="button"
              disabled={loading || distributing}
              onClick={() => setRefreshIndex((value) => value + 1)}
            >
              Refresh status
            </button>
            <button
              className="button button--outline fee-distribution__action"
              type="button"
              disabled={!canDistribute || Boolean(busyAction)}
              aria-describedby={statusId}
              onClick={distribute}
            >
              {distributing ? (
                <LoaderCircle className="button-spinner" size={14} aria-hidden="true" />
              ) : null}
              {distributing
                ? "Distributing…"
                : canDistribute
                  ? "Distribute fees"
                  : "No fees pending"}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
