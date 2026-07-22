import { useEffect, useState } from "react"
import { ArrowRight, Check, Flame, LoaderCircle } from "lucide-react"
import { Brand, StockBadge } from "../../components/Brand"
import { Modal } from "../../components/Modal"
import { contractAddressesConfigured } from "../../config/contracts"
import { formatWoven, WOVEN_LICENSE_SINK, WOVEN_TOKENOMICS } from "../../config/tokenomics"
import { stocks } from "../../data/baskets"
import { getCreatorLicenseStatus, isUsableAddress } from "../../protocol"
import { isPositiveDecimal, stockBySymbol, toneBySymbol } from "../shared"

export function CreatorStudio({ onAction, busyAction, wallet, getPublicClient, catalog = stocks }) {
  const configuredStocks = catalog.filter((stock) => isUsableAddress(stock.address))
  const visibleStocks =
    import.meta.env.VITE_PUBLIC_LAUNCH_LIVE?.trim().toLowerCase() === "true"
      ? configuredStocks
      : catalog
  const [selected, setSelected] = useState(() =>
    configuredStocks.slice(0, 3).map((stock) => stock.symbol),
  )
  const [name, setName] = useState("Woven Tech Basket")
  const [symbol, setSymbol] = useState("WTECH")
  const [licenseState, setLicenseState] = useState({
    status: "unknown",
    requestKey: "",
    data: null,
  })
  const [licenseReviewOpen, setLicenseReviewOpen] = useState(false)
  const [createReviewOpen, setCreateReviewOpen] = useState(false)
  const [units, setUnits] = useState(() =>
    Object.fromEntries(catalog.map((stock) => [stock.symbol, "1"])),
  )

  const toggle = (asset) => {
    setSelected((current) =>
      current.includes(asset)
        ? current.filter((item) => item !== asset)
        : current.length < 10
          ? [...current, asset]
          : current,
    )
  }

  const cleanName = name.trim()
  const validSymbol = /^[A-Z0-9]{3,8}$/.test(symbol)
  const validUnits = selected.every((asset) => isPositiveDecimal(units[asset]))
  const ready = selected.length >= 2 && cleanName.length >= 3 && validSymbol && validUnits
  const licenseRequestKey = `${wallet.account}:${busyAction || "idle"}`
  const visibleLicenseState =
    wallet.account && wallet.isBnbChain && contractAddressesConfigured
      ? licenseState.requestKey === licenseRequestKey
        ? licenseState.status
        : "loading"
      : "unknown"

  useEffect(() => {
    if (!wallet.account || !wallet.isBnbChain || !contractAddressesConfigured) {
      return undefined
    }

    let active = true
    const requestKey = licenseRequestKey
    void getPublicClient()
      .then((publicClient) => getCreatorLicenseStatus({ publicClient, account: wallet.account }))
      .then((status) => {
        if (active) {
          setLicenseState({
            status: status.licensed ? "active" : "inactive",
            requestKey,
            data: status,
          })
        }
      })
      .catch(() => {
        if (active) setLicenseState({ status: "unknown", requestKey, data: null })
      })
    return () => {
      active = false
    }
  }, [getPublicClient, licenseRequestKey, wallet.account, wallet.isBnbChain])

  return (
    <main id="app-content" className="app-main studio-page" tabIndex={-1}>
      <section className="simple-heading studio-heading">
        <div>
          <span>CREATE A BASKET</span>
          <h1>Create a bStock basket.</h1>
        </div>
        <p>Choose 2–10 assets, set the units behind each token and give the basket a name.</p>
      </section>
      <div className="studio-grid">
        <section className="license-card">
          <div className="license-card__icon">
            <Flame size={24} aria-hidden="true" />
          </div>
          <div>
            <span>CREATOR ACCESS</span>
            <h2>Unlock creation with {formatWoven(WOVEN_TOKENOMICS.creatorLicense)} $WOVEN</h2>
            <p>Unlock basket creation for this wallet.</p>
          </div>
          <button
            className="button button--ink"
            type="button"
            disabled={
              Boolean(busyAction) ||
              visibleLicenseState === "active" ||
              visibleLicenseState === "loading"
            }
            onClick={() => setLicenseReviewOpen(true)}
          >
            {busyAction === "license" ? (
              <LoaderCircle className="button-spinner" size={16} aria-hidden="true" />
            ) : null}
            {visibleLicenseState === "active"
              ? "Access active"
              : visibleLicenseState === "loading"
                ? "Checking access…"
                : busyAction === "license"
                  ? "Activating…"
                  : "Activate access"}
          </button>
        </section>

        <section className="studio-form">
          <div className="studio-form__heading">
            <div>
              <span>ASSETS</span>
              <h2>Choose approved assets</h2>
            </div>
            <span id="asset-limit-note" aria-live="polite">
              {selected.length}/10{selected.length >= 10 ? " · maximum" : ""}
            </span>
          </div>
          <div className="studio-fields">
            <div>
              <label htmlFor="basket-name">Basket name</label>
              <input
                id="basket-name"
                value={name}
                maxLength={40}
                aria-invalid={cleanName.length < 3}
                aria-describedby="basket-name-hint"
                onChange={(event) => setName(event.target.value)}
              />
              <small id="basket-name-hint">
                {cleanName.length < 3 ? "Use at least 3 characters" : `${name.length}/40`}
              </small>
            </div>
            <div>
              <label htmlFor="basket-ticker">Ticker</label>
              <input
                id="basket-ticker"
                value={symbol}
                maxLength={8}
                aria-invalid={!validSymbol}
                aria-describedby="basket-ticker-hint"
                onChange={(event) =>
                  setSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                }
              />
              <small id="basket-ticker-hint">
                {validSymbol ? "3–8 characters" : "Use 3–8 A–Z / 0–9"}
              </small>
            </div>
          </div>
          <div className="asset-picker" aria-describedby="asset-limit-note">
            {visibleStocks.map((stock) => {
              const chosen = selected.includes(stock.symbol)
              const full = selected.length >= 10 && !chosen
              const unavailable = !isUsableAddress(stock.address)
              return (
                <button
                  className={chosen ? "selected" : ""}
                  type="button"
                  key={stock.symbol}
                  disabled={full || unavailable}
                  aria-pressed={chosen}
                  onClick={() => toggle(stock.symbol)}
                >
                  <StockBadge symbol={stock.symbol} tone={stock.tone} small />
                  <span>
                    <strong>{stock.ticker}</strong>
                    <small>
                      {stock.name} · {unavailable ? "Not configured" : stock.symbol}
                    </small>
                  </span>
                  {chosen && <Check size={16} aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        </section>

        <aside className="studio-summary" aria-labelledby="basket-factsheet-title">
          <span>BASKET TOKEN</span>
          <div className="basket-token-mark">
            <Brand compact />
          </div>
          <h2 id="basket-factsheet-title">{cleanName || "Untitled basket"}</h2>
          <strong>${symbol || "TICKER"}</strong>
          <p>{selected.length} assets held behind one token</p>
          <div className="summary-constituents">
            {selected.length ? (
              selected.map((item) => {
                const stock = stockBySymbol[item]
                const unitValid = isPositiveDecimal(units[item])
                const errorId = `basket-unit-${item}-error`
                return (
                  <label key={item}>
                    <StockBadge symbol={item} tone={toneBySymbol[item]} small />
                    <span>
                      <strong>{stock?.ticker}</strong>
                      <small>{stock?.name}</small>
                    </span>
                    <span className="summary-unit-control">
                      <input
                        aria-label={`${stock?.ticker} units per basket token`}
                        aria-invalid={!unitValid}
                        aria-describedby={!unitValid ? errorId : undefined}
                        type="number"
                        min="0.000001"
                        step="any"
                        inputMode="decimal"
                        value={units[item]}
                        onChange={(event) =>
                          setUnits((current) => ({ ...current, [item]: event.target.value }))
                        }
                      />
                      {!unitValid ? <small id={errorId}>Enter a value above 0</small> : null}
                    </span>
                  </label>
                )
              })
            ) : (
              <p>Choose at least two assets.</p>
            )}
          </div>
          <small className="summary-unit-label" aria-live="polite">
            {validUnits
              ? "Units held behind each basket token"
              : "Every unit amount must be greater than zero"}
          </small>
          <button
            className="button button--ink button--full studio-publish"
            type="button"
            disabled={!ready || Boolean(busyAction)}
            onClick={() => setCreateReviewOpen(true)}
          >
            {busyAction === "create" ? (
              <LoaderCircle className="button-spinner" size={16} aria-hidden="true" />
            ) : null}
            {busyAction === "create" ? "Publishing basket…" : "Review basket"}{" "}
            {busyAction !== "create" && <ArrowRight size={16} aria-hidden="true" />}
          </button>
        </aside>
      </div>
      {createReviewOpen ? (
        <Modal title="Publish this basket?" onClose={() => setCreateReviewOpen(false)}>
          <div className="create-review">
            <p>Review the final token settings before Woven prepares the onchain transaction.</p>
            <dl>
              <div>
                <dt>Basket</dt>
                <dd>
                  {cleanName} · ${symbol}
                </dd>
              </div>
              <div>
                <dt>Assets</dt>
                <dd>{selected.length}</dd>
              </div>
              <div>
                <dt>Mint fee</dt>
                <dd>{(WOVEN_TOKENOMICS.mintFeeBps / 100).toFixed(2)}%</dd>
              </div>
              <div>
                <dt>Supply cap</dt>
                <dd>{formatWoven(WOVEN_TOKENOMICS.basketSupplyCap)} tokens</dd>
              </div>
            </dl>
            <div className="create-review__assets" role="list" aria-label="Basket units">
              {selected.map((item) => {
                const stock = stockBySymbol[item]
                return (
                  <div key={item} role="listitem">
                    <span>
                      <StockBadge symbol={item} tone={toneBySymbol[item]} small />
                      <strong>{stock?.ticker || item}</strong>
                    </span>
                    <strong>{units[item]} per token</strong>
                  </div>
                )
              })}
            </div>
            <p className="create-review__note">
              Woven checks every selected address against the protocol registry and converts these
              units to exact onchain amounts before your wallet is asked to sign.
            </p>
            <button
              className="button button--ink button--full"
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => {
                setCreateReviewOpen(false)
                void onAction({ type: "create", selected, name, symbol, units })
              }}
            >
              Publish basket <ArrowRight size={16} aria-hidden="true" />
            </button>
            <button
              className="button button--ghost button--full"
              type="button"
              onClick={() => setCreateReviewOpen(false)}
            >
              Go back
            </button>
          </div>
        </Modal>
      ) : null}
      {licenseReviewOpen ? (
        <Modal title="Activate creator access?" onClose={() => setLicenseReviewOpen(false)}>
          <div className="license-review">
            <p>
              This permanently transfers exactly{" "}
              <strong>
                {licenseState.data?.burnAmountFormatted ||
                  formatWoven(WOVEN_TOKENOMICS.creatorLicense)}{" "}
                {licenseState.data?.symbol || "WOVEN"}
              </strong>{" "}
              to the fixed published dead address. It is non-refundable and unlocks basket creation
              for this wallet.
            </p>
            <dl>
              <div>
                <dt>Destination</dt>
                <dd>{licenseState.data?.burnSink || WOVEN_LICENSE_SINK}</dd>
              </div>
              <div>
                <dt>Supply effect</dt>
                <dd>Removed from circulation; ERC-20 totalSupply is unchanged</dd>
              </div>
            </dl>
            <button
              className="button button--ink button--full"
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => {
                setLicenseReviewOpen(false)
                void onAction({ type: "license", licenseConfirmed: true })
              }}
            >
              Confirm permanent removal
            </button>
            <button
              className="button button--ghost button--full"
              type="button"
              onClick={() => setLicenseReviewOpen(false)}
            >
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </main>
  )
}
