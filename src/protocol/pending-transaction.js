export const PENDING_TRANSACTION_VERSION = 1
export const PENDING_TRANSACTION_STORAGE_KEY = "woven.pending-transaction.v1"
export const PENDING_TRANSACTION_CONFIRMATIONS = 2n

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/
const ACTION_PATTERN = /^[a-z0-9][a-z0-9 .:/_-]{0,63}$/
const ZERO_ADDRESS = `0x${"0".repeat(40)}`
const MAX_STORED_LENGTH = 1_024
const RECONCILE_RECEIPT_TIMEOUT_MS = 10_000
const INPUT_KEYS = Object.freeze(["account", "action", "basket", "chainId", "hash"])
const STORED_KEYS = Object.freeze([...INPUT_KEYS, "version"])
let storageProbeSequence = 0

export class PendingTransactionGuardError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "PendingTransactionGuardError"
    this.code = code
  }
}

function guardError(code, message) {
  return new PendingTransactionGuardError(code, message)
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function normalizeAddress(value, label) {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw guardError("INVALID_PENDING_TRANSACTION", `${label} must be a valid EVM address.`)
  }

  const normalized = value.toLowerCase()
  if (normalized === ZERO_ADDRESS) {
    throw guardError("INVALID_PENDING_TRANSACTION", `${label} cannot be the zero address.`)
  }
  return normalized
}

function normalizeAction(value) {
  if (typeof value !== "string") {
    throw guardError("INVALID_PENDING_TRANSACTION", "Action must be a stable action identifier.")
  }

  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase()
  if (!ACTION_PATTERN.test(normalized)) {
    throw guardError(
      "INVALID_PENDING_TRANSACTION",
      "Action must contain 1 to 64 safe ASCII characters.",
    )
  }
  return normalized
}

function normalizeTransactionHash(value) {
  if (typeof value !== "string" || !TRANSACTION_HASH_PATTERN.test(value)) {
    throw guardError("INVALID_PENDING_TRANSACTION", "Hash must be a valid EVM transaction hash.")
  }
  return value.toLowerCase()
}

function normalizePendingTransaction(value, { stored = false } = {}) {
  const expectedKeys = stored ? STORED_KEYS : INPUT_KEYS
  if (
    !hasExactKeys(value, expectedKeys) ||
    (stored && value.version !== PENDING_TRANSACTION_VERSION)
  ) {
    throw guardError("INVALID_PENDING_TRANSACTION", "Pending transaction data is invalid.")
  }
  if (!Number.isSafeInteger(value.chainId) || value.chainId <= 0) {
    throw guardError("INVALID_PENDING_TRANSACTION", "Chain ID must be a positive safe integer.")
  }

  const transaction = {
    version: PENDING_TRANSACTION_VERSION,
    chainId: value.chainId,
    account: normalizeAddress(value.account, "Account"),
    action: normalizeAction(value.action),
    basket: value.basket === null ? null : normalizeAddress(value.basket, "Basket"),
    hash: normalizeTransactionHash(value.hash),
  }
  return Object.freeze(transaction)
}

export function pendingTransactionIdentity(value) {
  const transaction = normalizePendingTransaction(value, {
    stored: Object.hasOwn(value || {}, "version"),
  })
  return JSON.stringify([
    transaction.version,
    transaction.chainId,
    transaction.account,
    transaction.action,
    transaction.basket,
    transaction.hash,
  ])
}

function samePendingTransaction(left, right) {
  return pendingTransactionIdentity(left) === pendingTransactionIdentity(right)
}

function freezeState(state) {
  return Object.freeze(state)
}

function emptyState() {
  return freezeState({ status: "empty", locked: false, transaction: null })
}

function blockedState(reason, transaction = null) {
  return freezeState({ status: "blocked", locked: true, reason, transaction })
}

function pendingState(transaction, persistence, reason = null) {
  return freezeState({
    status: "pending",
    locked: true,
    transaction,
    persistence,
    reason,
  })
}

function parseStoredTransaction(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_STORED_LENGTH) {
    throw guardError("STORAGE_CORRUPT", "Stored pending transaction data is invalid.")
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw guardError("STORAGE_CORRUPT", "Stored pending transaction data is invalid.")
  }

  try {
    return normalizePendingTransaction(parsed, { stored: true })
  } catch {
    throw guardError("STORAGE_CORRUPT", "Stored pending transaction data is invalid.")
  }
}

function isStorageLike(storage) {
  return (
    storage &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  )
}

function defaultStorage() {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

function receiptNotFound(error) {
  const name = error?.name || ""
  const message = `${error?.shortMessage || ""} ${error?.message || ""}`
  return (
    /Transaction(?:Receipt)?NotFound/i.test(name) ||
    /receipt.*not found|not found.*receipt/i.test(message)
  )
}

function receiptWaitTimedOut(error) {
  const name = error?.name || ""
  const message = `${error?.shortMessage || ""} ${error?.message || ""}`
  return /WaitForTransactionReceiptTimeout|timeout|timed out/i.test(`${name} ${message}`)
}

function matchingFinalReceipt(receipt, transaction) {
  if (!receipt || (receipt.status !== "success" && receipt.status !== "reverted")) return false
  return (
    typeof receipt.transactionHash === "string" &&
    TRANSACTION_HASH_PATTERN.test(receipt.transactionHash) &&
    receipt.transactionHash.toLowerCase() === transaction.hash
  )
}

/**
 * Creates a single-slot guard for a transaction whose receipt could not be confirmed.
 * A different pending transaction can never overwrite the current slot.
 */
export function createPendingTransactionGuard(options = {}) {
  const hasStorageOverride = Object.hasOwn(options, "storage")
  const resolveStorage = () => (hasStorageOverride ? options.storage : defaultStorage())
  let memoryTransaction = null
  let memoryOrigin = null

  function storageAccess() {
    try {
      const storage = resolveStorage()
      return isStorageLike(storage) ? { available: true, storage } : { available: false }
    } catch {
      return { available: false }
    }
  }

  function read() {
    const access = storageAccess()
    if (!access.available) {
      return memoryTransaction
        ? pendingState(memoryTransaction, "memory", "storage-unavailable")
        : blockedState("storage-unavailable")
    }

    let raw
    try {
      raw = access.storage.getItem(PENDING_TRANSACTION_STORAGE_KEY)
    } catch {
      return memoryTransaction
        ? pendingState(memoryTransaction, "memory", "storage-unavailable")
        : blockedState("storage-unavailable")
    }

    if (raw === null) {
      return memoryTransaction ? pendingState(memoryTransaction, "memory") : emptyState()
    }

    try {
      const transaction = parseStoredTransaction(raw)
      memoryTransaction = transaction
      memoryOrigin = "local-storage"
      return pendingState(transaction, "local-storage")
    } catch {
      return blockedState("storage-corrupt", memoryTransaction)
    }
  }

  /**
   * Proves that the durable slot can be written before a wallet broadcast.
   * Memory state is deliberately insufficient: a reload must be able to recover
   * every hash that is submitted after this check succeeds.
   */
  function assertWritable() {
    const current = read()
    if (current.status === "pending") {
      throw guardError(
        "PENDING_TRANSACTION_EXISTS",
        "Another submitted transaction still requires confirmation.",
      )
    }
    if (current.reason === "storage-corrupt") {
      throw guardError(
        "STORAGE_CORRUPT",
        "Pending transaction storage is invalid and cannot be used safely.",
      )
    }
    if (current.status !== "empty") {
      throw guardError(
        "STORAGE_UNAVAILABLE",
        "Pending transaction storage is unavailable or not writable.",
      )
    }

    const access = storageAccess()
    if (!access.available) {
      throw guardError(
        "STORAGE_UNAVAILABLE",
        "Pending transaction storage is unavailable or not writable.",
      )
    }

    storageProbeSequence += 1
    const probeKey = `${PENDING_TRANSACTION_STORAGE_KEY}.probe.${Date.now().toString(36)}.${storageProbeSequence.toString(36)}`
    const probeValue = `${probeKey}:writable`

    try {
      if (access.storage.getItem(probeKey) !== null) {
        throw new Error("The pending transaction storage probe key is already occupied.")
      }
      access.storage.setItem(probeKey, probeValue)
      if (access.storage.getItem(probeKey) !== probeValue) {
        throw new Error("The pending transaction storage write could not be verified.")
      }
      access.storage.removeItem(probeKey)
      if (access.storage.getItem(probeKey) !== null) {
        throw new Error("The pending transaction storage cleanup could not be verified.")
      }
    } catch {
      try {
        access.storage.removeItem(probeKey)
      } catch {
        // Best-effort cleanup only. The failed probe remains fail-closed.
      }
      throw guardError(
        "STORAGE_UNAVAILABLE",
        "Pending transaction storage is unavailable or not writable.",
      )
    }

    const verified = read()
    if (verified.status !== "empty") {
      if (verified.status === "pending") {
        throw guardError(
          "PENDING_TRANSACTION_EXISTS",
          "Another submitted transaction still requires confirmation.",
        )
      }
      throw guardError(
        verified.reason === "storage-corrupt" ? "STORAGE_CORRUPT" : "STORAGE_UNAVAILABLE",
        "Pending transaction storage changed while write access was being verified.",
      )
    }
    return true
  }

  function persist(value) {
    const transaction = normalizePendingTransaction(value)
    const current = read()

    if (current.status === "pending") {
      if (samePendingTransaction(current.transaction, transaction)) return current
      throw guardError(
        "PENDING_TRANSACTION_EXISTS",
        "Another submitted transaction still requires confirmation.",
      )
    }
    if (current.reason === "storage-corrupt") {
      throw guardError(
        "STORAGE_CORRUPT",
        "Pending transaction storage is invalid and cannot be overwritten safely.",
      )
    }

    memoryTransaction = transaction
    memoryOrigin = "memory"
    const access = storageAccess()
    if (!access.available) {
      return pendingState(transaction, "memory", "storage-unavailable")
    }

    const serialized = JSON.stringify(transaction)
    try {
      access.storage.setItem(PENDING_TRANSACTION_STORAGE_KEY, serialized)
      const stored = parseStoredTransaction(access.storage.getItem(PENDING_TRANSACTION_STORAGE_KEY))
      if (!samePendingTransaction(stored, transaction)) {
        return blockedState("storage-corrupt", transaction)
      }
      memoryOrigin = "local-storage"
      return pendingState(stored, "local-storage")
    } catch {
      memoryOrigin = "unknown"
      return pendingState(transaction, "memory", "storage-unavailable")
    }
  }

  /**
   * Atomically replaces the hash of the exact pending transaction.
   * Replaying a completed replacement is idempotent; no other field can change.
   */
  function replaceHash(expectedValue, nextHashValue) {
    const expected = normalizePendingTransaction(expectedValue, {
      stored: Object.hasOwn(expectedValue || {}, "version"),
    })
    const replacement = Object.freeze({
      ...expected,
      hash: normalizeTransactionHash(nextHashValue),
    })
    const current = read()

    if (current.reason === "storage-corrupt") {
      throw guardError(
        "STORAGE_CORRUPT",
        "Pending transaction storage is invalid and cannot be overwritten safely.",
      )
    }
    if (current.status !== "pending") {
      throw guardError(
        current.reason === "storage-unavailable"
          ? "STORAGE_UNAVAILABLE"
          : "PENDING_TRANSACTION_MISMATCH",
        "The expected pending transaction is not currently locked.",
      )
    }

    // A compare-and-set replay may observe the intended postcondition. Treat it
    // as success without writing again, while still requiring every non-hash
    // identity field to match because `replacement` is derived from `expected`.
    if (samePendingTransaction(current.transaction, replacement)) return current
    if (!samePendingTransaction(current.transaction, expected)) {
      throw guardError(
        "PENDING_TRANSACTION_MISMATCH",
        "The pending transaction changed before its hash could be replaced.",
      )
    }

    const access = storageAccess()
    if (!access.available) {
      if (current.persistence !== "memory" || memoryOrigin !== "memory") {
        throw guardError(
          "STORAGE_UNAVAILABLE",
          "Pending transaction storage became unavailable before the hash update.",
        )
      }
      memoryTransaction = replacement
      return pendingState(replacement, "memory", "storage-unavailable")
    }

    let stored
    try {
      const raw = access.storage.getItem(PENDING_TRANSACTION_STORAGE_KEY)
      stored = raw === null ? null : parseStoredTransaction(raw)
    } catch (error) {
      throw guardError(
        error?.code === "STORAGE_CORRUPT" ? "STORAGE_CORRUPT" : "STORAGE_UNAVAILABLE",
        "Pending transaction storage could not be verified before the hash update.",
      )
    }

    if (stored && samePendingTransaction(stored, replacement)) {
      memoryTransaction = replacement
      memoryOrigin = "local-storage"
      return pendingState(replacement, "local-storage")
    }
    if (
      (stored && !samePendingTransaction(stored, expected)) ||
      (!stored && (current.persistence !== "memory" || memoryOrigin !== "memory"))
    ) {
      throw guardError(
        "PENDING_TRANSACTION_MISMATCH",
        "The pending transaction changed before its hash could be replaced.",
      )
    }

    const serialized = JSON.stringify(replacement)
    try {
      access.storage.setItem(PENDING_TRANSACTION_STORAGE_KEY, serialized)
    } catch {
      // A storage implementation can throw after committing. Verification below
      // determines the actual outcome instead of risking a second overwrite.
    }

    let verified
    try {
      const raw = access.storage.getItem(PENDING_TRANSACTION_STORAGE_KEY)
      verified = raw === null ? null : parseStoredTransaction(raw)
    } catch (error) {
      throw guardError(
        error?.code === "STORAGE_CORRUPT" ? "STORAGE_CORRUPT" : "STORAGE_UNAVAILABLE",
        "Pending transaction storage could not be verified after the hash update.",
      )
    }

    if (verified && samePendingTransaction(verified, replacement)) {
      memoryTransaction = replacement
      memoryOrigin = "local-storage"
      return pendingState(replacement, "local-storage")
    }
    if (verified && !samePendingTransaction(verified, expected)) {
      throw guardError(
        "PENDING_TRANSACTION_MISMATCH",
        "The pending transaction changed while its hash was being replaced.",
      )
    }
    throw guardError(
      "PENDING_TRANSACTION_UPDATE_FAILED",
      "The replacement transaction hash could not be stored safely.",
    )
  }

  function clear(expectedValue) {
    const expected = normalizePendingTransaction(expectedValue, {
      stored: Object.hasOwn(expectedValue || {}, "version"),
    })
    const current = read()
    if (current.status !== "pending" || !samePendingTransaction(current.transaction, expected)) {
      return false
    }

    const access = storageAccess()
    if (!access.available) {
      if (current.persistence !== "memory") return false
      memoryTransaction = null
      memoryOrigin = null
      return true
    }

    try {
      const raw = access.storage.getItem(PENDING_TRANSACTION_STORAGE_KEY)
      if (raw !== null) {
        const stored = parseStoredTransaction(raw)
        if (!samePendingTransaction(stored, expected)) return false
        access.storage.removeItem(PENDING_TRANSACTION_STORAGE_KEY)
        if (access.storage.getItem(PENDING_TRANSACTION_STORAGE_KEY) !== null) return false
      }
      memoryTransaction = null
      memoryOrigin = null
      return true
    } catch {
      return false
    }
  }

  async function reconcile(publicClient) {
    const current = read()
    if (current.status !== "pending") return current

    let transaction = current.transaction
    const canWaitForReceipt = typeof publicClient?.waitForTransactionReceipt === "function"
    const canReadReceipt =
      typeof publicClient?.getTransactionReceipt === "function" &&
      typeof publicClient?.getBlockNumber === "function"
    if (!canWaitForReceipt && !canReadReceipt) {
      return pendingState(transaction, current.persistence, "rpc-unavailable")
    }
    if (
      Number.isSafeInteger(publicClient.chain?.id) &&
      publicClient.chain.id !== transaction.chainId
    ) {
      return pendingState(transaction, current.persistence, "chain-mismatch")
    }

    if (canWaitForReceipt) {
      let replacementFailure = null
      let replacementOutcome = null
      let receipt

      try {
        receipt = await publicClient.waitForTransactionReceipt({
          hash: transaction.hash,
          checkReplacement: true,
          confirmations: Number(PENDING_TRANSACTION_CONFIRMATIONS),
          timeout: RECONCILE_RECEIPT_TIMEOUT_MS,
          onReplaced: (details) => {
            if (replacementFailure) return

            try {
              const replaced = replaceHash(transaction, details?.transaction?.hash)
              transaction = replaced.transaction
              replacementOutcome =
                details?.reason === "cancelled"
                  ? "cancelled"
                  : details?.reason === "repriced"
                    ? null
                    : "replaced-different"
            } catch (error) {
              replacementFailure = error
            }
          },
        })
      } catch (error) {
        const latest = read()
        if (replacementFailure) {
          return pendingState(
            latest.transaction || transaction,
            latest.persistence || current.persistence,
            "replacement-storage-error",
          )
        }
        return pendingState(
          latest.transaction || transaction,
          latest.persistence || current.persistence,
          receiptWaitTimedOut(error)
            ? "receipt-wait-timeout"
            : receiptNotFound(error)
              ? "receipt-not-found"
              : "rpc-error",
        )
      }

      if (replacementFailure) {
        const latest = read()
        return pendingState(
          latest.transaction || transaction,
          latest.persistence || current.persistence,
          "replacement-storage-error",
        )
      }
      if (
        !matchingFinalReceipt(receipt, transaction) ||
        typeof receipt.blockNumber !== "bigint" ||
        receipt.blockNumber < 0n
      ) {
        return pendingState(transaction, current.persistence, "invalid-or-pending-receipt")
      }
      if (!clear(transaction)) {
        return pendingState(transaction, current.persistence, "storage-clear-failed")
      }

      return freezeState({
        status: "resolved",
        locked: false,
        transaction,
        outcome: replacementOutcome || receipt.status,
        receipt,
      })
    }

    let receipt
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: transaction.hash })
    } catch (error) {
      return pendingState(
        transaction,
        current.persistence,
        receiptNotFound(error) ? "receipt-not-found" : "rpc-error",
      )
    }

    if (!matchingFinalReceipt(receipt, transaction)) {
      return pendingState(transaction, current.persistence, "invalid-or-pending-receipt")
    }
    if (typeof receipt.blockNumber !== "bigint" || receipt.blockNumber < 0n) {
      return pendingState(transaction, current.persistence, "invalid-or-pending-receipt")
    }

    let latestBlock
    try {
      latestBlock = await publicClient.getBlockNumber()
    } catch {
      return pendingState(transaction, current.persistence, "rpc-error")
    }
    if (typeof latestBlock !== "bigint" || latestBlock < receipt.blockNumber) {
      return pendingState(transaction, current.persistence, "invalid-or-pending-receipt")
    }
    const observedConfirmations = latestBlock - receipt.blockNumber + 1n
    if (observedConfirmations < PENDING_TRANSACTION_CONFIRMATIONS) {
      return pendingState(transaction, current.persistence, "confirmations-pending")
    }
    if (!clear(transaction)) {
      return pendingState(transaction, current.persistence, "storage-clear-failed")
    }

    return freezeState({
      status: "resolved",
      locked: false,
      transaction,
      outcome: receipt.status,
      receipt,
    })
  }

  return Object.freeze({ assertWritable, clear, persist, read, reconcile, replaceHash })
}

export const pendingTransactionGuard = createPendingTransactionGuard()
