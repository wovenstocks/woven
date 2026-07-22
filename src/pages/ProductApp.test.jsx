// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Brand } from "../components/Brand"
import { CreatorStudio } from "../features/studio/CreatorStudio"
import { isPositiveDecimal } from "../features/shared"
import {
  createDynamicBasketView,
  getConfiguredBasketRecipe,
  getMintQuote,
  isTradeReviewCurrent,
} from "../data/baskets"
import { PENDING_TRANSACTION_STORAGE_KEY, PENDING_TRANSACTION_VERSION } from "../protocol"
import {
  BasketComposition,
  BasketFeeDistribution,
  ProductApp,
  TradeReview,
  UsdcBuyReview,
} from "./ProductApp"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const BASKET = "0x2222222222222222222222222222222222222222"
const TOKEN_A = "0x3333333333333333333333333333333333333333"
const TOKEN_B = "0x4444444444444444444444444444444444444444"
const PENDING_HASH = `0x${"ab".repeat(32)}`
const REPLACEMENT_HASH = `0x${"cd".repeat(32)}`

function installProvider() {
  const provider = {
    request: vi.fn(async ({ method }) => {
      if (method === "eth_accounts") return []
      if (method === "eth_chainId") return "0x38"
      if (method === "eth_requestAccounts") {
        return [ACCOUNT]
      }
      return null
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  Object.defineProperty(window, "ethereum", {
    configurable: true,
    value: provider,
  })
  return provider
}

function installMultipleProviders() {
  const createProvider = (flags = {}) => ({
    ...flags,
    request: vi.fn(async ({ method }) => {
      if (method === "eth_accounts") return []
      if (method === "eth_chainId") return "0x38"
      if (method === "eth_requestAccounts") return [ACCOUNT]
      return null
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  })
  const providers = [
    createProvider({ isMetaMask: true }),
    createProvider({ isCoinbaseWallet: true }),
  ]
  Object.defineProperty(window, "ethereum", {
    configurable: true,
    value: { providers },
  })
  return providers
}

beforeEach(() => {
  window.localStorage.clear()
  window.location.hash = ""
})

afterEach(() => {
  cleanup()
  delete window.ethereum
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe("ProductApp", () => {
  it("requires an explicit permanent-removal review before creator activation", async () => {
    const provider = installProvider()
    render(<ProductApp initialView="studio" onNavigate={vi.fn()} />)

    await waitFor(() => expect(provider.request).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "Activate access" }))

    expect(screen.getByRole("dialog", { name: "Activate creator access?" })).toBeTruthy()
    expect(screen.getByText("0x000000000000000000000000000000000000dEaD")).toBeTruthy()
    expect(screen.getByText(/non-refundable/i)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("dialog", { name: "Activate creator access?" })).toBeNull()
    expect(
      provider.request.mock.calls.some(([request]) => request.method === "eth_requestAccounts"),
    ).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: "Activate access" }))
    fireEvent.click(screen.getByRole("button", { name: "Confirm permanent removal" }))
    expect(await screen.findByRole("dialog", { name: "Action unavailable" })).toBeTruthy()
    expect(
      provider.request.mock.calls.some(([request]) => request.method === "eth_requestAccounts"),
    ).toBe(false)
  })

  it("lets the user choose among multiple injected wallets before connecting", async () => {
    const [metaMask, coinbase] = installMultipleProviders()
    render(<ProductApp initialView="portfolio" onNavigate={vi.fn()} />)

    let connect
    await waitFor(() => {
      connect = screen
        .getAllByRole("button", { name: "Connect wallet" })
        .find((button) => button.getAttribute("aria-haspopup") === "dialog")
      expect(connect).toBeTruthy()
    })
    fireEvent.click(connect)

    expect(screen.getByRole("dialog", { name: "Choose wallet" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Connect Coinbase Wallet" }))

    await waitFor(() =>
      expect(coinbase.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" }),
    )
    expect(metaMask.request).not.toHaveBeenCalledWith({ method: "eth_requestAccounts" })
    expect(screen.queryByRole("dialog", { name: "Choose wallet" })).toBeNull()
  })

  it("fails closed before requesting a wallet when basket contracts are absent", async () => {
    const provider = installProvider()
    render(<ProductApp initialView="basket" basketId="tech5" onNavigate={vi.fn()} />)

    await waitFor(() => expect(provider.request).toHaveBeenCalled())
    const requestsBeforeAction = provider.request.mock.calls.length

    expect(screen.queryByRole("button", { name: "Buy" })).toBeNull()
    expect(screen.getByRole("button", { name: "Mint" }).getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(screen.getByRole("button", { name: "Review mint" }))

    expect(await screen.findByRole("dialog", { name: "Action unavailable" })).toBeTruthy()
    expect(screen.getByText(/no wallet request or transaction was sent/i)).toBeTruthy()
    expect(provider.request).toHaveBeenCalledTimes(requestsBeforeAction)
  })

  it("blocks resubmission until a stored transaction reaches two confirmations", async () => {
    let latestBlock = 10n
    window.localStorage.setItem(
      PENDING_TRANSACTION_STORAGE_KEY,
      JSON.stringify({
        version: PENDING_TRANSACTION_VERSION,
        chainId: 56,
        account: ACCOUNT,
        action: "mint",
        basket: BASKET,
        hash: PENDING_HASH,
      }),
    )
    const publicClient = {
      chain: { id: 56 },
      getTransactionReceipt: vi.fn(async () => ({
        status: "success",
        transactionHash: PENDING_HASH,
        blockNumber: 10n,
      })),
      getBlockNumber: vi.fn(async () => latestBlock),
    }

    render(
      <ProductApp
        initialView="studio"
        onNavigate={vi.fn()}
        createPublicClient={vi.fn(async () => publicClient)}
      />,
    )

    expect(
      await screen.findByRole("dialog", {
        name: "Transaction submitted — confirmation pending",
      }),
    ).toBeTruthy()
    expect(screen.getByText(/do not submit this action again/i)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    latestBlock = 11n
    fireEvent.click(screen.getByRole("button", { name: "Review basket" }))
    fireEvent.click(screen.getByRole("button", { name: "Publish basket" }))
    expect(
      await screen.findByRole("dialog", { name: "Previous transaction confirmed" }),
    ).toBeTruthy()
    expect(screen.getByText(/no new wallet request was sent/i)).toBeTruthy()
    expect(window.localStorage.getItem(PENDING_TRANSACTION_STORAGE_KEY)).toBeNull()
  })

  it("distinguishes a confirmed wallet cancellation from a reverted protocol action", async () => {
    window.localStorage.setItem(
      PENDING_TRANSACTION_STORAGE_KEY,
      JSON.stringify({
        version: PENDING_TRANSACTION_VERSION,
        chainId: 56,
        account: ACCOUNT,
        action: "mint",
        basket: BASKET,
        hash: PENDING_HASH,
      }),
    )
    const receipt = {
      status: "success",
      transactionHash: REPLACEMENT_HASH,
      blockNumber: 10n,
    }
    const publicClient = {
      chain: { id: 56 },
      waitForTransactionReceipt: vi.fn(async ({ onReplaced }) => {
        onReplaced({
          reason: "cancelled",
          transaction: { hash: REPLACEMENT_HASH },
          transactionReceipt: receipt,
        })
        return receipt
      }),
    }

    render(
      <ProductApp
        initialView="studio"
        onNavigate={vi.fn()}
        createPublicClient={vi.fn(async () => publicClient)}
      />,
    )

    expect(
      await screen.findByRole("dialog", { name: "Previous transaction cancelled" }),
    ).toBeTruthy()
    expect(screen.getByText(/original Woven action was not executed/i)).toBeTruthy()
    expect(window.localStorage.getItem(PENDING_TRANSACTION_STORAGE_KEY)).toBeNull()
  })

  it("blocks writes when saved transaction state is corrupt", async () => {
    window.localStorage.setItem(PENDING_TRANSACTION_STORAGE_KEY, "{broken")
    render(<ProductApp initialView="studio" onNavigate={vi.fn()} />)

    expect(
      await screen.findByRole("dialog", { name: "Transaction safety check unavailable" }),
    ).toBeTruthy()
    expect(screen.getByText(/no wallet request was sent/i)).toBeTruthy()
  })

  it("defaults a route-covered basket to buying and exposes every action", () => {
    render(<ProductApp initialView="basket" basketId="core4" onNavigate={vi.fn()} />)

    expect(screen.getByRole("group", { name: "Basket action" })).toBeTruthy()
    expect(screen.getByRole("list", { name: "4 basket assets" })).toBeTruthy()
    const buy = screen.getByRole("button", { name: "Buy" })
    const mint = screen.getByRole("button", { name: "Mint" })
    const redeem = screen.getByRole("button", { name: "Redeem" })
    expect(buy.getAttribute("aria-pressed")).toBe("true")
    expect(mint.getAttribute("aria-pressed")).toBe("false")
    expect(redeem.getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(mint)
    expect(buy.getAttribute("aria-pressed")).toBe("false")
    expect(mint.getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(redeem)
    expect(mint.getAttribute("aria-pressed")).toBe("false")
    expect(redeem.getAttribute("aria-pressed")).toBe("true")
  })

  it("does not substitute another financial product for an unknown basket", () => {
    render(<ProductApp initialView="basket" basketId="does-not-exist" onNavigate={vi.fn()} />)

    expect(screen.getByRole("heading", { name: "Basket not found" })).toBeTruthy()
    expect(screen.queryByText("Technology Leaders Five")).toBeNull()
  })

  it("keeps builder execution fail-closed while preserving editable fixed units", async () => {
    const provider = installProvider()
    render(<ProductApp initialView="studio" onNavigate={vi.fn()} />)

    await waitFor(() => expect(provider.request).toHaveBeenCalled())
    const requestsBeforeAction = provider.request.mock.calls.length

    const units = screen.getByRole("spinbutton", { name: "NVDA units per basket token" })
    fireEvent.change(units, { target: { value: "2.5" } })
    expect(units.value).toBe("2.5")

    fireEvent.click(screen.getByRole("button", { name: "Review basket" }))
    expect(screen.getByRole("dialog", { name: "Publish this basket?" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Publish basket" }))
    expect(await screen.findByRole("dialog", { name: "Action unavailable" })).toBeTruthy()
    expect(provider.request).toHaveBeenCalledTimes(requestsBeforeAction)
  })

  it("reviews exact basket settings before publishing", () => {
    const onAction = vi.fn()
    render(
      <CreatorStudio
        onAction={onAction}
        busyAction={null}
        wallet={{ account: "", isBnbChain: false }}
        getPublicClient={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole("spinbutton", { name: "NVDA units per basket token" }), {
      target: { value: "2.5" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Review basket" }))

    const review = screen.getByRole("dialog", { name: "Publish this basket?" })
    expect(onAction).not.toHaveBeenCalled()
    expect(within(review).getByText("Woven Tech Basket · $WTECH")).toBeTruthy()
    expect(within(review).getByText("0.30%")).toBeTruthy()
    expect(within(review).getByText("1,000 tokens")).toBeTruthy()
    expect(within(review).getByRole("list", { name: "Basket units" })).toBeTruthy()
    expect(within(review).getByText("2.5 per token")).toBeTruthy()
    expect(within(review).getAllByText("1 per token")).toHaveLength(2)

    fireEvent.click(within(review).getByRole("button", { name: "Go back" }))
    expect(screen.queryByRole("dialog", { name: "Publish this basket?" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Review basket" }))
    fireEvent.click(screen.getByRole("button", { name: "Publish basket" }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({
      type: "create",
      selected: ["NVDAB", "MSFTB", "METAB"],
      name: "Woven Tech Basket",
      symbol: "WTECH",
      units: expect.objectContaining({ NVDAB: "2.5", MSFTB: "1", METAB: "1" }),
    })
  })

  it("rejects exponent and non-canonical basket unit formats", () => {
    for (const value of ["1e3", "1e-3", "0", "+1", "-1", " 1", "1 ", "01"]) {
      expect(isPositiveDecimal(value)).toBe(false)
    }
    for (const value of ["1", "0.000001", "12.5"]) expect(isPositiveDecimal(value)).toBe(true)

    render(
      <CreatorStudio
        onAction={vi.fn()}
        busyAction={null}
        wallet={{ account: "", isBnbChain: false }}
        getPublicClient={vi.fn()}
      />,
    )
    const units = screen.getByRole("spinbutton", { name: "NVDA units per basket token" })
    fireEvent.change(units, { target: { value: "1e3" } })
    expect(units.getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByText("Enter a value above 0")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Review basket" }).disabled).toBe(true)
  })

  it("uses the complete Woven Stocks name outside compact marks", () => {
    const { rerender } = render(<Brand />)
    expect(screen.getByText("Woven Stocks")).toBeTruthy()
    rerender(<Brand compact />)
    expect(screen.getByText("Woven")).toBeTruthy()
    expect(screen.queryByText("Woven Stocks")).toBeNull()
  })

  it("moves focus to the rendered route", async () => {
    render(<ProductApp initialView="portfolio" onNavigate={vi.fn()} />)

    await waitFor(() => {
      expect(document.activeElement?.tagName).toBe("MAIN")
    })
  })

  it("preserves exact raw units for a factory-created basket", () => {
    const catalog = [
      { symbol: "AAA", ticker: "AAA", name: "Asset A", address: TOKEN_A, tone: "green" },
      { symbol: "BBB", ticker: "BBB", name: "Asset B", address: TOKEN_B, tone: "blue" },
    ]
    const rawA = 2_500_000_000_000_000_001n
    const rawB = 7n
    const basket = createDynamicBasketView(
      {
        address: BASKET,
        name: "Verified Basket",
        symbol: "VBASKET",
        mintFeeBps: 30,
        constituents: [
          { token: TOKEN_A, units: rawA },
          { token: TOKEN_B, units: rawB },
        ],
      },
      catalog,
    )
    const recipe = getConfiguredBasketRecipe(basket, catalog)

    expect(recipe.constituents[0].unitsRaw).toBe(rawA)
    expect(recipe.constituents[1].unitsRaw).toBe(rawB)
    expect(() =>
      createDynamicBasketView(
        {
          address: BASKET,
          name: "Unknown Asset Basket",
          symbol: "UNKNOWN",
          mintFeeBps: 30,
          constituents: [
            { token: TOKEN_A, units: rawA },
            { token: ACCOUNT, units: rawB },
          ],
        },
        catalog,
      ),
    ).toThrow(/approved bStock catalog/i)
    expect(() =>
      createDynamicBasketView(
        {
          address: BASKET,
          name: "Spoof\u202eName",
          symbol: "VBASKET",
          mintFeeBps: 30,
          constituents: [
            { token: TOKEN_A, units: rawA },
            { token: TOKEN_B, units: rawB },
          ],
        },
        catalog,
      ),
    ).toThrow(/unsafe basket name/i)
  })

  it("computes the exact net mint amount with contract rounding", () => {
    const quote = getMintQuote({
      basketAmount: 1_000_000_000_000_000_001n,
      decimals: 18,
      mintFeeBps: 30,
    })

    expect(quote.feeAmount).toBe(3_000_000_000_000_000n)
    expect(quote.netAmount).toBe(997_000_000_000_000_001n)
    expect(quote.netFormatted).toBe("0.997000000000000001")
  })

  it("renders exact nominal backing in the redemption review", () => {
    render(
      <TradeReview
        mode="redeem"
        basket={{ symbol: "VBASKET" }}
        readiness={{
          basketAmountFormatted: "1",
          canRedeem: true,
          blockers: [],
          backing: [
            { token: TOKEN_A, symbol: "AAA", amountFormatted: "2.500000000000000001" },
            { token: TOKEN_B, symbol: "BBB", amountFormatted: "7" },
          ],
        }}
        submitting={false}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText("Required 2.500000000000000001")).toBeTruthy()
    expect(screen.getByText("Required 7")).toBeTruthy()
    expect(screen.getByRole("list", { name: "Required constituent amounts" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /confirm redemption/i })).toBeTruthy()
  })

  it("renders a bounded atomic USDC purchase and permits its required approval", () => {
    const onConfirm = vi.fn()
    render(
      <UsdcBuyReview
        basket={{ symbol: "VBASKET", assets: ["NVDAB", "MSFTB"] }}
        readiness={{
          fingerprint: `0x${"ab".repeat(32)}`,
          reviewExpiresAtMs: Date.now() + 45_000,
          expectedTotalUsdcIn: 48_000_000n,
          maxTotalUsdcIn: 50_000_000n,
          usdcDecimals: 6,
          usdcSymbol: "USDC",
          netBasketOutFormatted: "0.997",
          feeAmountFormatted: "0.003",
          mintFeeBps: 30,
          blockers: ["APPROVAL_REQUIRED"],
          legs: [
            {
              expectedToken: TOKEN_A,
              routeId: `0x${"01".repeat(32)}`,
              expectedUsdcIn: 19_000_000n,
              maxUsdcIn: 20_000_000n,
            },
            {
              expectedToken: TOKEN_B,
              routeId: `0x${"02".repeat(32)}`,
              expectedUsdcIn: 29_000_000n,
              maxUsdcIn: 30_000_000n,
            },
          ],
        }}
        submitting={false}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByText("48 USDC")).toBeTruthy()
    expect(screen.getByText("50 USDC")).toBeTruthy()
    expect(screen.getByText("0.997 VBASKET")).toBeTruthy()
    expect(screen.getByRole("list", { name: "Atomic bStock purchase routes" })).toBeTruthy()
    expect(screen.getByText("USDC → NVDAB")).toBeTruthy()
    expect(screen.getByText("USDC → MSFTB")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Approve USDC & buy" }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it("disables an expired USDC quote before opening the wallet", () => {
    render(
      <UsdcBuyReview
        basket={{ symbol: "VBASKET", assets: ["NVDAB"] }}
        readiness={{
          fingerprint: `0x${"cd".repeat(32)}`,
          reviewExpiresAtMs: Date.now() - 1_000,
          expectedTotalUsdcIn: 10_000_000n,
          maxTotalUsdcIn: 11_000_000n,
          usdcDecimals: 6,
          usdcSymbol: "USDC",
          netBasketOutFormatted: "0.997",
          feeAmountFormatted: "0.003",
          mintFeeBps: 30,
          blockers: [],
          legs: [
            {
              expectedToken: TOKEN_A,
              routeId: `0x${"03".repeat(32)}`,
              expectedUsdcIn: 10_000_000n,
              maxUsdcIn: 11_000_000n,
            },
          ],
        }}
        submitting={false}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText(/price bound expired/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Quote expired" }).disabled).toBe(true)
  })

  it("expires a trade review when any execution identity changes", () => {
    const review = {
      reviewType: "mint",
      requestedAmount: "1.00",
      reviewChainId: 56,
      reviewProviderId: "wallet-a",
      account: ACCOUNT,
      basketAddress: BASKET,
    }
    const context = {
      type: "mint",
      amount: "1.00",
      chainId: 56,
      providerId: "wallet-a",
      account: ACCOUNT,
      basketAddress: BASKET,
    }

    expect(isTradeReviewCurrent(review, context)).toBe(true)
    expect(isTradeReviewCurrent(review, { ...context, account: TOKEN_A })).toBe(false)
    expect(isTradeReviewCurrent(review, { ...context, amount: "1.01" })).toBe(false)
    expect(isTradeReviewCurrent(review, { ...context, providerId: "wallet-b" })).toBe(false)
    expect(isTradeReviewCurrent(review, { ...context, chainId: 1 })).toBe(false)
  })

  it("binds a USDC buy review to its basket address alias", () => {
    const buyReview = {
      reviewType: "buy",
      requestedAmount: "1",
      reviewChainId: 56,
      reviewProviderId: "wallet-a",
      account: ACCOUNT,
      basket: BASKET,
      basketAddress: BASKET,
    }

    expect(
      isTradeReviewCurrent(buyReview, {
        type: "buy",
        amount: "1",
        chainId: 56,
        providerId: "wallet-a",
        account: ACCOUNT,
        basketAddress: BASKET,
      }),
    ).toBe(true)
  })

  it("reads and renders exact constituent units without a connected wallet", async () => {
    const basket = {
      address: BASKET,
      symbol: "VBASKET",
      assets: ["NVDAB", "MSFTB"],
    }
    const recipe = {
      constituents: [
        { token: TOKEN_A, symbol: "NVDAB", unitsRaw: 1_250_000_000_000_000_001n },
        { token: TOKEN_B, symbol: "MSFTB", unitsRaw: 250_000_000n },
      ],
    }
    const publicClient = { chain: { id: 56 } }
    const getPublicClient = vi.fn(async () => publicClient)
    const getRequirements = vi.fn(async () => ({
      constituents: [
        {
          token: TOKEN_A,
          symbol: "NVDAB",
          decimals: 18,
          amount: 1_250_000_000_000_000_001n,
          amountFormatted: "1.250000000000000001",
        },
        {
          token: TOKEN_B,
          symbol: "MSFTB",
          decimals: 8,
          amount: 250_000_000n,
          amountFormatted: "2.5",
        },
      ],
    }))

    render(
      <BasketComposition
        basket={basket}
        enabled
        recipe={recipe}
        getPublicClient={getPublicClient}
        getRequirements={getRequirements}
      />,
    )

    expect(await screen.findByText("1.250000000000000001 NVDAB")).toBeTruthy()
    expect(screen.getByText("2.5 MSFTB")).toBeTruthy()
    expect(screen.getByText("NVDA · current units per basket token")).toBeTruthy()
    expect(screen.getByText("MSFT · current units per basket token")).toBeTruthy()
    expect(getRequirements).toHaveBeenCalledWith({
      publicClient,
      basketAddress: BASKET,
      amount: "1",
    })
  })

  it("rejects a basket whose onchain asset order differs from its recipe", async () => {
    const recipe = {
      constituents: [
        { token: TOKEN_A, symbol: "NVDAB", unitsRaw: 1n },
        { token: TOKEN_B, symbol: "MSFTB", unitsRaw: 2n },
      ],
    }
    render(
      <BasketComposition
        basket={{ address: BASKET, symbol: "VBASKET", assets: ["NVDAB", "MSFTB"] }}
        enabled
        recipe={recipe}
        getPublicClient={vi.fn(async () => ({}))}
        getRequirements={vi.fn(async () => ({
          constituents: [
            { token: TOKEN_B, amount: 2n, amountFormatted: "2", symbol: "MSFTB" },
            { token: TOKEN_A, amount: 1n, amountFormatted: "1", symbol: "NVDAB" },
          ],
        }))}
      />,
    )

    expect((await screen.findByRole("alert")).textContent).toContain(
      "does not match its approved asset definition",
    )
    expect(screen.getAllByText("Unavailable")).toHaveLength(2)
  })

  it("rejects a basket whose onchain raw units differ from its recipe", async () => {
    const recipe = {
      constituents: [
        { token: TOKEN_A, symbol: "NVDAB", unitsRaw: 1n },
        { token: TOKEN_B, symbol: "MSFTB", unitsRaw: 2n },
      ],
    }
    render(
      <BasketComposition
        basket={{ address: BASKET, symbol: "VBASKET", assets: ["NVDAB", "MSFTB"] }}
        enabled
        recipe={recipe}
        getPublicClient={vi.fn(async () => ({}))}
        getRequirements={vi.fn(async () => ({
          constituents: [
            { token: TOKEN_A, amount: 1n, amountFormatted: "1", symbol: "NVDAB" },
            { token: TOKEN_B, amount: 3n, amountFormatted: "3", symbol: "MSFTB" },
          ],
        }))}
      />,
    )

    expect((await screen.findByRole("alert")).textContent).toContain(
      "does not match its approved asset definition",
    )
    expect(screen.getAllByText("Unavailable")).toHaveLength(2)
  })

  it("uses only known human-readable recipe units when the route is unavailable", () => {
    const getPublicClient = vi.fn()
    const getRequirements = vi.fn()

    render(
      <BasketComposition
        basket={{
          address: "",
          symbol: "TECH5",
          assets: ["NVDAB"],
          units: { NVDAB: "1.25" },
        }}
        enabled={false}
        recipe={null}
        getPublicClient={getPublicClient}
        getRequirements={getRequirements}
      />,
    )

    expect(screen.getByText("1.25 NVDAB")).toBeTruthy()
    expect(screen.getByText("NVDA · published units per basket token")).toBeTruthy()
    expect(getPublicClient).not.toHaveBeenCalled()
    expect(getRequirements).not.toHaveBeenCalled()
  })

  it("does not format raw dynamic units without verified token precision", () => {
    render(
      <BasketComposition
        basket={{
          address: BASKET,
          symbol: "VBASKET",
          assets: ["NVDAB"],
          unitsRaw: { NVDAB: 1_000_000n },
        }}
        enabled={false}
        recipe={null}
        getPublicClient={vi.fn()}
        getRequirements={vi.fn()}
      />,
    )

    expect(screen.getByText("—")).toBeTruthy()
    expect(screen.getByText("NVDA")).toBeTruthy()
    expect(screen.queryByText(/verified onchain/i)).toBeNull()
  })

  it("shows pending fee shares and refreshes them after a permissionless distribution", async () => {
    const basket = { address: BASKET, symbol: "VBASKET" }
    const publicClient = { chain: { id: 56 } }
    const getPublicClient = vi.fn(async () => publicClient)
    const getStatus = vi.fn(async () => ({
      pendingBalance: 10n * 10n ** 18n,
      creatorAmount: 6n * 10n ** 18n,
      treasuryAmount: 4n * 10n ** 18n,
      canDistribute: true,
    }))
    const onAction = vi.fn(async () => ({ transaction: { hash: "0xabc" } }))

    render(
      <BasketFeeDistribution
        basket={basket}
        enabled
        getPublicClient={getPublicClient}
        getStatus={getStatus}
        onAction={onAction}
        busyAction={null}
      />,
    )

    expect(await screen.findByText("10 VBASKET")).toBeTruthy()
    expect(screen.getByText("6 VBASKET")).toBeTruthy()
    expect(screen.getByText("4 VBASKET")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }))
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole("button", { name: "Distribute fees" }))
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: "fees", basket }))
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(3))
  })

  it("keeps fee distribution disabled when the splitter has no pending balance", async () => {
    render(
      <BasketFeeDistribution
        basket={{ address: BASKET, symbol: "VBASKET" }}
        enabled
        getPublicClient={vi.fn(async () => ({}))}
        getStatus={vi.fn(async () => ({
          pendingBalance: 0n,
          creatorAmount: 0n,
          treasuryAmount: 0n,
          canDistribute: false,
        }))}
        onAction={vi.fn()}
        busyAction={null}
      />,
    )

    const button = await screen.findByRole("button", { name: "No fees pending" })
    expect(button.disabled).toBe(true)
  })
})
