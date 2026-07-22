import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { getContractAddress, keccak256 } from "viem"
import { normalizeAddress, quantityToDecimal, sha256 } from "./core.mjs"

const DIRECT_FOUNDRY_SURFACE = "metamask-direct-from-foundry-simulation"
const NETWORK_NAME = "bnb-smart-chain-mainnet"
const CHAIN_ID = 56

const PHASES = Object.freeze({
  core: Object.freeze([
    Object.freeze({
      id: "core-deploy-creator-license",
      transactionType: "CREATE",
      contractName: "CreatorLicense",
      functionName: null,
    }),
    Object.freeze({
      id: "core-deploy-asset-registry",
      transactionType: "CREATE",
      contractName: "CanonicalAssetRegistry",
      functionName: null,
    }),
    Object.freeze({
      id: "core-deploy-fee-splitter",
      transactionType: "CREATE",
      contractName: "FeeSplitter",
      functionName: null,
    }),
    Object.freeze({
      id: "core-deploy-curator-guardian",
      transactionType: "CREATE",
      contractName: "CuratorGuardian",
      functionName: null,
    }),
    Object.freeze({
      id: "core-deploy-basket-factory",
      transactionType: "CREATE",
      contractName: "BasketFactory",
      functionName: null,
    }),
    Object.freeze({
      id: "core-init-fee-splitter",
      transactionType: "CALL",
      contractName: "FeeSplitter",
      functionName: "initFactory(address)",
    }),
  ]),
  router: Object.freeze([
    Object.freeze({
      id: "router-deploy-uniswap-v4-adapter",
      transactionType: "CREATE",
      contractName: "UniswapV4ExactOutputAdapter",
      functionName: null,
    }),
    Object.freeze({
      id: "router-deploy-pancake-v3-adapter",
      transactionType: "CREATE",
      contractName: "PancakeV3ExactOutputAdapter",
      functionName: null,
    }),
    Object.freeze({
      id: "router-deploy-one-click-basket-router",
      transactionType: "CREATE",
      contractName: "OneClickBasketRouter",
      functionName: null,
    }),
  ]),
  core4: Object.freeze([
    Object.freeze({
      id: "core4-create-basket",
      transactionType: "CALL",
      contractName: "BasketFactory",
      functionName: "createBasket(string,string,address[],uint256[],uint16,uint256)",
    }),
  ]),
})

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`)
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON.`)
  }
}

function requiredIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(value)) {
    throw new Error(`${label} is not a valid identifier.`)
  }
  return value
}

function normalizeHexData(value, label) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error(`${label} must be non-empty, even-length 0x-prefixed bytes.`)
  }
  return value.toLowerCase()
}

function parseArguments(arguments_) {
  const allowed = new Set([
    "launch-record",
    "broadcast",
    "phase",
    "release-id",
    "attempt-id",
    "expires-at",
    "expected-commit",
    "record-output",
    "plan-output",
  ])
  const values = {}
  for (let index = 0; index < arguments_.length; index += 1) {
    const key = arguments_[index]
    if (!key.startsWith("--") || key.length === 2) throw new Error(`Unexpected argument: ${key}`)
    const normalized = key.slice(2)
    if (!allowed.has(normalized)) throw new Error(`Unsupported argument: ${key}.`)
    if (normalized in values) throw new Error(`${key} may be specified only once.`)
    const value = arguments_[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`)
    values[normalized] = value
    index += 1
  }
  return values
}

function normalizeExpiry(value, now) {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    throw new Error("Foundry-derived transactions require a valid UTC expiry ending in Z.")
  }
  const expiry = Date.parse(value)
  if (expiry <= now.getTime())
    throw new Error("Foundry-derived transaction expiry is not in the future.")
  if (expiry - now.getTime() > 24 * 60 * 60 * 1_000) {
    throw new Error("Foundry-derived transaction expiry may not exceed 24 hours.")
  }
  return value
}

function normalizeExpectedCommit(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error("Expected Git commit must be a full lowercase 40-character SHA-1.")
  }
  return value
}

function requireLaunchRecord(value) {
  assertObject(value, "Launch record")
  if (value.schema !== "woven-launch-signing-receipts/v1") {
    throw new Error("Launch record schema must be woven-launch-signing-receipts/v1.")
  }
  requiredIdentifier(value.releaseId, "Launch record release ID")
  requiredIdentifier(value.attemptId, "Launch record attempt ID")
  assertObject(value.network, "Launch record network")
  if (value.network.name !== NETWORK_NAME || value.network.chainId !== CHAIN_ID) {
    throw new Error("Foundry-derived plans are restricted to BNB Smart Chain mainnet.")
  }
  if (!Array.isArray(value.transactions))
    throw new Error("Launch record transactions must be an array.")
}

function requireBroadcast(value, expectedCommit, expectedLength) {
  assertObject(value, "Foundry dry-run broadcast")
  if (value.chain !== CHAIN_ID) throw new Error("Foundry dry-run chain must be 56.")
  if (
    typeof value.commit !== "string" ||
    value.commit.length < 7 ||
    !expectedCommit.startsWith(value.commit.toLowerCase())
  ) {
    throw new Error("Foundry dry-run commit does not match the reviewed Git commit.")
  }
  if (!Array.isArray(value.transactions) || value.transactions.length !== expectedLength) {
    throw new Error(`Foundry dry-run must contain exactly ${expectedLength} transaction(s).`)
  }
}

function updateCreatedContract(source, expectedCreatedContract, label) {
  if (expectedCreatedContract === null) return
  if (!Array.isArray(source.createdContracts) || source.createdContracts.length !== 1) {
    throw new Error(`${label} must declare exactly one created contract in the launch record.`)
  }
  source.createdContracts[0].address = expectedCreatedContract
}

function validateCoreRelationships(transactions) {
  const feeSplitter = normalizeAddress(transactions[2].contractAddress, "FeeSplitter address")
  const basketFactory = normalizeAddress(transactions[4].contractAddress, "BasketFactory address")
  const init = transactions[5]
  if (normalizeAddress(init.transaction.to, "FeeSplitter init target") !== feeSplitter) {
    throw new Error("Core init transaction does not target the simulated FeeSplitter.")
  }
  if (!Array.isArray(init.arguments) || normalizeAddress(init.arguments[0]) !== basketFactory) {
    throw new Error("Core init transaction does not bind the simulated BasketFactory.")
  }
}

export async function prepareFoundryPlan({
  launchRecordText,
  broadcastText,
  phase,
  releaseId = null,
  attemptId = null,
  expiresAtUtc,
  expectedCommit,
  now = new Date(),
}) {
  const mapping = PHASES[phase]
  if (!mapping) throw new Error(`Unsupported Foundry phase: ${phase}.`)
  const expiry = normalizeExpiry(expiresAtUtc, now)
  const normalizedCommit = normalizeExpectedCommit(expectedCommit)
  const launchRecord = parseJson(launchRecordText, "Launch record")
  const broadcast = parseJson(broadcastText, "Foundry dry-run broadcast")
  if (releaseId !== null) {
    const normalizedReleaseId = requiredIdentifier(releaseId, "Requested release ID")
    if (launchRecord.releaseId !== null && launchRecord.releaseId !== normalizedReleaseId) {
      throw new Error("Requested release ID does not match the launch record.")
    }
    launchRecord.releaseId = normalizedReleaseId
  }
  if (attemptId !== null) {
    const normalizedAttemptId = requiredIdentifier(attemptId, "Requested attempt ID")
    if (launchRecord.attemptId !== null && launchRecord.attemptId !== normalizedAttemptId) {
      throw new Error("Requested attempt ID does not match the launch record.")
    }
    launchRecord.attemptId = normalizedAttemptId
  }
  requireLaunchRecord(launchRecord)
  requireBroadcast(broadcast, normalizedCommit, mapping.length)
  if (phase === "core") validateCoreRelationships(broadcast.transactions)

  const launchTransactions = new Map(
    launchRecord.transactions.map((transaction) => [transaction.id, transaction]),
  )
  if (launchTransactions.size !== launchRecord.transactions.length) {
    throw new Error("Launch record contains duplicate transaction IDs.")
  }
  const simulationEvidenceSha256 = await sha256(broadcastText)
  const preparedTransactions = []
  let commonSender = null
  let previousNonce = null

  for (let index = 0; index < mapping.length; index += 1) {
    const expected = mapping[index]
    const foundry = broadcast.transactions[index]
    const label = `Foundry ${phase} transaction ${index + 1}`
    assertObject(foundry, label)
    assertObject(foundry.transaction, `${label} request`)
    if (
      foundry.transactionType !== expected.transactionType ||
      foundry.contractName !== expected.contractName ||
      foundry.function !== expected.functionName
    ) {
      throw new Error(`${label} does not match the expected ${expected.id} operation.`)
    }

    const sender = normalizeAddress(foundry.transaction.from, `${label} sender`)
    const target =
      foundry.transaction.to === null
        ? null
        : normalizeAddress(foundry.transaction.to, `${label} target`)
    const chainId = Number(quantityToDecimal(foundry.transaction.chainId, `${label} chain ID`))
    const nonce = quantityToDecimal(foundry.transaction.nonce, `${label} nonce`)
    const valueWei = quantityToDecimal(foundry.transaction.value, `${label} value`)
    const data = normalizeHexData(foundry.transaction.input, `${label} input`)
    if (chainId !== CHAIN_ID) throw new Error(`${label} is not a BNB mainnet transaction.`)
    if (commonSender !== null && sender !== commonSender) {
      throw new Error("Foundry phase transactions do not share one reviewed sender.")
    }
    commonSender = sender
    if (previousNonce !== null && BigInt(nonce) !== BigInt(previousNonce) + 1n) {
      throw new Error("Foundry phase transaction nonces are not contiguous.")
    }
    previousNonce = nonce

    let expectedCreatedContract = null
    if (expected.transactionType === "CREATE") {
      if (target !== null) throw new Error(`${label} contract creation unexpectedly has a target.`)
      expectedCreatedContract = normalizeAddress(
        foundry.contractAddress,
        `${label} expected contract`,
      )
      const independentlyDerived = getContractAddress({ from: sender, nonce: BigInt(nonce) })
      if (normalizeAddress(independentlyDerived) !== expectedCreatedContract) {
        throw new Error(`${label} predicted contract address does not match sender and nonce.`)
      }
    } else if (target === null) {
      throw new Error(`${label} call transaction is missing its target.`)
    }

    const source = launchTransactions.get(expected.id)
    if (!source) throw new Error(`Launch record is missing ${expected.id}.`)
    if (source.status !== "pending") {
      throw new Error(`Launch record transaction ${expected.id} is not pending.`)
    }
    if (
      source.signingSurface !== "foundry-external-signer" &&
      source.signingSurface !== DIRECT_FOUNDRY_SURFACE
    ) {
      throw new Error(`Launch record transaction ${expected.id} is not a Foundry deployment entry.`)
    }
    source.signingSurface = DIRECT_FOUNDRY_SURFACE
    source.from = sender
    source.to = target
    source.nonce = nonce
    source.valueWei = valueWei
    source.calldataKeccak256 = keccak256(data)
    source.simulationEvidenceSha256 = simulationEvidenceSha256
    updateCreatedContract(source, expectedCreatedContract, expected.id)

    preparedTransactions.push({
      id: expected.id,
      from: sender,
      to: target,
      nonce,
      valueWei,
      data,
      expectedCreatedContract,
      expiresAtUtc: expiry,
    })
  }

  return {
    launchRecord,
    plan: {
      schema: "woven-prepared-transaction-plan/v2",
      releaseId: launchRecord.releaseId,
      attemptId: launchRecord.attemptId,
      network: { name: NETWORK_NAME, chainId: CHAIN_ID },
      transactions: preparedTransactions,
    },
    simulationEvidenceSha256,
  }
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2))
  const required = [
    "launch-record",
    "broadcast",
    "phase",
    "release-id",
    "attempt-id",
    "expires-at",
    "expected-commit",
    "record-output",
    "plan-output",
  ]
  for (const key of required) {
    if (!arguments_[key]) throw new Error(`--${key} is required.`)
  }
  const launchRecordText = await readFile(path.resolve(arguments_["launch-record"]), "utf8")
  const broadcastText = await readFile(path.resolve(arguments_.broadcast), "utf8")
  const prepared = await prepareFoundryPlan({
    launchRecordText,
    broadcastText,
    phase: arguments_.phase,
    releaseId: arguments_["release-id"],
    attemptId: arguments_["attempt-id"],
    expiresAtUtc: arguments_["expires-at"],
    expectedCommit: arguments_["expected-commit"],
  })
  const recordOutput = path.resolve(arguments_["record-output"])
  const planOutput = path.resolve(arguments_["plan-output"])
  await writeFile(recordOutput, `${JSON.stringify(prepared.launchRecord, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  })
  await writeFile(planOutput, `${JSON.stringify(prepared.plan, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  })
  process.stdout.write(`Prepared Foundry-derived launch record: ${recordOutput}\n`)
  process.stdout.write(`Prepared Foundry-derived transaction plan: ${planOutput}\n`)
  process.stdout.write(`Simulation evidence: ${prepared.simulationEvidenceSha256}\n`)
}

const isCommandLine = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false

if (isCommandLine) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Foundry plan preparation failed: ${message}\n`)
    process.exitCode = 1
  })
}
