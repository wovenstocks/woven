const FRIENDLY_CONTRACT_ERRORS = Object.freeze({
  AlreadyLicensed: "This wallet already has creator access.",
  CapAboveFactoryLimit: "The initial supply cap is above the factory limit.",
  DuplicateToken: "Each constituent may appear only once.",
  Expired: "This USDC quote expired. Refresh it before signing.",
  ExistingBackingDeficit:
    "This basket is underbacked. Minting is disabled until backing is restored.",
  FeeTooHigh: "The mint fee is above the protocol maximum.",
  InexactRedemption: "A constituent could not be delivered exactly. The redemption was reverted.",
  LegSpendExceeded: "A constituent now costs more than the reviewed USDC maximum.",
  InsufficientDeposit: "A constituent transfer delivered fewer tokens than required.",
  InvalidConstituentCount: "A basket must contain between 2 and 20 constituents.",
  InvalidRedemptionRecipient: "Choose a wallet address as the redemption recipient.",
  MintingPaused: "Minting is currently paused for this basket.",
  NotLicensed: "Creator access is required before publishing a basket.",
  SupplyCapExceeded: "This mint would exceed the basket supply cap.",
  UnknownBasket: "This basket was not created by the configured Woven factory.",
  UnapprovedAdapter: "The reviewed swap route is not approved by the Woven router.",
  AdapterCodeChanged: "A reviewed swap adapter changed. Refresh the quote before signing.",
  AdapterRouteMismatch: "A reviewed swap route no longer matches this basket.",
  AdapterSpendMismatch: "A swap reported an invalid USDC spend. The purchase was reverted.",
  AllowanceNotCleared: "A temporary swap allowance was not cleared. The purchase was reverted.",
  AmountTooLarge: "The requested purchase amount is too large for this route.",
  BasketOutputBelowMinimum: "The basket output fell below the reviewed minimum.",
  ConstituentBalanceNotRestored:
    "The router retained an unexpected constituent balance. The purchase was reverted.",
  ConstituentOutputMismatch: "A swap did not deliver the exact required constituent amount.",
  DeadlineOverflow: "The reviewed quote deadline is not valid for this route.",
  DependencyCodeChanged: "A pinned DEX dependency changed. Refresh the quote before signing.",
  DexCodeChanged: "A pinned DEX contract changed. Refresh the quote before signing.",
  InexactCallerDebit: "USDC could not be debited exactly. The purchase was reverted.",
  InexactRefund: "Unused USDC could not be refunded exactly. The purchase was reverted.",
  InexactUsdcDebit: "USDC could not be debited exactly. The purchase was reverted.",
  InexactUsdcRefund: "Unused USDC could not be refunded exactly. The purchase was reverted.",
  InexactUsdcTransfer: "USDC could not be transferred exactly. The purchase was reverted.",
  InputSpendMismatch: "A swap reported an invalid USDC spend. The purchase was reverted.",
  OutputAmountMismatch: "A swap did not return the exact reviewed output.",
  ResidualInput: "A swap adapter retained unexpected USDC. The purchase was reverted.",
  RouteNotFound: "A reviewed swap route is no longer available.",
  RouteOutputMismatch: "A reviewed swap route no longer matches this basket.",
  ResidualOutput: "A swap adapter retained unexpected output tokens. The purchase was reverted.",
  UnsupportedAsset: "At least one constituent is not approved by the canonical registry.",
  UsdcBalanceNotRestored: "The router retained unexpected USDC. The purchase was reverted.",
  UnsupportedWovenToken: "The configured WOVEN token is not compatible with creator access.",
  ZeroAmount: "Enter an amount greater than zero.",
  ZeroRedemptionOutput:
    "That redemption amount is too small to return every constituent. Increase the basket amount.",
  ZeroUnits: "Every constituent must have a fixed amount greater than zero.",
})

const REJECTED_CODES = new Set([4001, "4001", "ACTION_REJECTED"])

export class ProtocolError extends Error {
  constructor(code, userMessage, options = {}) {
    super(userMessage, options.cause ? { cause: options.cause } : undefined)
    this.name = "ProtocolError"
    this.code = code
    this.userMessage = userMessage
    this.action = options.action || null
    this.txHash = options.txHash || null
    this.details = options.details || null
    this.retryable = Boolean(options.retryable)
  }
}

function errorChain(error) {
  const chain = []
  const seen = new Set()
  let current = error

  while (current && typeof current === "object" && !seen.has(current)) {
    chain.push(current)
    seen.add(current)
    current = current.cause || current.data?.cause || current.details
  }

  return chain
}

function findContractErrorName(error) {
  for (const item of errorChain(error)) {
    const candidate = item.data?.errorName || item.errorName
    if (typeof candidate === "string" && candidate) return candidate

    const match =
      typeof item.shortMessage === "string"
        ? item.shortMessage.match(/reverted with (?:custom )?error ['"]?([A-Za-z0-9_]+)/i)
        : null
    if (match) return match[1]
  }

  return null
}

function hasErrorMarker(error, predicate) {
  return errorChain(error).some(predicate)
}

export function toProtocolError(error, options = {}) {
  if (error instanceof ProtocolError) return error

  const action = options.action || null
  const txHash = options.txHash || null
  const contractErrorName = findContractErrorName(error)

  if (
    hasErrorMarker(
      error,
      (item) =>
        REJECTED_CODES.has(item.code) ||
        item.name === "UserRejectedRequestError" ||
        /user rejected|user denied/i.test(item.shortMessage || item.message || ""),
    )
  ) {
    return new ProtocolError("USER_REJECTED", "You rejected the wallet request.", {
      action,
      cause: error,
    })
  }

  if (
    hasErrorMarker(
      error,
      (item) => item.code === -32002 || /request (?:is )?already pending/i.test(item.message || ""),
    )
  ) {
    return new ProtocolError(
      "REQUEST_PENDING",
      "A wallet request is already open. Complete it in your wallet first.",
      { action, cause: error, retryable: true },
    )
  }

  if (
    hasErrorMarker(
      error,
      (item) =>
        item.name === "InsufficientFundsError" ||
        /insufficient funds|intrinsic transaction cost/i.test(
          item.shortMessage || item.message || "",
        ),
    )
  ) {
    return new ProtocolError(
      "INSUFFICIENT_GAS",
      "This wallet does not have enough BNB to pay the network fee.",
      { action, cause: error },
    )
  }

  if (contractErrorName && FRIENDLY_CONTRACT_ERRORS[contractErrorName]) {
    return new ProtocolError(
      `CONTRACT_${contractErrorName}`,
      FRIENDLY_CONTRACT_ERRORS[contractErrorName],
      {
        action,
        cause: error,
        details: { contractErrorName },
      },
    )
  }

  if (
    hasErrorMarker(
      error,
      (item) =>
        item.name === "HttpRequestError" ||
        item.name === "TimeoutError" ||
        /network|fetch failed|timed? ?out|rpc unavailable/i.test(
          item.shortMessage || item.message || "",
        ),
    )
  ) {
    return new ProtocolError(
      txHash ? "RECEIPT_UNCONFIRMED" : "RPC_UNAVAILABLE",
      txHash
        ? "The transaction was submitted, but confirmation could not be verified yet."
        : "BNB Chain could not be reached. Try again in a moment.",
      { action, cause: error, txHash, retryable: true },
    )
  }

  return new ProtocolError(
    txHash ? "RECEIPT_UNCONFIRMED" : "PROTOCOL_REQUEST_FAILED",
    txHash
      ? "The transaction was submitted, but its final status could not be verified."
      : "The onchain request could not be completed. No confirmed result was recorded.",
    { action, cause: error, txHash, retryable: Boolean(txHash) },
  )
}

export function formatProtocolError(error) {
  return toProtocolError(error).userMessage
}

export function withCompletedTransactions(error, transactions) {
  const protocolError = toProtocolError(error)
  const completedTransactionHashes = Array.isArray(transactions)
    ? transactions
        .map((transaction) => transaction?.hash)
        .filter((hash) => typeof hash === "string" && /^0x[a-fA-F0-9]{64}$/.test(hash))
    : []

  if (completedTransactionHashes.length === 0) return protocolError

  const existingDetails =
    protocolError.details && typeof protocolError.details === "object" ? protocolError.details : {}
  return new ProtocolError(protocolError.code, protocolError.userMessage, {
    action: protocolError.action,
    cause: protocolError,
    txHash: protocolError.txHash,
    retryable: protocolError.retryable,
    details: {
      ...existingDetails,
      completedTransactionHashes: Object.freeze([...completedTransactionHashes]),
    },
  })
}

export async function runProtocolAction(action, callback) {
  try {
    return await callback()
  } catch (error) {
    throw toProtocolError(error, { action, txHash: error?.txHash })
  }
}
