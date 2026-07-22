import { describe, expect, it } from "vitest"
import { baskets, createDynamicBasketView } from "./baskets"

const BASKET = "0x3000000000000000000000000000000000000001"
const TOKEN_A = "0x2000000000000000000000000000000000000001"
const TOKEN_B = "0x2000000000000000000000000000000000000002"
const catalog = [
  { symbol: "AAA", ticker: "AAA", name: "Asset A", address: TOKEN_A, tone: "green" },
  { symbol: "BBB", ticker: "BBB", name: "Asset B", address: TOKEN_B, tone: "blue" },
]

function factoryBasket(name) {
  return {
    address: BASKET,
    name,
    symbol: "BASKET",
    mintFeeBps: 30,
    constituents: [
      { token: TOKEN_A, units: 1n },
      { token: TOKEN_B, units: 2n },
    ],
  }
}

describe("factory basket display metadata", () => {
  it("uses the creation policy for Unicode control and format characters", () => {
    expect(createDynamicBasketView(factoryBasket("Verified Basket"), catalog).name).toBe(
      "Verified Basket",
    )

    for (const name of ["Spoof\u202eName", "Zero\u200bWidth", "Line\nBreak"]) {
      expect(() => createDynamicBasketView(factoryBasket(name), catalog)).toThrow(
        /unsafe basket name/i,
      )
    }
  })

  it("marks only baskets covered by the initial four-asset router as one-click ready", () => {
    const core = baskets.find((basket) => basket.id === "core4")
    const tech5 = baskets.find((basket) => basket.id === "tech5")
    expect(core).toMatchObject({ name: "Woven Core Four", symbol: "CORE4", oneClickRoute: true })
    expect(tech5).toMatchObject({ oneClickRoute: false })

    const routeable = createDynamicBasketView(factoryBasket("Routeable"), [
      { ...catalog[0], symbol: "NVDAB" },
      { ...catalog[1], symbol: "QQQB" },
    ])
    const unsupported = createDynamicBasketView(factoryBasket("Unsupported"), catalog)
    expect(routeable.oneClickRoute).toBe(true)
    expect(unsupported.oneClickRoute).toBe(false)
  })
})
