import { describe, expect, it } from "vitest"
import {
  eip1967Slots,
  parseBstockArgs,
  scaledUiInterfaceIds,
  storageWordAddress,
  verifyBstocks,
} from "./verify-bstocks.mjs"

const TOKEN_A = "0x1000000000000000000000000000000000000001"
const TOKEN_B = "0x2000000000000000000000000000000000000002"
const BEACON = "0x3000000000000000000000000000000000000003"
const IMPLEMENTATION = "0x4000000000000000000000000000000000000004"
const BASE = 10n ** 18n

function storageWord(address) {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`
}

function createClient({ unsupportedInterface, reportedSymbol = {} } = {}) {
  return {
    async getChainId() {
      return 56
    },
    async getBytecode({ address }) {
      if ([TOKEN_A, TOKEN_B, BEACON, IMPLEMENTATION].includes(address)) return "0x6000"
      return undefined
    },
    async getStorageAt({ address, slot }) {
      if (slot === eip1967Slots.implementation) return undefined
      if (slot === eip1967Slots.beacon && address === TOKEN_A) return storageWord(BEACON)
      return undefined
    },
    async readContract({ address, functionName, args = [] }) {
      if (address === BEACON && functionName === "implementation") return IMPLEMENTATION
      if (functionName === "symbol") {
        return reportedSymbol[address] ?? (address === TOKEN_A ? "NVDAB" : "MSFTB")
      }
      if (functionName === "decimals") return 18
      if (functionName === "supportsInterface") return args[0] !== unsupportedInterface
      if (functionName === "uiMultiplier" || functionName === "newUIMultiplier") return 2n * BASE
      if (functionName === "effectiveAt") return 0n
      if (functionName === "toUIAmount") return args[0] * 2n
      if (functionName === "fromUIAmount") return args[0] / 2n
      throw new Error(`Unexpected read: ${functionName}`)
    },
  }
}

describe("bStock technical verifier", () => {
  it("parses, validates, and sorts explicit SYMBOL=ADDRESS inputs", () => {
    const result = parseBstockArgs(["--network", "mainnet", `NVDAB=${TOKEN_A}`, `MSFTB=${TOKEN_B}`])

    expect(result.network).toBe("mainnet")
    expect(result.assets.map(({ symbol }) => symbol)).toEqual(["MSFTB", "NVDAB"])
    expect(() => parseBstockArgs([])).toThrow(/SYMBOL=ADDRESS/)
    expect(() => parseBstockArgs([`NVDAB=${TOKEN_A}`, `NVDAB=${TOKEN_B}`])).toThrow(
      /Duplicate asset symbol/,
    )
  })

  it("produces stable read-only evidence for direct and beacon-proxied tokens", async () => {
    const assets = parseBstockArgs([`NVDAB=${TOKEN_A}`, `MSFTB=${TOKEN_B}`]).assets
    const first = await verifyBstocks({
      client: createClient(),
      network: "mainnet",
      chainId: 56,
      assets,
    })
    const second = await verifyBstocks({
      client: createClient(),
      network: "mainnet",
      chainId: 56,
      assets: [...assets].reverse(),
    })

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.scope.readOnly).toBe(true)
    expect(first.scope.addressEvidence).toMatch(/does not prove/)
    expect(first.assets.map(({ symbol }) => symbol)).toEqual(["MSFTB", "NVDAB"])
    expect(first.assets[0].proxy.kind).toBe("none-detected")
    expect(first.assets[1].proxy).toEqual({
      kind: "beacon",
      implementationSlot: null,
      beaconSlot: BEACON,
      resolvedImplementation: IMPLEMENTATION,
    })
    expect(first.assets[1].erc8056.roundtrip).toEqual({
      rawInput: BASE.toString(),
      displayedAmount: (2n * BASE).toString(),
      rawOutput: BASE.toString(),
    })
  })

  it("fails closed on symbol and ERC-8056 mismatches", async () => {
    const assets = parseBstockArgs([`NVDAB=${TOKEN_A}`]).assets

    await expect(
      verifyBstocks({
        client: createClient({ reportedSymbol: { [TOKEN_A]: "FAKE" } }),
        network: "mainnet",
        chainId: 56,
        assets,
      }),
    ).rejects.toThrow(/reports symbol FAKE/)

    await expect(
      verifyBstocks({
        client: createClient({ unsupportedInterface: scaledUiInterfaceIds.pending }),
        network: "mainnet",
        chainId: 56,
        assets,
      }),
    ).rejects.toThrow(/pending-state interface/)
  })

  it("decodes only well-formed EIP-1967 storage words", () => {
    expect(storageWordAddress(undefined, "slot")).toBeNull()
    expect(storageWordAddress(storageWord(BEACON), "slot")).toBe(BEACON)
    expect(() => storageWordAddress(`0x01${"0".repeat(62)}`, "slot")).toThrow(/non-address data/)
  })
})
