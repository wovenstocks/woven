import { describe, expect, it, vi } from "vitest"
import {
  activateCreatorLicense,
  approveCreatorLicense,
  burnCreatorLicense,
  getCreatorLicenseStatus,
} from "./license"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const BURN_SINK = "0x000000000000000000000000000000000000dEaD"
const BURN_AMOUNT = 10_000n * 10n ** 18n
const RESET_APPROVAL_HASH = `0x${"b2".repeat(32)}`
const addresses = Object.freeze({
  wovenToken: "0x1000000000000000000000000000000000000001",
  creatorLicense: "0x1000000000000000000000000000000000000002",
  assetRegistry: "0x1000000000000000000000000000000000000003",
  feeSplitter: "0x1000000000000000000000000000000000000004",
  curatorGuardian: "0x1000000000000000000000000000000000000005",
  basketFactory: "0x1000000000000000000000000000000000000006",
})

function licenseHarness(overrides = {}) {
  const state = {
    licensed: false,
    balance: BURN_AMOUNT,
    allowance: 0n,
    symbol: "WOVEN",
    burnAmount: BURN_AMOUNT,
    burnSink: BURN_SINK,
    factoryCreatorLicense: addresses.creatorLicense,
    factoryAssetRegistry: addresses.assetRegistry,
    factorySplitter: addresses.feeSplitter,
    factoryGuardian: addresses.curatorGuardian,
    splitterFactory: addresses.basketFactory,
    ...overrides.state,
  }
  const writes = []
  let nonce = 1
  const publicClient = {
    getBytecode: vi.fn(async () => "0x6000"),
    readContract: vi.fn(async ({ address, functionName }) => {
      if (address === addresses.basketFactory) {
        if (functionName === "creatorLicense") return state.factoryCreatorLicense
        if (functionName === "assetRegistry") return state.factoryAssetRegistry
        if (functionName === "splitter") return state.factorySplitter
        if (functionName === "basketGuardian") return state.factoryGuardian
      }
      if (address === addresses.feeSplitter && functionName === "factory") {
        return state.splitterFactory
      }
      if (address === addresses.creatorLicense) {
        if (functionName === "isLicensed") return state.licensed
        if (functionName === "LICENSE_BURN_AMOUNT") return state.burnAmount
        if (functionName === "BURN_SINK") return state.burnSink
        if (functionName === "wovenToken") return addresses.wovenToken
      }
      if (address === addresses.wovenToken) {
        if (functionName === "decimals") return 18
        if (functionName === "symbol") return state.symbol
        if (functionName === "balanceOf") return state.balance
        if (functionName === "allowance") return state.allowance
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
      writes.push({ functionName: request.functionName, args: request.args || [] })
      if (request.functionName === "approve") state.allowance = request.args[1]
      if (request.functionName === "burnForLicense") {
        state.licensed = true
        state.allowance -= BURN_AMOUNT
        state.balance -= BURN_AMOUNT
      }
      const hash = `0x${String(nonce).padStart(64, "0")}`
      nonce += 1
      return hash
    }),
  }
  return { publicClient, walletClient, account: ACCOUNT, addresses, state, writes }
}

describe("creator license client", () => {
  it("reads exact license, balance, allowance, and immutable wiring", async () => {
    const harness = licenseHarness()
    const status = await getCreatorLicenseStatus(harness)
    expect(status).toMatchObject({
      licensed: false,
      burnAmount: BURN_AMOUNT,
      burnAmountFormatted: "10000",
      hasBalance: true,
      hasAllowance: false,
      symbol: "WOVEN",
    })
    expect(status.burnSink).toBe(BURN_SINK)
  })

  it("resets a nonzero allowance, approves exactly, then burns in order", async () => {
    const harness = licenseHarness({ state: { allowance: 1n } })
    const result = await activateCreatorLicense(harness)

    expect(harness.writes).toEqual([
      { functionName: "approve", args: [addresses.creatorLicense, 0n] },
      { functionName: "approve", args: [addresses.creatorLicense, BURN_AMOUNT] },
      { functionName: "burnForLicense", args: [] },
    ])
    expect(result.transactions).toHaveLength(3)
    expect(result.status.licensed).toBe(true)
    expect(harness.state.balance).toBe(0n)
  })

  it("does not write when already licensed or underfunded", async () => {
    const licensed = licenseHarness({ state: { licensed: true } })
    const result = await activateCreatorLicense(licensed)
    expect(result.alreadyLicensed).toBe(true)
    expect(licensed.walletClient.writeContract).not.toHaveBeenCalled()

    const underfunded = licenseHarness({ state: { balance: BURN_AMOUNT - 1n } })
    await expect(activateCreatorLicense(underfunded)).rejects.toMatchObject({
      code: "INSUFFICIENT_WOVEN_BALANCE",
    })
    expect(underfunded.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("rejects unsafe WOVEN metadata before approval or activation", async () => {
    const harness = licenseHarness({ state: { symbol: "WOV\u202eEN" } })

    await expect(activateCreatorLicense(harness)).rejects.toMatchObject({
      code: "INVALID_TEXT",
    })
    expect(harness.walletClient.writeContract).not.toHaveBeenCalled()
    expect(harness.writes).toEqual([])
  })

  it("keeps approval and burn available as explicit independent actions", async () => {
    const harness = licenseHarness()
    const approval = await approveCreatorLicense(harness)
    expect(approval.transactions).toHaveLength(1)
    expect(harness.state.allowance).toBe(BURN_AMOUNT)

    const activation = await burnCreatorLicense(harness)
    expect(activation.transaction.receipt.status).toBe("success")
    expect(activation.status.licensed).toBe(true)
  })

  it("retains a confirmed reset hash when the replacement approval is rejected", async () => {
    const harness = licenseHarness({ state: { allowance: 1n } })
    let requestIndex = 0
    harness.walletClient.writeContract = vi.fn(async (request) => {
      requestIndex += 1
      if (requestIndex === 1) {
        harness.state.allowance = request.args[1]
        return RESET_APPROVAL_HASH
      }
      throw Object.assign(new Error("User rejected the request"), { code: 4001 })
    })

    await expect(approveCreatorLicense(harness)).rejects.toMatchObject({
      code: "USER_REJECTED",
      details: { completedTransactionHashes: [RESET_APPROVAL_HASH] },
    })
  })

  it("fails closed on incomplete core config, missing bytecode, or altered constants", async () => {
    const incomplete = licenseHarness()
    const incompleteAddresses = { ...addresses, feeSplitter: "" }
    await expect(
      activateCreatorLicense({ ...incomplete, addresses: incompleteAddresses }),
    ).rejects.toMatchObject({ code: "CONTRACTS_UNAVAILABLE" })
    expect(incomplete.walletClient.writeContract).not.toHaveBeenCalled()

    const noCode = licenseHarness({ publicClient: { getBytecode: vi.fn(async () => "0x") } })
    await expect(activateCreatorLicense(noCode)).rejects.toMatchObject({
      code: "CONTRACT_CODE_MISSING",
    })
    expect(noCode.walletClient.writeContract).not.toHaveBeenCalled()

    const altered = licenseHarness({ state: { burnAmount: BURN_AMOUNT + 1n } })
    await expect(activateCreatorLicense(altered)).rejects.toMatchObject({
      code: "INVALID_LICENSE_AMOUNT",
    })
    expect(altered.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it("never approves or burns when factory or splitter wiring is inconsistent", async () => {
    const wrongLicense = licenseHarness({
      state: { factoryCreatorLicense: "0x9999999999999999999999999999999999999999" },
    })
    await expect(activateCreatorLicense(wrongLicense)).rejects.toMatchObject({
      code: "CONTRACT_CONFIGURATION_MISMATCH",
    })
    expect(wrongLicense.walletClient.writeContract).not.toHaveBeenCalled()

    const wrongSplitterFactory = licenseHarness({
      state: { splitterFactory: "0x9999999999999999999999999999999999999999" },
    })
    await expect(activateCreatorLicense(wrongSplitterFactory)).rejects.toMatchObject({
      code: "CONTRACT_CONFIGURATION_MISMATCH",
    })
    expect(wrongSplitterFactory.walletClient.writeContract).not.toHaveBeenCalled()
  })
})
