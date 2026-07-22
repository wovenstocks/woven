import { Component, createRef } from "react"

export class AppErrorBoundary extends Component {
  state = { error: null }

  fallbackRef = createRef()
  focusFrame = null

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, errorInfo) {
    console.error("Woven interface error", error, errorInfo.componentStack)
    if (this.focusFrame !== null) window.cancelAnimationFrame(this.focusFrame)
    this.focusFrame = window.requestAnimationFrame(() => {
      this.focusFrame = null
      this.fallbackRef.current?.focus()
    })
  }

  componentWillUnmount() {
    if (this.focusFrame !== null) window.cancelAnimationFrame(this.focusFrame)
  }

  returnHome = () => {
    const homeUrl = `${window.location.pathname}${window.location.search}`
    window.history.replaceState(null, "", homeUrl)
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="product-app">
        <main className="app-main" ref={this.fallbackRef} tabIndex={-1}>
          <section className="empty-state" role="alert">
            <span aria-hidden="true">W</span>
            <h1>This view didn’t load.</h1>
            <p>
              The interface stopped before it could continue reliably. Check your wallet for any
              pending request, then reload or return home.
            </p>
            <button
              className="button button--ink"
              type="button"
              onClick={() => window.location.reload()}
            >
              Reload Woven
            </button>
            <button className="button button--outline" type="button" onClick={this.returnHome}>
              Back to home
            </button>
          </section>
        </main>
      </div>
    )
  }
}
