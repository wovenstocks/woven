import { wovenContracts } from "../config/contracts"
import { ProtocolError, toProtocolError } from "./errors"
import { BNB_CONFIGURED_CHAIN_ID, normalizeAddress } from "./validation"

const transactionHashPattern = /^0x[a-fA-F0-9]{64}$/

function requireTransactionHash(hash) {
  if (typeof hash !== "string" || !transactionHashPattern.test(hash)) {
    throw new ProtocolError(
      "INVALID_TRANSACTION_HASH",
      "The wallet returned an invalid transaction hash.",
    )
  }
  return hash
}

function requireLifecycleCallback(callback) {
  if (callback !== undefined && typeof callback !== "function") {
    throw new ProtocolError(
      "INVALID_LIFECYCLE_CALLBACK",
      "Transaction lifecycle tracking is not configured safely.",
    )
  }
}

function requireBeforeSubmitCallback(callback) {
  if (callback !== undefined && typeof callback !== "function") {
    throw new ProtocolError(
      "INVALID_TRANSACTION_SAFETY_CALLBACK",
      "Transaction safety storage is not configured correctly.",
    )
  }
}

async function verifyBeforeSubmit(callback, context) {
  if (!callback) return

  try {
    await callback(Object.freeze(context))
  } catch (error) {
    throw new ProtocolError(
      "TRANSACTION_SAFETY_UNAVAILABLE",
      "Woven could not verify durable transaction tracking. No transaction was submitted.",
      {
        action: context.action,
        cause: error,
        retryable: false,
        details: { guardCode: error?.code || null },
      },
    )
  }
}

function lifecycleCallbackError(error, event, action) {
  return new ProtocolError(
    "RECEIPT_UNCONFIRMED",
    "The transaction was submitted, but local transaction tracking failed. Do not retry until its onchain status is verified.",
    {
      action,
      cause: error,
      txHash: event.txHash,
      retryable: false,
      details: {
        doNotRetry: true,
        lifecycleCallbackFailed: true,
        lifecycleStatus: event.status,
        submittedHash: event.submittedHash,
      },
    },
  )
}

function notifyLifecycle(callback, event, action) {
  if (!callback) return Promise.resolve()

  const frozenEvent = Object.freeze({ action, ...event })
  try {
    return Promise.resolve(callback(frozenEvent)).catch((error) => {
      throw lifecycleCallbackError(error, frozenEvent, action)
    })
  } catch (error) {
    return Promise.reject(lifecycleCallbackError(error, frozenEvent, action))
  }
}

function submittedButUnconfirmed(error, action, submittedHash, txHash) {
  const protocolError = toProtocolError(error, { action, txHash })
  const existingDetails =
    protocolError.details && typeof protocolError.details === "object" ? protocolError.details : {}

  return new ProtocolError(
    "RECEIPT_UNCONFIRMED",
    "The transaction was submitted, but confirmation could not be verified. Do not retry until its onchain status is known.",
    {
      action,
      cause: protocolError,
      txHash,
      retryable: false,
      details: {
        ...existingDetails,
        doNotRetry: true,
        submittedHash,
        currentHash: txHash,
      },
    },
  )
}

function sameTransactionCall(replacedTransaction, replacementTransaction) {
  if (!replacedTransaction || !replacementTransaction) return false

  const normalizeHex = (value) => (typeof value === "string" ? value.toLowerCase() : value)
  return (
    normalizeHex(replacedTransaction.to) === normalizeHex(replacementTransaction.to) &&
    normalizeHex(replacedTransaction.input) === normalizeHex(replacementTransaction.input) &&
    replacedTransaction.value === replacementTransaction.value
  )
}

function replacementError(replacement, submittedHash) {
  const replacementHash = replacement?.transaction?.hash
  const txHash = transactionHashPattern.test(replacementHash || "")
    ? replacementHash
    : submittedHash
  const reason = replacement?.reason || "unknown"

  if (reason === "cancelled") {
    return new ProtocolError(
      "TRANSACTION_CANCELLED",
      "The wallet cancelled this transaction. The requested protocol action was not confirmed.",
      {
        txHash,
        details: { reason, submittedHash, replacementHash: replacementHash || null },
      },
    )
  }

  return new ProtocolError(
    "TRANSACTION_REPLACED",
    "The wallet replaced this transaction with a different transaction. The requested protocol action was not confirmed.",
    {
      txHash,
      details: { reason, submittedHash, replacementHash: replacementHash || null },
    },
  )
}

function requireClient(client, method, code, message) {
  if (!client || typeof client[method] !== "function") {
    throw new ProtocolError(code, message)
  }
  return client
}

async function requireCurrentContext(assertCurrentContext, phase, account) {
  if (assertCurrentContext === undefined) return
  if (typeof assertCurrentContext !== "function") {
    throw new ProtocolError(
      "CONTEXT_CHANGED",
      "The connected wallet context changed. Review the wallet and try again.",
      { details: { phase } },
    )
  }

  try {
    const current = await assertCurrentContext({ phase, account })
    if (current === false) throw new Error("Wallet context is no longer current")
  } catch (error) {
    throw new ProtocolError(
      "CONTEXT_CHANGED",
      "The connected wallet context changed. Review the wallet and try again.",
      { cause: error, details: { phase } },
    )
  }
}

export async function assertWalletReady(walletClient, account) {
  requireClient(
    walletClient,
    "getChainId",
    "WALLET_UNAVAILABLE",
    "Connect a compatible wallet before continuing.",
  )
  requireClient(
    walletClient,
    "writeContract",
    "WALLET_UNAVAILABLE",
    "Connect a compatible wallet before continuing.",
  )
  requireClient(
    walletClient,
    "getAddresses",
    "WALLET_UNAVAILABLE",
    "The active wallet account cannot be verified.",
  )

  const normalizedAccount = normalizeAddress(account, "Wallet account")
  const walletAccount = walletClient.account?.address || walletClient.account
  if (
    walletAccount &&
    normalizeAddress(walletAccount, "Active wallet account") !== normalizedAccount
  ) {
    throw new ProtocolError(
      "ACCOUNT_MISMATCH",
      "The active wallet account changed. Review the connected wallet and try again.",
    )
  }

  let providerAccounts
  try {
    providerAccounts = await walletClient.getAddresses()
  } catch (error) {
    throw toProtocolError(error, { action: "verify active wallet account" })
  }
  if (!Array.isArray(providerAccounts) || providerAccounts.length === 0) {
    throw new ProtocolError("WALLET_LOCKED", "Unlock or reconnect the wallet before continuing.")
  }
  if (normalizeAddress(providerAccounts[0], "Active provider account") !== normalizedAccount) {
    throw new ProtocolError(
      "ACCOUNT_MISMATCH",
      "The active wallet account changed. Review the connected wallet and try again.",
    )
  }

  const chainId = await walletClient.getChainId()
  if (chainId !== BNB_CONFIGURED_CHAIN_ID) {
    throw new ProtocolError(
      "CHAIN_MISMATCH",
      `Switch your wallet to ${wovenContracts.networkName} before continuing.`,
      { details: { expectedChainId: BNB_CONFIGURED_CHAIN_ID, actualChainId: chainId } },
    )
  }

  return normalizedAccount
}

export async function waitForSuccessfulReceipt(publicClient, hash, options = {}) {
  requireClient(
    publicClient,
    "waitForTransactionReceipt",
    "RPC_UNAVAILABLE",
    "BNB Chain confirmation is unavailable.",
  )
  const submittedHash = requireTransactionHash(hash)
  requireLifecycleCallback(options.onTransactionLifecycle)

  let receipt
  let replacement = null
  let currentHash = submittedHash
  let replacementNotificationTail = null
  let rejectLifecycleFailure
  const lifecycleFailure = new Promise((_, reject) => {
    rejectLifecycleFailure = reject
  })

  const trackReplacementNotification = (event) => {
    const notification = replacementNotificationTail
      ? replacementNotificationTail.then(() =>
          notifyLifecycle(options.onTransactionLifecycle, event, options.action),
        )
      : notifyLifecycle(options.onTransactionLifecycle, event, options.action)
    replacementNotificationTail = notification
    notification.then(
      () => {},
      (error) => rejectLifecycleFailure(error),
    )
  }

  try {
    const receiptPromise = publicClient.waitForTransactionReceipt({
      hash: submittedHash,
      checkReplacement: true,
      confirmations: options.confirmations ?? 2,
      timeout: options.timeout ?? 120_000,
      pollingInterval: options.pollingInterval,
      onReplaced: (replacementDetails) => {
        replacement = replacementDetails
        const replacementHash = replacementDetails?.transaction?.hash
        if (
          transactionHashPattern.test(replacementHash || "") &&
          replacementHash.toLowerCase() !== currentHash.toLowerCase()
        ) {
          const previousHash = currentHash
          currentHash = replacementHash
          trackReplacementNotification({
            status: "replaced",
            final: false,
            txHash: currentHash,
            submittedHash,
            previousHash,
            reason: replacementDetails?.reason || "unknown",
            sameCall: sameTransactionCall(
              replacementDetails?.replacedTransaction,
              replacementDetails?.transaction,
            ),
          })
        }
      },
    })
    receipt = await Promise.race([receiptPromise, lifecycleFailure])
    if (replacementNotificationTail) await replacementNotificationTail
  } catch (error) {
    if (error?.details?.lifecycleCallbackFailed) throw error

    const protocolError = submittedButUnconfirmed(error, options.action, submittedHash, currentHash)
    await notifyLifecycle(
      options.onTransactionLifecycle,
      {
        status: "unconfirmed",
        final: false,
        txHash: currentHash,
        submittedHash,
      },
      options.action,
    )
    throw protocolError
  }

  const replacementHash = replacement?.transaction?.hash || null
  if (replacement && !transactionHashPattern.test(replacementHash || "")) {
    const protocolError = submittedButUnconfirmed(
      new ProtocolError(
        "TRANSACTION_REPLACEMENT_INVALID",
        "The replacement transaction did not contain a valid transaction hash.",
        {
          txHash: currentHash,
          details: { submittedHash, replacementHash },
        },
      ),
      options.action,
      submittedHash,
      currentHash,
    )
    await notifyLifecycle(
      options.onTransactionLifecycle,
      {
        status: "unconfirmed",
        final: false,
        txHash: currentHash,
        submittedHash,
      },
      options.action,
    )
    throw protocolError
  }

  if (!receipt || (receipt.status !== "success" && receipt.status !== "reverted")) {
    const protocolError = submittedButUnconfirmed(
      new Error("The receipt returned an unknown final status."),
      options.action,
      submittedHash,
      currentHash,
    )
    await notifyLifecycle(
      options.onTransactionLifecycle,
      {
        status: "unconfirmed",
        final: false,
        txHash: currentHash,
        submittedHash,
      },
      options.action,
    )
    throw protocolError
  }

  const expectedHash = replacementHash || submittedHash
  const receiptHash = receipt.transactionHash
  if (typeof receiptHash === "string" && transactionHashPattern.test(receiptHash)) {
    if (receiptHash.toLowerCase() !== expectedHash.toLowerCase()) {
      await notifyLifecycle(
        options.onTransactionLifecycle,
        {
          status: "unconfirmed",
          final: false,
          txHash: currentHash,
          submittedHash,
        },
        options.action,
      )
      throw new ProtocolError(
        "TRANSACTION_RECEIPT_MISMATCH",
        "The transaction receipt does not match the transaction submitted by this wallet.",
        {
          txHash: receiptHash,
          details: { submittedHash, replacementHash, receiptHash },
        },
      )
    }
  } else {
    const protocolError = submittedButUnconfirmed(
      new ProtocolError(
        "TRANSACTION_RECEIPT_INVALID",
        "The transaction receipt did not contain a valid transaction hash.",
        {
          txHash: currentHash,
          details: { submittedHash, replacementHash, receiptHash: receiptHash ?? null },
        },
      ),
      options.action,
      submittedHash,
      currentHash,
    )
    await notifyLifecycle(
      options.onTransactionLifecycle,
      {
        status: "unconfirmed",
        final: false,
        txHash: currentHash,
        submittedHash,
      },
      options.action,
    )
    throw protocolError
  }

  if (typeof receipt.blockNumber !== "bigint" || receipt.blockNumber < 0n) {
    const protocolError = submittedButUnconfirmed(
      new ProtocolError(
        "TRANSACTION_RECEIPT_INVALID",
        "The transaction receipt did not contain a valid block number.",
        {
          txHash: currentHash,
          details: {
            submittedHash,
            replacementHash,
            receiptHash,
            receiptBlockNumber:
              typeof receipt.blockNumber === "bigint"
                ? receipt.blockNumber.toString()
                : (receipt.blockNumber ?? null),
          },
        },
      ),
      options.action,
      submittedHash,
      currentHash,
    )
    await notifyLifecycle(
      options.onTransactionLifecycle,
      {
        status: "unconfirmed",
        final: false,
        txHash: currentHash,
        submittedHash,
      },
      options.action,
    )
    throw protocolError
  }

  if (
    replacement &&
    (replacement.reason !== "repriced" ||
      !sameTransactionCall(replacement.replacedTransaction, replacement.transaction))
  ) {
    const terminalStatus = replacement.reason === "cancelled" ? "cancelled" : "replaced-different"
    await notifyLifecycle(
      options.onTransactionLifecycle,
      {
        status: terminalStatus,
        final: true,
        txHash: currentHash,
        submittedHash,
        reason: replacement.reason || "unknown",
        receipt,
      },
      options.action,
    )
    throw replacementError(replacement, submittedHash)
  }

  if (receipt.status === "reverted") {
    await notifyLifecycle(
      options.onTransactionLifecycle,
      {
        status: "reverted",
        final: true,
        txHash: currentHash,
        submittedHash,
        receipt: receipt || null,
      },
      options.action,
    )
    throw new ProtocolError(
      "TRANSACTION_REVERTED",
      "The transaction reverted on BNB Chain. No protocol state was changed.",
      {
        txHash: currentHash,
        details: { blockNumber: receipt?.blockNumber ?? null },
      },
    )
  }

  const canonicalReceipt = Object.freeze({
    ...receipt,
    transactionHash: receiptHash,
  })
  await notifyLifecycle(
    options.onTransactionLifecycle,
    {
      status: "confirmed",
      final: true,
      txHash: canonicalReceipt.transactionHash,
      submittedHash,
      receipt: canonicalReceipt,
    },
    options.action,
  )
  return canonicalReceipt
}

export async function executeContractWrite(options) {
  const {
    publicClient,
    walletClient,
    account,
    address,
    abi,
    functionName,
    args = [],
    action = functionName,
    assertCurrentContext,
  } = options

  requireLifecycleCallback(options.onTransactionLifecycle)
  requireBeforeSubmitCallback(options.beforeTransactionSubmit)

  requireClient(
    publicClient,
    "simulateContract",
    "RPC_UNAVAILABLE",
    "BNB Chain simulation is unavailable.",
  )
  const normalizedAccount = await assertWalletReady(walletClient, account)
  const contractAddress = normalizeAddress(address, "Contract address")

  let request
  try {
    await requireCurrentContext(assertCurrentContext, "before-simulate", normalizedAccount)
    const simulation = await publicClient.simulateContract({
      account: normalizedAccount,
      address: contractAddress,
      abi,
      functionName,
      args,
    })
    request = simulation?.request
  } catch (error) {
    throw toProtocolError(error, { action })
  }

  if (!request) {
    throw new ProtocolError("SIMULATION_INVALID", "The transaction could not be prepared safely.", {
      action,
    })
  }

  let hash
  try {
    await assertWalletReady(walletClient, normalizedAccount)
    await requireCurrentContext(assertCurrentContext, "before-write", normalizedAccount)
    await verifyBeforeSubmit(options.beforeTransactionSubmit, {
      action,
      account: normalizedAccount,
      address: contractAddress,
      functionName,
    })
    await requireCurrentContext(assertCurrentContext, "after-safety-check", normalizedAccount)
    hash = await walletClient.writeContract(request)
  } catch (error) {
    throw toProtocolError(error, { action })
  }

  hash = requireTransactionHash(hash)
  await notifyLifecycle(
    options.onTransactionLifecycle,
    {
      status: "submitted",
      final: false,
      txHash: hash,
      submittedHash: hash,
    },
    action,
  )

  const receipt = await waitForSuccessfulReceipt(publicClient, hash, { ...options, action })
  return Object.freeze({ hash: receipt.transactionHash, receipt })
}
