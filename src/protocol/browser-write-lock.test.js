import { describe, expect, it, vi } from "vitest"
import { runWithExclusiveWriteLock, WOVEN_WRITE_LOCK } from "./browser-write-lock"

describe("browser-wide write lock", () => {
  it("fails closed when Web Locks are unavailable", async () => {
    const callback = vi.fn()
    await expect(runWithExclusiveWriteLock(null, callback)).resolves.toEqual({
      status: "unsupported",
      value: undefined,
    })
    expect(callback).not.toHaveBeenCalled()
  })

  it("does not run when another tab owns the lock", async () => {
    const callback = vi.fn()
    const lockManager = {
      request: vi.fn(async (_name, _options, holder) => holder(null)),
    }
    await expect(runWithExclusiveWriteLock(lockManager, callback)).resolves.toEqual({
      status: "busy",
      value: undefined,
    })
    expect(callback).not.toHaveBeenCalled()
  })

  it("holds the named exclusive lock across the complete callback", async () => {
    const callback = vi.fn(async () => "confirmed")
    const lockManager = {
      request: vi.fn(async (_name, _options, holder) => holder({ name: "woven" })),
    }
    await expect(runWithExclusiveWriteLock(lockManager, callback)).resolves.toEqual({
      status: "acquired",
      value: "confirmed",
    })
    expect(lockManager.request).toHaveBeenCalledWith(
      WOVEN_WRITE_LOCK,
      { mode: "exclusive", ifAvailable: true },
      expect.any(Function),
    )
    expect(callback).toHaveBeenCalledOnce()
  })
})
