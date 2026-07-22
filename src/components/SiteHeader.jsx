import { Menu, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Brand } from "./Brand"

const focusableSelector = "button:not([disabled]), a[href]"

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
        <button type="button" onClick={() => scrollToSection("tokenomics")}>
          $WOVEN
        </button>
      </nav>
      <button
        className="button button--paper header-launch"
        type="button"
        onClick={() => navigate("app")}
      >
        Explore baskets
      </button>
      <button
        ref={menuButtonRef}
        className="menu-button"
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="woven-mobile-navigation"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X size={23} aria-hidden="true" /> : <Menu size={23} aria-hidden="true" />}
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
          <button type="button" onClick={() => scrollToSection("tokenomics")}>
            $WOVEN
          </button>
          <button type="button" onClick={() => navigate("studio")}>
            Create a basket
          </button>
          <button type="button" onClick={() => navigate("app")}>
            Explore baskets
          </button>
        </nav>
      )}
    </header>
  )
}
