import { Menu, X as CloseIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { siGithub, siX } from "simple-icons"
import { WOVEN_FOUR_MEME_URL } from "../config/tokenomics"
import { Brand } from "./Brand"

const focusableSelector = "button:not([disabled]), a[href]"
const socialLinks = [
  { label: "Woven on X", href: "https://x.com/wovenstocks", icon: siX },
  { label: "Woven on GitHub", href: "https://github.com/wovenstocks/woven", icon: siGithub },
]

function HeaderSocialLinks({ mobile = false }) {
  return (
    <div
      className={mobile ? "mobile-nav__socials" : "header-social-links"}
      aria-label="Woven social links"
    >
      {socialLinks.map(({ label, href, icon }) => (
        <a key={href} href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d={icon.path} />
          </svg>
          {mobile && <span>{label.replace("Woven on ", "")}</span>}
        </a>
      ))}
    </div>
  )
}

export function SiteHeader({ onNavigate }) {
  const [open, setOpen] = useState(false)
  const headerRef = useRef(null)
  const menuButtonRef = useRef(null)
  const mobileNavRef = useRef(null)

  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 1000px)")
    if (!query) return undefined
    const onBreakpointChange = () => {
      if (!query.matches) setOpen(false)
    }
    query.addEventListener?.("change", onBreakpointChange)
    return () => query.removeEventListener?.("change", onBreakpointChange)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    mobileNavRef.current?.querySelector("button")?.focus()

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        setOpen(false)
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
      if (!headerRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("pointerdown", onPointerDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("pointerdown", onPointerDown)
    }
  }, [open])

  const navigate = (target) => {
    setOpen(false)
    onNavigate(target)
  }

  const scrollToSection = (sectionId) => {
    setOpen(false)
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    const target = document.getElementById(sectionId)
    target?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    })
    target?.focus({ preventScroll: true })
  }

  return (
    <header className="site-header" ref={headerRef}>
      <button
        className="brand-button"
        type="button"
        aria-label="Go to Woven home"
        onClick={() => navigate("landing")}
      >
        <Brand />
      </button>
      <nav className="site-nav" aria-label="Primary navigation">
        <button type="button" onClick={() => scrollToSection("baskets")}>
          Baskets
        </button>
        <button type="button" onClick={() => scrollToSection("how-it-works")}>
          How it works
        </button>
        <a href={WOVEN_FOUR_MEME_URL} target="_blank" rel="noopener noreferrer">
          Buy $WOVEN
        </a>
      </nav>
      <div className="header-actions">
        <HeaderSocialLinks />
        <button
          className="button button--paper header-launch"
          type="button"
          onClick={() => navigate("app")}
        >
          Explore baskets
        </button>
      </div>
      <button
        ref={menuButtonRef}
        className="menu-button"
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="woven-mobile-navigation"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <CloseIcon size={23} aria-hidden="true" /> : <Menu size={23} aria-hidden="true" />}
      </button>
      {open && (
        <nav
          ref={mobileNavRef}
          id="woven-mobile-navigation"
          className="mobile-nav"
          aria-label="Mobile navigation"
        >
          <button type="button" onClick={() => scrollToSection("baskets")}>
            Baskets
          </button>
          <button type="button" onClick={() => scrollToSection("how-it-works")}>
            How it works
          </button>
          <a href={WOVEN_FOUR_MEME_URL} target="_blank" rel="noopener noreferrer">
            Buy $WOVEN
          </a>
          <button type="button" onClick={() => navigate("studio")}>
            Create a basket
          </button>
          <button type="button" onClick={() => navigate("app")}>
            Explore baskets
          </button>
          <HeaderSocialLinks mobile />
        </nav>
      )}
    </header>
  )
}
