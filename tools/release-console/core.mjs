const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/
const HEX_DATA_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/
const METAMASK_DIRECT_SIGNING_SURFACES = new Set([
  "metamask-direct-transaction",
  "metamask-direct-transaction-or-foundry-external-signer",
  "metamask-direct-from-foundry-simulation",
])

const NETWORKS = Object.freeze({
  56: Object.freeze({
    name: "bnb-smart-chain-mainnet",
    explorerBaseUrl: "https://bscscan.com",
  }),
  97: Object.freeze({
    name: "bnb-smart-chain-testnet",
    explorerBaseUrl: "https://testnet.bscscan.com",
  }),
})

const TOP_LEVEL_KEYS = Object.freeze([
  "schema",
  "releaseId",
  "attemptId",
  "generatedAtUtc",
  "network",
  "source",
  "transactions",
  "manifestSha256",
])
const NETWORK_KEYS = Object.freeze(["name", "chainId"])
const SOURCE_KEYS = Object.freeze([
  "launchRecordSchema",
  "launchRecordSha256",
  "preparedPlanSchema",
  "preparedPlanSha256",
])
const TRANSACTION_KEYS = Object.freeze([
  "id",
  "sourceTransactionId",
  "signingSurface",
  "from",
  "to",
  "nonce",
  "valueWei",
  "data",
  "expectedCreatedContract",
  "description",
  "simulationEvidenceSha256",
  "expiresAtUtc",
  "intentSha256",
])

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`)
  }
}

function assertExactKeys(value, allowedKeys, label) {
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key))
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported field(s): ${unexpected.join(", ")}.`)
  }

  const missing = allowedKeys.filter((key) => !(key in value))
  if (missing.length > 0) {
    throw new Error(`${label} is missing field(s): ${missing.join(", ")}.`)
  }
}

function requiredString(value, label, maximumLength = 512) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`)
  }
  const normalized = value.trim()
  if (normalized.length > maximumLength) {
    throw new Error(`${label} exceeds ${maximumLength} characters.`)
  }
  return normalized
}

function normalizeIdentifier(value, label) {
  const normalized = requiredString(value, label, 128)
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new Error(`${label} contains unsupported characters.`)
  }
  return normalized
}

export function normalizeAddress(value, label = "Address") {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new Error(`${label} must be a complete 20-byte address.`)
  }
  return value.toLowerCase()
}

function normalizeOptionalAddress(value, label) {
  if (value === null) return null
  return normalizeAddress(value, label)
}

function normalizeData(value, label = "Transaction data") {
  if (typeof value !== "string" || !HEX_DATA_PATTERN.test(value)) {
    throw new Error(`${label} must be even-length 0x-prefixed bytes.`)
  }
  if (value.length > 524_290) {
    throw new Error(`${label} exceeds the 256 KiB console limit.`)
  }
  return value.toLowerCase()
}

function normalizeDecimal(value, label) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical, non-negative decimal string.`)
  }
  return value
}

function normalizeSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must use the form sha256:<64 lowercase hex characters>.`)
  }
  return value
}

function normalizeNetwork(value) {
  assertObject(value, "Network")
  assertExactKeys(value, NETWORK_KEYS, "Network")
  if (!Number.isSafeInteger(value.chainId) || !NETWORKS[value.chainId]) {
    throw new Error("Only BNB Smart Chain chain IDs 56 and 97 are accepted.")
  }
  const expected = NETWORKS[value.chainId]
  if (value.name !== expected.name) {
    throw new Error(`Network name must be ${expected.name} for chain ${value.chainId}.`)
  }
  return { name: expected.name, chainId: value.chainId }
}

function normalizeSource(value) {
  assertObject(value, "Manifest source")
  assertExactKeys(value, SOURCE_KEYS, "Manifest source")
  if (value.launchRecordSchema !== "woven-launch-signing-receipts/v1") {
    throw new Error("Manifest source must reference woven-launch-signing-receipts/v1.")
  }
  if (value.preparedPlanSchema !== "woven-prepared-transaction-plan/v2") {
    throw new Error("Manifest source must reference woven-prepared-transaction-plan/v2.")
  }
  return {
    launchRecordSchema: value.launchRecordSchema,
    launchRecordSha256: normalizeSha256(value.launchRecordSha256, "Launch record SHA-256"),
    preparedPlanSchema: value.preparedPlanSchema,
    preparedPlanSha256: normalizeSha256(value.preparedPlanSha256, "Prepared plan SHA-256"),
  }
}

export function transactionIntentPayload(manifest, transaction) {
  return {
    schema: "woven-unsigned-transaction-intent/v2",
    releaseId: manifest.releaseId,
    attemptId: manifest.attemptId,
    chainId: manifest.network.chainId,
    id: transaction.id,
    sourceTransactionId: transaction.sourceTransactionId,
    signingSurface: transaction.signingSurface,
    from: transaction.from,
    to: transaction.to,
    nonce: transaction.nonce,
    valueWei: transaction.valueWei,
    data: transaction.data,
    expectedCreatedContract: transaction.expectedCreatedContract,
    description: transaction.description,
    simulationEvidenceSha256: transaction.simulationEvidenceSha256,
    expiresAtUtc: transaction.expiresAtUtc,
  }
}

export function manifestHashPayload(manifest) {
  return {
    schema: manifest.schema,
    releaseId: manifest.releaseId,
    attemptId: manifest.attemptId,
    generatedAtUtc: manifest.generatedAtUtc,
    network: manifest.network,
    source: manifest.source,
    transactions: manifest.transactions,
  }
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`
}

export async function sha256Json(value) {
  return sha256(JSON.stringify(value))
}

export async function normalizeAndVerifyManifest(value) {
  assertObject(value, "Manifest")
  assertExactKeys(value, TOP_LEVEL_KEYS, "Manifest")
  if (value.schema !== "woven-unsigned-transactions/v2") {
    throw new Error("Unsupported manifest schema; expected woven-unsigned-transactions/v2.")
  }

  const releaseId = normalizeIdentifier(value.releaseId, "Release ID")
  const attemptId = normalizeIdentifier(value.attemptId, "Attempt ID")
  const generatedAtUtc = requiredString(value.generatedAtUtc, "Generated timestamp", 64)
  if (!Number.isFinite(Date.parse(generatedAtUtc)) || !generatedAtUtc.endsWith("Z")) {
    throw new Error("Generated timestamp must be a valid UTC ISO-8601 value ending in Z.")
  }

  const network = normalizeNetwork(value.network)
  const source = normalizeSource(value.source)
  if (!Array.isArray(value.transactions) || value.transactions.length === 0) {
    throw new Error("Manifest must contain at least one prepared transaction.")
  }
  if (value.transactions.length > 64) {
    throw new Error("Manifest exceeds the 64-transaction console limit.")
  }

  const ids = new Set()
  const transactions = value.transactions.map((transaction, index) => {
    const label = `Transaction ${index + 1}`
    assertObject(transaction, label)
    assertExactKeys(transaction, TRANSACTION_KEYS, label)
    const id = normalizeIdentifier(transaction.id, `${label} ID`)
    if (ids.has(id)) throw new Error(`Duplicate transaction ID: ${id}.`)
    ids.add(id)

    const sourceTransactionId = normalizeIdentifier(
      transaction.sourceTransactionId,
      `${label} source transaction ID`,
    )
    if (id !== sourceTransactionId) {
      throw new Error(`${label} ID must equal its launch-record transaction ID.`)
    }
    const signingSurface = requiredString(
      transaction.signingSurface,
      `${label} signing surface`,
      128,
    )
    if (!METAMASK_DIRECT_SIGNING_SURFACES.has(signingSurface)) {
      throw new Error(`${label} is not an approved direct MetaMask signing surface.`)
    }
    const from = normalizeAddress(transaction.from, `${label} sender`)
    const to = normalizeOptionalAddress(transaction.to, `${label} target`)
    const nonce = normalizeDecimal(transaction.nonce, `${label} nonce`)
    const data = normalizeData(transaction.data, `${label} data`)
    const expectedCreatedContract = normalizeOptionalAddress(
      transaction.expectedCreatedContract,
      `${label} expected created contract`,
    )
    if (to === null && data === "0x") {
      throw new Error(`${label} contract creation requires non-empty bytecode.`)
    }
    if (to === null && expectedCreatedContract === null) {
      throw new Error(`${label} contract creation requires its expected contract address.`)
    }
    if (to !== null && expectedCreatedContract !== null) {
      throw new Error(`${label} call transaction cannot declare a created contract address.`)
    }

    let expiresAtUtc = null
    if (transaction.expiresAtUtc !== null) {
      expiresAtUtc = requiredString(transaction.expiresAtUtc, `${label} expiry`, 64)
      if (!Number.isFinite(Date.parse(expiresAtUtc)) || !expiresAtUtc.endsWith("Z")) {
        throw new Error(`${label} expiry must be a valid UTC ISO-8601 value ending in Z.`)
      }
    }
    if (id === "canary-mint-with-usdc" && expiresAtUtc === null) {
      throw new Error("The USDC canary transaction requires an explicit UTC expiry.")
    }
    if (signingSurface === "metamask-direct-from-foundry-simulation" && expiresAtUtc === null) {
      throw new Error("Foundry-derived MetaMask transactions require an explicit UTC expiry.")
    }

    return {
      id,
      sourceTransactionId,
      signingSurface,
      from,
      to,
      nonce,
      valueWei: normalizeDecimal(transaction.valueWei, `${label} valueWei`),
      data,
      expectedCreatedContract,
      description: requiredString(transaction.description, `${label} description`, 2_000),
      simulationEvidenceSha256: normalizeSha256(
        transaction.simulationEvidenceSha256,
        `${label} simulation evidence SHA-256`,
      ),
      expiresAtUtc,
      intentSha256: normalizeSha256(transaction.intentSha256, `${label} intent SHA-256`),
    }
  })

  const manifest = {
    schema: value.schema,
    releaseId,
    attemptId,
    generatedAtUtc,
    network,
    source,
    transactions,
    manifestSha256: normalizeSha256(value.manifestSha256, "Manifest SHA-256"),
  }

  for (const transaction of manifest.transactions) {
    const calculated = await sha256Json(transactionIntentPayload(manifest, transaction))
    if (calculated !== transaction.intentSha256) {
      throw new Error(`Intent hash mismatch for transaction ${transaction.id}.`)
    }
  }

  const calculatedManifestHash = await sha256Json(manifestHashPayload(manifest))
  if (calculatedManifestHash !== manifest.manifestSha256) {
    throw new Error("Manifest SHA-256 does not match its canonical contents.")
  }

  return Object.freeze({
    ...manifest,
    transactions: Object.freeze(
      manifest.transactions.map((transaction) => Object.freeze(transaction)),
    ),
  })
}

export function isTransactionExpired(transaction, now = Date.now()) {
  return transaction.expiresAtUtc !== null && Date.parse(transaction.expiresAtUtc) <= now
}

export function transactionSequenceFailure(transactions, receiptRecords, transactionId) {
  const transactionIndex = transactions.findIndex(({ id }) => id === transactionId)
  if (transactionIndex < 0) throw new Error("Transaction is absent from the active manifest.")
  if (receiptRecords.has(transactionId)) return "Already submitted"
  for (const prerequisite of transactions.slice(0, transactionIndex)) {
    const record = receiptRecords.get(prerequisite.id)
    if (!record) return "Previous step pending"
    if (record.status !== "confirmed") return "Previous step failed"
  }
  return null
}

export function decimalToQuantity(valueWei) {
  const normalized = normalizeDecimal(valueWei, "valueWei")
  return `0x${BigInt(normalized).toString(16)}`
}

export function quantityToDecimal(value, label = "RPC quantity") {
  // Browser-wallet providers occasionally zero-pad JSON-RPC quantities (for example, `0x04`).
  // Accept that lossless representation, then normalize it immediately through BigInt. Decimal
  // strings, numbers, signs, empty hex and non-hex data remain rejected.
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    const received = typeof value === "string" ? JSON.stringify(value) : typeof value
    throw new Error(`${label} is not a hexadecimal quantity (received ${received}).`)
  }
  return BigInt(value).toString(10)
}

export function buildWalletTransaction(transaction) {
  const request = {
    from: transaction.from,
    nonce: decimalToQuantity(transaction.nonce),
    value: decimalToQuantity(transaction.valueWei),
    data: transaction.data,
  }
  if (transaction.to !== null) request.to = transaction.to
  return request
}

export function normalizeTransactionHash(value, label = "Transaction hash") {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a complete 32-byte hash.`)
  }
  return value.toLowerCase()
}

function nullableNormalizedAddress(value, label) {
  if (value === null || value === undefined) return null
  return normalizeAddress(value, label)
}

export function verifyObservedTransaction(transaction, observed, expectedChainId = null) {
  assertObject(observed, "Observed transaction")
  const observedFrom = normalizeAddress(observed.from, "Observed sender")
  const observedTo = nullableNormalizedAddress(observed.to, "Observed target")
  const observedData = normalizeData(observed.input ?? observed.data, "Observed data")
  const observedValueWei = quantityToDecimal(observed.value, "Observed value")
  const observedNonce = quantityToDecimal(observed.nonce, "Observed nonce")
  const observedChainId = observed.chainId
    ? Number(quantityToDecimal(observed.chainId, "Observed chain ID"))
    : null
  if (observedChainId !== null && !Number.isSafeInteger(observedChainId)) {
    throw new Error("Observed chain ID exceeds the safe integer range.")
  }

  const mismatches = []
  if (observedFrom !== transaction.from) mismatches.push("sender")
  if (observedTo !== transaction.to) mismatches.push("target")
  if (observedData !== transaction.data) mismatches.push("data")
  if (observedValueWei !== transaction.valueWei) mismatches.push("value")
  if (observedNonce !== transaction.nonce) mismatches.push("nonce")
  if (expectedChainId !== null && observedChainId !== null && observedChainId !== expectedChainId) {
    mismatches.push("chain-id")
  }
  return {
    matches: mismatches.length === 0,
    mismatches,
    normalized: {
      from: observedFrom,
      to: observedTo,
      valueWei: observedValueWei,
      data: observedData,
      chainId: observedChainId,
      nonce: observedNonce,
    },
  }
}

export function createReceiptRecord({
  manifest,
  transaction,
  transactionHash,
  submittedAtUtc,
  confirmedAtUtc,
  observedTransaction,
  receipt,
  confirmationsObserved,
}) {
  assertObject(receipt, "Receipt")
  const normalizedHash = normalizeTransactionHash(transactionHash)
  const receiptHash = normalizeTransactionHash(receipt.transactionHash, "Receipt transaction hash")
  if (normalizedHash !== receiptHash)
    throw new Error("Receipt transaction hash does not match submission.")

  const observed = verifyObservedTransaction(
    transaction,
    observedTransaction,
    manifest.network.chainId,
  )
  const receiptFrom = normalizeAddress(receipt.from, "Receipt sender")
  const receiptTo = nullableNormalizedAddress(receipt.to, "Receipt target")
  const receiptContractAddress = nullableNormalizedAddress(
    receipt.contractAddress,
    "Receipt contract address",
  )
  const receiptStatus = quantityToDecimal(receipt.status, "Receipt status")
  const receiptMatchesIntent =
    receiptFrom === transaction.from &&
    receiptTo === transaction.to &&
    receiptContractAddress === transaction.expectedCreatedContract
  const successful = receiptStatus === "1"
  const status =
    !observed.matches || !receiptMatchesIntent ? "mismatch" : successful ? "confirmed" : "reverted"

  return {
    schema: "woven-release-transaction-receipt/v1",
    releaseId: manifest.releaseId,
    attemptId: manifest.attemptId,
    manifestSha256: manifest.manifestSha256,
    id: transaction.id,
    intentSha256: transaction.intentSha256,
    description: transaction.description,
    chainId: manifest.network.chainId,
    intendedTransaction: {
      from: transaction.from,
      to: transaction.to,
      nonce: transaction.nonce,
      valueWei: transaction.valueWei,
      data: transaction.data,
      expectedCreatedContract: transaction.expectedCreatedContract,
      simulationEvidenceSha256: transaction.simulationEvidenceSha256,
    },
    transactionHash: normalizedHash,
    explorerUrl: `${NETWORKS[manifest.network.chainId].explorerBaseUrl}/tx/${normalizedHash}`,
    submittedAtUtc,
    confirmedAtUtc,
    status,
    confirmationsObserved,
    observedTransaction: observed.normalized,
    validation: {
      observedTransactionMatchesIntent: observed.matches,
      receiptMatchesIntent,
      mismatches: [
        ...observed.mismatches,
        ...(receiptFrom !== transaction.from ? ["receipt-sender"] : []),
        ...(receiptTo !== transaction.to ? ["receipt-target"] : []),
        ...(receiptContractAddress !== transaction.expectedCreatedContract
          ? ["receipt-contract-address"]
          : []),
      ],
    },
    receipt: {
      transactionHash: receiptHash,
      blockNumber: quantityToDecimal(receipt.blockNumber, "Receipt block number"),
      blockHash: normalizeTransactionHash(receipt.blockHash, "Receipt block hash"),
      status: Number(receiptStatus),
      from: receiptFrom,
      to: receiptTo,
      contractAddress: receiptContractAddress,
      gasUsed: quantityToDecimal(receipt.gasUsed, "Receipt gas used"),
    },
  }
}

export function createSubmittedRecord({ manifest, transaction, transactionHash, submittedAtUtc }) {
  const normalizedHash = normalizeTransactionHash(transactionHash)
  return {
    schema: "woven-release-transaction-receipt/v1",
    releaseId: manifest.releaseId,
    attemptId: manifest.attemptId,
    manifestSha256: manifest.manifestSha256,
    id: transaction.id,
    intentSha256: transaction.intentSha256,
    description: transaction.description,
    chainId: manifest.network.chainId,
    intendedTransaction: {
      from: transaction.from,
      to: transaction.to,
      nonce: transaction.nonce,
      valueWei: transaction.valueWei,
      data: transaction.data,
      expectedCreatedContract: transaction.expectedCreatedContract,
      simulationEvidenceSha256: transaction.simulationEvidenceSha256,
    },
    transactionHash: normalizedHash,
    explorerUrl: `${NETWORKS[manifest.network.chainId].explorerBaseUrl}/tx/${normalizedHash}`,
    submittedAtUtc,
    confirmedAtUtc: null,
    status: "submitted",
    confirmationsObserved: 0,
    observedTransaction: null,
    validation: null,
    receipt: null,
  }
}

export function exportReceiptBundle(manifest, records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("There are no receipt records to export.")
  }
  return {
    schema: "woven-release-console-receipts/v1",
    exportedAtUtc: new Date().toISOString(),
    releaseId: manifest.releaseId,
    attemptId: manifest.attemptId,
    network: manifest.network,
    source: manifest.source,
    manifestSha256: manifest.manifestSha256,
    records,
  }
}

export const releaseConsoleNetworks = NETWORKS
