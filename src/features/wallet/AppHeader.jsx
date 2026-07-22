import { useCallback, useEffect, useRef, useState } from "react"
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  LogOut,
  Menu,
  Network,
  RefreshCcw,
  Wallet,
  X,
} from "lucide-react"
import { Brand } from "../../components/Brand"
import { wovenContracts } from "../../config/contracts"
import { WOVEN_FOUR_MEME_URL } from "../../config/tokenomics"
import { compactAddress, copyToClipboard, focusableSelector } from "../shared"

function WalletControl({ wallet, open, onOpenChange }) {
  const [copyState, setCopyState] = useState("idle")
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)
  const wasConnectedRef = useRef(Boolean(wallet.account))

  useEffect(() => {
    if (!open) return undefined
    popoverRef.current?.querySelector(focusableSelector)?.focus()
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onOpenChange(false)
        triggerRef.current?.focus()
        return
      }
      if (event.key !== "Tab") return

      const focusable = Array.from(popoverRef.current?.querySelectorAll(focusableSelector) || [])
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) onOpenChange(false)
    }
    const onFocusIn = (event) => {
      if (!rootRef.current?.contains(event.target)) onOpenChange(false)
    }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("focusin", onFocusIn)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("focusin", onFocusIn)
    }
  }, [onOpenChange, open])

  useEffect(() => {
    if (copyState === "idle") return undefined
    const timeout = window.setTimeout(() => setCopyState("idle"), 1800)
    return () => window.clearTimeout(timeout)
  }, [copyState])

  useEffect(() => {
    const wasConnected = wasConnectedRef.current
    wasConnectedRef.current = Boolean(wallet.account)
    if (!wasConnected || wallet.account) return undefined

    const frame = window.requestAnimationFrame(() => {
      onOpenChange(false)
      setCopyState("idle")
    })
    return () => window.cancelAnimationFrame(frame)
  }, [onOpenChange, wallet.account])

  if (!wallet.account) {
    const checking = wallet.status === "checking"
    const connecting = wallet.status === "connecting"
    const hasProviderChoice = wallet.providers.length > 1
    const chooseProvider = async (providerId) => {
      onOpenChange(false)
      await wallet.connect(providerId)
    }

    return (
      <div className="wallet-control" ref={rootRef}>
        <button
          ref={triggerRef}
          className="button button--ink app-connect"
          type="button"
          disabled={checking || connecting}
          onClick={() => (hasProviderChoice ? onOpenChange(!open) : wallet.connect())}
          aria-expanded={hasProviderChoice ? open : undefined}
          aria-haspopup={hasProviderChoice ? "dialog" : undefined}
          aria-controls={hasProviderChoice ? "woven-wallet-options" : undefined}
          aria-label={
            checking ? "Checking wallet" : connecting ? "Connecting wallet" : "Connect wallet"
          }
        >
          <Wallet size={16} aria-hidden="true" />
          <span>{checking ? "Checking…" : connecting ? "Connecting…" : "Connect wallet"}</span>
          {hasProviderChoice ? <ChevronDown size={14} aria-hidden="true" /> : null}
        </button>

        {hasProviderChoice && open ? (
          <div
            ref={popoverRef}
            id="woven-wallet-options"
            className="wallet-popover wallet-picker"
            role="dialog"
            aria-label="Choose wallet"
          >
            <div className="wallet-picker__head">
              <strong>Choose wallet</strong>
              <span>{wallet.providers.length} available</span>
            </div>
            <div className="wallet-picker__list">
              {wallet.providers.map((provider) => {
                const selected = provider.id === wallet.selectedProviderId
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => chooseProvider(provider.id)}
                    aria-label={`Connect ${provider.name}${provider.rdns ? ` (${provider.rdns})` : ""}`}
                  >
                    <span className="wallet-picker__mark" aria-hidden="true">
                      {provider.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="wallet-picker__identity">
                      <strong>{provider.name}</strong>
                      {provider.rdns ? <small>{provider.rdns}</small> : null}
                    </span>
                    {selected ? <Check size={15} aria-label="Selected" /> : null}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  const networkLabel =
    wallet.chainId === null
      ? "Network unavailable"
      : wallet.isBnbChain
        ? wovenContracts.networkName
        : `Switch to ${wovenContracts.networkName}`

  const copyAddress = async () => {
    try {
      await copyToClipboard(wallet.account)
      setCopyState("success")
    } catch {
      setCopyState("error")
    }
  }

  return (
    <div className="wallet-control" ref={rootRef}>
      <button
        ref={triggerRef}
        className={`button button--ink app-connect ${wallet.isBnbChain ? "" : wallet.chainId === null ? "app-connect--muted" : "app-connect--warning"}`}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="woven-wallet-options"
        aria-label={`Wallet ${compactAddress(wallet.account)}, ${networkLabel}`}
      >
        <Wallet size={16} aria-hidden="true" />
        <span>{compactAddress(wallet.account)}</span>
        <i className="wallet-network-dot" aria-hidden="true" />
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          id="woven-wallet-options"
          className="wallet-popover"
          role="dialog"
          aria-label="Wallet options"
        >
          <div className="wallet-popover__head">
            <span>Connected wallet</span>
            <strong>{compactAddress(wallet.account)}</strong>
          </div>
          <div
            className={`wallet-popover__network ${wallet.isBnbChain ? "" : wallet.chainId === null ? "wallet-popover__network--muted" : "wallet-popover__network--warning"}`}
          >
            <i />
            <span>{networkLabel}</span>
          </div>
          {!wallet.isBnbChain && wallet.chainId !== null && (
            <button type="button" onClick={wallet.switchToBnbChain} disabled={wallet.isSwitching}>
              <Network size={16} aria-hidden="true" />{" "}
              {wallet.isSwitching ? "Switching…" : `Switch to ${wovenContracts.networkName}`}
            </button>
          )}
          {wallet.chainId === null ? (
            <button type="button" onClick={wallet.refreshNetwork}>
              <RefreshCcw size={16} aria-hidden="true" /> Check network again
            </button>
          ) : null}
          <button type="button" onClick={copyAddress}>
            {copyState === "success" ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <Copy size={16} aria-hidden="true" />
            )}
            <span aria-live="polite">
              {copyState === "success"
                ? "Copied"
                : copyState === "error"
                  ? "Copy failed"
                  : "Copy address"}
            </span>
          </button>
          <a
            href={`${wovenContracts.explorerBaseUrl}/address/${wallet.account}`}
            target="_blank"
            rel="noreferrer"
            aria-label="View wallet on BscScan (opens in a new tab)"
          >
            <ExternalLink size={16} aria-hidden="true" /> View on BscScan
          </a>
          <button
            className="wallet-popover__disconnect"
            type="button"
            onClick={() => {
              onOpenChange(false)
              wallet.disconnect()
            }}
          >
            <LogOut size={16} aria-hidden="true" /> Disconnect
          </button>
        </div>
      )}
    </div>
  )
}

export function AppHeader({ view, onNavigate, wallet, walletPanelRequest }) {
  const [openPanel, setOpenPanel] = useState(null)
  const menuButtonRef = useRef(null)
  const mobileNavRef = useRef(null)
  const mobileOpen = openPanel === "navigation"
  const setWalletOpen = useCallback((nextOpen) => {
    setOpenPanel(nextOpen ? "wallet" : null)
  }, [])
  const items = [
    ["app", "Baskets"],
    ["portfolio", "Portfolio"],
    ["studio", "Create"],
  ]

  useEffect(() => {
    if (walletPanelRequest <= 0) return undefined
    const frame = window.requestAnimationFrame(() => setOpenPanel("wallet"))
    return () => window.cancelAnimationFrame(frame)
  }, [walletPanelRequest])

  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 1000px)")
    if (!query) return undefined
    const onBreakpointChange = () => {
      if (!query.matches) setOpenPanel(null)
    }
    query.addEventListener?.("change", onBreakpointChange)
    return () => query.removeEventListener?.("change", onBreakpointChange)
  }, [])

  useEffect(() => {
    if (!mobileOpen) return undefined
    mobileNavRef.current?.querySelector("button")?.focus()
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        setOpenPanel(null)
        menuButtonRef.current?.focus()
        return
      }
      if (event.key !== "Tab") return
      const focusable = Array.from(mobileNavRef.current?.querySelectorAll(focusableSelector) || [])
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    const onPointerDown = (event) => {
      const insideMenu = mobileNavRef.current?.contains(event.target)
      const insideTrigger = menuButtonRef.current?.contains(event.target)
      if (!insideMenu && !insideTrigger) setOpenPanel(null)
    }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("pointerdown", onPointerDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("pointerdown", onPointerDown)
    }
  }, [mobileOpen])

  const go = (target) => {
    setOpenPanel(null)
    onNavigate(target)
  }
  const activeView = view === "basket" ? "app" : view

  return (
    <header className="app-header">
      <button
        className="brand-button"
        type="button"
        aria-label="Go to Woven home"
        onClick={() => onNavigate("landing")}
      >
        <Brand />
      </button>
      <nav className="app-nav" aria-label="Application navigation">
        {items.map(([target, label]) => (
          <button
            key={target}
            className={activeView === target ? "active" : ""}
            type="button"
            aria-current={activeView === target ? "page" : undefined}
            onClick={() => go(target)}
          >
            {label}
          </button>
        ))}
        <a href={WOVEN_FOUR_MEME_URL} target="_blank" rel="noopener noreferrer">
          Buy $WOVEN
        </a>
      </nav>
      {wallet.account && wallet.chainId !== null && !wallet.isBnbChain ? (
        <button
          className="network-chip network-chip--warning"
          type="button"
          onClick={wallet.switchToBnbChain}
          disabled={wallet.isSwitching}
        >
          <i /> {wallet.isSwitching ? "Switching…" : "Switch network"}
        </button>
      ) : wallet.account && wallet.chainId === null ? (
        <button
          className="network-chip network-chip--muted"
          type="button"
          onClick={wallet.refreshNetwork}
        >
          <i /> Network unavailable
        </button>
      ) : wallet.account ? (
        <span className="network-chip">
          <i /> {wovenContracts.networkName}
        </span>
      ) : (
        <span className="network-chip network-chip--neutral">
          <Network size={14} aria-hidden="true" /> {wovenContracts.networkName}
        </span>
      )}
      <WalletControl wallet={wallet} open={openPanel === "wallet"} onOpenChange={setWalletOpen} />
      <button
        ref={menuButtonRef}
        className="app-mobile-menu"
        type="button"
        onClick={() => setOpenPanel((panel) => (panel === "navigation" ? null : "navigation"))}
        aria-label={mobileOpen ? "Close app menu" : "Open app menu"}
        aria-expanded={mobileOpen}
        aria-controls="woven-app-mobile-navigation"
      >
        {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
      </button>
      {mobileOpen && (
        <nav
          ref={mobileNavRef}
          id="woven-app-mobile-navigation"
          className="app-mobile-nav"
          aria-label="Mobile application navigation"
        >
          {items.map(([target, label]) => (
            <button
              className={activeView === target ? "active" : ""}
              aria-current={activeView === target ? "page" : undefined}
              key={target}
              type="button"
              onClick={() => go(target)}
            >
              {label}
            </button>
          ))}
          <a href={WOVEN_FOUR_MEME_URL} target="_blank" rel="noopener noreferrer">
            Buy $WOVEN
          </a>
        </nav>
      )}
    </header>
  )
}
