import { stocks } from "../data/baskets"

export const toneBySymbol = Object.fromEntries(stocks.map((stock) => [stock.symbol, stock.tone]))

export const stockBySymbol = Object.fromEntries(stocks.map((stock) => [stock.symbol, stock]))

export const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

export function compactAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ""
}

export function addressKey(address) {
  return typeof address === "string" ? address.toLowerCase() : ""
}

export function isPositiveDecimal(value) {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && /[1-9]/.test(value)
}

export function latestTransactionHash(result) {
  return (
    result?.transaction?.hash ||
    result?.transactions?.at?.(-1)?.hash ||
    result?.approvalTransactions?.at?.(-1)?.hash ||
    null
  )
}

export function exactAmount(item) {
  if (typeof item?.amountFormatted === "string") return item.amountFormatted
  return "Unavailable"
}

export async function copyToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return true
  }

  const input = document.createElement("textarea")
  input.value = value
  input.className = "clipboard-helper"
  document.body.appendChild(input)
  try {
    input.select()
    if (!document.execCommand("copy")) throw new Error("Copy command failed")
    return true
  } finally {
    input.remove()
  }
}
