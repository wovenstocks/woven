import { describe, expect, it, vi } from "vitest"
import {
  discoverFactoryBaskets,
  getPortfolioBalances,
  listFactoryBasketAddresses,
  readFactoryBasket,
} from "./portfolio"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const CREATOR_A = "0x1111111111111111111111111111111111111112"
const CREATOR_B = "0x1111111111111111111111111111111111111113"
const FACTORY = "0x1000000000000000000000000000000000000006"
const BASKET_A = "0x3000000000000000000000000000000000000001"
const BASKET_B = "0x3000000000000000000000000000000000000002"
const TOKEN_A = "0x2000000000000000000000000000000000000001"
const TOKEN_B = "0x2000000000000000000000000000000000000002"
const addresses = { basketFactory: FACTORY }

function portfolioHarness(overrides = {}) {
  const state = {
    baskets: [BASKET_A, BASKET_B],
    creators: { [BASKET_A]: CREATOR_A, [BASKET_B]: CREATOR_B },
    balances: { [BASKET_A]: 2n * 10n ** 18n, [BASKET_B]: 0n },
    ...overrides,
  }
  const publicClient = {
    readContract: vi.fn(async ({ address, functionName, args = [] }) => {
      if (address === FACTORY) {
        if (functionName === "basketCount") return BigInt(state.baskets.length)
        if (functionName === "basketsPage") {
          const page = state.baskets.slice(Number(args[0]), Number(args[0] + args[1]))
          return state.pageResponse ? state.pageResponse(page, args) : page
        }
        if (functionName === "creatorOf") return state.creators[args[0]] ?? CREATOR_A
      }
      if (state.baskets.includes(address)) {
        if (state.failRead?.(address, functionName)) {
          throw new Error(`Reverting basket read ${address}:${functionName}`)
        }
        if (functionName === "name") {
          return state.names?.[address] ?? (address === BASKET_A ? "First Basket" : "Second Basket")
        }
        if (functionName === "symbol") return state.symbols?.[address] ?? "SAME"
        if (functionName === "decimals") return 18
        if (functionName === "balanceOf") return state.balances[address]
        if (functionName === "totalSupply") return 100n * 10n ** 18n
        if (functionName === "supplyCap") return 1000n * 10n ** 18n
        if (functionName === "mintFeeBps") return 30
        if (functionName === "mintPaused") return false
        if (functionName === "isFullyBacked") return true
        if (functionName === "constituents") return [TOKEN_A, TOKEN_B]
        if (functionName === "units") return [1n * 10n ** 18n, 2n * 10n ** 18n]
      }
      throw new Error(`Unexpected read ${address}:${functionName}`)
    }),
  }
  return { publicClient, addresses, account: ACCOUNT }
}

describe("factory discovery and portfolio", () => {
  it("uses only factory addresses and creator provenance, never duplicate symbols", async () => {
    const harness = portfolioHarness()
    const index = await listFactoryBasketAddresses(harness)
    expect(index.entries).toEqual([
      { address: BASKET_A, creator: CREATOR_A, index: 0 },
      { address: BASKET_B, creator: CREATOR_B, index: 1 },
    ])
    expect(index.failures).toEqual([])

    const discovery = await discoverFactoryBaskets(harness)
    expect(discovery.baskets.map((basket) => basket.address)).toEqual([BASKET_A, BASKET_B])
    expect(discovery.baskets.map((basket) => basket.symbol)).toEqual(["SAME", "SAME"])
    expect(discovery.baskets[0].constituents).toHaveLength(2)
    expect(discovery.failures).toEqual([])
  })

  it("returns exact bigint portfolio balances and filters zero balances by default", async () => {
    const harness = portfolioHarness()
    const portfolio = await getPortfolioBalances(harness)
    expect(portfolio.indexedBasketCount).toBe(2)
    expect(portfolio.positions).toEqual([
      expect.objectContaining({
        address: BASKET_A,
        creator: CREATOR_A,
        balance: 2n * 10n ** 18n,
        balanceFormatted: "2",
      }),
    ])
    expect(portfolio.failures).toEqual([])

    const all = await getPortfolioBalances({ ...harness, includeZeroBalances: true })
    expect(all.positions).toHaveLength(2)
  })

  it("reads one address with factory provenance and exact raw units", async () => {
    const basket = await readFactoryBasket({
      ...portfolioHarness(),
      basketAddress: BASKET_A,
    })
    expect(basket).toMatchObject({
      address: BASKET_A,
      creator: CREATOR_A,
      name: "First Basket",
      symbol: "SAME",
      mintFeeBps: 30,
      constituents: [
        { token: TOKEN_A, units: 1n * 10n ** 18n },
        { token: TOKEN_B, units: 2n * 10n ** 18n },
      ],
    })
  })

  it("reads more than 500 baskets in bounded pages", async () => {
    const baskets = Array.from(
      { length: 503 },
      (_, index) =>
        `0x${(0x3000000000000000000000000000000000000001n + BigInt(index))
          .toString(16)
          .padStart(40, "0")}`,
    )
    const harness = portfolioHarness({ baskets, creators: {} })
    const index = await listFactoryBasketAddresses(harness)

    expect(index.count).toBe(503)
    expect(index.scannedCount).toBe(503)
    expect(index.hasMore).toBe(false)
    expect(index.nextOffset).toBeNull()
    expect(index.validEntryCount).toBe(503)
    expect(index.entries).toHaveLength(503)
    expect(index.failures).toEqual([])
    expect(
      harness.publicClient.readContract.mock.calls.filter(
        ([request]) => request.functionName === "basketsPage",
      ),
    ).toHaveLength(6)
  })

  it("reads only the requested cursor slice from an index above 500", async () => {
    const baskets = Array.from(
      { length: 501 },
      (_, index) =>
        `0x${(0x3000000000000000000000000000000000000001n + BigInt(index))
          .toString(16)
          .padStart(40, "0")}`,
    )
    const harness = portfolioHarness({ baskets, creators: {} })
    const page = await listFactoryBasketAddresses({ ...harness, offset: 475, limit: 25 })

    expect(page.count).toBe(501)
    expect(page.offset).toBe(475)
    expect(page.scannedCount).toBe(25)
    expect(page.entries).toHaveLength(25)
    expect(page.entries[0].index).toBe(475)
    expect(page.entries[24].index).toBe(499)
    expect(page.hasMore).toBe(true)
    expect(page.nextOffset).toBe(500)
    expect(
      harness.publicClient.readContract.mock.calls.filter(
        ([request]) => request.functionName === "basketsPage",
      ),
    ).toEqual([
      [
        expect.objectContaining({
          functionName: "basketsPage",
          args: [475n, 25n],
        }),
      ],
    ])
  })

  it("propagates bounded cursors through discovery and portfolio reads", async () => {
    const harness = portfolioHarness()
    const discovery = await discoverFactoryBaskets({ ...harness, offset: 1, limit: 1 })
    expect(discovery.baskets.map((basket) => basket.address)).toEqual([BASKET_B])
    expect(discovery.scannedCount).toBe(1)
    expect(discovery.hasMore).toBe(false)
    expect(discovery.nextOffset).toBeNull()

    const portfolio = await getPortfolioBalances({
      ...harness,
      offset: 0,
      limit: 1,
      includeZeroBalances: true,
    })
    expect(portfolio.positions.map((position) => position.address)).toEqual([BASKET_A])
    expect(portfolio.scannedCount).toBe(1)
    expect(portfolio.hasMore).toBe(true)
    expect(portfolio.nextOffset).toBe(1)
  })

  it("fails closed on malformed pages, duplicates, excessive explicit indexes, and page sizes", async () => {
    const mismatch = portfolioHarness({ pageResponse: () => [BASKET_A] })
    await expect(listFactoryBasketAddresses(mismatch)).rejects.toMatchObject({
      code: "INVALID_FACTORY_INDEX",
    })

    const duplicate = portfolioHarness({ baskets: [BASKET_A, BASKET_A] })
    await expect(listFactoryBasketAddresses(duplicate)).rejects.toMatchObject({
      code: "INVALID_FACTORY_INDEX",
    })

    await expect(
      listFactoryBasketAddresses({ ...portfolioHarness(), maxBaskets: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_FACTORY_INDEX" })

    await expect(
      listFactoryBasketAddresses({ ...portfolioHarness(), pageSize: 101 }),
    ).rejects.toMatchObject({ code: "INVALID_FACTORY_INDEX" })

    await expect(
      listFactoryBasketAddresses({ ...portfolioHarness(), offset: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_FACTORY_INDEX" })

    await expect(
      listFactoryBasketAddresses({ ...portfolioHarness(), limit: 101 }),
    ).rejects.toMatchObject({ code: "INVALID_FACTORY_INDEX" })
  })

  it("keeps valid entries when one basket has no verifiable creator provenance", async () => {
    const noCreator = portfolioHarness({
      creators: {
        [BASKET_A]: "0x0000000000000000000000000000000000000000",
        [BASKET_B]: CREATOR_B,
      },
    })
    const index = await listFactoryBasketAddresses(noCreator)
    expect(index.entries).toEqual([{ address: BASKET_B, creator: CREATOR_B, index: 1 }])
    expect(index.failures).toEqual([
      expect.objectContaining({
        stage: "provenance",
        index: 0,
        address: BASKET_A,
        code: "ZERO_ADDRESS",
      }),
    ])
  })

  it("isolates reverting metadata and balance reads to the poisoned basket", async () => {
    const metadataFailure = await discoverFactoryBaskets(
      portfolioHarness({
        failRead: (address, functionName) => address === BASKET_B && functionName === "name",
      }),
    )
    expect(metadataFailure.baskets.map((basket) => basket.address)).toEqual([BASKET_A])
    expect(metadataFailure.failures).toEqual([
      expect.objectContaining({ stage: "metadata", address: BASKET_B }),
    ])

    const balanceFailure = await getPortfolioBalances({
      ...portfolioHarness({
        failRead: (address, functionName) => address === BASKET_B && functionName === "balanceOf",
      }),
      includeZeroBalances: true,
    })
    expect(balanceFailure.positions.map((position) => position.address)).toEqual([BASKET_A])
    expect(balanceFailure.failures).toEqual([
      expect.objectContaining({ stage: "balance", address: BASKET_B }),
    ])
  })

  it("rejects unsafe onchain display metadata and isolates it during aggregate reads", async () => {
    const harness = portfolioHarness({ names: { [BASKET_B]: "Spoof\u202eName" } })

    await expect(readFactoryBasket({ ...harness, basketAddress: BASKET_B })).rejects.toMatchObject({
      code: "INVALID_TEXT",
    })

    const discovery = await discoverFactoryBaskets(harness)
    expect(discovery.baskets.map((basket) => basket.address)).toEqual([BASKET_A])
    expect(discovery.failures).toEqual([
      expect.objectContaining({ stage: "metadata", address: BASKET_B, code: "INVALID_TEXT" }),
    ])

    const portfolio = await getPortfolioBalances({ ...harness, includeZeroBalances: true })
    expect(portfolio.positions.map((position) => position.address)).toEqual([BASKET_A])
    expect(portfolio.failures).toEqual([
      expect.objectContaining({ stage: "balance", address: BASKET_B, code: "INVALID_TEXT" }),
    ])
  })

  it("does not hide metadata when a constituent breaks the optional backing check", async () => {
    const discovery = await discoverFactoryBaskets(
      portfolioHarness({
        failRead: (address, functionName) =>
          address === BASKET_B && functionName === "isFullyBacked",
      }),
    )
    expect(discovery.baskets.map((basket) => basket.address)).toEqual([BASKET_A, BASKET_B])
    expect(discovery.baskets[1].isFullyBacked).toBeNull()
    expect(discovery.failures).toEqual([
      expect.objectContaining({ stage: "backing-status", address: BASKET_B }),
    ])
  })
})
