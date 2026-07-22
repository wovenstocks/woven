// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { stocks } from "../../data/baskets"
import { CreatorStudio } from "./CreatorStudio"

describe("CreatorStudio asset availability", () => {
  it("fails closed when the catalog has no verified contract addresses", () => {
    const catalog = stocks.slice(0, 3).map((stock) => ({ ...stock, address: "" }))

    render(
      <CreatorStudio
        catalog={catalog}
        onAction={vi.fn()}
        busyAction={null}
        wallet={{ account: null, isBnbChain: false }}
        getPublicClient={vi.fn()}
      />,
    )

    const unavailableLabels = screen.getAllByText("Not configured", { exact: false })
    expect(unavailableLabels).toHaveLength(3)
    unavailableLabels.forEach((label) => expect(label.closest("button")?.disabled).toBe(true))
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Review basket" }).disabled).toBe(true)
  })
})
