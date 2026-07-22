import { describe, expect, it } from "vitest"
import { keccak256 } from "viem"
import { prepareManifest } from "./prepare-manifest.mjs"

const FROM = "0x1111111111111111111111111111111111111111"
const TO = "0x2222222222222222222222222222222222222222"
const EVIDENCE_HASH = "3".repeat(64)

function launchRecord(signingSurface = "metamask-direct-transaction") {
  return {
    schema: "woven-launch-signing-receipts/v1",
    releaseId: "woven-2026-07-22",
    attemptId: "attempt-001",
    network: { name: "bnb-smart-chain-mainnet", chainId: 56 },
    transactions: [
      {
        id: "creator-approve-woven-license",
        signingSurface,
        from: FROM,
        to: TO,
        nonce: "7",
        valueWei: "0",
        calldataKeccak256: keccak256("0x1234"),
        decodedIntent: "Approve the reviewed creator-license amount",
        simulationEvidenceSha256: EVIDENCE_HASH,
        createdContracts: [],
        status: "pending",
      },
    ],
  }
}

function preparedPlan() {
  return {
    schema: "woven-prepared-transaction-plan/v2",
    releaseId: "woven-2026-07-22",
    attemptId: "attempt-001",
    network: { name: "bnb-smart-chain-mainnet", chainId: 56 },
    transactions: [
      {
        id: "creator-approve-woven-license",
        from: FROM,
        to: TO,
        nonce: "7",
        valueWei: "0",
        data: "0x1234",
        expectedCreatedContract: null,
        expiresAtUtc: null,
      },
    ],
  }
}

describe("release-console manifest preparation", () => {
  it("joins a final launch record with a reviewed direct-MetaMask transaction plan", async () => {
    const manifest = await prepareManifest({
      launchRecordText: JSON.stringify(launchRecord()),
      preparedPlanText: JSON.stringify(preparedPlan()),
      now: new Date("2026-07-22T12:00:00.000Z"),
    })
    expect(manifest).toMatchObject({
      schema: "woven-unsigned-transactions/v2",
      releaseId: "woven-2026-07-22",
      attemptId: "attempt-001",
      network: { chainId: 56 },
    })
    expect(manifest.transactions[0]).toMatchObject({
      id: "creator-approve-woven-license",
      from: FROM,
      to: TO,
      nonce: "7",
      data: "0x1234",
      description: "Approve the reviewed creator-license amount",
      simulationEvidenceSha256: `sha256:${EVIDENCE_HASH}`,
    })
    expect(manifest.manifestSha256).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("rejects Foundry-only, Safe and external-platform signing surfaces", async () => {
    for (const signingSurface of [
      "foundry-external-signer",
      "safe-transaction-signed-with-metamask",
      "metamask-or-four-meme-wallet-flow",
    ]) {
      await expect(
        prepareManifest({
          launchRecordText: JSON.stringify(launchRecord(signingSurface)),
          preparedPlanText: JSON.stringify(preparedPlan()),
        }),
      ).rejects.toThrow("unsupported signing surface")
    }
  })

  it("accepts an expiring nonce-bound Foundry-derived MetaMask transaction", async () => {
    const record = launchRecord("metamask-direct-from-foundry-simulation")
    const plan = preparedPlan()
    plan.transactions[0].expiresAtUtc = "2026-07-22T14:00:00.000Z"
    const manifest = await prepareManifest({
      launchRecordText: JSON.stringify(record),
      preparedPlanText: JSON.stringify(plan),
      now: new Date("2026-07-22T12:00:00.000Z"),
    })
    expect(manifest.transactions[0]).toMatchObject({
      nonce: "7",
      signingSurface: "metamask-direct-from-foundry-simulation",
    })
  })

  it("rejects confirmed entries and sender mismatches", async () => {
    const completed = launchRecord()
    completed.transactions[0].status = "confirmed"
    await expect(
      prepareManifest({
        launchRecordText: JSON.stringify(completed),
        preparedPlanText: JSON.stringify(preparedPlan()),
      }),
    ).rejects.toThrow("only pending entries")

    const mismatched = preparedPlan()
    mismatched.transactions[0].from = "0x3333333333333333333333333333333333333333"
    await expect(
      prepareManifest({
        launchRecordText: JSON.stringify(launchRecord()),
        preparedPlanText: JSON.stringify(mismatched),
      }),
    ).rejects.toThrow("sender does not match")

    const nonceMismatched = preparedPlan()
    nonceMismatched.transactions[0].nonce = "8"
    await expect(
      prepareManifest({
        launchRecordText: JSON.stringify(launchRecord()),
        preparedPlanText: JSON.stringify(nonceMismatched),
      }),
    ).rejects.toThrow("nonce does not match")
  })

  it("requires a recorded simulation evidence hash", async () => {
    const record = launchRecord()
    record.transactions[0].simulationEvidenceSha256 = null
    await expect(
      prepareManifest({
        launchRecordText: JSON.stringify(record),
        preparedPlanText: JSON.stringify(preparedPlan()),
      }),
    ).rejects.toThrow("simulation evidence SHA-256")
  })

  it("requires the prepared calldata to match the launch-record hash", async () => {
    const missing = launchRecord()
    missing.transactions[0].calldataKeccak256 = null
    await expect(
      prepareManifest({
        launchRecordText: JSON.stringify(missing),
        preparedPlanText: JSON.stringify(preparedPlan()),
      }),
    ).rejects.toThrow("calldata hash must be recorded")

    const mismatched = launchRecord()
    mismatched.transactions[0].calldataKeccak256 = `0x${"4".repeat(64)}`
    await expect(
      prepareManifest({
        launchRecordText: JSON.stringify(mismatched),
        preparedPlanText: JSON.stringify(preparedPlan()),
      }),
    ).rejects.toThrow("calldata does not match")
  })
})
