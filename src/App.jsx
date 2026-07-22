import { lazy, Suspense, useEffect, useState } from "react"
import { LandingPage } from "./pages/LandingPage"

const ProductApp = lazy(() =>
  import("./pages/ProductApp").then((module) => ({ default: module.ProductApp })),
)
const appViews = new Set(["app", "portfolio", "studio"])

function readRoute() {
  const route = window.location.hash.replace(/^#\/?/, "") || "landing"
  const [view, basketId, extra] = route.split("/")
  if (view === "landing" && !basketId) return { view: "landing", basketId: undefined }
  if (appViews.has(view) && !basketId) return { view, basketId: undefined }
  if (view === "basket" && basketId && !extra) return { view, basketId }
  return { view: "not-found", basketId: undefined }
}

function focusRoute() {
  window.requestAnimationFrame(() => {
    document.querySelector("main")?.focus({ preventScroll: true })
  })
}

export function App() {
  const [route, setRoute] = useState(readRoute)

  useEffect(() => {
    const onHashChange = () => {
      setRoute(readRoute())
      window.scrollTo({ top: 0, behavior: "auto" })
      focusRoute()
    }
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  const navigate = (view, basketId) => {
    const nextHash = basketId ? `${view}/${basketId}` : view
    if (window.location.hash === `#${nextHash}`) {
      setRoute({ view, basketId })
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" })
      focusRoute()
      return
    }
    window.location.hash = nextHash
  }

  if (route.view === "landing") return <LandingPage onNavigate={navigate} />

  return (
    <Suspense
      fallback={
        <main className="route-loader" tabIndex={-1} role="status" aria-live="polite">
          <span />
          <p>Loading Woven…</p>
        </main>
      }
    >
      <ProductApp initialView={route.view} basketId={route.basketId} onNavigate={navigate} />
    </Suspense>
  )
}
