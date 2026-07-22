import { useEffect, useRef, useState } from "react"
import {
  ArrowDown,
  ArrowRight,
  Blocks,
  Check,
  Copy,
  ExternalLink,
  Flame,
  RefreshCcw,
  Sparkles,
} from "lucide-react"
import { siGithub } from "simple-icons"
import { Brand, StockBadge } from "../components/Brand"
import { Reveal } from "../components/Reveal"
import { SiteHeader } from "../components/SiteHeader"
import {
  formatWoven,
  WOVEN_EXPLORER_URL,
  WOVEN_FOUR_MEME_URL,
  WOVEN_TOKEN_ADDRESS,
  WOVEN_TOKENOMICS,
} from "../config/tokenomics"
import { marketedBaskets, stocks } from "../data/baskets"

const toneBySymbol = Object.fromEntries(stocks.map((stock) => [stock.symbol, stock.tone]))
const stockBySymbol = Object.fromEntries(stocks.map((stock) => [stock.symbol, stock]))

function BasketPanel({ basket, active, onSelect, onOpen }) {
  const buttonId = `basket-trigger-${basket.id}`
  const panelId = `basket-panel-${basket.id}`
  return (
    <article className={`basket-panel ${active ? "basket-panel--active" : ""}`}>
      <h3>
        <button
          id={buttonId}
          className="basket-panel__title"
          type="button"
          onClick={onSelect}
          aria-expanded={active}
          aria-controls={panelId}
        >
          <span>{basket.name}</span>
          <span className="basket-panel__meta">
            <strong>${basket.symbol}</strong>
            <i aria-hidden="true">{active ? "✓" : "+"}</i>
          </span>
        </button>
      </h3>
      <div
        id={panelId}
        className="basket-panel__clip"
        role="region"
        aria-labelledby={buttonId}
        hidden={!active}
      >
        <div className="basket-panel__body">
          <p>{basket.description}</p>
          <div className="ticker-list">
            {basket.assets.map((symbol) => {
              const stock = stockBySymbol[symbol]
              return (
                <span key={symbol}>
                  <StockBadge symbol={symbol} tone={toneBySymbol[symbol]} small />
                  {stock?.ticker || symbol}
                </span>
              )
            })}
          </div>
          <button
            className="button button--ink"
            type="button"
            onClick={onOpen}
            tabIndex={active ? 0 : -1}
          >
            Explore ${basket.symbol} <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </article>
  )
}

export function LandingPage({ onNavigate }) {
  const [activeBasketId, setActiveBasketId] = useState(marketedBaskets[0].id)
  const [contractCopied, setContractCopied] = useState(false)
  const copyResetTimerRef = useRef(null)
  const activeBasket =
    marketedBaskets.find((basket) => basket.id === activeBasketId) || marketedBaskets[0]

  const scrollToBaskets = () => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    const target = document.getElementById("baskets")
    target?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" })
    target?.focus({ preventScroll: true })
  }

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current)
    },
    [],
  )

  const copyContract = async () => {
    try {
      await navigator.clipboard.writeText(WOVEN_TOKEN_ADDRESS)
      setContractCopied(true)
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current)
      copyResetTimerRef.current = window.setTimeout(() => {
        setContractCopied(false)
        copyResetTimerRef.current = null
      }, 1800)
    } catch {
      setContractCopied(false)
    }
  }

  return (
    <div className="landing-page">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById("main-content")?.focus({ preventScroll: true })
          document.getElementById("main-content")?.scrollIntoView({ block: "start" })
        }}
      >
        Skip to content
      </a>
      <SiteHeader onNavigate={onNavigate} />
      <main id="main-content" tabIndex={-1}>
        <div className="hero-shell">
          <section className="hero" aria-labelledby="hero-title">
            <picture>
              <source
                srcSet="/woven-hero-folio-720.avif 720w, /woven-hero-folio-1280.avif 1280w, /woven-hero-folio-1586.avif 1586w"
                sizes="(max-width: 640px) calc(100vw - 16px), calc(100vw - 28px)"
                type="image/avif"
              />
              <source
                srcSet="/woven-hero-folio-720.webp 720w, /woven-hero-folio-1280.webp 1280w, /woven-hero-folio-1586.webp 1586w"
                sizes="(max-width: 640px) calc(100vw - 16px), calc(100vw - 28px)"
                type="image/webp"
              />
              <source
                srcSet="/woven-hero-folio-720.jpg 720w, /woven-hero-folio-1280.jpg 1280w, /woven-hero-folio-1586.jpg 1586w"
                sizes="(max-width: 640px) calc(100vw - 16px), calc(100vw - 28px)"
                type="image/jpeg"
              />
              <img
                src="/woven-hero-folio-1280.jpg"
                alt=""
                width="1586"
                height="992"
                fetchPriority="high"
                loading="eager"
                decoding="async"
              />
            </picture>
            <div className="hero__shade" />
            <div className="hero__copy">
              <h1 id="hero-title">
                Built from many.
                <br />
                Held as one.
              </h1>
              <p>
                Buy a complete bStock basket with USDC. Hold it, send it or redeem its constituent
                tokens when their transfer rules permit.
              </p>
              <div className="hero__actions">
                <button className="button button--paper" type="button" onClick={scrollToBaskets}>
                  Explore baskets <ArrowDown size={16} />
                </button>
                <button
                  className="button button--glass"
                  type="button"
                  onClick={() => onNavigate("studio")}
                >
                  Create a basket
                </button>
              </div>
            </div>
          </section>
        </div>

        {/* Keyboard focus is intentional because the rail is horizontally scrollable. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <section className="token-rail" aria-label="Basket universe" tabIndex={0}>
          <div className="token-rail__track">
            {stocks.slice(0, 9).map((stock) => (
              <span key={stock.symbol}>
                <StockBadge symbol={stock.symbol} tone={stock.tone} small /> {stock.ticker}
              </span>
            ))}
          </div>
        </section>

        <section className="baskets-section page-section" id="baskets" tabIndex={-1}>
          <Reveal className="section-intro">
            <p className="section-label">Woven baskets</p>
            <h2>
              A portfolio,
              <br />
              held as one.
            </h2>
            <p>Start with CORE4 or publish a basket of your own.</p>
          </Reveal>

          <Reveal className="basket-dashboard" delay={60}>
            <div className="basket-dashboard__list">
              {marketedBaskets.map((basket) => (
                <BasketPanel
                  key={basket.id}
                  basket={basket}
                  active={basket.id === activeBasket.id}
                  onSelect={() => setActiveBasketId(basket.id)}
                  onOpen={() => onNavigate("basket", basket.id)}
                />
              ))}
            </div>

            <div
              className={`basket-dashboard__stats basket-dashboard__stats--${activeBasket.tint}`}
            >
              <article className="stat-card stat-card--wide">
                <div className="stat-card__top">
                  <span>Inside ${activeBasket.symbol}</span>
                  <strong>Units per token</strong>
                </div>
                <div className="allocation-list">
                  {activeBasket.assets.map((symbol) => {
                    const stock = stockBySymbol[symbol]
                    return (
                      <div key={symbol}>
                        <span className="allocation-list__identity">
                          <StockBadge symbol={symbol} tone={toneBySymbol[symbol]} small />{" "}
                          <span>
                            <strong>{stock?.ticker || symbol}</strong>
                            <small>{stock?.name}</small>
                          </span>
                        </span>
                        <strong>{activeBasket.units?.[symbol] || "Onchain"}</strong>
                      </div>
                    )
                  })}
                </div>
              </article>
              <article className="stat-card">
                <span>{activeBasket.oneClickRoute ? "Buy with" : "Deposit"}</span>
                <strong>{activeBasket.oneClickRoute ? "USDC" : "Assets"}</strong>
                <p>
                  {activeBasket.oneClickRoute
                    ? "One transaction buys every required asset and mints the basket token."
                    : "Deposit the listed assets to mint the basket token."}
                </p>
                <div className="stat-card__logos" aria-hidden="true">
                  {activeBasket.assets.slice(0, 4).map((symbol) => (
                    <span key={symbol}>
                      <StockBadge symbol={symbol} tone={toneBySymbol[symbol]} small />
                    </span>
                  ))}
                </div>
              </article>
              <article className="stat-card">
                <span>Mint fee</span>
                <strong>0.30%</strong>
                <p>60% to the basket creator. 40% to the Woven treasury.</p>
                <div
                  className="fee-split"
                  role="img"
                  aria-label="60 percent creator, 40 percent treasury"
                >
                  <i />
                  <i />
                </div>
                <small className="stat-card__foot">0% protocol redemption fee</small>
              </article>
            </div>
          </Reveal>
        </section>

        <section className="how-section" id="how-it-works" tabIndex={-1}>
          <div className="how-section__inner">
            <Reveal>
              <p className="section-label">How it works</p>
              <h2>
                Buy. Hold.
                <br />
                Redeem.
              </h2>
            </Reveal>
            <div className="steps-grid">
              <Reveal as="article" delay={0}>
                <span>01</span>
                <Blocks size={35} strokeWidth={1.3} />
                <h3>Choose a basket</h3>
                <p>See every bStock held behind the basket token.</p>
              </Reveal>
              <Reveal as="article" delay={50}>
                <span>02</span>
                <Sparkles size={35} strokeWidth={1.3} />
                <h3>Buy with USDC</h3>
                <p>One transaction buys the assets and mints your basket token.</p>
              </Reveal>
              <Reveal as="article" delay={100}>
                <span>03</span>
                <RefreshCcw size={35} strokeWidth={1.3} />
                <h3>Keep control</h3>
                <p>Hold it, send it or redeem the listed tokens when transfers are permitted.</p>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="tokenomics-section page-section" id="tokenomics" tabIndex={-1}>
          <Reveal className="tokenomics-copy">
            <p className="section-label">$WOVEN for creators</p>
            <h2>
              Publish a basket.
              <br />
              <span>Share in mint fees.</span>
            </h2>
            <p>
              Send 10,000 $WOVEN permanently to the published dead address to unlock basket
              creation. Creators receive 60% of the basket-token fees issued on completed mints.
            </p>
            <a
              className="button button--outline"
              href={WOVEN_FOUR_MEME_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Buy $WOVEN <ExternalLink size={15} />
            </a>
            <div className="woven-contract">
              <span>Official contract</span>
              <div>
                <a href={WOVEN_EXPLORER_URL} target="_blank" rel="noopener noreferrer">
                  {WOVEN_TOKEN_ADDRESS}
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
                <button
                  type="button"
                  onClick={copyContract}
                  aria-label={contractCopied ? "WOVEN contract copied" : "Copy WOVEN contract"}
                >
                  {contractCopied ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </div>
            </div>
          </Reveal>
          <Reveal className="license-spec" delay={70}>
            <div className="license-spec__seal">
              <Flame size={31} />
              <span>
                Creator
                <br />
                access
              </span>
            </div>
            <div className="license-spec__number">
              <span>Creator requirement</span>
              <strong>{formatWoven(WOVEN_TOKENOMICS.creatorLicense)}</strong>
              <small>$WOVEN</small>
            </div>
            <div className="license-spec__grid">
              <div>
                <span>Required supply</span>
                <strong>1B</strong>
              </div>
              <div>
                <span>Mint fee</span>
                <strong>0.30%</strong>
              </div>
              <div>
                <span>Creator share</span>
                <strong>60%</strong>
              </div>
              <div>
                <span>Redeem fee</span>
                <strong>0%</strong>
              </div>
            </div>
          </Reveal>
        </section>

        <section className="final-cta">
          <Reveal>
            <h2>
              One portfolio.
              <br />
              One token.
            </h2>
            <p>Explore CORE4 or publish a basket of your own.</p>
            <div>
              <button
                className="button button--ink"
                type="button"
                onClick={() => onNavigate("app")}
              >
                Explore baskets <ArrowRight size={17} />
              </button>
              <button
                className="button button--ghost"
                type="button"
                onClick={() => onNavigate("studio")}
              >
                Create a basket
              </button>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-brand">
          <Brand />
          <p>
            Built from many.
            <br />
            Held as one.
          </p>
        </div>
        <div className="footer-links">
          <div>
            <span>Product</span>
            <button onClick={() => onNavigate("app")}>Baskets</button>
            <button onClick={() => onNavigate("portfolio")}>Portfolio</button>
          </div>
          <div>
            <span>Create</span>
            <button onClick={() => onNavigate("studio")}>Create a basket</button>
            <button onClick={() => document.getElementById("tokenomics")?.scrollIntoView()}>
              $WOVEN
            </button>
          </div>
          <div>
            <span>Company</span>
            <div className="footer-social-links" aria-label="Woven Stocks social links">
              <a
                href="https://x.com/wovenstocks"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Woven Stocks on X"
              >
                X / @wovenstocks
              </a>
              <a
                href="https://github.com/wovenstocks/woven"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Woven Stocks on GitHub"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d={siGithub.path} />
                </svg>
                GitHub
              </a>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2026 Woven Stocks</span>
          <span>BNB Chain</span>
        </div>
      </footer>
    </div>
  )
}
