import { describe, expect, it } from "vitest"
import { formatProtocolError, toProtocolError } from "./errors"
import {
  MAX_UINT256,
  formatTokenAmount,
  hasUnsafeTokenTextCharacters,
  isUsableAddress,
  normalizeAddress,
  parseBasisPoints,
  parseTokenAmount,
  sanitizeTokenSymbol,
  sanitizeTokenText,
} from "./validation"

describe("protocol validation", () => {
  it("normalizes valid addresses and rejects zero, malformed, and bad-checksum addresses", () => {
    expect(normalizeAddress("0x1111111111111111111111111111111111111111")).toBe(
      "0x1111111111111111111111111111111111111111",
    )
    expect(isUsableAddress("0x1111111111111111111111111111111111111111")).toBe(true)
    expect(isUsableAddress("0x0000000000000000000000000000000000000000")).toBe(false)
    expect(isUsableAddress("0x1234")).toBe(false)
    expect(isUsableAddress("0xAbcdefabcdefabcdefabcdefabcdefabcdefabcd")).toBe(false)
  })

  it("parses exact integer and fractional token amounts without floating point", () => {
    expect(parseTokenAmount("12", 6)).toBe(12_000_000n)
    expect(parseTokenAmount("0.000001", 6)).toBe(1n)
    expect(parseTokenAmount("1.2300", 6)).toBe(1_230_000n)
    expect(parseTokenAmount(12, 18)).toBe(12n * 10n ** 18n)
    expect(parseTokenAmount(25n, 18)).toBe(25n)
  })

  it("rejects exponent notation, unsafe numbers, negatives, zero, and excess precision", () => {
    for (const value of ["1e3", "-1", "+1", ".5", "01", 1.1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseTokenAmount(value, 6)).toThrow()
    }
    expect(() => parseTokenAmount("0", 18)).toThrow(/greater than zero/i)
    expect(() => parseTokenAmount("0.0000001", 6)).toThrow(/at most 6 decimal/i)
    expect(parseTokenAmount("0", 18, { allowZero: true })).toBe(0n)
  })

  it("rejects uint256 overflow", () => {
    expect(parseTokenAmount(MAX_UINT256, 18)).toBe(MAX_UINT256)
    expect(() => parseTokenAmount(String(MAX_UINT256 + 1n), 0)).toThrow(/too large/i)
  })

  it("formats bigint amounts deterministically", () => {
    expect(formatTokenAmount(1_230_000n, 6)).toBe("1.23")
    expect(formatTokenAmount(1_234_567n, 6, { maxFractionDigits: 3 })).toBe("1.234")
    expect(formatTokenAmount(0n, 18)).toBe("0")
  })

  it("validates basis points and public token text", () => {
    expect(parseBasisPoints("30", { max: 50 })).toBe(30)
    expect(parseBasisPoints(0, { max: 50 })).toBe(0)
    expect(() => parseBasisPoints(51, { max: 50 })).toThrow(/0 to 50/i)
    expect(sanitizeTokenText("  Woven   Tech  ")).toBe("Woven Tech")
    expect(sanitizeTokenSymbol("tech.5")).toBe("TECH.5")
    expect(() => sanitizeTokenSymbol("BAD SYMBOL")).toThrow(/letters, numbers/i)

    for (const unsafe of ["Spoof\u202eName", "Zero\u200bWidth", "Line\nBreak", "Null\u0000Byte"]) {
      expect(hasUnsafeTokenTextCharacters(unsafe)).toBe(true)
      expect(() => sanitizeTokenText(unsafe)).toThrow(/valid characters/i)
    }
    expect(hasUnsafeTokenTextCharacters("Woven Tech")).toBe(false)
  })
})

describe("user-safe protocol errors", () => {
  it("maps wallet rejection and pending-request errors without exposing provider internals", () => {
    expect(formatProtocolError({ code: 4001, message: "secret internal provider text" })).toBe(
      "You rejected the wallet request.",
    )
    expect(toProtocolError({ code: -32002, message: "request already pending" }).code).toBe(
      "REQUEST_PENDING",
    )
  })

  it("maps known contract errors and sanitizes unknown failures", () => {
    const known = toProtocolError({ data: { errorName: "MintingPaused" } })
    expect(known.code).toBe("CONTRACT_MintingPaused")
    expect(known.userMessage).toMatch(/paused/i)

    const underbacked = toProtocolError({ data: { errorName: "ExistingBackingDeficit" } })
    expect(underbacked).toMatchObject({
      code: "CONTRACT_ExistingBackingDeficit",
      userMessage: expect.stringMatching(/underbacked/i),
    })

    const inexactRedemption = toProtocolError({ data: { errorName: "InexactRedemption" } })
    expect(inexactRedemption).toMatchObject({
      code: "CONTRACT_InexactRedemption",
      userMessage: expect.stringMatching(/reverted/i),
    })

    const dependencyChanged = toProtocolError({ data: { errorName: "DependencyCodeChanged" } })
    expect(dependencyChanged).toMatchObject({
      code: "CONTRACT_DependencyCodeChanged",
      userMessage: expect.stringMatching(/dependency changed/i),
    })

    const unknown = toProtocolError(new Error("api key=do-not-leak"))
    expect(unknown.userMessage).not.toContain("do-not-leak")
    expect(unknown.code).toBe("PROTOCOL_REQUEST_FAILED")
  })
})
