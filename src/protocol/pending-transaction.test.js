import { describe, expect, it, vi } from "vitest"
import {
  PENDING_TRANSACTION_STORAGE_KEY,
  PENDING_TRANSACTION_CONFIRMATIONS,
  PENDING_TRANSACTION_VERSION,
  createPendingTransactionGuard,
  pendingTransactionIdentity,
} from "./pending-transaction"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const BASKET = "0x2222222222222222222222222222222222222222"
const HASH = `0x${"ab".repeat(32)}`
const OTHER_HASH = `0x${"cd".repeat(32)}`

function transaction(overrides = {}) {
  return {
    chainId: 56,
    account: ACCOUNT,
    action: "mint basket",
    basket: BASKET,
    hash: HASH,
    ...overrides,
  }
}

function memoryStorage(initialValue = null) {
  let value = initialValue
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_, nextValue) => {
      value = nextValue
    }),
    removeItem: vi.fn(() => {
      value = null
    }),
  }
}

describe("pending transaction persistence", () => {
  it("normalizes, persists and reads one versioned transaction", () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })

    const stored = guard.persist(
      transaction({
        account: ACCOUNT.toUpperCase().replace("0X", "0x"),
        action: "  MINT   BASKET ",
        hash: HASH.toUpperCase().replace("0X", "0x"),
      }),
    )

    expect(stored).toMatchObject({ status: "pending", locked: true, persistence: "local-storage" })
    expect(stored.transaction).toEqual({
      version: PENDING_TRANSACTION_VERSION,
      chainId: 56,
      account: ACCOUNT,
      action: "mint basket",
      basket: BASKET,
      hash: HASH,
    })
    expect(storage.setItem.mock.calls[0][0]).toBe(PENDING_TRANSACTION_STORAGE_KEY)
    expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual(stored.transaction)
    expect(guard.read()).toEqual(stored)
    expect(pendingTransactionIdentity(transaction())).toBe(
      pendingTransactionIdentity(stored.transaction),
    )
  })

  it.each([
    ["non-object", null],
    ["extra properties", transaction({ unsafe: true })],
    ["invalid chain", transaction({ chainId: 0 })],
    ["unsafe account", transaction({ account: "javascript:alert(1)" })],
    ["zero account", transaction({ account: `0x${"0".repeat(40)}` })],
    ["unsafe action", transaction({ action: "mint\u202ebasket" })],
    ["oversized action", transaction({ action: "a".repeat(65) })],
    ["unsafe basket", transaction({ basket: "<script>" })],
    ["invalid hash", transaction({ hash: "0xabc" })],
  ])("rejects %s", (_, value) => {
    const guard = createPendingTransactionGuard({ storage: memoryStorage() })
    expect(() => guard.persist(value)).toThrowError(
      expect.objectContaining({ code: "INVALID_PENDING_TRANSACTION" }),
    )
  })

  it("is idempotent for the same identity and refuses to overwrite another hash", () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    const first = guard.persist(transaction())

    expect(guard.persist(transaction())).toEqual(first)
    expect(() => guard.persist(transaction({ hash: OTHER_HASH }))).toThrowError(
      expect.objectContaining({ code: "PENDING_TRANSACTION_EXISTS" }),
    )
    expect(guard.read().transaction.hash).toBe(HASH)
  })

  it.each(["{broken", JSON.stringify({ version: 1 }), "x".repeat(1_025)])(
    "keeps corrupt storage locked without deleting it",
    (storedValue) => {
      const storage = memoryStorage(storedValue)
      const guard = createPendingTransactionGuard({ storage })

      expect(guard.read()).toMatchObject({
        status: "blocked",
        locked: true,
        reason: "storage-corrupt",
      })
      expect(storage.removeItem).not.toHaveBeenCalled()
      expect(() => guard.persist(transaction())).toThrowError(
        expect.objectContaining({ code: "STORAGE_CORRUPT" }),
      )
    },
  )

  it("uses an in-memory lock when localStorage is absent or throws", () => {
    const absentGuard = createPendingTransactionGuard({ storage: null })
    expect(absentGuard.read()).toEqual({
      status: "blocked",
      locked: true,
      reason: "storage-unavailable",
      transaction: null,
    })
    expect(absentGuard.persist(transaction())).toMatchObject({
      status: "pending",
      persistence: "memory",
      reason: "storage-unavailable",
    })
    expect(absentGuard.read().transaction.hash).toBe(HASH)

    const throwingStorage = {
      getItem: vi.fn(() => {
        throw new Error("disabled")
      }),
      setItem: vi.fn(() => {
        throw new Error("disabled")
      }),
      removeItem: vi.fn(() => {
        throw new Error("disabled")
      }),
    }
    const throwingGuard = createPendingTransactionGuard({ storage: throwingStorage })
    expect(throwingGuard.persist(transaction()).transaction.hash).toBe(HASH)
    expect(throwingGuard.read()).toMatchObject({ status: "pending", persistence: "memory" })
  })

  it("only clears the exact stored identity", () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())

    expect(guard.clear(transaction({ action: "redeem basket" }))).toBe(false)
    expect(guard.read().locked).toBe(true)
    expect(guard.clear(transaction())).toBe(true)
    expect(guard.read()).toEqual({ status: "empty", locked: false, transaction: null })
  })
})

describe("pending transaction write readiness", () => {
  it("proves that an empty durable slot can be written, read and cleaned up", () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })

    expect(guard.assertWritable()).toBe(true)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(storage.setItem.mock.calls[0][0]).toContain(`${PENDING_TRANSACTION_STORAGE_KEY}.probe.`)
    expect(storage.removeItem).toHaveBeenCalledTimes(1)
    expect(guard.read()).toEqual({ status: "empty", locked: false, transaction: null })
  })

  it("fails closed when reads work but setItem throws", () => {
    const storage = memoryStorage()
    storage.setItem.mockImplementation(() => {
      throw new Error("Quota exceeded")
    })
    const guard = createPendingTransactionGuard({ storage })

    expect(() => guard.assertWritable()).toThrowError(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }),
    )
  })

  it("fails closed when storage silently refuses the probe write", () => {
    const storage = memoryStorage()
    storage.setItem.mockImplementation(() => {})
    const guard = createPendingTransactionGuard({ storage })

    expect(() => guard.assertWritable()).toThrowError(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }),
    )
    expect(guard.read()).toEqual({ status: "empty", locked: false, transaction: null })
  })

  it("refuses pending, corrupt and unavailable slots without a memory-only success", () => {
    const pendingGuard = createPendingTransactionGuard({ storage: memoryStorage() })
    pendingGuard.persist(transaction())
    expect(() => pendingGuard.assertWritable()).toThrowError(
      expect.objectContaining({ code: "PENDING_TRANSACTION_EXISTS" }),
    )

    const corruptGuard = createPendingTransactionGuard({ storage: memoryStorage("{broken") })
    expect(() => corruptGuard.assertWritable()).toThrowError(
      expect.objectContaining({ code: "STORAGE_CORRUPT" }),
    )

    const unavailableGuard = createPendingTransactionGuard({ storage: null })
    expect(() => unavailableGuard.assertWritable()).toThrowError(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }),
    )
  })
})

describe("pending transaction hash replacement", () => {
  it("replaces only the hash after matching the exact stored identity", () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())

    const replaced = guard.replaceHash(transaction(), OTHER_HASH.toUpperCase().replace("0X", "0x"))

    expect(replaced).toMatchObject({
      status: "pending",
      locked: true,
      persistence: "local-storage",
      transaction: {
        version: PENDING_TRANSACTION_VERSION,
        chainId: 56,
        account: ACCOUNT,
        action: "mint basket",
        basket: BASKET,
        hash: OTHER_HASH,
      },
    })
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(JSON.parse(storage.setItem.mock.calls[1][1])).toEqual(replaced.transaction)
    expect(guard.read()).toEqual(replaced)
  })

  it("is idempotent when the requested replacement is already current", () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())
    const replaced = guard.replaceHash(transaction(), OTHER_HASH)
    const writesAfterReplacement = storage.setItem.mock.calls.length

    expect(guard.replaceHash(transaction(), OTHER_HASH)).toEqual(replaced)
    expect(guard.replaceHash(transaction({ hash: OTHER_HASH }), OTHER_HASH)).toEqual(replaced)
    expect(storage.setItem).toHaveBeenCalledTimes(writesAfterReplacement)
  })

  it.each([
    ["chain", transaction({ chainId: 97 })],
    ["account", transaction({ account: "0x3333333333333333333333333333333333333333" })],
    ["action", transaction({ action: "redeem basket" })],
    ["basket", transaction({ basket: null })],
    ["hash", transaction({ hash: OTHER_HASH })],
  ])("refuses a mismatched expected %s without changing storage", (_, expected) => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())

    expect(() => guard.replaceHash(expected, `0x${"ef".repeat(32)}`)).toThrowError(
      expect.objectContaining({ code: "PENDING_TRANSACTION_MISMATCH" }),
    )
    expect(guard.read().transaction.hash).toBe(HASH)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  it("rejects an invalid replacement hash before touching the lock", () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())

    expect(() => guard.replaceHash(transaction(), "0x1234")).toThrowError(
      expect.objectContaining({ code: "INVALID_PENDING_TRANSACTION" }),
    )
    expect(guard.read().transaction.hash).toBe(HASH)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  it("keeps a known memory-only lock fail-closed while replacing its hash", () => {
    const guard = createPendingTransactionGuard({ storage: null })
    guard.persist(transaction())

    expect(guard.replaceHash(transaction(), OTHER_HASH)).toMatchObject({
      status: "pending",
      locked: true,
      persistence: "memory",
      reason: "storage-unavailable",
      transaction: { hash: OTHER_HASH },
    })
    expect(guard.read().transaction.hash).toBe(OTHER_HASH)
  })

  it("refuses unavailable or corrupt storage when no exact safe update is possible", () => {
    const unavailableGuard = createPendingTransactionGuard({ storage: null })
    expect(() => unavailableGuard.replaceHash(transaction(), OTHER_HASH)).toThrowError(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }),
    )

    const storage = memoryStorage("{broken")
    const corruptGuard = createPendingTransactionGuard({ storage })
    expect(() => corruptGuard.replaceHash(transaction(), OTHER_HASH)).toThrowError(
      expect.objectContaining({ code: "STORAGE_CORRUPT" }),
    )
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it("refuses a memory fallback when the known durable slot becomes unavailable", () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())
    storage.getItem.mockImplementation(() => {
      throw new Error("storage disabled")
    })

    expect(() => guard.replaceHash(transaction(), OTHER_HASH)).toThrowError(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }),
    )
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  it("refuses to recreate a durable slot that disappeared before replacement", () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())
    storage.removeItem(PENDING_TRANSACTION_STORAGE_KEY)

    expect(() => guard.replaceHash(transaction(), OTHER_HASH)).toThrowError(
      expect.objectContaining({ code: "PENDING_TRANSACTION_MISMATCH" }),
    )
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  it("does not update memory when storage silently refuses the replacement", () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())
    storage.setItem.mockImplementation(() => {})

    expect(() => guard.replaceHash(transaction(), OTHER_HASH)).toThrowError(
      expect.objectContaining({ code: "PENDING_TRANSACTION_UPDATE_FAILED" }),
    )
    expect(guard.read().transaction.hash).toBe(HASH)
  })
})

describe("pending transaction reconciliation", () => {
  it("uses the replacement-aware wait path and clears a repriced hash after two confirmations", async () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())
    const publicClient = {
      chain: { id: 56 },
      getTransactionReceipt: vi.fn(),
      getBlockNumber: vi.fn(),
      waitForTransactionReceipt: vi.fn(async ({ onReplaced }) => {
        onReplaced({
          reason: "repriced",
          transaction: { hash: OTHER_HASH },
        })
        return {
          status: "success",
          transactionHash: OTHER_HASH,
          blockNumber: 10n,
        }
      }),
    }

    await expect(guard.reconcile(publicClient)).resolves.toMatchObject({
      status: "resolved",
      locked: false,
      outcome: "success",
      transaction: { hash: OTHER_HASH },
    })
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: HASH,
        checkReplacement: true,
        confirmations: 2,
        timeout: 10_000,
        onReplaced: expect.any(Function),
      }),
    )
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled()
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled()
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(storage.removeItem).toHaveBeenCalledTimes(1)
    expect(guard.read().status).toBe("empty")
  })

  it.each([
    ["cancelled", "cancelled"],
    ["replaced", "replaced-different"],
  ])("returns a terminal %s replacement outcome", async (reason, outcome) => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())

    await expect(
      guard.reconcile({
        chain: { id: 56 },
        waitForTransactionReceipt: vi.fn(async ({ onReplaced }) => {
          onReplaced({ reason, transaction: { hash: OTHER_HASH } })
          return {
            status: "success",
            transactionHash: OTHER_HASH,
            blockNumber: 12n,
          }
        }),
      }),
    ).resolves.toMatchObject({
      status: "resolved",
      locked: false,
      outcome,
      transaction: { hash: OTHER_HASH },
    })
    expect(guard.read().status).toBe("empty")
  })

  it("never clears when a replacement hash cannot be stored", async () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())
    storage.setItem.mockImplementation(() => {})

    await expect(
      guard.reconcile({
        chain: { id: 56 },
        waitForTransactionReceipt: vi.fn(async ({ onReplaced }) => {
          onReplaced({ reason: "repriced", transaction: { hash: OTHER_HASH } })
          return {
            status: "success",
            transactionHash: OTHER_HASH,
            blockNumber: 12n,
          }
        }),
      }),
    ).resolves.toMatchObject({
      status: "pending",
      locked: true,
      reason: "replacement-storage-error",
      transaction: { hash: HASH },
    })
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(guard.read().transaction.hash).toBe(HASH)
  })

  it("keeps the replacement lock when the wait path returns an invalid receipt", async () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())

    await expect(
      guard.reconcile({
        chain: { id: 56 },
        waitForTransactionReceipt: vi.fn(async ({ onReplaced }) => {
          onReplaced({ reason: "repriced", transaction: { hash: OTHER_HASH } })
          return { status: "success", transactionHash: HASH, blockNumber: 12n }
        }),
      }),
    ).resolves.toMatchObject({
      status: "pending",
      locked: true,
      reason: "invalid-or-pending-receipt",
      transaction: { hash: OTHER_HASH },
    })
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(guard.read().transaction.hash).toBe(OTHER_HASH)
  })

  it.each(["success", "reverted"])(
    "clears only after a matching final %s receipt",
    async (status) => {
      const storage = memoryStorage()
      const guard = createPendingTransactionGuard({ storage })
      guard.persist(transaction())
      const publicClient = {
        chain: { id: 56 },
        getTransactionReceipt: vi.fn(async () => ({
          status,
          transactionHash: HASH,
          blockNumber: 10n,
        })),
        getBlockNumber: vi.fn(async () => 10n + PENDING_TRANSACTION_CONFIRMATIONS - 1n),
      }

      await expect(guard.reconcile(publicClient)).resolves.toMatchObject({
        status: "resolved",
        locked: false,
        outcome: status,
      })
      expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: HASH })
      expect(guard.read().status).toBe("empty")
    },
  )

  it.each([
    [
      "not found",
      async () => {
        const error = new Error("Transaction receipt not found")
        error.name = "TransactionReceiptNotFoundError"
        throw error
      },
      "receipt-not-found",
    ],
    [
      "RPC failure",
      async () => {
        throw new Error("RPC offline")
      },
      "rpc-error",
    ],
    ["null receipt", async () => null, "invalid-or-pending-receipt"],
    [
      "pending receipt",
      async () => ({ status: "pending", transactionHash: HASH }),
      "invalid-or-pending-receipt",
    ],
    [
      "mismatched hash",
      async () => ({ status: "success", transactionHash: OTHER_HASH }),
      "invalid-or-pending-receipt",
    ],
  ])("keeps the lock after %s", async (_, getTransactionReceipt, reason) => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())

    await expect(
      guard.reconcile({ getTransactionReceipt, getBlockNumber: vi.fn(async () => 20n) }),
    ).resolves.toMatchObject({
      status: "pending",
      locked: true,
      reason,
    })
    expect(guard.read().transaction.hash).toBe(HASH)
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it("does not query a client configured for another chain", async () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())
    const publicClient = {
      chain: { id: 97 },
      getTransactionReceipt: vi.fn(),
      getBlockNumber: vi.fn(),
    }

    await expect(guard.reconcile(publicClient)).resolves.toMatchObject({
      status: "pending",
      reason: "chain-mismatch",
    })
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled()
  })

  it("keeps the lock if persistent storage cannot be cleared", async () => {
    const stored = JSON.stringify({ version: 1, ...transaction() })
    const storage = memoryStorage(stored)
    storage.removeItem.mockImplementation(() => {})
    const guard = createPendingTransactionGuard({ storage })

    await expect(
      guard.reconcile({
        getTransactionReceipt: vi.fn(async () => ({
          status: "success",
          transactionHash: HASH,
          blockNumber: 10n,
        })),
        getBlockNumber: vi.fn(async () => 11n),
      }),
    ).resolves.toMatchObject({
      status: "pending",
      locked: true,
      reason: "storage-clear-failed",
    })
    expect(guard.read().transaction.hash).toBe(HASH)
  })

  it("keeps the lock until the required confirmation depth is observed", async () => {
    const storage = memoryStorage()
    const guard = createPendingTransactionGuard({ storage })
    guard.persist(transaction())
    const publicClient = {
      chain: { id: 56 },
      getTransactionReceipt: vi.fn(async () => ({
        status: "success",
        transactionHash: HASH,
        blockNumber: 10n,
      })),
      getBlockNumber: vi.fn(async () => 10n),
    }

    await expect(guard.reconcile(publicClient)).resolves.toMatchObject({
      status: "pending",
      locked: true,
      reason: "confirmations-pending",
    })
    expect(guard.read().transaction.hash).toBe(HASH)
  })
})
