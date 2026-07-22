import { describe, expect, it, vi } from "vitest"
import { convertScaledUiInput, readScaledUiAmount } from "./scaled-ui"

const TOKEN = "0x2000000000000000000000000000000000000001"
const BASE = 10n ** 18n

function scaledHarness({ decimals = 18, multiplier = 2n * BASE, supported = true } = {}) {
  return {
    readContract: vi.fn(async ({ functionName, args = [] }) => {
      if (functionName === "decimals") return decimals
      if (functionName === "supportsInterface") return supported
      if (functionName === "uiMultiplier") return multiplier
      if (functionName === "newUIMultiplier") return multiplier
      if (functionName === "effectiveAt") return 0n
      if (functionName === "toUIAmount") return (args[0] * multiplier) / BASE
      if (functionName === "fromUIAmount") return (args[0] * BASE) / multiplier
      throw new Error(`Unexpected read: ${functionName}`)
    }),
  }
}

describe("ERC-8056 scaled UI amounts", () => {
  it("converts a displayed Studio amount to raw transfer units", async () => {
    const result = await convertScaledUiInput({
      publicClient: scaledHarness(),
      token: TOKEN,
      amount: "1",
    })

    expect(result).toMatchObject({
      requestedUiAmount: BASE,
      rawAmount: BASE / 2n,
      uiAmount: BASE,
      uiMultiplier: 2n * BASE,
      amountFormatted: "1",
      rounded: false,
    })
  })

  it("formats raw basket backing through the active multiplier", async () => {
    const result = await readScaledUiAmount({
      publicClient: scaledHarness(),
      token: TOKEN,
      rawAmount: BASE,
    })

    expect(result.uiAmount).toBe(2n * BASE)
    expect(result.amountFormatted).toBe("2")
  })

  it("fails closed for unsupported tokens and zero-result conversions", async () => {
    await expect(
      readScaledUiAmount({
        publicClient: scaledHarness({ supported: false }),
        token: TOKEN,
        rawAmount: BASE,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCALED_UI_TOKEN" })

    await expect(
      convertScaledUiInput({
        publicClient: scaledHarness({ decimals: 0, multiplier: 3n * BASE }),
        token: TOKEN,
        amount: "1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SCALED_UI_STATE" })
  })
})
