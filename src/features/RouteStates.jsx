import { LoaderCircle, Network } from "lucide-react"

export function BasketRouteStatus({ title, body, loading = false, onNavigate }) {
  return (
    <main id="app-content" className="app-main" tabIndex={-1}>
      <section className="empty-state empty-state--not-found" aria-live="polite">
        <span className={loading ? "empty-state__spinner" : ""}>
          {loading ? <LoaderCircle size={28} aria-hidden="true" /> : <Network size={28} />}
        </span>
        <h1>{title}</h1>
        <p>{body}</p>
        {!loading ? (
          <button className="button button--ink" type="button" onClick={() => onNavigate("app")}>
            Back to baskets
          </button>
        ) : null}
      </section>
    </main>
  )
}

export function NotFound({ title = "Page not found", onNavigate }) {
  return (
    <main id="app-content" className="app-main" tabIndex={-1}>
      <section className="empty-state empty-state--not-found">
        <span>404</span>
        <h1>{title}</h1>
        <p>The requested Woven route does not exist.</p>
        <button className="button button--ink" type="button" onClick={() => onNavigate("app")}>
          Back to baskets
        </button>
      </section>
    </main>
  )
}
