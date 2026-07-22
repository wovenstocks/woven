import { describe, expect, it, vi } from "vitest"
import {
  approveBasketConstituents,
  getBasketMintReadiness,
  getBasketRequiredUnits,
  getBasketRedemptionReadiness,
  mintBasket,
  redeemBasket,
  verifyBasketRecipe,
} from "./basket"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const CREATOR = "0x1111111111111111111111111111111111111112"
const TOKEN_A = "0x2000000000000000000000000000000000000001"
const TOKEN_B = "0x2000000000000000000000000000000000000002"
const BASKET = "0x3000000000000000000000000000000000000001"
const ONE = 10n ** 18n
const UNITS_A = 1_250_000n
const UNITS_B = 500_000_000_000_000_000n
const FIRST_APPROVAL_HASH = `0x${"a1".repeat(32)}`
const addresses = Object.freeze({
  wovenToken: "0x1000000000000000000000000000000000000001",
  creatorLicense: "0x1000000000000000000000000000000000000002",
  assetRegistry: "0x1000000000000000000000000000000000000003",
  feeSplitter: "0x1000000000000000000000000000000000000004",
  curatorGuardian: "0x1000000000000000000000000000000000000005",
  basketFactory: "0x1000000000000000000000000000000000000006",
})
const expectedRecipe = Object.freeze([
  { token: TOKEN_A, unitsRaw: UNITS_A },
  { token: TOKEN_B, unitsRaw: UNITS_B },
])
const expectedBasket = Object.freeze({
  address: BASKET,
  name: "Global Leaders",
  symbol: "GLB2",
  mintFeeBps: 30,
  constituents: expectedRecipe,
})

function ceilMulDiv(amount, units) {
  return (amount * units + ONE - 1n) / ONE
}

function basketHarness(overrides = {}) {
  const state = {
    tokenBalances: { [TOKEN_A]: 10_000_000n, [TOKEN_B]: 10n * ONE },
    allowances: { [TOKEN_A]: 0n, [TOKEN_B]: 0n },
    basketBalance: 5n * ONE,
    totalSupply: 100n * ONE,
    supplyCap: 1000n * ONE,
    isFullyBacked: true,
    mintPaused: false,
    basketName: "Global Leaders",
    basketSymbol: "GLB2",
    tokenAName: "Asset A",
    tokenASymbol: "ASSETA",
    tokenBName: "Asset B",
    tokenBSymbol: "ASSETB",
    units: [UNITS_A, UNITS_B],
    tokens: [TOKEN_A, TOKEN_B],
    multipliers: { [TOKEN_A]: ONE, [TOKEN_B]: ONE },
    newMultipliers: { [TOKEN_A]: ONE, [TOKEN_B]: ONE },
    effectiveAts: { [TOKEN_A]: 0n, [TOKEN_B]: 0n },
    ...overrides.state,
  }
  const writes = []
  let nonce = 1
  const publicClient = {
    getBytecode: vi.fn(async () => "0x6000"),
    readContract: vi.fn(async ({ address, functionName, args = [] }) => {
      if (address === addresses.basketFactory) {
        if (functionName === "creatorOf") return CREATOR
        if (functionName === "creatorLicense") return addresses.creatorLicense
        if (functionName === "assetRegistry") return addresses.assetRegistry
        if (functionName === "splitter") return addresses.feeSplitter
        if (functionName === "basketGuardian") return addresses.curatorGuardian
      }
      if (address === addresses.feeSplitter && functionName === "factory") {
        return addresses.basketFactory
      }
      if (address === BASKET) {
        if (functionName === "decimals") return 18
        if (functionName === "name") return state.basketName
        if (functionName === "symbol") return state.basketSymbol
        if (functionName === "constituents") return state.tokens
        if (functionName === "units") return state.units
        if (functionName === "getRequiredUnits") {
          return [state.tokens, state.units.map((units) => ceilMulDiv(args[0], units))]
        }
        if (functionName === "backingOf") {
          return [state.tokens, state.units.map((units) => (args[0] * units) / ONE)]
        }
        if (functionName === "mintPaused") return state.mintPaused
        if (functionName === "isFullyBacked") return state.isFullyBacked
        if (functionName === "totalSupply") return state.totalSupply
        if (functionName === "supplyCap") return state.supplyCap
        if (functionName === "mintFeeBps") return 30
        if (functionName === "guardian") return addresses.curatorGuardian
        if (functionName === "feeRecipient") return addresses.feeSplitter
        if (functionName === "balanceOf") return state.basketBalance
      }
      if (address === TOKEN_A || address === TOKEN_B) {
        if (functionName === "decimals") return address === TOKEN_A ? 6 : 18
        if (functionName === "symbol") {
          return address === TOKEN_A ? state.tokenASymbol : state.tokenBSymbol
        }
        if (functionName === "name") {
          return address === TOKEN_A ? state.tokenAName : state.tokenBName
        }
        if (functionName === "balanceOf") return state.tokenBalances[address]
        if (functionName === "allowance") return state.allowances[address]
        if (functionName === "supportsInterface") return true
        if (functionName === "uiMultiplier") return state.multipliers[address]
        if (functionName === "newUIMultiplier") return state.newMultipliers[address]
        if (functionName === "effectiveAt") return state.effectiveAts[address]
        if (functionName === "toUIAmount") return (args[0] * state.multipliers[address]) / ONE
        if (functionName === "fromUIAmount") return (args[0] * ONE) / state.multipliers[address]
      }
      throw new Error(`Unexpected read ${address}:${functionName}`)
    }),
    simulateContract: vi.fn(async (request) => ({ request })),
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
    getChainId: vi.fn(async () => 56),
    writeContract: vi.fn(async (request) => {
      writes.push({
        address: request.address,
        functionName: request.functionName,
        args: request.args || [],
      })
      if (request.functionName === "approve") state.allowances[request.address] = request.args[1]
      const hash = `0x${String(nonce).padStart(64, "0")}`
      nonce += 1
      return hash
    }),
  }

  return {
    publicClient,
    walletClient,
    account: ACCOUNT,
    addresses,
    basketAddress: BASKET,
    expectedRecipe,
    expectedBasket,
    amount: "1",
    state,
    writes,
  }
}

describe("basket reads and canonicality", () => {
  it("reads exact required units and constituent metadata", async () => {
    const result = await getBasketRequiredUnits(basketHarness())
    expect(result.basketAmount).toBe(ONE)
    expect(result.constituents).toEqual([
      expect.objectContaining({
        token: TOKEN_A,
        amount: UNITS_A,
        amountFormatted: "1.25",
        name: "Asset A",
        symbol: "ASSETA",
      }),
      expect.objectContaining({
        token: TOKEN_B,
        amount: UNITS_B,
        amountFormatted: "0.5",
        name: "Asset B",
        symbol: "ASSETB",
      }),
    ])
  })

  it("shows split-adjusted amounts while keeping raw basket units unchanged", async () => {
    const harness = basketHarness({
      state: {
        multipliers: { [TOKEN_A]: 2n * ONE, [TOKEN_B]: ONE },
        newMultipliers: { [TOKEN_A]: 2n * ONE, [TOKEN_B]: ONE },
      },
    })
    const requirements = await getBasketRequiredUnits(harness)

    expect(requirements.constituents[0]).toMatchObject({
      amount: UNITS_A,
      uiAmount: 2n * UNITS_A,
      amountFormatted: "2.5",
      uiMultiplier: 2n * ONE,
    })
    await expect(verifyBasketRecipe(harness)).resolves.toMatchObject({ basketAddress: BASKET })
  })

  it("rejects unsafe constituent metadata before any approval or mint write", async () => {
    const unsafeSymbol = basketHarness({ state: { tokenASymbol: "ASSET\u202eA" } })
    await expect(mintBasket(unsafeSymbol)).rejects.toMatchObject({ code: "INVALID_TEXT" })
    expect(unsafeSymbol.walletClient.writeContract).not.toHaveBeenCalled()
    expect(unsafeSymbol.writes).toEqual([])

    const unsafeName = basketHarness({ state: { tokenAName: "Asset\u0000A" } })
    await expect(mintBasket(unsafeName)).rejects.toMatchObject({ code: "INVALID_TEXT" })
    expect(unsafeName.walletClient.writeContract).not.toHaveBeenCalled()
    expect(unsafeName.writes).toEqual([])

    const unsafeRedemptionName = basketHarness({ state: { tokenBName: "Asset\u0000B" } })
    await expect(getBasketRedemptionReadiness(unsafeRedemptionName)).rejects.toMatchObject({
      code: "INVALID_TEXT",
    })
    expect(unsafeRedemptionName.walletClient.writeContract).not.toHaveBeenCalled()
    expect(unsafeRedemptionName.writes).toEqual([])
  })

  it("rejects unsafe basket metadata before recipe verification or writes", async () => {
    const harness = basketHarness({ state: { basketName: "Global\u202e Leaders" } })

    await expect(mintBasket(harness)).rejects.toMatchObject({ code: "INVALID_TEXT" })
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
    expect(harness.writes).toEqual([])
  })

  it("returns nominal redemption backing, metadata, balance, and blockers", async () => {
    const harness = basketHarness()
    const readiness = await getBasketRedemptionReadiness(harness)
    expect(readiness).toMatchObject({
      basketAddress: BASKET,
      creator: CREATOR,
      basketAmount: ONE,
      balance: 5n * ONE,
      canRedeem: true,
      blockers: [],
    })
    expect(readiness.backing).toEqual([
      expect.objectContaining({ token: TOKEN_A, amount: UNITS_A, amountFormatted: "1.25" }),
      expect.objectContaining({ token: TOKEN_B, amount: UNITS_B, amountFormatted: "0.5" }),
    ])

    const insufficient = basketHarness({ state: { basketBalance: ONE - 1n } })
    const blocked = await getBasketRedemptionReadiness(insufficient)
    expect(blocked).toMatchObject({
      canRedeem: false,
      blockers: ["INSUFFICIENT_BASKET_BALANCE"],
    })
  })

  it("reports backing state and blocks an underbacked basket from mint readiness", async () => {
    const harness = basketHarness({
      state: {
        allowances: { [TOKEN_A]: UNITS_A, [TOKEN_B]: UNITS_B },
        isFullyBacked: false,
      },
    })

    const readiness = await getBasketMintReadiness(harness)
    expect(readiness).toMatchObject({
      isFullyBacked: false,
      blockers: ["UNDERBACKED"],
      canMint: false,
    })
  })

  it("rejects malformed backing state", async () => {
    const harness = basketHarness({ state: { isFullyBacked: "yes" } })

    await expect(getBasketMintReadiness(harness)).rejects.toMatchObject({
      code: "INVALID_BASKET_STATE",
      userMessage: "The basket returned invalid backing data.",
    })
  })

  it("requires exact address order and raw units for a configured recipe", async () => {
    const harness = basketHarness()
    await expect(verifyBasketRecipe(harness)).resolves.toMatchObject({ basketAddress: BASKET })

    await expect(
      verifyBasketRecipe({
        ...harness,
        expectedBasket: {
          ...expectedBasket,
          constituents: [expectedRecipe[1], expectedRecipe[0]],
        },
      }),
    ).rejects.toMatchObject({ code: "BASKET_RECIPE_MISMATCH" })
    await expect(
      verifyBasketRecipe({
        ...harness,
        expectedBasket: null,
        expectedRecipe: null,
      }),
    ).rejects.toMatchObject({ code: "BASKET_RECIPE_REQUIRED" })
  })
})

describe("basket write sequencing", () => {
  it("rejects an underbacked basket before any approval or mint write", async () => {
    const harness = basketHarness({ state: { isFullyBacked: false } })

    await expect(mintBasket(harness)).rejects.toMatchObject({
      code: "UNDERBACKED",
      userMessage:
        "This basket is not fully backed. Minting is disabled until backing is restored.",
    })
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
    expect(harness.writes).toEqual([])
  })

  it("resets a partial allowance, approves the exact requirement, and re-verifies", async () => {
    const harness = basketHarness({
      state: { allowances: { [TOKEN_A]: 1n, [TOKEN_B]: UNITS_B } },
    })
    const result = await approveBasketConstituents(harness)
    expect(harness.writes).toEqual([
      { address: TOKEN_A, functionName: "approve", args: [BASKET, 0n] },
      { address: TOKEN_A, functionName: "approve", args: [BASKET, UNITS_A] },
    ])
    expect(result.readiness.canMint).toBe(true)
    expect(result.transactions).toHaveLength(2)
  })

  it("approves missing constituents sequentially before mint", async () => {
    const harness = basketHarness()
    const result = await mintBasket(harness)
    expect(harness.writes.map((write) => write.functionName)).toEqual([
      "approve",
      "approve",
      "mint",
    ])
    expect(harness.writes[0].args).toEqual([BASKET, UNITS_A])
    expect(harness.writes[1].args).toEqual([BASKET, UNITS_B])
    expect(harness.writes[2].args).toEqual([ONE, ACCOUNT])
    expect(result.approvalTransactions).toHaveLength(2)
    expect(result.readiness).toMatchObject({
      mintFeeBps: 30,
      feeAmount: 3_000_000_000_000_000n,
      netAmount: 997_000_000_000_000_000n,
      netAmountFormatted: "0.997",
    })
    expect(result.transaction.receipt.status).toBe("success")
  })

  it("retains confirmed approval hashes when a later wallet request fails", async () => {
    const harness = basketHarness()
    let requestIndex = 0
    harness.walletClient.writeContract = vi.fn(async (request) => {
      requestIndex += 1
      if (requestIndex === 1) {
        harness.state.allowances[request.address] = request.args[1]
        return FIRST_APPROVAL_HASH
      }
      throw Object.assign(new Error("User rejected the request"), { code: 4001 })
    })

    await expect(approveBasketConstituents(harness)).rejects.toMatchObject({
      code: "USER_REJECTED",
      details: { completedTransactionHashes: [FIRST_APPROVAL_HASH] },
    })
  })

  it("never approves or mints when balance, cap, pause, recipe, or provenance checks fail", async () => {
    const underfunded = basketHarness({
      state: { tokenBalances: { [TOKEN_A]: UNITS_A - 1n, [TOKEN_B]: UNITS_B } },
    })
    await expect(mintBasket(underfunded)).rejects.toMatchObject({
      code: "INSUFFICIENT_CONSTITUENT_BALANCE",
    })
    expect(underfunded.walletClient.writeContract).not.toHaveBeenCalled()

    const capped = basketHarness({ state: { totalSupply: 1000n * ONE } })
    await expect(mintBasket(capped)).rejects.toMatchObject({ code: "SUPPLY_CAP_EXCEEDED" })
    expect(capped.walletClient.writeContract).not.toHaveBeenCalled()

    const paused = basketHarness({ state: { mintPaused: true } })
    await expect(mintBasket(paused)).rejects.toMatchObject({ code: "MINT_PAUSED" })
    expect(paused.walletClient.writeContract).not.toHaveBeenCalled()

    const wrongRecipe = basketHarness({ state: { units: [UNITS_A + 1n, UNITS_B] } })
    await expect(mintBasket(wrongRecipe)).rejects.toMatchObject({
      code: "BASKET_RECIPE_MISMATCH",
    })
    expect(wrongRecipe.walletClient.writeContract).not.toHaveBeenCalled()

    const unknown = basketHarness({
      publicClient: {
        readContract: vi.fn(async ({ address, functionName }) => {
          if (address === addresses.basketFactory) {
            if (functionName === "creatorLicense") return addresses.creatorLicense
            if (functionName === "assetRegistry") return addresses.assetRegistry
            if (functionName === "splitter") return addresses.feeSplitter
            if (functionName === "basketGuardian") return addresses.curatorGuardian
            if (functionName === "creatorOf") {
              return "0x0000000000000000000000000000000000000000"
            }
          }
          if (address === addresses.feeSplitter && functionName === "factory") {
            return addresses.basketFactory
          }
          throw new Error("must stop at provenance")
        }),
      },
    })
    await expect(mintBasket(unknown)).rejects.toMatchObject({ code: "UNRECOGNIZED_BASKET" })
    expect(unknown.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("requires explicit pre-approval when automatic approvals are disabled", async () => {
    const harness = basketHarness()
    await expect(mintBasket({ ...harness, approveConstituents: false })).rejects.toMatchObject({
      code: "CONSTITUENT_APPROVAL_REQUIRED",
    })
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("expires a reviewed trade before any write when a multiplier changes", async () => {
    const harness = basketHarness({
      state: { allowances: { [TOKEN_A]: UNITS_A, [TOKEN_B]: UNITS_B } },
    })
    const review = await getBasketMintReadiness(harness)
    harness.state.multipliers[TOKEN_A] = 2n * ONE
    harness.state.newMultipliers[TOKEN_A] = 2n * ONE

    await expect(mintBasket({ ...harness, review })).rejects.toMatchObject({
      code: "REVIEW_STALE",
    })
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
    expect(harness.writes).toEqual([])
  })

  it("rejects a configured mint-fee mismatch before any approval or mint", async () => {
    const harness = basketHarness()
    await expect(
      mintBasket({
        ...harness,
        expectedBasket: { ...expectedBasket, mintFeeBps: 20 },
      }),
    ).rejects.toMatchObject({ code: "BASKET_RECIPE_MISMATCH" })
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("checks balance and expected backing before redeem, then simulates and waits", async () => {
    const harness = basketHarness()
    const result = await redeemBasket(harness)
    expect(harness.writes).toEqual([
      { address: BASKET, functionName: "redeem", args: [ONE, ACCOUNT] },
    ])
    expect(result.expectedConstituents).toEqual([
      { token: TOKEN_A, amount: UNITS_A },
      { token: TOKEN_B, amount: UNITS_B },
    ])

    const insufficient = basketHarness({ state: { basketBalance: ONE - 1n } })
    await expect(redeemBasket(insufficient)).rejects.toMatchObject({
      code: "INSUFFICIENT_BASKET_BALANCE",
    })
    expect(insufficient.walletClient.writeContract).not.toHaveBeenCalled()
  })
})
