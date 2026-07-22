import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowRight, LoaderCircle, Plus } from "lucide-react"
import { StockBadge } from "../../components/Brand"
import { contractAddressesConfigured } from "../../config/contracts"
import { createDynamicBasketView, marketedBaskets } from "../../data/baskets"
import { discoverFactoryBaskets, formatProtocolError } from "../../protocol"
import { addressKey, stockBySymbol, toneBySymbol } from "../shared"

const FACTORY_PAGE_SIZE = 12

function BasketCard({ basket, onOpen }) {
  return (
    <article className={`app-basket-card app-basket-card--${basket.tint}`}>
      <div className="app-basket-card__visual">
        <div className="basket-factsheet__head">
          <span>Assets</span>
          <strong>{basket.assets.length}</strong>
        </div>
        <div className="basket-factsheet__rows">
          {basket.assets.slice(0, 5).map((symbol) => {
            const stock = stockBySymbol[symbol]
            return (
              <div key={symbol}>
                <StockBadge symbol={symbol} tone={toneBySymbol[symbol]} small />
                <span>
                  <strong>{stock?.ticker || symbol}</strong>
                  <small>{stock?.name}</small>
                </span>
                {basket.units?.[symbol] ? <em>{basket.units[symbol]}</em> : null}
              </div>
            )
          })}
        </div>
      </div>
      <div className="app-basket-card__top">
        <span className="basket-symbol">${basket.symbol}</span>
      </div>
      <div>
        <h3>{basket.name}</h3>
        <p>{basket.description}</p>
      </div>
      <div className="app-basket-card__assets">
        <span>{basket.assets.length} holdings</span>
        <strong>${basket.symbol}</strong>
      </div>
      <button
        className="button button--ink"
        type="button"
        aria-label={`View ${basket.name} basket`}
        onClick={() => onOpen(basket.id)}
      >
        View basket <ArrowRight size={16} aria-hidden="true" />
      </button>
    </article>
  )
}

export function BasketIndex({ onOpen, onNavigate, getPublicClient }) {
  const [factoryIndex, setFactoryIndex] = useState({
    status: "idle",
    baskets: [],
    failures: [],
    error: "",
    count: 0,
    scannedCount: 0,
    hasMore: false,
    nextOffset: 0,
  })
  const [refreshIndex, setRefreshIndex] = useState(0)
  const requestRevisionRef = useRef(0)

  const loadPage = useCallback(
    async (offset, replace = false) => {
      const revision = ++requestRevisionRef.current
      setFactoryIndex((current) => ({
        ...current,
        status: replace ? "loading" : "loading-more",
        error: "",
        ...(replace
          ? { baskets: [], failures: [], count: 0, scannedCount: 0, hasMore: false }
          : {}),
      }))

      try {
        const publicClient = await getPublicClient()
        const result = await discoverFactoryBaskets({
          publicClient,
          offset,
          limit: FACTORY_PAGE_SIZE,
        })
        const displayFailures = []
        const visible = result.baskets.flatMap((factoryBasket) => {
          try {
            return [createDynamicBasketView(factoryBasket)]
          } catch (error) {
            displayFailures.push({
              stage: "display",
              address: factoryBasket.address,
              message: formatProtocolError(error),
            })
            return []
          }
        })
        if (revision !== requestRevisionRef.current) return

        setFactoryIndex((current) => {
          const previous = replace ? [] : current.baskets
          const byAddress = new Map(
            [...previous, ...visible].map((item) => [addressKey(item.address), item]),
          )
          return {
            status: "ready",
            baskets: [...byAddress.values()],
            failures: [
              ...(replace ? [] : current.failures),
              ...result.failures,
              ...displayFailures,
            ],
            error: "",
            count: result.count,
            scannedCount: (replace ? 0 : current.scannedCount) + result.scannedCount,
            hasMore: result.hasMore,
            nextOffset: result.nextOffset ?? 0,
          }
        })
      } catch (error) {
        if (revision !== requestRevisionRef.current) return
        setFactoryIndex((current) => ({
          ...current,
          status: replace ? "error" : "ready",
          error: formatProtocolError(error),
        }))
      }
    },
    [getPublicClient],
  )

  useEffect(() => {
    if (!contractAddressesConfigured) return undefined
    void loadPage(0, true)
    return () => {
      requestRevisionRef.current += 1
    }
  }, [loadPage, refreshIndex])

  const featuredAddresses = new Set(marketedBaskets.map((basket) => addressKey(basket.address)))
  const visibleBaskets = [
    ...marketedBaskets,
    ...factoryIndex.baskets.filter((basket) => !featuredAddresses.has(addressKey(basket.address))),
  ]

  return (
    <main id="app-content" className="app-main" tabIndex={-1}>
      <section className="app-hero-row app-hero-row--simple">
        <div>
          <h1>
            bStock baskets.
            <br />
            One token.
          </h1>
          <p>Explore CORE4, discover published baskets or create one of your own.</p>
        </div>
      </section>
      <section className="app-section-heading">
        <div>
          <span>BASKETS</span>
          <h2>Explore baskets</h2>
        </div>
        <button
          className="button button--outline"
          type="button"
          onClick={() => onNavigate("studio")}
        >
          <Plus size={16} aria-hidden="true" /> Create a basket
        </button>
      </section>
      <section className="app-basket-grid">
        {visibleBaskets.map((basket) => (
          <BasketCard key={basket.id} basket={basket} onOpen={onOpen} />
        ))}
      </section>
      {contractAddressesConfigured &&
      (factoryIndex.status === "idle" || factoryIndex.status === "loading") ? (
        <p className="factory-index-note" role="status">
          <LoaderCircle className="button-spinner" size={15} aria-hidden="true" /> Reading factory
          baskets…
        </p>
      ) : factoryIndex.status === "error" ? (
        <div className="factory-index-note factory-index-note--error">
          <span>Factory baskets could not be read. {factoryIndex.error}</span>
          <button type="button" onClick={() => setRefreshIndex((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : contractAddressesConfigured && factoryIndex.status === "ready" ? (
        <div className="factory-index-note factory-index-note--summary" aria-live="polite">
          <span>
            Scanned {factoryIndex.scannedCount} of {factoryIndex.count} factory baskets.
            {factoryIndex.failures.length
              ? ` ${factoryIndex.failures.length} could not be displayed safely.`
              : ""}
            {factoryIndex.error ? ` ${factoryIndex.error}` : ""}
          </span>
          {factoryIndex.hasMore ? (
            <button
              type="button"
              disabled={factoryIndex.status === "loading-more"}
              onClick={() => loadPage(factoryIndex.nextOffset)}
            >
              Load more baskets
            </button>
          ) : factoryIndex.error ? (
            <button type="button" onClick={() => loadPage(factoryIndex.nextOffset)}>
              Try this page again
            </button>
          ) : null}
        </div>
      ) : factoryIndex.status === "loading-more" ? (
        <p className="factory-index-note" role="status">
          <LoaderCircle className="button-spinner" size={15} aria-hidden="true" /> Reading more
          baskets…
        </p>
      ) : null}
    </main>
  )
}
