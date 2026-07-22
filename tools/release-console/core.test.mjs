import { describe, expect, it } from "vitest"
import {
  buildWalletTransaction,
  createReceiptRecord,
  createSubmittedRecord,
  isTransactionExpired,
  manifestHashPayload,
  normalizeAndVerifyManifest,
  sha256Json,
  transactionIntentPayload,
  verifyObservedTransaction,
} from "./core.mjs"

const FROM = "0x1111111111111111111111111111111111111111"
const TO = "0x2222222222222222222222222222222222222222"
const TX_HASH = `0x${"a".repeat(64)}`
const BLOCK_HASH = `0x${"b".repeat(64)}`

async function validManifest(overrides = {}) {
  const manifest = {
    schema: "woven-unsigned-transactions/v1",
    releaseId: "woven-2026-07-22",
    attemptId: "attempt-001",
    generatedAtUtc: "2026-07-22T12:00:00.000Z",
    network: { name: "bnb-smart-chain-mainnet", chainId: 56 },
    source: {
      launchRecordSchema: "woven-launch-signing-receipts/v1",
      launchRecordSha256: `sha256:${"1".repeat(64)}`,
      preparedPlanSchema: "woven-prepared-transaction-plan/v1",
      preparedPlanSha256: `sha256:${"2".repeat(64)}`,
    },
    transactions: [
      {
        id: "creator-approve-woven-license",
        sourceTransactionId: "creator-approve-woven-license",
        signingSurface: "metamask-direct-transaction",
        from: FROM,
        to: TO,
        valueWei: "0",
        data: "0x1234",
        description: "Approve the reviewed creator-license amount",
        expiresAtUtc: null,
        intentSha256: `sha256:${"0".repeat(64)}`,
      },
    ],
    manifestSha256: `sha256:${"0".repeat(64)}`,
    ...overrides,
  }
  for (const transaction of manifest.transactions) {
    transaction.intentSha256 = await sha256Json(transactionIntentPayload(manifest, transaction))
  }
  manifest.manifestSha256 = await sha256Json(manifestHashPayload(manifest))
  return manifest
}

describe("release-console manifest validation", () => {
  it("verifies the canonical manifest and transaction hashes", async () => {
    const manifest = await normalizeAndVerifyManifest(await validManifest())
    expect(manifest.network.chainId).toBe(56)
    expect(manifest.transactions[0].from).toBe(FROM)
  })

  it("rejects tampered transaction data", async () => {
    const manifest = await validManifest()
    manifest.transactions[0].data = "0xabcd"
    await expect(normalizeAndVerifyManifest(manifest)).rejects.toThrow("Intent hash mismatch")
  })

  it("rejects Foundry-only and Safe signing surfaces", async () => {
    for (const signingSurface of [
      "foundry-external-signer",
      "safe-transaction-signed-with-metamask",
    ]) {
      const manifest = await validManifest()
      manifest.transactions[0].signingSurface = signingSurface
      manifest.transactions[0].intentSha256 = await sha256Json(
        transactionIntentPayload(manifest, manifest.transactions[0]),
      )
      manifest.manifestSha256 = await sha256Json(manifestHashPayload(manifest))
      await expect(normalizeAndVerifyManifest(manifest)).rejects.toThrow(
        "not an approved direct MetaMask signing surface",
      )
    }
  })

  it("rejects unsupported chains, unknown fields and duplicate IDs", async () => {
    const wrongChain = await validManifest({
      network: { name: "ethereum-mainnet", chainId: 1 },
    })
    await expect(normalizeAndVerifyManifest(wrongChain)).rejects.toThrow("chain IDs 56 and 97")

    const unknown = await validManifest()
    unknown.remoteRpcUrl = "https://example.invalid"
    await expect(normalizeAndVerifyManifest(unknown)).rejects.toThrow("unsupported field")

    const duplicate = await validManifest()
    duplicate.transactions.push({ ...duplicate.transactions[0] })
    duplicate.manifestSha256 = await sha256Json(manifestHashPayload(duplicate))
    await expect(normalizeAndVerifyManifest(duplicate)).rejects.toThrow("Duplicate transaction ID")
  })

  it("requires an explicit expiry for the USDC canary", async () => {
    const manifest = await validManifest()
    manifest.transactions[0].id = "canary-mint-with-usdc"
    manifest.transactions[0].sourceTransactionId = "canary-mint-with-usdc"
    manifest.transactions[0].intentSha256 = await sha256Json(
      transactionIntentPayload(manifest, manifest.transactions[0]),
    )
    manifest.manifestSha256 = await sha256Json(manifestHashPayload(manifest))
    await expect(normalizeAndVerifyManifest(manifest)).rejects.toThrow(
      "requires an explicit UTC expiry",
    )
  })

  it("detects expired transaction intents", () => {
    expect(
      isTransactionExpired(
        { expiresAtUtc: "2026-07-22T12:00:00.000Z" },
        Date.parse("2026-07-22T12:00:01Z"),
      ),
    ).toBe(true)
    expect(isTransactionExpired({ expiresAtUtc: null })).toBe(false)
  })
})

describe("release-console transaction and receipt records", () => {
  it("builds only the reviewed wallet transaction fields", async () => {
    const manifest = await normalizeAndVerifyManifest(await validManifest())
    expect(buildWalletTransaction(manifest.transactions[0])).toEqual({
      from: FROM,
      to: TO,
      value: "0x0",
      data: "0x1234",
    })
  })

  it("compares the observed public transaction to the intent", async () => {
    const manifest = await normalizeAndVerifyManifest(await validManifest())
    const transaction = manifest.transactions[0]
    expect(
      verifyObservedTransaction(
        transaction,
        {
          from: FROM,
          to: TO,
          value: "0x0",
          input: "0x1234",
          chainId: "0x38",
          nonce: "0x7",
        },
        56,
      ),
    ).toMatchObject({ matches: true, mismatches: [] })

    expect(
      verifyObservedTransaction(
        transaction,
        {
          from: FROM,
          to: TO,
          value: "0x0",
          input: "0x1234",
          chainId: "0x61",
          nonce: "0x7",
        },
        56,
      ).mismatches,
    ).toContain("chain-id")
  })

  it("records submitted and confirmed receipts without wallet secrets", async () => {
    const manifest = await normalizeAndVerifyManifest(await validManifest())
    const transaction = manifest.transactions[0]
    const submitted = createSubmittedRecord({
      manifest,
      transaction,
      transactionHash: TX_HASH,
      submittedAtUtc: "2026-07-22T12:01:00.000Z",
    })
    expect(submitted).toMatchObject({ status: "submitted", receipt: null })

    const record = createReceiptRecord({
      manifest,
      transaction,
      transactionHash: TX_HASH,
      submittedAtUtc: submitted.submittedAtUtc,
      confirmedAtUtc: "2026-07-22T12:02:00.000Z",
      confirmationsObserved: 2,
      observedTransaction: {
        from: FROM,
        to: TO,
        value: "0x0",
        input: "0x1234",
        chainId: "0x38",
        nonce: "0x7",
      },
      receipt: {
        transactionHash: TX_HASH,
        blockNumber: "0x64",
        blockHash: BLOCK_HASH,
        status: "0x1",
        from: FROM,
        to: TO,
        contractAddress: null,
        gasUsed: "0x5208",
      },
    })
    expect(record).toMatchObject({
      status: "confirmed",
      confirmationsObserved: 2,
      receipt: { blockNumber: "100", gasUsed: "21000", status: 1 },
    })
  })

  it("marks a changed observed target as a mismatch", async () => {
    const manifest = await normalizeAndVerifyManifest(await validManifest())
    const transaction = manifest.transactions[0]
    const record = createReceiptRecord({
      manifest,
      transaction,
      transactionHash: TX_HASH,
      submittedAtUtc: "2026-07-22T12:01:00.000Z",
      confirmedAtUtc: "2026-07-22T12:02:00.000Z",
      confirmationsObserved: 2,
      observedTransaction: {
        from: FROM,
        to: "0x3333333333333333333333333333333333333333",
        value: "0x0",
        input: "0x1234",
        chainId: "0x38",
        nonce: "0x7",
      },
      receipt: {
        transactionHash: TX_HASH,
        blockNumber: "0x64",
        blockHash: BLOCK_HASH,
        status: "0x1",
        from: FROM,
        to: "0x3333333333333333333333333333333333333333",
        contractAddress: null,
        gasUsed: "0x5208",
      },
    })
    expect(record.status).toBe("mismatch")
    expect(record.validation.mismatches).toContain("target")
  })
})
