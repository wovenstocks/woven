import { encodeFunctionData, keccak256 } from "viem"
import { describe, expect, it, vi } from "vitest"
import { oneClickBasketRouterAbi } from "./abis"
import {
  approveUsdcForBasketBuy,
  createBasketBuyQuote,
  getBasketBuyReadiness,
  mintBasketWithUsdc,
} from "./buy"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const RECIPIENT = "0x1111111111111111111111111111111111111112"
const CREATOR = "0x1111111111111111111111111111111111111113"
const TOKEN_A = "0x2000000000000000000000000000000000000001"
const TOKEN_B = "0x2000000000000000000000000000000000000002"
const BASKET = "0x3000000000000000000000000000000000000001"
const USDC = "0x4000000000000000000000000000000000000001"
const ROUTER = "0x4000000000000000000000000000000000000002"
const ADAPTER_A = "0x5000000000000000000000000000000000000001"
const ADAPTER_B = "0x5000000000000000000000000000000000000002"
const ROUTE_A = `0x${"a1".repeat(32)}`
const ROUTE_A_ALT = `0x${"a2".repeat(32)}`
const ROUTE_B = `0x${"b2".repeat(32)}`
const ROUTE_HASH_A = `0x${"c3".repeat(32)}`
const ROUTE_HASH_A_ALT = `0x${"c4".repeat(32)}`
const ROUTE_HASH_B = `0x${"d4".repeat(32)}`
const QUOTE_BLOCK_NUMBER = 100n
const QUOTE_BLOCK_HASH = `0x${"e5".repeat(32)}`
const REORG_BLOCK_HASH = `0x${"f6".repeat(32)}`
const ADAPTER_BYTECODE = "0x6001600055"
const ADAPTER_CODEHASH = keccak256(ADAPTER_BYTECODE)
const ONE = 10n ** 18n
const UNITS_A = 1_250_000n
const UNITS_B = 500_000_000_000_000_000n
const EXPECTED_A = 10n * ONE
const EXPECTED_B = 20n * ONE
const MAX_A = (EXPECTED_A * 101n) / 100n
const MAX_B = (EXPECTED_B * 101n) / 100n
const MAX_TOTAL = MAX_A + MAX_B
const EXPECTED_TOTAL = EXPECTED_A + EXPECTED_B

const addresses = Object.freeze({
  usdc: USDC,
  oneClickRouter: ROUTER,
  assetRegistry: "0x1000000000000000000000000000000000000003",
  basketFactory: "0x1000000000000000000000000000000000000006",
})

const expectedBasket = Object.freeze({
  address: BASKET,
  name: "Global Leaders",
  symbol: "GLB2",
  mintFeeBps: 30,
  constituents: Object.freeze([
    { token: TOKEN_A, unitsRaw: UNITS_A },
    { token: TOKEN_B, unitsRaw: UNITS_B },
  ]),
})

function ceilMulDiv(amount, units) {
  return (amount * units + ONE - 1n) / ONE
}

function buyHarness(overrides = {}) {
  const state = {
    timestamp: 1_000n,
    latestBlockNumber: QUOTE_BLOCK_NUMBER,
    latestBlockHash: QUOTE_BLOCK_HASH,
    quoteBlockTimestamp: 1_000n,
    canonicalQuoteBlockHash: QUOTE_BLOCK_HASH,
    chainId: 56,
    walletChainId: 56,
    allowance: 0n,
    balance: 100n * ONE,
    usdcDecimals: 18,
    usdcSymbol: "USDC",
    basketName: "Global Leaders",
    basketSymbol: "GLB2",
    tokens: [TOKEN_A, TOKEN_B],
    units: [UNITS_A, UNITS_B],
    isFullyBacked: true,
    mintPaused: false,
    totalSupply: 100n * ONE,
    supplyCap: 1_000n * ONE,
    mintFeeBps: 30,
    multipliers: { [TOKEN_A]: ONE, [TOKEN_B]: ONE },
    newMultipliers: { [TOKEN_A]: ONE, [TOKEN_B]: ONE },
    effectiveAts: { [TOKEN_A]: 0n, [TOKEN_B]: 0n },
    adapterBytecodes: { [ADAPTER_A]: ADAPTER_BYTECODE, [ADAPTER_B]: ADAPTER_BYTECODE },
    pinnedCodehashes: { [ADAPTER_A]: ADAPTER_CODEHASH, [ADAPTER_B]: ADAPTER_CODEHASH },
    routeIds: { [ADAPTER_A]: [ROUTE_A], [ADAPTER_B]: [ROUTE_A_ALT, ROUTE_B] },
    routeOutputs: {
      [ROUTE_A]: TOKEN_A,
      [ROUTE_A_ALT]: TOKEN_A,
      [ROUTE_B]: TOKEN_B,
    },
    routeHashes: {
      [ROUTE_A]: ROUTE_HASH_A,
      [ROUTE_A_ALT]: ROUTE_HASH_A_ALT,
      [ROUTE_B]: ROUTE_HASH_B,
    },
    quoteResults: {
      [ROUTE_A]: [EXPECTED_A, 100_000n],
      [ROUTE_A_ALT]: [9n * ONE, 120_000n],
      [ROUTE_B]: [EXPECTED_B, 200_000n],
    },
    ...overrides.state,
  }
  const writes = []
  const simulations = []
  const reads = []
  let nonce = 1

  const publicClient = {
    getChainId: vi.fn(async () => state.chainId),
    getBlock: vi.fn(async ({ blockNumber } = {}) =>
      blockNumber === undefined
        ? {
            number: state.latestBlockNumber,
            hash: state.latestBlockHash,
            timestamp: state.timestamp,
          }
        : {
            number: blockNumber,
            hash: state.canonicalQuoteBlockHash,
            timestamp: state.quoteBlockTimestamp,
          },
    ),
    getBytecode: vi.fn(async ({ address }) => state.adapterBytecodes[address] || "0x6000"),
    readContract: vi.fn(async ({ address, functionName, args = [], blockNumber }) => {
      reads.push({ address, functionName, args, blockNumber })
      if (address === ROUTER) {
        if (functionName === "usdc") return USDC
        if (functionName === "basketFactory") return addresses.basketFactory
        if (functionName === "assetRegistry") return addresses.assetRegistry
        if (functionName === "adapters") return [ADAPTER_A, ADAPTER_B]
        if (functionName === "MAX_ROUTED_CONSTITUENTS") return 8n
        if (functionName === "MAX_DEADLINE_WINDOW") return 1_200n
        if (functionName === "adapterCodehash") return state.pinnedCodehashes[args[0]]
      }
      if (address === addresses.basketFactory) {
        if (functionName === "assetRegistry") return addresses.assetRegistry
        if (functionName === "creatorOf") return CREATOR
      }
      if (address === addresses.assetRegistry && functionName === "isSupported") return true
      if (address === BASKET) {
        if (functionName === "name") return state.basketName
        if (functionName === "symbol") return state.basketSymbol
        if (functionName === "decimals") return 18
        if (functionName === "mintFeeBps") return state.mintFeeBps
        if (functionName === "constituents") return state.tokens
        if (functionName === "units") return state.units
        if (functionName === "getRequiredUnits") {
          return [state.tokens, state.units.map((units) => ceilMulDiv(args[0], units))]
        }
        if (functionName === "isFullyBacked") return state.isFullyBacked
        if (functionName === "mintPaused") return state.mintPaused
        if (functionName === "totalSupply") return state.totalSupply
        if (functionName === "supplyCap") return state.supplyCap
      }
      if (address === USDC) {
        if (functionName === "decimals") return state.usdcDecimals
        if (functionName === "symbol") return state.usdcSymbol
        if (functionName === "balanceOf") return state.balance
        if (functionName === "allowance") return state.allowance
      }
      if (address === TOKEN_A || address === TOKEN_B) {
        if (functionName === "decimals") return address === TOKEN_A ? 6 : 18
        if (functionName === "symbol") return address === TOKEN_A ? "ASSETA" : "ASSETB"
        if (functionName === "name") return address === TOKEN_A ? "Asset A" : "Asset B"
        if (functionName === "supportsInterface") return true
        if (functionName === "uiMultiplier") return state.multipliers[address]
        if (functionName === "newUIMultiplier") return state.newMultipliers[address]
        if (functionName === "effectiveAt") return state.effectiveAts[address]
        if (functionName === "toUIAmount") {
          return (args[0] * state.multipliers[address]) / ONE
        }
      }
      if (address === ADAPTER_A || address === ADAPTER_B) {
        if (functionName === "inputToken") return USDC
        if (functionName === "routeIds") return state.routeIds[address]
        if (functionName === "routeOutput") return state.routeOutputs[args[0]]
        if (functionName === "routeHash") return state.routeHashes[args[0]]
      }
      throw new Error(`Unexpected read ${address}:${functionName}`)
    }),
    simulateContract: vi.fn(async (request) => {
      simulations.push({
        address: request.address,
        functionName: request.functionName,
        args: request.args || [],
        blockNumber: request.blockNumber,
      })
      if (request.functionName === "quoteExactOutput") {
        const result = state.quoteResults[request.args[2]]
        if (result instanceof Error) throw result
        return { request, result }
      }
      if (overrides.simulateContract) return overrides.simulateContract(request)
      return { request }
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }) => ({
      status: "success",
      transactionHash: hash,
      blockNumber: 1n,
      logs: [],
    })),
    ...overrides.publicClient,
  }
  const walletClient = {
    account: { address: ACCOUNT },
    getAddresses: vi.fn(async () => [ACCOUNT]),
    getChainId: vi.fn(async () => state.walletChainId),
    writeContract: vi.fn(async (request) => {
      writes.push({
        address: request.address,
        functionName: request.functionName,
        args: request.args || [],
      })
      if (request.address === USDC && request.functionName === "approve") {
        state.allowance = request.args[1]
      }
      const hash = `0x${String(nonce).padStart(64, "0")}`
      nonce += 1
      return hash
    }),
    ...overrides.walletClient,
  }
  const quote = {
    chainId: 56,
    router: ROUTER,
    usdc: USDC,
    basket: BASKET,
    account: ACCOUNT,
    recipient: RECIPIENT,
    grossBasketAmount: ONE,
    usdcDecimals: 18,
    usdcSymbol: "USDC",
    slippageBps: 100,
    expectedTotalUsdcIn: EXPECTED_TOTAL,
    maxTotalUsdcIn: MAX_TOTAL,
    deadline: 1_600n,
    quoteBlockNumber: QUOTE_BLOCK_NUMBER,
    quoteBlockHash: QUOTE_BLOCK_HASH,
    quoteBlockTimestamp: 1_000n,
    source: { kind: "onchain-constructor-bound-exact-output", version: 1 },
    legs: [
      {
        expectedToken: TOKEN_A,
        adapter: ADAPTER_A,
        routeId: ROUTE_A,
        routeHash: ROUTE_HASH_A,
        adapterCodehash: ADAPTER_CODEHASH,
        expectedAmountOut: UNITS_A,
        expectedUsdcIn: EXPECTED_A,
        maxUsdcIn: MAX_A,
        gasEstimate: 100_000n,
        source: {
          kind: "onchain-constructor-bound-exact-output",
          version: 1,
          adapter: ADAPTER_A,
          routeId: ROUTE_A,
        },
      },
      {
        expectedToken: TOKEN_B,
        adapter: ADAPTER_B,
        routeId: ROUTE_B,
        routeHash: ROUTE_HASH_B,
        adapterCodehash: ADAPTER_CODEHASH,
        expectedAmountOut: UNITS_B,
        expectedUsdcIn: EXPECTED_B,
        maxUsdcIn: MAX_B,
        gasEstimate: 200_000n,
        source: {
          kind: "onchain-constructor-bound-exact-output",
          version: 1,
          adapter: ADAPTER_B,
          routeId: ROUTE_B,
        },
      },
    ],
    ...overrides.quote,
  }

  return {
    publicClient,
    walletClient,
    account: ACCOUNT,
    recipient: RECIPIENT,
    basketAddress: BASKET,
    amount: "1",
    addresses,
    expectedBasket,
    quote,
    state,
    writes,
    simulations,
    reads,
  }
}

describe("onchain one-click quote discovery", () => {
  it("enumerates immutable routes at one block and selects the cheapest positive exact-output quote", async () => {
    const harness = buyHarness()
    const quote = await createBasketBuyQuote(harness)

    expect(quote).toMatchObject({
      chainId: 56,
      usdcDecimals: 18,
      usdcSymbol: "USDC",
      basket: BASKET,
      grossBasketAmount: ONE,
      slippageBps: 100,
      expectedTotalUsdcIn: 29n * ONE,
      maxTotalUsdcIn: 29_290_000_000_000_000_000n,
      expectedTotalUsdcInFormatted: "29",
      maxTotalUsdcInFormatted: "29.29",
      deadline: 1_300n,
      quoteBlockNumber: QUOTE_BLOCK_NUMBER,
      quoteBlockHash: QUOTE_BLOCK_HASH,
      quoteBlockTimestamp: 1_000n,
      source: { kind: "onchain-constructor-bound-exact-output", version: 1 },
    })
    expect(quote.legs).toEqual([
      expect.objectContaining({
        expectedToken: TOKEN_A,
        adapter: ADAPTER_B,
        routeId: ROUTE_A_ALT,
        routeHash: ROUTE_HASH_A_ALT,
        expectedAmountOut: UNITS_A,
        expectedUsdcIn: 9n * ONE,
        maxUsdcIn: 9_090_000_000_000_000_000n,
        expectedUsdcInFormatted: "9",
        maxUsdcInFormatted: "9.09",
      }),
      expect.objectContaining({
        expectedToken: TOKEN_B,
        adapter: ADAPTER_B,
        routeId: ROUTE_B,
        expectedUsdcIn: EXPECTED_B,
        maxUsdcIn: MAX_B,
      }),
    ])
    const quoteSimulations = harness.simulations.filter(
      (call) => call.functionName === "quoteExactOutput",
    )
    expect(quoteSimulations).toHaveLength(3)
    expect(quoteSimulations.every((call) => call.blockNumber === QUOTE_BLOCK_NUMBER)).toBe(true)

    const readiness = await getBasketBuyReadiness({ ...harness, quote })
    expect(readiness).toMatchObject({
      expectedTotalUsdcIn: 29n * ONE,
      expectedTotalUsdcInFormatted: "29",
      maxTotalUsdcInFormatted: "29.29",
      quoteBlockHash: QUOTE_BLOCK_HASH,
      slippageBps: 100,
    })
    expect(readiness.legs[0]).toMatchObject({
      expectedUsdcInFormatted: "9",
      maxUsdcInFormatted: "9.09",
      source: {
        kind: "onchain-constructor-bound-exact-output",
        version: 1,
        adapter: ADAPTER_B,
        routeId: ROUTE_A_ALT,
      },
    })
  })

  it("validates slippage and route-enumeration limits before returning a quote", async () => {
    const custom = buyHarness()
    const quote = await createBasketBuyQuote({ ...custom, slippageBps: 250 })
    expect(quote.slippageBps).toBe(250)
    expect(quote.legs[0].maxUsdcIn).toBe(9_225_000_000_000_000_000n)

    const invalidSlippage = buyHarness()
    await expect(
      createBasketBuyQuote({ ...invalidSlippage, slippageBps: 2_001 }),
    ).rejects.toMatchObject({ code: "INVALID_BASIS_POINTS" })
    expect(invalidSlippage.publicClient.simulateContract).not.toHaveBeenCalled()

    const tooManyRoutes = buyHarness()
    tooManyRoutes.state.routeIds[ADAPTER_A] = Array.from(
      { length: 33 },
      (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`,
    )
    await expect(createBasketBuyQuote(tooManyRoutes)).rejects.toMatchObject({
      code: "ROUTE_ENUMERATION_LIMIT",
    })
  })

  it("fails closed when every matching route reverts at the pinned quote block", async () => {
    const harness = buyHarness()
    harness.state.quoteResults[ROUTE_A] = new Error("pool unavailable")
    harness.state.quoteResults[ROUTE_A_ALT] = new Error("pool unavailable")

    await expect(createBasketBuyQuote(harness)).rejects.toMatchObject({
      code: "NO_EXECUTABLE_ROUTE",
      details: { token: TOKEN_A, routesTried: 2 },
    })
  })

  it("rejects non-18-decimal input tokens instead of assuming Ethereum USDC units", async () => {
    const harness = buyHarness({ state: { usdcDecimals: 6 } })

    await expect(createBasketBuyQuote(harness)).rejects.toMatchObject({
      code: "UNSUPPORTED_USDC_CONFIGURATION",
    })
    expect(harness.publicClient.simulateContract).not.toHaveBeenCalled()
  })
})

describe("one-click USDC quote validation", () => {
  it("binds a short-lived quote to the live recipe, routes, and ERC-8056 state", async () => {
    const harness = buyHarness()
    const readiness = await getBasketBuyReadiness(harness)

    expect(readiness).toMatchObject({
      chainId: 56,
      account: ACCOUNT,
      recipient: RECIPIENT,
      basket: BASKET,
      grossBasketAmount: ONE,
      minNetBasketOut: 997_000_000_000_000_000n,
      maxTotalUsdcIn: MAX_TOTAL,
      expectedTotalUsdcIn: EXPECTED_TOTAL,
      expiresIn: 600n,
      feeAmount: 3_000_000_000_000_000n,
      hasBalance: true,
      hasAllowance: false,
      blockers: ["APPROVAL_REQUIRED"],
      canApprove: true,
      canBuy: false,
      quoteBlockNumber: QUOTE_BLOCK_NUMBER,
      quoteBlockHash: QUOTE_BLOCK_HASH,
      usdcDecimals: 18,
      usdcSymbol: "USDC",
    })
    expect(readiness.fingerprint).toMatch(/^0x[a-f0-9]{64}$/)
    expect(readiness.legs).toEqual([
      expect.objectContaining({
        expectedToken: TOKEN_A,
        routeId: ROUTE_A,
        adapterCodehash: ADAPTER_CODEHASH,
        routeHash: ROUTE_HASH_A,
        uiMultiplier: ONE,
        expectedUsdcIn: EXPECTED_A,
        expectedUsdcInFormatted: "10",
        maxUsdcInFormatted: "10.1",
      }),
      expect.objectContaining({
        expectedToken: TOKEN_B,
        routeId: ROUTE_B,
        adapterCodehash: ADAPTER_CODEHASH,
        routeHash: ROUTE_HASH_B,
        uiMultiplier: ONE,
      }),
    ])
    expect(readiness.routerArgs[6]).toEqual([
      {
        expectedToken: TOKEN_A,
        adapter: ADAPTER_A,
        routeId: ROUTE_A,
        expectedAmountOut: UNITS_A,
        maxUsdcIn: MAX_A,
      },
      {
        expectedToken: TOKEN_B,
        adapter: ADAPTER_B,
        routeId: ROUTE_B,
        expectedAmountOut: UNITS_B,
        maxUsdcIn: MAX_B,
      },
    ])
    expect(
      encodeFunctionData({
        abi: oneClickBasketRouterAbi,
        functionName: "mintWithUsdc",
        args: readiness.routerArgs,
      }),
    ).toMatch(/^0x[a-f0-9]+$/)
  })

  it("accepts the complete readiness object as the next write quote without losing provenance", async () => {
    const harness = buyHarness()
    const first = await getBasketBuyReadiness(harness)
    const second = await getBasketBuyReadiness({ ...harness, quote: first })

    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.expectedTotalUsdcInFormatted).toBe("30")
    expect(second.legs[0]).toMatchObject({
      expectedUsdcIn: EXPECTED_A,
      expectedUsdcInFormatted: "10",
      adapterCodehash: ADAPTER_CODEHASH,
      routeHash: ROUTE_HASH_A,
    })
  })

  it("pins each readiness read to one canonical block without invalidating on unrelated supply growth", async () => {
    const harness = buyHarness()
    const first = await getBasketBuyReadiness(harness)

    expect(harness.reads.length).toBeGreaterThan(0)
    expect(harness.reads.every((read) => read.blockNumber === QUOTE_BLOCK_NUMBER)).toBe(true)
    expect(
      harness.publicClient.getBytecode.mock.calls.every(
        ([request]) => request.blockNumber === QUOTE_BLOCK_NUMBER,
      ),
    ).toBe(true)

    harness.state.totalSupply += ONE
    const second = await getBasketBuyReadiness({ ...harness, quote: first })
    expect(second.supplyAvailable).toBe(true)
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it("rejects a reorged quote block and tampered expected display values", async () => {
    const reorged = buyHarness()
    reorged.state.canonicalQuoteBlockHash = REORG_BLOCK_HASH
    await expect(getBasketBuyReadiness(reorged)).rejects.toMatchObject({
      code: "QUOTE_BLOCK_REORGED",
    })

    const tamperedTotal = buyHarness({
      quote: { expectedTotalUsdcIn: EXPECTED_TOTAL + 1n },
    })
    await expect(getBasketBuyReadiness(tamperedTotal)).rejects.toMatchObject({
      code: "QUOTE_TOTAL_MISMATCH",
    })

    const tamperedLeg = buyHarness()
    tamperedLeg.quote.legs[0].expectedUsdcIn += 1n
    await expect(getBasketBuyReadiness(tamperedLeg)).rejects.toMatchObject({
      code: "QUOTE_SLIPPAGE_MISMATCH",
    })

    const fabricatedOnchainValue = buyHarness()
    const fabricatedExpected = EXPECTED_A + 1n
    const fabricatedMaximum = (fabricatedExpected * 10_100n + 9_999n) / 10_000n
    fabricatedOnchainValue.quote.legs[0].expectedUsdcIn = fabricatedExpected
    fabricatedOnchainValue.quote.legs[0].maxUsdcIn = fabricatedMaximum
    fabricatedOnchainValue.quote.expectedTotalUsdcIn = fabricatedExpected + EXPECTED_B
    fabricatedOnchainValue.quote.maxTotalUsdcIn = fabricatedMaximum + MAX_B
    await expect(getBasketBuyReadiness(fabricatedOnchainValue)).rejects.toMatchObject({
      code: "QUOTE_SOURCE_MISMATCH",
    })
  })

  it("rejects an expired, overlong, wrong-chain, or wrong-wallet quote", async () => {
    await expect(
      getBasketBuyReadiness(buyHarness({ quote: { deadline: 1_000n } })),
    ).rejects.toMatchObject({ code: "QUOTE_EXPIRED" })
    await expect(
      getBasketBuyReadiness(buyHarness({ quote: { deadline: 2_201n } })),
    ).rejects.toMatchObject({ code: "QUOTE_DEADLINE_UNSAFE" })
    await expect(
      getBasketBuyReadiness(buyHarness({ quote: { chainId: 97 } })),
    ).rejects.toMatchObject({ code: "QUOTE_CHAIN_MISMATCH" })
    await expect(
      getBasketBuyReadiness(
        buyHarness({ quote: { account: "0x9999999999999999999999999999999999999999" } }),
      ),
    ).rejects.toMatchObject({ code: "QUOTE_CONTEXT_MISMATCH" })
  })

  it("rejects route, raw amount, total maximum, codehash, and recipe mismatches", async () => {
    const wrongRoute = buyHarness({
      state: { routeOutputs: { [ROUTE_A]: TOKEN_B, [ROUTE_B]: TOKEN_B } },
    })
    await expect(getBasketBuyReadiness(wrongRoute)).rejects.toMatchObject({
      code: "ADAPTER_ROUTE_MISMATCH",
    })

    const wrongAmount = buyHarness()
    wrongAmount.quote.legs[0].expectedAmountOut += 1n
    await expect(getBasketBuyReadiness(wrongAmount)).rejects.toMatchObject({
      code: "QUOTE_RECIPE_MISMATCH",
    })

    await expect(
      getBasketBuyReadiness(buyHarness({ quote: { maxTotalUsdcIn: MAX_TOTAL + 1n } })),
    ).rejects.toMatchObject({ code: "QUOTE_TOTAL_MISMATCH" })

    const changedCode = buyHarness({
      state: {
        adapterBytecodes: { [ADAPTER_A]: "0x6002600055", [ADAPTER_B]: ADAPTER_BYTECODE },
      },
    })
    await expect(getBasketBuyReadiness(changedCode)).rejects.toMatchObject({
      code: "ADAPTER_CODE_CHANGED",
    })

    const wrongRecipe = buyHarness({ state: { units: [UNITS_A + 1n, UNITS_B] } })
    await expect(getBasketBuyReadiness(wrongRecipe)).rejects.toMatchObject({
      code: "BASKET_RECIPE_MISMATCH",
    })
  })
})

describe("one-click USDC write sequencing", () => {
  it("simulates and confirms the exact USDC approval before simulating mintWithUsdc", async () => {
    const harness = buyHarness()
    const quote = await createBasketBuyQuote(harness)
    const review = await getBasketBuyReadiness({ ...harness, quote })
    const result = await mintBasketWithUsdc({ ...harness, quote: review, review })

    expect(
      harness.simulations
        .filter((call) => call.functionName !== "quoteExactOutput")
        .map((call) => call.functionName),
    ).toEqual(["approve", "mintWithUsdc"])
    expect(harness.writes.map((call) => call.functionName)).toEqual(["approve", "mintWithUsdc"])
    expect(harness.writes[0]).toEqual({
      address: USDC,
      functionName: "approve",
      args: [ROUTER, quote.maxTotalUsdcIn],
    })
    expect(harness.writes[1].args).toEqual(review.routerArgs)
    expect(result.approvalTransactions).toHaveLength(1)
    expect(result.transaction.receipt.status).toBe("success")
  })

  it("resets a partial USDC allowance before the exact approval", async () => {
    const harness = buyHarness({ state: { allowance: 1n } })
    const review = await getBasketBuyReadiness(harness)
    const result = await approveUsdcForBasketBuy({ ...harness, review })

    expect(
      harness.simulations
        .filter((call) => call.functionName !== "quoteExactOutput")
        .map((call) => call.functionName),
    ).toEqual(["approve", "approve"])
    expect(harness.writes).toEqual([
      { address: USDC, functionName: "approve", args: [ROUTER, 0n] },
      { address: USDC, functionName: "approve", args: [ROUTER, MAX_TOTAL] },
    ])
    expect(result.readiness.hasAllowance).toBe(true)
  })

  it("requires a matching review fingerprint and rechecks multipliers before any write", async () => {
    const missing = buyHarness()
    await expect(mintBasketWithUsdc(missing)).rejects.toMatchObject({
      code: "QUOTE_REVIEW_REQUIRED",
    })
    expect(missing.walletClient.writeContract).not.toHaveBeenCalled()

    const stale = buyHarness()
    const review = await getBasketBuyReadiness(stale)
    stale.state.multipliers[TOKEN_A] = 2n * ONE
    stale.state.newMultipliers[TOKEN_A] = 2n * ONE
    await expect(mintBasketWithUsdc({ ...stale, review })).rejects.toMatchObject({
      code: "QUOTE_REVIEW_STALE",
    })
    expect(stale.walletClient.writeContract).not.toHaveBeenCalled()
    expect(stale.simulations.filter((call) => call.functionName !== "quoteExactOutput")).toEqual([])
  })

  it("checks the active wallet chain before simulation and never writes on mismatch", async () => {
    const harness = buyHarness({ state: { allowance: MAX_TOTAL, walletChainId: 97 } })
    const review = await getBasketBuyReadiness(harness)

    await expect(mintBasketWithUsdc({ ...harness, review })).rejects.toMatchObject({
      code: "CHAIN_MISMATCH",
    })
    expect(harness.simulations.filter((call) => call.functionName !== "quoteExactOutput")).toEqual(
      [],
    )
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("never writes when mintWithUsdc simulation fails", async () => {
    const harness = buyHarness({
      state: { allowance: MAX_TOTAL },
      simulateContract: async (request) => {
        if (request.functionName === "mintWithUsdc") {
          throw { data: { errorName: "LegSpendExceeded" } }
        }
        return { request }
      },
    })
    const review = await getBasketBuyReadiness(harness)

    await expect(mintBasketWithUsdc({ ...harness, review })).rejects.toMatchObject({
      code: "CONTRACT_LegSpendExceeded",
    })
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("preserves the confirmed approval hash when the quote expires before mint", async () => {
    const harness = buyHarness()
    const review = await getBasketBuyReadiness(harness)
    const approvalHash = `0x${"77".repeat(32)}`
    harness.walletClient.writeContract = vi.fn(async (request) => {
      harness.state.allowance = request.args[1]
      harness.state.timestamp = harness.quote.deadline
      return approvalHash
    })

    await expect(mintBasketWithUsdc({ ...harness, review })).rejects.toMatchObject({
      code: "QUOTE_EXPIRED",
      details: { completedTransactionHashes: [approvalHash] },
    })
    expect(
      harness.simulations
        .filter((call) => call.functionName !== "quoteExactOutput")
        .map((call) => call.functionName),
    ).toEqual(["approve"])
    expect(harness.walletClient.writeContract).toHaveBeenCalledOnce()
  })

  it("does not approve when automatic USDC approval is disabled", async () => {
    const harness = buyHarness()
    const review = await getBasketBuyReadiness(harness)

    await expect(
      mintBasketWithUsdc({ ...harness, review, approveUsdc: false }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" })
    expect(harness.simulations.filter((call) => call.functionName !== "quoteExactOutput")).toEqual(
      [],
    )
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
  })
})
