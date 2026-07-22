export const WOVEN_WRITE_LOCK = "woven.protocol-write.v1"

export async function runWithExclusiveWriteLock(lockManager, callback) {
  if (!lockManager || typeof lockManager.request !== "function") {
    return Object.freeze({ status: "unsupported", value: undefined })
  }
  if (typeof callback !== "function") {
    throw new TypeError("A transaction callback is required.")
  }

  let acquired = false
  let value
  await lockManager.request(
    WOVEN_WRITE_LOCK,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) return
      acquired = true
      value = await callback()
    },
  )
  return Object.freeze({ status: acquired ? "acquired" : "busy", value })
}

export function getBrowserLockManager() {
  try {
    return globalThis.navigator?.locks || null
  } catch {
    return null
  }
}
