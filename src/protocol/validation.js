import { getAddress, isAddress } from "viem"
import { wovenContracts } from "../config/contracts"
import { ProtocolError } from "./errors"

export const BNB_CONFIGURED_CHAIN_ID = wovenContracts.chainId
export const BNB_CHAIN_ID = BNB_CONFIGURED_CHAIN_ID
export const MAX_UINT256 = (1n << 256n) - 1n
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const unsafeTokenTextPattern = /[\p{Cc}\p{Cf}]/u

function inputError(code, message, details) {
  return new ProtocolError(code, message, { details })
}

export function normalizeAddress(value, label = "Address") {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw inputError("INVALID_ADDRESS", `${label} is not a valid EVM address.`, { label })
  }

  const normalized = getAddress(value)
  if (normalized === ZERO_ADDRESS) {
    throw inputError("ZERO_ADDRESS", `${label} cannot be the zero address.`, { label })
  }

  return normalized
}

export function isUsableAddress(value) {
  try {
    normalizeAddress(value)
    return true
  } catch {
    return false
  }
}

export function requireAddressMap(addresses, requiredKeys) {
  if (!addresses || typeof addresses !== "object") {
    throw inputError("CONTRACTS_UNAVAILABLE", "Protocol contracts are not configured.")
  }

  return Object.freeze(
    Object.fromEntries(
      requiredKeys.map((key) => {
        try {
          return [key, normalizeAddress(addresses[key], `${key} contract`)]
        } catch (error) {
          throw new ProtocolError(
            "CONTRACTS_UNAVAILABLE",
            "Protocol contracts are not fully configured.",
            { cause: error, details: { missingKey: key } },
          )
        }
      }),
    ),
  )
}

export function assertDecimals(decimals, label = "Token decimals") {
  const parsed = typeof decimals === "bigint" ? Number(decimals) : decimals
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    throw inputError("INVALID_DECIMALS", `${label} must be an integer between 0 and 255.`, {
      label,
    })
  }
  return parsed
}

export function parseTokenAmount(value, decimals, options = {}) {
  const label = options.label || "Amount"
  const allowZero = Boolean(options.allowZero)
  const places = assertDecimals(decimals)

  if (typeof value === "bigint") {
    if (value < 0n || (!allowZero && value === 0n) || value > MAX_UINT256) {
      throw inputError("INVALID_AMOUNT", `${label} must be greater than zero.`, { label })
    }
    return value
  }

  let text
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    text = String(value)
  } else if (typeof value === "string") {
    text = value.trim()
  } else {
    throw inputError("INVALID_AMOUNT", `${label} must be a plain decimal value.`, { label })
  }

  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(text)
  if (!match) {
    throw inputError("INVALID_AMOUNT", `${label} must be a plain decimal value.`, { label })
  }

  const fractional = match[1] || ""
  if (fractional.length > places) {
    throw inputError(
      "TOO_MANY_DECIMALS",
      `${label} supports at most ${places} decimal place${places === 1 ? "" : "s"}.`,
      { label, decimals: places },
    )
  }

  const [whole = "0"] = text.split(".")
  const scale = 10n ** BigInt(places)
  const raw = BigInt(whole) * scale + BigInt(fractional.padEnd(places, "0") || "0")

  if (raw > MAX_UINT256) {
    throw inputError("AMOUNT_OVERFLOW", `${label} is too large.`, { label })
  }
  if (raw < 0n || (!allowZero && raw === 0n)) {
    throw inputError("INVALID_AMOUNT", `${label} must be greater than zero.`, { label })
  }

  return raw
}

export function formatTokenAmount(value, decimals, options = {}) {
  const places = assertDecimals(decimals)
  if (typeof value !== "bigint" || value < 0n) {
    throw inputError("INVALID_RAW_AMOUNT", "Raw token amounts must be non-negative bigint values.")
  }

  const scale = 10n ** BigInt(places)
  const whole = value / scale
  const fractional = String(value % scale).padStart(places, "0")
  const trimmed = fractional.replace(/0+$/, "")
  const full = trimmed ? `${whole}.${trimmed}` : String(whole)
  const maxFractionDigits = options.maxFractionDigits

  if (!Number.isInteger(maxFractionDigits) || maxFractionDigits < 0 || !trimmed) return full
  const clipped = trimmed.slice(0, maxFractionDigits).replace(/0+$/, "")
  return clipped ? `${whole}.${clipped}` : String(whole)
}

export function parseBasisPoints(value, options = {}) {
  const label = options.label || "Fee"
  const max = options.max ?? 10_000
  const parsed = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw inputError("INVALID_BASIS_POINTS", `${label} must be a whole number from 0 to ${max}.`, {
      label,
      max,
    })
  }
  return parsed
}

export function hasUnsafeTokenTextCharacters(value) {
  return typeof value !== "string" || unsafeTokenTextPattern.test(value)
}

export function sanitizeTokenText(value, options = {}) {
  const label = options.label || "Value"
  const maxLength = options.maxLength || 64
  if (typeof value !== "string") {
    throw inputError("INVALID_TEXT", `${label} is required.`, { label })
  }
  const text = value.trim().replace(/\s+/g, " ")
  if (!text || text.length > maxLength || hasUnsafeTokenTextCharacters(value)) {
    throw inputError("INVALID_TEXT", `${label} must contain 1 to ${maxLength} valid characters.`, {
      label,
      maxLength,
    })
  }
  return text
}

export function sanitizeTokenSymbol(value) {
  const symbol = sanitizeTokenText(value, { label: "Basket symbol", maxLength: 16 })
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(symbol)) {
    throw inputError(
      "INVALID_SYMBOL",
      "Basket symbol may contain only letters, numbers, periods, underscores and hyphens.",
    )
  }
  return symbol.toUpperCase()
}
