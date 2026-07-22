import { describe, expect, it } from "vitest"
import { createPendingTransactionLifecycle } from "./pending-lifecycle"
import { createPendingTransactionGuard } from "./pending-transaction"

const ACCOUNT = "0x1111111111111111111111111111111111111111"
const BASKET = "0x2222222222222222222222222222222222222222"
const FIRST_HASH = `0x${"11".repeat(32)}`
const REPLACEMENT_HASH = `0x${"22".repeat(32)}`

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }
}

function setup() {
  const guard = createPendingTransactionGuard({ storage: memoryStorage() })
  const lifecycle = createPendingTransactionLifecycle({
    guard,
    chainId: 56,
    account: ACCOUNT,
    action: "mint",
    basket: BASKET,
  })
  return { guard, lifecycle }
}

describe("pending transaction lifecycle", () => {
  it("persists on submission, follows a replacement and clears only after confirmation", () => {
    const { guard, lifecycle } = setup()

    lifecycle.handle({ status: "submitted", txHash: FIRST_HASH })
    expect(guard.read()).toMatchObject({
      status: "pending",
      persistence: "local-storage",
      transaction: { hash: FIRST_HASH.toLowerCase(), action: "mint", basket: BASKET.toLowerCase() },
    })

    lifecycle.handle({ status: "unconfirmed", txHash: FIRST_HASH })
    expect(guard.read().status).toBe("pending")

    lifecycle.handle({ status: "replaced", txHash: REPLACEMENT_HASH })
    expect(guard.read().transaction.hash).toBe(REPLACEMENT_HASH.toLowerCase())

    lifecycle.handle({ status: "confirmed", txHash: REPLACEMENT_HASH })
    expect(guard.read()).toMatchObject({ status: "empty", locked: false })
    expect(lifecycle.current()).toBeNull()
  })

  it.each(["reverted", "cancelled", "replaced-different"])(
    "clears the exact record after the terminal %s event",
    (status) => {
      const { guard, lifecycle } = setup()
      lifecycle.handle({ status: "submitted", txHash: FIRST_HASH })
      lifecycle.handle({ status, txHash: FIRST_HASH })
      expect(guard.read().status).toBe("empty")
    },
  )

  it("rejects a replacement before any transaction was submitted", () => {
    const { lifecycle } = setup()
    expect(() => lifecycle.handle({ status: "replaced", txHash: REPLACEMENT_HASH })).toThrow(
      /before a transaction was submitted/i,
    )
  })

  it("fails after broadcast when storage is no longer durable", () => {
    const guard = createPendingTransactionGuard({ storage: null })
    const lifecycle = createPendingTransactionLifecycle({
      guard,
      chainId: 56,
      account: ACCOUNT,
      action: "mint",
      basket: BASKET,
    })

    expect(() => lifecycle.handle({ status: "submitted", txHash: FIRST_HASH })).toThrow(
      /stored durably/i,
    )
    expect(guard.read()).toMatchObject({ status: "pending", reason: "storage-unavailable" })
  })

  it("fails closed when a terminal transaction record cannot be cleared", () => {
    const durableGuard = createPendingTransactionGuard({ storage: memoryStorage() })
    const guard = {
      persist: durableGuard.persist,
      replaceHash: durableGuard.replaceHash,
      clear: () => false,
    }
    const lifecycle = createPendingTransactionLifecycle({
      guard,
      chainId: 56,
      account: ACCOUNT,
      action: "mint",
      basket: BASKET,
    })

    lifecycle.handle({ status: "submitted", txHash: FIRST_HASH })
    expect(() => lifecycle.handle({ status: "confirmed", txHash: FIRST_HASH })).toThrow(
      /could not be cleared safely/i,
    )
    expect(durableGuard.read().status).toBe("pending")
    expect(lifecycle.current()?.hash).toBe(FIRST_HASH.toLowerCase())
  })
})
