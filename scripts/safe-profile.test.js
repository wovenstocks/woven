import { describe, expect, it } from "vitest"
import { encodeAbiParameters, encodeEventTopics, keccak256 } from "viem"
import {
  assertPinnedBytecode,
  buildSafeDeployment,
  safeProxyFactoryAbi,
  safeProfile,
  storageWordAddress,
  validateSafeCreationEvidence,
} from "./safe-profile.mjs"

const OWNER = "0x1000000000000000000000000000000000000001"
const PROXY_CREATION_CODE = "0x6001600055"

describe("single-wallet Safe preparation", () => {
  it("builds deterministic unsigned deployment calldata", () => {
    const first = buildSafeDeployment({
      owner: OWNER,
      saltNonce: 0n,
      proxyCreationCode: PROXY_CREATION_CODE,
    })
    const second = buildSafeDeployment({
      owner: OWNER,
      saltNonce: 0n,
      proxyCreationCode: PROXY_CREATION_CODE,
    })

    expect(first).toEqual(second)
    expect(first.predictedSafe).toMatch(/^0x[0-9A-Fa-f]{40}$/)
    expect(first.initializer).toMatch(/^0x[0-9a-f]+$/i)
    expect(first.transactionData).toMatch(/^0x[0-9a-f]+$/i)
  })

  it("separates deployments by salt nonce", () => {
    const first = buildSafeDeployment({
      owner: OWNER,
      saltNonce: 0n,
      proxyCreationCode: PROXY_CREATION_CODE,
    })
    const second = buildSafeDeployment({
      owner: OWNER,
      saltNonce: 1n,
      proxyCreationCode: PROXY_CREATION_CODE,
    })

    expect(first.predictedSafe).not.toBe(second.predictedSafe)
  })

  it("decodes Safe storage addresses without accepting malformed words", () => {
    const word = `0x${"0".repeat(24)}${safeProfile.fallbackHandler.slice(2).toLowerCase()}`
    expect(storageWordAddress(word, "handler")).toBe(safeProfile.fallbackHandler)
    expect(() => storageWordAddress("0x01", "handler")).toThrow(/invalid storage word/i)
  })

  it("pins canonical Safe proxy and creation-factory bytecode", () => {
    expect(safeProfile.proxyRuntimeCodehash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(safeProfile.proxyFactoryRuntimeCodehash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(safeProfile.proxyCreationCodehash).toMatch(/^0x[0-9a-f]{64}$/)

    expect(() =>
      assertPinnedBytecode("0x6001600055", safeProfile.proxyCreationCodehash, "proxy"),
    ).toThrow(/codehash mismatch/i)

    const bytecode = "0x6001600055"
    expect(assertPinnedBytecode(bytecode, keccak256(bytecode), "fixture")).toBe(keccak256(bytecode))
  })

  it("binds Safe creation evidence to the pinned factory and emitted proxy", () => {
    const deployment = buildSafeDeployment({
      owner: OWNER,
      saltNonce: 0n,
      proxyCreationCode: PROXY_CREATION_CODE,
    })
    const transactionHash = `0x${"ab".repeat(32)}`
    const [topic0, topic1] = encodeEventTopics({
      abi: [safeProxyFactoryAbi.at(-1)],
      eventName: "ProxyCreation",
      args: { proxy: deployment.predictedSafe },
    })
    const transaction = {
      hash: transactionHash,
      from: OWNER,
      to: safeProfile.proxyFactory,
      input: deployment.transactionData,
    }
    const receipt = {
      transactionHash,
      status: "success",
      logs: [
        {
          address: safeProfile.proxyFactory,
          topics: [topic0, topic1],
          data: encodeAbiParameters([{ type: "address" }], [safeProfile.singleton]),
        },
      ],
    }

    expect(
      validateSafeCreationEvidence({
        safeAddress: deployment.predictedSafe,
        expectedOwner: OWNER,
        transaction,
        receipt,
      }),
    ).toMatchObject({
      transactionHash,
      factory: safeProfile.proxyFactory,
      creationSingleton: safeProfile.singleton,
    })

    expect(() =>
      validateSafeCreationEvidence({
        safeAddress: deployment.predictedSafe,
        expectedOwner: OWNER,
        transaction: { ...transaction, to: OWNER },
        receipt,
      }),
    ).toThrow(/pinned proxy factory/i)
  })
})
