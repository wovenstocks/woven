import { encodeAbiParameters, encodeEventTopics } from "viem"
import { describe, expect, it, vi } from "vitest"
import { basketFactoryAbi } from "./abis"
import { createBasket, prepareBasketCreation } from "./factory"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const TOKEN_A = "0x2000000000000000000000000000000000000001"
const TOKEN_B = "0x2000000000000000000000000000000000000002"
const BASKET = "0x3000000000000000000000000000000000000001"
const OTHER = "0x9999999999999999999999999999999999999999"
const HASH = `0x${"12".repeat(32)}`
const ONE = 10n ** 18n
const STARTER_CAP = 1000n * ONE
const CEILING = 1_000_000n * ONE
const UNITS_A = 1_250_000n
const UNITS_B = 500_000_000_000_000_000n
const addresses = Object.freeze({
  wovenToken: "0x1000000000000000000000000000000000000001",
  creatorLicense: "0x1000000000000000000000000000000000000002",
  assetRegistry: "0x1000000000000000000000000000000000000003",
  feeSplitter: "0x1000000000000000000000000000000000000004",
  curatorGuardian: "0x1000000000000000000000000000000000000005",
  basketFactory: "0x1000000000000000000000000000000000000006",
})

const input = Object.freeze({
  name: "Global Leaders",
  symbol: "glb2",
  constituents: [
    { token: TOKEN_A, units: "1.25" },
    { token: TOKEN_B, units: "0.5" },
  ],
  mintFeeBps: "30",
  initialSupplyCap: "1000",
})

function createdLog(overrides = {}) {
  return {
    address: addresses.basketFactory,
    topics: encodeEventTopics({
      abi: basketFactoryAbi,
      eventName: "BasketCreated",
      args: { basket: BASKET, creator: ACCOUNT },
    }),
    data: encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "uint256" }],
      [
        overrides.name ?? "Global Leaders",
        overrides.symbol ?? "GLB2",
        overrides.initialSupplyCap ?? STARTER_CAP,
      ],
    ),
  }
}

function factoryHarness(overrides = {}) {
  const stateOverrides = overrides.state || {}
  const state = {
    licensed: true,
    supported: { [TOKEN_A]: true, [TOKEN_B]: true },
    decimals: { [TOKEN_A]: 6, [TOKEN_B]: 18 },
    multipliers: { [TOKEN_A]: ONE, [TOKEN_B]: ONE },
    ...stateOverrides,
    created: {
      bytecode: "0x6000",
      factoryCreator: ACCOUNT,
      splitterCreator: ACCOUNT,
      name: "Global Leaders",
      symbol: "GLB2",
      decimals: 18,
      tokens: [TOKEN_A, TOKEN_B],
      unitsPerBasket: [UNITS_A, UNITS_B],
      mintFeeBps: 30,
      supplyCap: STARTER_CAP,
      maxSupplyCap: CEILING,
      guardian: addresses.curatorGuardian,
      feeRecipient: addresses.feeSplitter,
      event: {},
      ...stateOverrides.created,
    },
  }
  const publicClient = {
    getBytecode: vi.fn(async ({ address }) =>
      address === BASKET ? state.created.bytecode : "0x6000",
    ),
    readContract: vi.fn(async ({ address, functionName, args = [] }) => {
      if (address === addresses.basketFactory) {
        if (functionName === "creatorLicense") return addresses.creatorLicense
        if (functionName === "assetRegistry") return addresses.assetRegistry
        if (functionName === "splitter") return addresses.feeSplitter
        if (functionName === "basketGuardian") return addresses.curatorGuardian
        if (functionName === "STARTER_CAP") return STARTER_CAP
        if (functionName === "CEILING") return CEILING
        if (functionName === "creatorOf") return state.created.factoryCreator
      }
      if (address === addresses.creatorLicense && functionName === "isLicensed") {
        return state.licensed
      }
      if (address === addresses.feeSplitter) {
        if (functionName === "factory") return addresses.basketFactory
        if (functionName === "creatorOf") return state.created.splitterCreator
      }
      if (address === addresses.assetRegistry && functionName === "isSupported") {
        return state.supported[args[0]] ?? false
      }
      if (address === BASKET) {
        if (functionName === "name") return state.created.name
        if (functionName === "symbol") return state.created.symbol
        if (functionName === "decimals") return state.created.decimals
        if (functionName === "constituents") return state.created.tokens
        if (functionName === "units") return state.created.unitsPerBasket
        if (functionName === "mintFeeBps") return state.created.mintFeeBps
        if (functionName === "supplyCap") return state.created.supplyCap
        if (functionName === "maxSupplyCap") return state.created.maxSupplyCap
        if (functionName === "guardian") return state.created.guardian
        if (functionName === "feeRecipient") return state.created.feeRecipient
      }
      if (functionName === "decimals") return state.decimals[address]
      if (functionName === "supportsInterface") return true
      if (functionName === "uiMultiplier") return state.multipliers[address]
      if (functionName === "newUIMultiplier") return state.multipliers[address]
      if (functionName === "effectiveAt") return 0n
      if (functionName === "fromUIAmount") return (args[0] * ONE) / state.multipliers[address]
      if (functionName === "toUIAmount") return (args[0] * state.multipliers[address]) / ONE
      throw new Error(`Unexpected read ${address}:${functionName}`)
    }),
    simulateContract: vi.fn(async (request) => ({ request })),
    waitForTransactionReceipt: vi.fn(async () => ({
      status: "success",
      transactionHash: HASH,
      blockNumber: 1n,
      logs: [createdLog(state.created.event)],
    })),
    ...overrides.publicClient,
  }
  const walletClient = {
    account: { address: ACCOUNT },
    getAddresses: vi.fn(async () => [ACCOUNT]),
    getChainId: vi.fn(async () => 56),
    writeContract: vi.fn(async () => HASH),
  }
  return { publicClient, walletClient, account: ACCOUNT, addresses, ...input }
}

describe("basket factory client", () => {
  it("parses every fixed amount with its token decimals and the cap with 18 decimals", async () => {
    const prepared = await prepareBasketCreation(factoryHarness())
    expect(prepared).toMatchObject({
      name: "Global Leaders",
      symbol: "GLB2",
      mintFeeBps: 30,
      initialSupplyCap: STARTER_CAP,
      unitsPerBasket: [UNITS_A, UNITS_B],
      ceiling: CEILING,
    })
    expect(prepared.constituents.map((item) => item.decimals)).toEqual([6, 18])
  })

  it("converts displayed Studio amounts through each constituent multiplier", async () => {
    const prepared = await prepareBasketCreation(
      factoryHarness({
        state: { multipliers: { [TOKEN_A]: 2n * ONE, [TOKEN_B]: ONE } },
      }),
    )

    expect(prepared.unitsPerBasket).toEqual([UNITS_A / 2n, UNITS_B])
    expect(prepared.constituents[0]).toMatchObject({
      unitsUi: UNITS_A,
      uiMultiplier: 2n * ONE,
    })
  })

  it("rejects displayed amounts that would be silently rounded", async () => {
    const harness = factoryHarness({
      state: { multipliers: { [TOKEN_A]: 3n * ONE, [TOKEN_B]: ONE } },
    })

    await expect(prepareBasketCreation(harness)).rejects.toMatchObject({
      code: "SCALED_UI_ROUNDING_REVIEW_REQUIRED",
      details: {
        token: TOKEN_A,
        requestedUiAmount: UNITS_A.toString(),
      },
    })
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("simulates, writes, waits, and returns only the event-proven basket address", async () => {
    const harness = factoryHarness()
    const result = await createBasket(harness)

    expect(result.basketAddress).toBe(BASKET)
    expect(result.transaction.hash).toBe(HASH)
    expect(harness.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "createBasket",
        args: ["Global Leaders", "GLB2", [TOKEN_A, TOKEN_B], [UNITS_A, UNITS_B], 30, STARTER_CAP],
      }),
    )
    expect(result.verifiedBasket).toMatchObject({
      basketAddress: BASKET,
      creator: ACCOUNT,
      name: "Global Leaders",
      symbol: "GLB2",
      constituents: [TOKEN_A, TOKEN_B],
      unitsPerBasket: [UNITS_A, UNITS_B],
      mintFeeBps: 30,
      supplyCap: STARTER_CAP,
      maxSupplyCap: CEILING,
      guardian: addresses.curatorGuardian,
      feeRecipient: addresses.feeSplitter,
    })
  })

  it.each([
    ["factory provenance", { factoryCreator: OTHER }, "factory.creatorOf"],
    ["fee registration", { splitterCreator: OTHER }, "feeSplitter.creatorOf"],
    ["name", { name: "Different Basket" }, "name"],
    ["symbol", { symbol: "OTHER" }, "symbol"],
    ["constituent order", { tokens: [TOKEN_B, TOKEN_A] }, "constituents"],
    ["raw units", { unitsPerBasket: [UNITS_A + 1n, UNITS_B] }, "unitsPerBasket"],
    ["mint fee", { mintFeeBps: 20 }, "mintFeeBps"],
    ["initial supply cap", { supplyCap: STARTER_CAP - 1n }, "supplyCap"],
    ["maximum supply cap", { maxSupplyCap: CEILING - 1n }, "maxSupplyCap"],
    ["guardian", { guardian: OTHER }, "guardian"],
    ["fee recipient", { feeRecipient: OTHER }, "feeRecipient"],
    ["basket decimals", { decimals: 6 }, "decimals"],
    ["deployed code", { bytecode: "0x" }, "bytecode"],
    ["event name", { event: { name: "Wrong Event Name" } }, "event.name"],
  ])("fails closed after confirmation when %s differs", async (_label, created, field) => {
    const harness = factoryHarness({ state: { created } })

    await expect(createBasket(harness)).rejects.toMatchObject({
      code: "BASKET_POST_CONFIRMATION_MISMATCH",
      txHash: HASH,
      details: { basketAddress: BASKET, field },
    })
    expect(harness.walletClient.writeContract).toHaveBeenCalledOnce()
  })

  it("keeps the confirmed hash when post-confirmation reads cannot be completed", async () => {
    const harness = factoryHarness()
    const originalRead = harness.publicClient.readContract
    harness.publicClient.readContract = vi.fn(async (request) => {
      if (request.address === BASKET && request.functionName === "name") {
        throw new Error("rpc read unavailable")
      }
      return originalRead(request)
    })

    await expect(createBasket(harness)).rejects.toMatchObject({
      code: "BASKET_POST_CONFIRMATION_UNVERIFIED",
      txHash: HASH,
      details: { basketAddress: BASKET },
    })
    expect(harness.walletClient.writeContract).toHaveBeenCalledOnce()
  })

  it("rejects unsupported, duplicate, unlicensed, and over-cap recipes before any write", async () => {
    const unsupported = factoryHarness({
      state: { supported: { [TOKEN_A]: true, [TOKEN_B]: false } },
    })
    await expect(createBasket(unsupported)).rejects.toMatchObject({
      code: "UNSUPPORTED_CONSTITUENT",
    })
    expect(unsupported.walletClient.writeContract).not.toHaveBeenCalled()

    const duplicate = factoryHarness()
    await expect(
      createBasket({
        ...duplicate,
        constituents: [
          { token: TOKEN_A, units: "1" },
          { token: TOKEN_A, units: "2" },
        ],
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_CONSTITUENT" })
    expect(duplicate.walletClient.writeContract).not.toHaveBeenCalled()

    const unlicensed = factoryHarness({ state: { licensed: false } })
    await expect(createBasket(unlicensed)).rejects.toMatchObject({
      code: "CREATOR_LICENSE_REQUIRED",
    })
    expect(unlicensed.walletClient.writeContract).not.toHaveBeenCalled()

    const overCap = factoryHarness()
    await expect(
      createBasket({ ...overCap, initialSupplyCap: "1000.000000000000000001" }),
    ).rejects.toMatchObject({
      code: "SUPPLY_CAP_ABOVE_FACTORY_LIMIT",
    })
    expect(overCap.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("rejects Unicode control and format characters before basket creation", async () => {
    for (const name of ["Spoof\u202eName", "Zero\u200bWidth", "Line\nBreak"]) {
      const harness = factoryHarness()
      await expect(createBasket({ ...harness, name })).rejects.toMatchObject({
        code: "INVALID_TEXT",
      })
      expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
    }
  })

  it("fails closed when immutable factory wiring differs", async () => {
    const harness = factoryHarness({
      publicClient: {
        readContract: vi.fn(async ({ address, functionName, args = [] }) => {
          if (address === addresses.basketFactory && functionName === "creatorLicense") {
            return "0x9999999999999999999999999999999999999999"
          }
          if (address === addresses.basketFactory && functionName === "assetRegistry") {
            return addresses.assetRegistry
          }
          if (address === addresses.basketFactory && functionName === "splitter") {
            return addresses.feeSplitter
          }
          if (address === addresses.basketFactory && functionName === "basketGuardian") {
            return addresses.curatorGuardian
          }
          if (address === addresses.basketFactory && functionName === "STARTER_CAP") {
            return STARTER_CAP
          }
          if (address === addresses.basketFactory && functionName === "CEILING") {
            return CEILING
          }
          if (address === addresses.creatorLicense && functionName === "isLicensed") return true
          if (address === addresses.feeSplitter && functionName === "factory") {
            return addresses.basketFactory
          }
          if (address === addresses.assetRegistry && functionName === "isSupported") return true
          if (functionName === "decimals") return args[0] === TOKEN_A ? 6 : 18
          return 18
        }),
      },
    })
    await expect(createBasket(harness)).rejects.toMatchObject({
      code: "CONTRACT_CONFIGURATION_MISMATCH",
    })
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("does not infer a basket address when the verified factory event is absent", async () => {
    const harness = factoryHarness({
      publicClient: {
        waitForTransactionReceipt: vi.fn(async () => ({
          status: "success",
          transactionHash: HASH,
          blockNumber: 1n,
          logs: [],
        })),
      },
    })
    await expect(createBasket(harness)).rejects.toMatchObject({
      code: "BASKET_EVENT_NOT_FOUND",
      txHash: HASH,
    })
  })
})
