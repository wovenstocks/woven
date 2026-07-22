import { useEffect, useState } from "react"
import { LoaderCircle } from "lucide-react"
import { StockBadge } from "../../components/Brand"
import { getBasketRequiredUnits, formatProtocolError } from "../../protocol"
import { addressKey, stockBySymbol } from "../shared"

export function BasketComposition({
  basket,
  enabled,
  recipe,
  getPublicClient,
  getRequirements = getBasketRequiredUnits,
}) {
  const [refreshIndex, setRefreshIndex] = useState(0)
  const [compositionState, setCompositionState] = useState({
    requestKey: "",
    status: "idle",
    data: null,
    error: "",
  })
  const basketAddress = basket?.address || ""
  const requestKey = `${addressKey(basketAddress)}:${refreshIndex}`

  useEffect(() => {
    if (!enabled || !basketAddress) return undefined

    let active = true
    void getPublicClient()
      .then((publicClient) => getRequirements({ publicClient, basketAddress, amount: "1" }))
      .then((data) => {
        if (active) setCompositionState({ requestKey, status: "ready", data, error: "" })
      })
      .catch((error) => {
        if (active) {
          setCompositionState({
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
  }, [basketAddress, enabled, getPublicClient, getRequirements, requestKey])

  const loading = enabled && compositionState.requestKey !== requestKey
  const requirements = loading ? null : compositionState.data
  const requirementsByToken = new Map(
    (requirements?.constituents || []).map((item) => [addressKey(item.token), item]),
  )
  const recipeMatches =
    !enabled ||
    !requirements ||
    (requirements.constituents.length === recipe?.constituents?.length &&
      recipe.constituents.every((item, index) => {
        const requirement = requirements.constituents[index]
        return (
          addressKey(requirement?.token) === addressKey(item.token) &&
          typeof requirement?.amount === "bigint" &&
          requirement.amount === item.unitsRaw
        )
      }))
  const readFailed =
    enabled && !loading && (compositionState.status === "error" || (requirements && !recipeMatches))

  return (
    <>
      <div className="composition-list" aria-busy={loading || undefined} role="list">
        {basket.assets.map((symbol) => {
          const stock = stockBySymbol[symbol]
          const recipeItem = recipe?.constituents?.find((item) => item.symbol === symbol)
          const requirement = recipeMatches
            ? requirementsByToken.get(addressKey(recipeItem?.token))
            : null
          const knownUnit = basket.units?.[symbol]
          const amountLabel = requirement
            ? `${requirement.amountFormatted} ${requirement.symbol}`
            : loading
              ? "Reading…"
              : readFailed
                ? "Unavailable"
                : knownUnit
                  ? `${knownUnit} ${symbol}`
                  : "—"
          const metadata = requirement
            ? `${stock?.ticker || symbol} · current units per basket token`
            : knownUnit
              ? `${stock?.ticker || symbol} · published units per basket token`
              : `${stock?.ticker || symbol}`

          return (
            <div key={symbol} role="listitem">
              <StockBadge symbol={symbol} tone={stock?.tone} />
              <span>
                <strong>{stock?.name || symbol}</strong>
                <small>{metadata}</small>
              </span>
              <span className="composition-list__amount">{amountLabel}</span>
            </div>
          )
        })}
      </div>

      {loading ? (
        <p className="composition-read-state" role="status">
          <LoaderCircle className="button-spinner" size={13} aria-hidden="true" /> Reading exact
          units for one basket…
        </p>
      ) : readFailed ? (
        <div className="composition-read-state composition-read-state--error">
          <p role="alert">
            {requirements && !recipeMatches
              ? "The onchain basket does not match its approved asset definition."
              : `Exact onchain units are unavailable. ${compositionState.error}`}
          </p>
          <button type="button" onClick={() => setRefreshIndex((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : null}
    </>
  )
}
