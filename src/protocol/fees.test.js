import { encodeAbiParameters, encodeEventTopics } from "viem"
import { describe, expect, it, vi } from "vitest"
import { feeSplitterAbi } from "./abis"
import { distributeBasketFees, getFeeDistributionStatus } from "./fees"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const CREATOR = "0x1111111111111111111111111111111111111112"
const TREASURY = "0x1111111111111111111111111111111111111113"
const BASKET = "0x3000000000000000000000000000000000000001"
const OTHER_BASKET = "0x3000000000000000000000000000000000000002"
const HASH = `0x${"34".repeat(32)}`
const addresses = Object.freeze({
  wovenToken: "0x1000000000000000000000000000000000000001",
  creatorLicense: "0x1000000000000000000000000000000000000002",
  assetRegistry: "0x1000000000000000000000000000000000000003",
  feeSplitter: "0x1000000000000000000000000000000000000004",
  curatorGuardian: "0x1000000000000000000000000000000000000005",
  basketFactory: "0x1000000000000000000000000000000000000006",
})

function distributedLog(overrides = {}) {
  const basket = overrides.basket || BASKET
  const creator = overrides.creator || CREATOR
  const toCreator = overrides.toCreator ?? 6n * 10n ** 18n
  const toTreasury = overrides.toTreasury ?? 4n * 10n ** 18n

  return {
    address: overrides.address || addresses.feeSplitter,
    topics: encodeEventTopics({
      abi: feeSplitterAbi,
      eventName: "Distributed",
      args: { basket, creator },
    }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [toCreator, toTreasury]),
  }
}

function feeHarness(overrides = {}) {
  const state = {
    factoryCreator: CREATOR,
    splitterCreator: CREATOR,
    pendingBalance: 10n * 10n ** 18n,
    ...overrides.state,
  }
  const publicClient = {
    getBytecode: vi.fn(async () => "0x6000"),
    readContract: vi.fn(async ({ address, functionName }) => {
      if (address === addresses.basketFactory) {
        if (functionName === "creatorLicense") return addresses.creatorLicense
        if (functionName === "assetRegistry") return addresses.assetRegistry
        if (functionName === "splitter") return addresses.feeSplitter
        if (functionName === "basketGuardian") return addresses.curatorGuardian
        if (functionName === "creatorOf") return state.factoryCreator
      }
      if (address === addresses.feeSplitter) {
        if (functionName === "factory") return addresses.basketFactory
        if (functionName === "creatorOf") return state.splitterCreator
        if (functionName === "treasury") return TREASURY
        if (functionName === "CREATOR_SHARE_BPS") return 6_000n
      }
      if (address === BASKET && functionName === "balanceOf") return state.pendingBalance
      throw new Error(`Unexpected read ${address}:${functionName}`)
    }),
    simulateContract: vi.fn(async (request) => ({ request })),
    waitForTransactionReceipt: vi.fn(async () => ({
      status: "success",
      transactionHash: HASH,
      blockNumber: 1n,
      logs: [distributedLog()],
    })),
    ...overrides.publicClient,
  }
  const walletClient = {
    account: { address: ACCOUNT },
    getAddresses: vi.fn(async () => [ACCOUNT]),
    getChainId: vi.fn(async () => 56),
    writeContract: vi.fn(async () => HASH),
  }
  return {
    publicClient,
    walletClient,
    account: ACCOUNT,
    addresses,
    basketAddress: BASKET,
  }
}

describe("fee distribution client", () => {
  it("reads the registered pending balance and exact 60/40 amounts", async () => {
    const status = await getFeeDistributionStatus(feeHarness())
    expect(status).toMatchObject({
      basketAddress: BASKET,
      creator: CREATOR,
      treasury: TREASURY,
      creatorShareBps: 6000,
      pendingBalance: 10n * 10n ** 18n,
      creatorAmount: 6n * 10n ** 18n,
      treasuryAmount: 4n * 10n ** 18n,
      canDistribute: true,
    })
  })

  it("simulates and confirms a permissionless distribution", async () => {
    const harness = feeHarness()
    const result = await distributeBasketFees(harness)
    expect(harness.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: addresses.feeSplitter,
        functionName: "distribute",
        args: [BASKET],
      }),
    )
    expect(result.transaction.hash).toBe(HASH)
    expect(result.distribution).toEqual({
      basketAddress: BASKET,
      creator: CREATOR,
      treasury: TREASURY,
      creatorAmount: 6n * 10n ** 18n,
      treasuryAmount: 4n * 10n ** 18n,
      totalAmount: 10n * 10n ** 18n,
    })
  })

  it("returns receipt-proven amounts when the preflight balance became stale", async () => {
    const harness = feeHarness({
      publicClient: {
        waitForTransactionReceipt: vi.fn(async () => ({
          status: "success",
          transactionHash: HASH,
          blockNumber: 1n,
          logs: [
            distributedLog({
              toCreator: 3n * 10n ** 18n,
              toTreasury: 2n * 10n ** 18n,
            }),
          ],
        })),
      },
    })

    const result = await distributeBasketFees(harness)
    expect(result.status).toMatchObject({
      pendingBalance: 5n * 10n ** 18n,
      creatorAmount: 3n * 10n ** 18n,
      treasuryAmount: 2n * 10n ** 18n,
    })
    expect(result.distribution.totalAmount).toBe(5n * 10n ** 18n)
  })

  it.each([
    ["successful zero-noop", []],
    [
      "event from another contract",
      [distributedLog({ address: "0x9999999999999999999999999999999999999999" })],
    ],
    ["event for another basket", [distributedLog({ basket: OTHER_BASKET })]],
    [
      "event for another creator",
      [distributedLog({ creator: "0x9999999999999999999999999999999999999999" })],
    ],
    ["event with an invalid split", [distributedLog({ toCreator: 7n, toTreasury: 3n })]],
  ])("fails closed after a confirmed %s", async (_case, logs) => {
    const harness = feeHarness({
      publicClient: {
        waitForTransactionReceipt: vi.fn(async () => ({
          status: "success",
          transactionHash: HASH,
          blockNumber: 1n,
          logs,
        })),
      },
    })

    await expect(distributeBasketFees(harness)).rejects.toMatchObject({
      code: "FEE_DISTRIBUTION_EVENT_NOT_FOUND",
      txHash: HASH,
    })
  })

  it("never writes for unknown, inconsistently registered, or zero-fee baskets", async () => {
    const unknown = feeHarness({
      state: { factoryCreator: "0x0000000000000000000000000000000000000000" },
    })
    await expect(distributeBasketFees(unknown)).rejects.toMatchObject({
      code: "UNRECOGNIZED_BASKET",
    })
    expect(unknown.walletClient.writeContract).not.toHaveBeenCalled()

    const inconsistent = feeHarness({
      state: { splitterCreator: "0x9999999999999999999999999999999999999999" },
    })
    await expect(distributeBasketFees(inconsistent)).rejects.toMatchObject({
      code: "CONTRACT_CONFIGURATION_MISMATCH",
    })
    expect(inconsistent.walletClient.writeContract).not.toHaveBeenCalled()

    const empty = feeHarness({ state: { pendingBalance: 0n } })
    await expect(distributeBasketFees(empty)).rejects.toMatchObject({
      code: "NO_FEES_TO_DISTRIBUTE",
    })
    expect(empty.walletClient.writeContract).not.toHaveBeenCalled()
  })
})
