const FINAL_LIFECYCLE_STATUSES = new Set([
  "confirmed",
  "reverted",
  "cancelled",
  "replaced-different",
])

function requireGuard(guard) {
  if (
    !guard ||
    typeof guard.persist !== "function" ||
    typeof guard.replaceHash !== "function" ||
    typeof guard.clear !== "function"
  ) {
    throw new TypeError("A pending transaction guard is required.")
  }
  return guard
}

function requireLifecycleEvent(event) {
  if (!event || typeof event !== "object" || typeof event.status !== "string") {
    throw new TypeError("A valid transaction lifecycle event is required.")
  }
  return event
}

function requireDurableState(state) {
  if (state?.status !== "pending" || state.persistence !== "local-storage") {
    throw new Error("The submitted transaction could not be stored durably.")
  }
  return state
}

/**
 * Binds one protocol action to the single-slot pending transaction guard.
 * Every broadcast hash is persisted before receipt polling begins. A repriced
 * transaction atomically replaces that hash, and only a known terminal event
 * can clear the exact record.
 */
export function createPendingTransactionLifecycle(options = {}) {
  const guard = requireGuard(options.guard)
  const identity = Object.freeze({
    chainId: options.chainId,
    account: options.account,
    action: options.action,
    basket: options.basket ?? null,
  })
  let trackedTransaction = null

  const replaceTrackedHash = (nextHash) => {
    if (!trackedTransaction) {
      throw new Error("A replacement hash was received before a transaction was submitted.")
    }
    const state = requireDurableState(guard.replaceHash(trackedTransaction, nextHash))
    trackedTransaction = state.transaction
    return state
  }

  const handle = (value) => {
    const event = requireLifecycleEvent(value)

    if (event.status === "submitted") {
      const state = requireDurableState(
        guard.persist({
          ...identity,
          hash: event.txHash,
        }),
      )
      trackedTransaction = state.transaction
      return state
    }

    if (event.status === "replaced") {
      return replaceTrackedHash(event.txHash)
    }

    if (event.status === "unconfirmed") {
      return trackedTransaction
    }

    if (FINAL_LIFECYCLE_STATUSES.has(event.status)) {
      if (!trackedTransaction) return null
      if (
        typeof event.txHash === "string" &&
        trackedTransaction.hash.toLowerCase() !== event.txHash.toLowerCase()
      ) {
        replaceTrackedHash(event.txHash)
      }
      const finalizedTransaction = trackedTransaction
      if (!guard.clear(finalizedTransaction)) {
        throw new Error("The finalized transaction lock could not be cleared safely.")
      }
      trackedTransaction = null
      return finalizedTransaction
    }

    throw new TypeError(`Unsupported transaction lifecycle status: ${event.status}`)
  }

  return Object.freeze({
    current: () => trackedTransaction,
    handle,
  })
}
