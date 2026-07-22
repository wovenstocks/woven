// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AppErrorBoundary } from "./AppErrorBoundary"

afterEach(() => {
  window.history.replaceState(null, "", "/")
  vi.restoreAllMocks()
})

describe("AppErrorBoundary", () => {
  it("contains a render failure and can return to the landing route", () => {
    window.history.replaceState(null, "", "/#app")
    vi.spyOn(console, "error").mockImplementation(() => {})
    let shouldFail = true

    function View() {
      if (shouldFail) {
        throw new Error("route chunk failed")
      }
      return <p>Landing restored</p>
    }

    render(
      <AppErrorBoundary>
        <View />
      </AppErrorBoundary>,
    )

    expect(screen.getByRole("heading", { name: "This view didn’t load." })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reload Woven" })).toBeTruthy()

    shouldFail = false
    fireEvent.click(screen.getByRole("button", { name: "Back to home" }))

    expect(window.location.hash).toBe("")
    expect(screen.getByText("Landing restored")).toBeTruthy()
  })
})
