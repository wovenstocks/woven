import { describe, expect, it } from "vitest"
import { getContractAddress } from "viem"
import { prepareFoundryPlan } from "./prepare-foundry-plan.mjs"

const FROM = "0x1111111111111111111111111111111111111111"
const COMMIT = "56cbbf5285bf8f7345b9aa3303f5431682cf56c0"
const IDS = [
  "core-deploy-creator-license",
  "core-deploy-asset-registry",
  "core-deploy-fee-splitter",
  "core-deploy-curator-guardian",
  "core-deploy-basket-factory",
  "core-init-fee-splitter",
]
const NAMES = [
  "CreatorLicense",
  "CanonicalAssetRegistry",
  "FeeSplitter",
  "CuratorGuardian",
  "BasketFactory",
]

function launchRecord() {
  return {
    schema: "woven-launch-signing-receipts/v1",
    releaseId: "woven-mainnet-2026-07-22",
    attemptId: "attempt-001",
    network: { name: "bnb-smart-chain-mainnet", chainId: 56 },
    transactions: IDS.map((id, index) => ({
      id,
      signingSurface: "foundry-external-signer",
      from: null,
      to: null,
      nonce: null,
      valueWei: "0",
      calldataKeccak256: null,
      decodedIntent: `Reviewed ${id}`,
      simulationEvidenceSha256: null,
      createdContracts: index < 5 ? [{ name: NAMES[index], address: null }] : [],
      status: "pending",
    })),
  }
}

function broadcast() {
  const transactions = NAMES.map((contractName, index) => {
    const nonce = 3n + BigInt(index)
    return {
      transactionType: "CREATE",
      contractName,
      function: null,
      contractAddress: getContractAddress({ from: FROM, nonce }),
      arguments: [],
      transaction: {
        from: FROM,
        to: null,
        gas: "0x100000",
        value: "0x0",
        input: `0x60${index.toString(16).padStart(2, "0")}`,
        nonce: `0x${nonce.toString(16)}`,
        chainId: "0x38",
      },
    }
  })
  transactions.push({
    transactionType: "CALL",
    contractName: "FeeSplitter",
    function: "initFactory(address)",
    contractAddress: transactions[2].contractAddress,
    arguments: [transactions[4].contractAddress],
    transaction: {
      from: FROM,
      to: transactions[2].contractAddress,
      gas: "0x10000",
      value: "0x0",
      input: "0x89106fb90000000000000000000000001111111111111111111111111111111111111111",
      nonce: "0x8",
      chainId: "0x38",
    },
  })
  return { chain: 56, commit: "56cbbf5", transactions }
}

function prepare(overrides = {}) {
  return prepareFoundryPlan({
    launchRecordText: JSON.stringify(launchRecord()),
    broadcastText: JSON.stringify(broadcast()),
    phase: "core",
    expiresAtUtc: "2026-07-22T14:00:00.000Z",
    expectedCommit: COMMIT,
    now: new Date("2026-07-22T12:00:00.000Z"),
    ...overrides,
  })
}

describe("Foundry dry-run to MetaMask plan preparation", () => {
  it("binds the exact simulated order, nonces, inputs and predicted contracts", async () => {
    const prepared = await prepare()
    expect(prepared.plan).toMatchObject({
      schema: "woven-prepared-transaction-plan/v2",
      releaseId: "woven-mainnet-2026-07-22",
      network: { chainId: 56 },
    })
    expect(prepared.plan.transactions).toHaveLength(6)
    expect(prepared.plan.transactions[0]).toMatchObject({
      id: "core-deploy-creator-license",
      from: FROM,
      nonce: "3",
      to: null,
    })
    expect(prepared.plan.transactions[5]).toMatchObject({
      id: "core-init-fee-splitter",
      nonce: "8",
      expectedCreatedContract: null,
    })
    expect(
      prepared.launchRecord.transactions
        .slice(0, 6)
        .every(
          ({ signingSurface }) => signingSurface === "metamask-direct-from-foundry-simulation",
        ),
    ).toBe(true)
    expect(prepared.simulationEvidenceSha256).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("rejects a changed commit, non-contiguous nonce or core relationship", async () => {
    await expect(prepare({ expectedCommit: "a".repeat(40) })).rejects.toThrow(
      "commit does not match",
    )

    const nonceChanged = broadcast()
    nonceChanged.transactions[1].transaction.nonce = "0x9"
    await expect(prepare({ broadcastText: JSON.stringify(nonceChanged) })).rejects.toThrow(
      "nonces are not contiguous",
    )

    const relationshipChanged = broadcast()
    relationshipChanged.transactions[5].arguments[0] = FROM
    await expect(prepare({ broadcastText: JSON.stringify(relationshipChanged) })).rejects.toThrow(
      "does not bind the simulated BasketFactory",
    )
  })
})
