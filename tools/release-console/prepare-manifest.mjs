import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { keccak256 } from "viem"
import {
  manifestHashPayload,
  normalizeAddress,
  normalizeAndVerifyManifest,
  sha256,
  sha256Json,
  transactionIntentPayload,
} from "./core.mjs"

const ALLOWED_SIGNING_SURFACES = new Set([
  "metamask-direct-transaction-or-foundry-external-signer",
  "metamask-direct-transaction",
])
const PLAN_KEYS = ["schema", "releaseId", "attemptId", "network", "transactions"]
const PLAN_NETWORK_KEYS = ["name", "chainId"]
const PLAN_TRANSACTION_KEYS = ["id", "from", "to", "valueWei", "data", "expiresAtUtc"]

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`)
  }
}

function assertExactKeys(value, allowedKeys, label) {
  const keys = Object.keys(value)
  const unexpected = keys.filter((key) => !allowedKeys.includes(key))
  const missing = allowedKeys.filter((key) => !keys.includes(key))
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported field(s): ${unexpected.join(", ")}.`)
  }
  if (missing.length > 0) {
    throw new Error(`${label} is missing field(s): ${missing.join(", ")}.`)
  }
}

function requiredIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(value)) {
    throw new Error(`${label} is not a valid release identifier.`)
  }
  return value
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON.`)
  }
}

function parseArguments(arguments_) {
  const values = {}
  const allowed = new Set(["launch-record", "plan", "output"])
  for (let index = 0; index < arguments_.length; index += 1) {
    const key = arguments_[index]
    if (!key.startsWith("--") || key.length === 2) {
      throw new Error(`Unexpected argument: ${key}`)
    }
    const normalizedKey = key.slice(2)
    if (!allowed.has(normalizedKey)) throw new Error(`Unsupported argument: ${key}.`)
    if (normalizedKey in values) throw new Error(`${key} may be specified only once.`)
    const value = arguments_[index + 1]
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}.`)
    }
    values[normalizedKey] = value
    index += 1
  }
  return values
}

function normalizePlan(plan) {
  assertObject(plan, "Prepared transaction plan")
  assertExactKeys(plan, PLAN_KEYS, "Prepared transaction plan")
  if (plan.schema !== "woven-prepared-transaction-plan/v1") {
    throw new Error("Prepared transaction plan schema must be woven-prepared-transaction-plan/v1.")
  }
  assertObject(plan.network, "Prepared transaction plan network")
  assertExactKeys(plan.network, PLAN_NETWORK_KEYS, "Prepared transaction plan network")
  if (!Array.isArray(plan.transactions) || plan.transactions.length === 0) {
    throw new Error("Prepared transaction plan must contain at least one transaction.")
  }

  const ids = new Set()
  const transactions = plan.transactions.map((transaction, index) => {
    const label = `Prepared transaction ${index + 1}`
    assertObject(transaction, label)
    assertExactKeys(transaction, PLAN_TRANSACTION_KEYS, label)
    const id = requiredIdentifier(transaction.id, `${label} ID`)
    if (ids.has(id)) throw new Error(`Duplicate prepared transaction ID: ${id}.`)
    ids.add(id)
    if (typeof transaction.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(transaction.data)) {
      throw new Error(`${label} data must be non-empty, even-length 0x-prefixed bytes.`)
    }
    if (
      typeof transaction.valueWei !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(transaction.valueWei)
    ) {
      throw new Error(`${label} valueWei must be a canonical decimal string.`)
    }
    if (transaction.to !== null && typeof transaction.to !== "string") {
      throw new Error(`${label} target must be an address or null for contract creation.`)
    }
    if (transaction.expiresAtUtc !== null && typeof transaction.expiresAtUtc !== "string") {
      throw new Error(`${label} expiresAtUtc must be a UTC timestamp or null.`)
    }
    return {
      id,
      from: normalizeAddress(transaction.from, `${label} sender`),
      to: transaction.to === null ? null : normalizeAddress(transaction.to, `${label} target`),
      valueWei: transaction.valueWei,
      data: transaction.data.toLowerCase(),
      expiresAtUtc: transaction.expiresAtUtc,
    }
  })

  return {
    schema: plan.schema,
    releaseId: requiredIdentifier(plan.releaseId, "Prepared plan release ID"),
    attemptId: requiredIdentifier(plan.attemptId, "Prepared plan attempt ID"),
    network: plan.network,
    transactions,
  }
}

function requireLaunchRecord(record) {
  assertObject(record, "Launch record")
  if (record.schema !== "woven-launch-signing-receipts/v1") {
    throw new Error("Launch record schema must be woven-launch-signing-receipts/v1.")
  }
  const releaseId = requiredIdentifier(record.releaseId, "Launch record release ID")
  const attemptId = requiredIdentifier(record.attemptId, "Launch record attempt ID")
  assertObject(record.network, "Launch record network")
  if (!Array.isArray(record.transactions)) {
    throw new Error("Launch record transactions must be an array.")
  }
  return { releaseId, attemptId }
}

function requireHash(value, label) {
  if (typeof value !== "string" || !/^(?:sha256:)?[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be recorded before preparing a wallet manifest.`)
  }
}

export async function prepareManifest({ launchRecordText, preparedPlanText, now = new Date() }) {
  const launchRecord = parseJson(launchRecordText, "Launch record")
  const plan = normalizePlan(parseJson(preparedPlanText, "Prepared transaction plan"))
  const launchIds = requireLaunchRecord(launchRecord)

  if (launchIds.releaseId !== plan.releaseId || launchIds.attemptId !== plan.attemptId) {
    throw new Error("Release and attempt IDs must match between the launch record and plan.")
  }
  if (
    launchRecord.network.chainId !== plan.network.chainId ||
    launchRecord.network.name !== plan.network.name
  ) {
    throw new Error("Network must match between the launch record and prepared plan.")
  }

  const launchTransactions = new Map()
  for (const transaction of launchRecord.transactions) {
    if (launchTransactions.has(transaction.id)) {
      throw new Error(`Duplicate launch-record transaction ID: ${transaction.id}.`)
    }
    launchTransactions.set(transaction.id, transaction)
  }
  const manifest = {
    schema: "woven-unsigned-transactions/v1",
    releaseId: plan.releaseId,
    attemptId: plan.attemptId,
    generatedAtUtc: now.toISOString(),
    network: {
      name: plan.network.name,
      chainId: plan.network.chainId,
    },
    source: {
      launchRecordSchema: launchRecord.schema,
      launchRecordSha256: await sha256(launchRecordText),
      preparedPlanSchema: plan.schema,
      preparedPlanSha256: await sha256(preparedPlanText),
    },
    transactions: [],
    manifestSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  }

  for (const prepared of plan.transactions) {
    const source = launchTransactions.get(prepared.id)
    if (!source) {
      throw new Error(`Prepared transaction ${prepared.id} is absent from the launch record.`)
    }
    if (source.status !== "pending") {
      throw new Error(
        `Launch transaction ${prepared.id} is ${source.status}; only pending entries may be prepared.`,
      )
    }
    if (!ALLOWED_SIGNING_SURFACES.has(source.signingSurface)) {
      throw new Error(
        `Launch transaction ${prepared.id} uses unsupported signing surface ${source.signingSurface}.`,
      )
    }
    if (source.from !== null && normalizeAddress(source.from) !== prepared.from) {
      throw new Error(`Prepared sender does not match the launch record for ${prepared.id}.`)
    }
    if (source.to !== null && normalizeAddress(source.to) !== prepared.to) {
      throw new Error(`Prepared target does not match the launch record for ${prepared.id}.`)
    }
    if (source.valueWei !== null && source.valueWei !== prepared.valueWei) {
      throw new Error(`Prepared value does not match the launch record for ${prepared.id}.`)
    }
    if (typeof source.calldataKeccak256 !== "string") {
      throw new Error(`Launch record calldata hash must be recorded for ${prepared.id}.`)
    }
    if (keccak256(prepared.data) !== source.calldataKeccak256.toLowerCase()) {
      throw new Error(`Prepared calldata does not match the launch record hash for ${prepared.id}.`)
    }
    requireHash(source.simulationEvidenceSha256, `${prepared.id} simulation evidence SHA-256`)

    const transaction = {
      id: prepared.id,
      sourceTransactionId: prepared.id,
      signingSurface: source.signingSurface,
      from: prepared.from,
      to: prepared.to,
      valueWei: prepared.valueWei,
      data: prepared.data,
      description: source.decodedIntent,
      expiresAtUtc: prepared.expiresAtUtc,
      intentSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }
    transaction.intentSha256 = await sha256Json(transactionIntentPayload(manifest, transaction))
    manifest.transactions.push(transaction)
  }

  manifest.manifestSha256 = await sha256Json(manifestHashPayload(manifest))
  return normalizeAndVerifyManifest(manifest)
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2))
  if (!arguments_["launch-record"] || !arguments_.plan) {
    throw new Error(
      "Usage: prepare-manifest.mjs --launch-record <record.json> --plan <plan.json> [--output <manifest.json>]",
    )
  }

  const launchRecordText = await readFile(path.resolve(arguments_["launch-record"]), "utf8")
  const preparedPlanText = await readFile(path.resolve(arguments_.plan), "utf8")
  const manifest = await prepareManifest({ launchRecordText, preparedPlanText })
  const output = `${JSON.stringify(manifest, null, 2)}\n`

  if (arguments_.output) {
    const outputPath = path.resolve(arguments_.output)
    await writeFile(outputPath, output, { encoding: "utf8", flag: "wx", mode: 0o600 })
    process.stdout.write(`Prepared unsigned manifest: ${outputPath}\n`)
  } else {
    process.stdout.write(output)
  }
}

const isCommandLine = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false

if (isCommandLine) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Release manifest preparation failed: ${message}\n`)
    process.exitCode = 1
  })
}
