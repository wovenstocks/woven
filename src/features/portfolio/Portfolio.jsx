import { useCallback, useEffect, useRef, useState } from "react"
import { ExternalLink, LoaderCircle, Network, Wallet } from "lucide-react"
import { contractAddressesConfigured, wovenContracts } from "../../config/contracts"
import { formatProtocolError, getPortfolioBalances } from "../../protocol"
import { addressKey } from "../shared"

const PORTFOLIO_PAGE_SIZE = 25

export function Portfolio({ wallet, onNavigate, getPublicClient, onConnect }) {
  const [portfolio, setPortfolio] = useState({
    status: "idle",
    positions: [],
    failures: [],
    error: "",
    requestKey: "",
    indexedBasketCount: 0,
    scannedCount: 0,
    hasMore: false,
    nextOffset: 0,
  })
  const [refreshIndex, setRefreshIndex] = useState(0)
  const requestRevisionRef = useRef(0)
  const portfolioRequestKey = `${addressKey(wallet.account)}:${refreshIndex}`
  const headingCopy = wallet.account
    ? "Review basket positions held by this wallet."
    : "Connect a wallet to continue."

  const loadPage = useCallback(
    async (offset, replace = false) => {
      if (!wallet.account) return
      const account = wallet.account
      const requestKey = portfolioRequestKey
      const revision = ++requestRevisionRef.current
      setPortfolio((current) => ({
        ...current,
        status: replace ? "loading" : "loading-more",
        requestKey,
        error: "",
        ...(replace
          ? {
              positions: [],
              failures: [],
              indexedBasketCount: 0,
              scannedCount: 0,
              hasMore: false,
            }
          : {}),
      }))

      try {
        const publicClient = await getPublicClient()
        const result = await getPortfolioBalances({
          publicClient,
          account,
          includeZeroBalances: false,
          offset,
          limit: PORTFOLIO_PAGE_SIZE,
        })
        if (revision !== requestRevisionRef.current) return

        setPortfolio((current) => {
          const previous = replace ? [] : current.positions
          const byAddress = new Map(
            [...previous, ...result.positions].map((position) => [
              addressKey(position.address),
              position,
            ]),
          )
          return {
            status: "ready",
            positions: [...byAddress.values()],
            failures: [...(replace ? [] : current.failures), ...result.failures],
            error: "",
            requestKey,
            indexedBasketCount: result.indexedBasketCount,
            scannedCount: (replace ? 0 : current.scannedCount) + result.scannedCount,
            hasMore: result.hasMore,
            nextOffset: result.nextOffset ?? 0,
          }
        })
      } catch (error) {
        if (revision !== requestRevisionRef.current) return
        setPortfolio((current) => ({
          ...current,
          status: replace ? "error" : "ready",
          error: formatProtocolError(error),
          requestKey,
        }))
      }
    },
    [getPublicClient, portfolioRequestKey, wallet.account],
  )

  useEffect(() => {
    if (!wallet.account || !wallet.isBnbChain || !contractAddressesConfigured) {
      return undefined
    }
    void loadPage(0, true)
    return () => {
      requestRevisionRef.current += 1
    }
  }, [loadPage, wallet.account, wallet.isBnbChain])

  const scanControls =
    portfolio.status === "ready" || portfolio.status === "loading-more" ? (
      <div className="portfolio-scan-note" aria-live="polite">
        <span>
          Scanned {portfolio.scannedCount} of {portfolio.indexedBasketCount} factory baskets.
          {portfolio.failures.length
            ? ` ${portfolio.failures.length} balance checks could not be verified.`
            : ""}
          {portfolio.error ? ` ${portfolio.error}` : ""}
        </span>
        {portfolio.hasMore ? (
          <button
            className="button button--outline"
            type="button"
            disabled={portfolio.status === "loading-more"}
            onClick={() => loadPage(portfolio.nextOffset)}
          >
            {portfolio.status === "loading-more" ? "Scanning…" : "Scan more baskets"}
          </button>
        ) : portfolio.error ? (
          <button
            className="button button--outline"
            type="button"
            onClick={() => loadPage(portfolio.nextOffset)}
          >
            Try this page again
          </button>
        ) : null}
      </div>
    ) : null

  return (
    <main id="app-content" className="app-main" tabIndex={-1}>
      <section className="simple-heading">
        <span>PORTFOLIO</span>
        <h1>Your baskets</h1>
        <p>{headingCopy}</p>
      </section>
      {!wallet.account ? (
        <section className="empty-state">
          <span>
            <Wallet size={30} aria-hidden="true" />
          </span>
          <h2>Connect your wallet</h2>
          <p>Connect an EVM wallet to view its Woven positions.</p>
          <button
            className="button button--ink"
            type="button"
            disabled={wallet.status === "checking" || wallet.status === "connecting"}
            onClick={onConnect}
          >
            {wallet.status === "checking"
              ? "Checking wallet…"
              : wallet.status === "connecting"
                ? "Connecting…"
                : "Connect wallet"}
          </button>
        </section>
      ) : wallet.chainId === null ? (
        <section className="empty-state">
          <span>
            <Network size={30} aria-hidden="true" />
          </span>
          <h2>Network unavailable</h2>
          <p>Unlock your wallet or reconnect its network.</p>
        </section>
      ) : !wallet.isBnbChain ? (
        <section className="empty-state">
          <span>
            <Network size={30} aria-hidden="true" />
          </span>
          <h2>Switch network</h2>
          <p>Switch to {wovenContracts.networkName} to continue.</p>
          <button className="button button--ink" type="button" onClick={wallet.switchToBnbChain}>
            Switch to {wovenContracts.networkName}
          </button>
        </section>
      ) : !contractAddressesConfigured ? (
        <section className="empty-state">
          <span>
            <Network size={30} aria-hidden="true" />
          </span>
          <h2>Portfolio unavailable</h2>
          <p>
            Woven is not connected to its verified contracts on this network, so no positions were
            queried.
          </p>
          <button
            className="button button--outline"
            type="button"
            onClick={() => onNavigate("app")}
          >
            Explore baskets
          </button>
        </section>
      ) : portfolio.status === "idle" || portfolio.status === "loading" ? (
        <section className="empty-state">
          <span className="empty-state__spinner">
            <LoaderCircle size={28} aria-hidden="true" />
          </span>
          <h2>Reading your baskets</h2>
          <p>Checking factory-created basket balances on {wovenContracts.networkName}.</p>
        </section>
      ) : portfolio.status === "error" ? (
        <section className="empty-state">
          <span>
            <Network size={30} aria-hidden="true" />
          </span>
          <h2>Portfolio could not be read</h2>
          <p>{portfolio.error}</p>
          <button
            className="button button--outline"
            type="button"
            onClick={() => setRefreshIndex((value) => value + 1)}
          >
            Try again
          </button>
        </section>
      ) : portfolio.positions.length > 0 ? (
        <>
          <section className="portfolio-grid" aria-label="Basket positions">
            {portfolio.positions.map((position) => (
              <article className="portfolio-position" key={position.address}>
                <div className="portfolio-position__top">
                  <span className="basket-symbol">${position.symbol}</span>
                  <span>Created by Woven factory</span>
                </div>
                <h2>{position.name}</h2>
                <p>Wallet balance</p>
                <strong>{position.balanceFormatted}</strong>
                <div className="portfolio-position__actions">
                  <button
                    className="button button--ink"
                    type="button"
                    onClick={() => onNavigate("basket", position.address)}
                  >
                    Open basket
                  </button>
                  <a
                    className="button button--outline"
                    href={`${wovenContracts.explorerBaseUrl}/token/${position.address}?a=${wallet.account}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`View ${position.symbol} on BscScan (opens in a new tab)`}
                  >
                    BscScan <ExternalLink size={15} aria-hidden="true" />
                  </a>
                </div>
              </article>
            ))}
          </section>
          {scanControls}
        </>
      ) : portfolio.failures.length > 0 ? (
        <section className="empty-state">
          <span>
            <Network size={30} aria-hidden="true" />
          </span>
          <h2>Portfolio incomplete</h2>
          <p>
            Some basket balances could not be verified, so this view cannot confirm that the wallet
            has no positions.
          </p>
          {scanControls}
        </section>
      ) : portfolio.hasMore ? (
        <section className="empty-state">
          <span>
            <Wallet size={30} aria-hidden="true" />
          </span>
          <h2>No basket balance in this batch</h2>
          <p>Continue scanning the factory index to check the remaining baskets.</p>
          {scanControls}
        </section>
      ) : (
        <section className="empty-state">
          <span>
            <Wallet size={30} aria-hidden="true" />
          </span>
          <h2>No basket tokens yet</h2>
          <p>This wallet has no balance in a basket created by the configured Woven factory.</p>
          <button
            className="button button--outline"
            type="button"
            onClick={() => onNavigate("app")}
          >
            Explore baskets
          </button>
        </section>
      )}
    </main>
  )
}
